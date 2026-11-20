import { cloneDeep } from 'lodash';
import { type Observable, of, Subject } from 'rxjs';

import { type DataSourceInstanceSettings } from '@grafana/data';
import { getBackendSrv, setBackendSrv, type BackendSrvRequest, type TemplateSrv } from '@grafana/runtime';

import { PrometheusDatasource } from '../datasource';
import { QueryEditorMode } from '../querybuilder/shared/types';
import { type PromMetricsMetadata, type PromOptions, type PromQuery } from '../types';

import { type QueryCoauthoringLanguage } from './queryCoauthoringContracts';

const originalBackend = getBackendSrv();
const fetch = jest.fn<Observable<unknown>, [BackendSrvRequest]>();

function respond(metadata: PromMetricsMetadata = {}, labels: string[] = []) {
  fetch.mockImplementation((request) =>
    of({
      data: {
        status: 'success',
        data: request.url.endsWith('/metadata')
          ? Object.fromEntries(Object.entries(metadata).map(([name, item]) => [name, [item]]))
          : labels,
      },
    })
  );
}

beforeEach(() => {
  fetch.mockReset();
  respond();
  setBackendSrv({ ...originalBackend, fetch } as unknown as ReturnType<typeof getBackendSrv>);
});

afterEach(() => setBackendSrv(originalBackend));

function setup() {
  return new PrometheusDatasource(
    { uid: 'prom', url: '/prom', jsonData: {} } as DataSourceInstanceSettings<PromOptions>,
    { replace: (text: string) => text.replace('$__rate_interval', '1s') } as TemplateSrv
  );
}

describe('Prometheus datasource coauthoring language', () => {
  it.each([
    { refId: 'A', expr: 'up', editorMode: QueryEditorMode.Code },
    { refId: 'A', expr: 'sum(up)', editorMode: QueryEditorMode.Builder },
    { refId: 'A', expr: '' },
    { refId: 'A', expr: 'sum(' },
    { refId: 'A', expr: 'rate(up[$__rate_interval])' },
  ])('reports editability synchronously without validating or mutating draft $expr', (draft) => {
    const ds = setup();
    const language = ds.queryCoauthoring();
    const describe = jest.spyOn(language, 'describe');
    const prepare = jest.spyOn(language, 'prepare');
    const query = Object.freeze({
      ...draft,
      datasource: Object.freeze({ uid: 'prom', type: 'prometheus' }),
      hide: true,
      instant: true,
      range: false,
      legendFormat: '{{job}}',
      futureField: Object.freeze({ nested: Object.freeze(['preserve me']) }),
    });
    const before = cloneDeep(query);

    expect(language.version).toBe(1);
    expect(language.getQuerySupport?.(query)).toEqual({ editable: true });
    expect(query).toEqual(before);
    expect(describe).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps describe and prepare usable by a language1 consumer ignoring the optional support hook', async () => {
    const language = setup().queryCoauthoring();
    const support = jest.spyOn(language, 'getQuerySupport');
    // This is the language1 shape before getQuerySupport was added, as consumed by older Core.
    const legacy: Omit<QueryCoauthoringLanguage<PromQuery>, 'getQuerySupport'> = language;
    const query = { refId: 'A', expr: 'up', hide: true };
    expect(legacy.version).toBe(1);
    expect((await legacy.describe(query, {})).text).toBe('up');
    expect(legacy.prepare(query, 'sum(up)')).toMatchObject({
      status: 'ready',
      query: { ...query, expr: 'sum(up)' },
    });
    expect(support).not.toHaveBeenCalled();

    // An adapter implementing only the old members still satisfies language1.
    const olderAdapter: QueryCoauthoringLanguage<PromQuery> = {
      version: legacy.version,
      describe: legacy.describe,
      prepare: legacy.prepare,
    };
    expect(olderAdapter.getQuerySupport).toBeUndefined();
  });

  it('describes authored PromQL with guidance and relevant metric metadata', async () => {
    const ds = setup();
    respond(
      {
        http_requests_total: { type: 'counter', help: 'Request count', unit: 'requests' },
        unrelated: { type: 'gauge', help: 'Excluded' },
      },
      ['job', '__name__', 'handler']
    );
    await expect(
      ds.queryCoauthoring().describe({ refId: 'A', expr: 'rate(http_requests_total[5m])' }, {})
    ).resolves.toEqual({
      text: 'rate(http_requests_total[5m])',
      language: {
        id: 'promql',
        displayName: 'PromQL',
        guidance: expect.arrayContaining([expect.stringContaining('Grafana template variables')]),
      },
      metadata: [
        {
          kind: 'metric',
          name: 'http_requests_total',
          attributes: { type: 'counter', help: 'Request count', unit: 'requests', labels: ['handler', 'job'] },
        },
      ],
    });
  });

  it('prepares a typed query preserving every non-text field without mounting an editor', () => {
    const ds = setup();
    const baseline = {
      refId: 'B',
      expr: 'up',
      datasource: { uid: 'prom', type: 'prometheus' },
      hide: true,
      instant: true,
      range: false,
      legendFormat: '{{job}}',
      interval: '30s',
      exemplar: true,
      format: 'table' as const,
      editorMode: QueryEditorMode.Code,
      futureField: { nested: ['preserve me'] },
    };
    const language = ds.queryCoauthoring();
    expect(language.version).toBe(1);
    expect(language.prepare(baseline, 'up + 1')).toEqual({
      status: 'ready',
      query: { ...baseline, expr: 'up + 1' },
      changes: [
        {
          original: 'up',
          proposed: 'up + 1',
          originalRanges: [{ from: 2, to: 2 }],
          proposedRanges: [{ from: 2, to: 6 }],
        },
      ],
    });
    expect(baseline.expr).toBe('up');
  });
});

describe('language rejection and cancellation', () => {
  it.each(['', '   ', 'sum(', 'up +', 'rate(up[5m]) by (job)'])('rejects invalid PromQL: %s', (text) => {
    expect(setup().queryCoauthoring().prepare({ refId: 'A', expr: 'up' }, text)).toEqual({
      status: 'rejected',
      reason: 'invalid',
    });
  });

  it('rejects unchanged text', () => {
    expect(setup().queryCoauthoring().prepare({ refId: 'A', expr: 'up' }, 'up')).toEqual({
      status: 'rejected',
      reason: 'unchanged',
    });
  });

  it('does not start metadata work for an aborted description', async () => {
    const ds = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      ds.queryCoauthoring().describe({ refId: 'A', expr: 'up' }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('language metadata budgets', () => {
  it('bounds metrics, label lookups, label keys and help; does not mutate the cache', async () => {
    const ds = setup();
    const metricNames = Array.from({ length: 25 }, (_, i) => `metric_${i}`);
    const metadata = Object.fromEntries(
      metricNames.map((name) => [name, { type: 'gauge', help: 'h'.repeat(600), unit: 'bytes' }])
    );
    const labelKeys = ['__name__', ...Array.from({ length: 40 }, (_, i) => `label_${i}`)];
    respond(metadata, labelKeys);
    await ds.languageProvider.queryMetricsMetadata();
    fetch.mockClear();
    const result = await ds.queryCoauthoring().describe({ refId: 'A', expr: metricNames.join(' + ') }, {});
    expect(result.metadata).toHaveLength(20);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('/labels'),
        data: expect.objectContaining({ 'match[]': '{__name__="metric_0"}', limit: 30 }),
      })
    );
    expect(result.metadata?.[0].attributes).toEqual({
      type: 'gauge',
      help: 'h'.repeat(500),
      unit: 'bytes',
      labels: expect.any(Array),
    });
    expect(result.metadata?.[0].attributes?.labels).toHaveLength(30);
    expect(result.metadata?.[5].attributes?.labels).toBeUndefined();
    expect(labelKeys[0]).toBe('__name__');
    expect(metadata.metric_0.help).toHaveLength(600);
  });

  it('uses cached metadata with lookups disabled and makes no requests', async () => {
    const ds = setup();
    respond({ up: { type: 'gauge', help: '' } });
    await ds.languageProvider.queryMetricsMetadata();
    fetch.mockClear();
    ds.lookupsDisabled = true;
    const result = await ds.queryCoauthoring().describe({ refId: 'A', expr: 'up + missing' }, {});
    expect(result.metadata).toEqual([
      { kind: 'metric', name: 'up', attributes: { type: 'gauge' } },
      { kind: 'metric', name: 'missing', attributes: {} },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels while a cache-backed metadata lookup is still pending', async () => {
    const ds = setup();
    const pending = new Subject<unknown>();
    fetch.mockReturnValue(pending);
    const controller = new AbortController();
    const result = ds.queryCoauthoring().describe({ refId: 'A', expr: 'up' }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalled();
    pending.next({ data: { status: 'success', data: [] } });
    pending.complete();
  });

  it('returns authored template text and prepares against interpolated PromQL', async () => {
    const ds = setup();
    ds.lookupsDisabled = true;
    const query = { refId: 'A', expr: 'rate(up[$__rate_interval])' };
    expect((await ds.queryCoauthoring().describe(query, {})).text).toBe(query.expr);
    expect(ds.queryCoauthoring().prepare(query, 'sum(rate(up[$__rate_interval]))')).toMatchObject({
      status: 'ready',
      query: { expr: 'sum(rate(up[$__rate_interval]))' },
    });
  });
});

it('describes through the real language provider and resource clients, including in an inheriting datasource', async () => {
  respond({ http_requests_total: { type: 'counter', help: 'Requests', unit: 'requests' } }, [
    '__name__',
    'handler',
    'job',
  ]);
  class InheritedDatasource extends PrometheusDatasource {}
  const datasource = new InheritedDatasource(
    { uid: 'inherited', url: '/prom', jsonData: { httpMethod: 'GET' } } as DataSourceInstanceSettings<PromOptions>,
    { replace: (text: string) => text } as TemplateSrv
  );
  datasource.type = 'inheriting-prometheus-plugin';
  const language = datasource.queryCoauthoring();
  expect(language.getQuerySupport?.({ refId: 'A', expr: 'up' })).toEqual({ editable: true });
  expect(fetch).not.toHaveBeenCalled();
  const result = await language.describe({ refId: 'A', expr: 'rate(http_requests_total[5m])' }, {});
  expect(result.metadata).toEqual([
    {
      kind: 'metric',
      name: 'http_requests_total',
      attributes: { type: 'counter', help: 'Requests', unit: 'requests', labels: ['handler', 'job'] },
    },
  ]);
  expect(fetch.mock.calls.map(([request]) => request)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining('/resources/api/v1/metadata') }),
      expect.objectContaining({
        url: expect.stringContaining('/resources/api/v1/labels'),
        params: expect.objectContaining({ 'match[]': '{__name__="http_requests_total"}', limit: 30 }),
      }),
    ])
  );
  expect(language.prepare({ refId: 'A', expr: 'up', hide: true }, 'sum(up)')).toMatchObject({
    status: 'ready',
    query: { refId: 'A', expr: 'sum(up)', hide: true },
  });
});
