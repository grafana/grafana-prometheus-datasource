import { lastValueFrom, of, toArray } from 'rxjs';

import { LoadingState, dateTime, type DataQueryRequest } from '@grafana/data';
import { getBackendSrv, setBackendSrv } from '@grafana/runtime';

import {
  buildChunkedQueryBody,
  createChunkedQueryURL,
  isChunkedQueryEligible,
  queryChunked,
  supportsChunkedQueries,
} from './chunked_query';
import { type PromQuery } from './types';

const chunked = jest.fn();
const originalBackendSrv = getBackendSrv();
const datasource = {
  id: 1,
  uid: 'prometheus/dev',
  getRef: () => ({ uid: 'prometheus/dev', type: 'prometheus' }),
  applyTemplateVariables: (query: PromQuery) => ({ ...query, expr: `${query.expr}_interpolated` }),
};

beforeAll(() => {
  setBackendSrv({ ...originalBackendSrv, chunked });
});

beforeEach(() => {
  jest.clearAllMocks();
});

function request(target: Partial<PromQuery> = {}): DataQueryRequest<PromQuery> {
  return {
    requestId: 'request-1',
    range: { from: dateTime(0), to: dateTime(1000), raw: { from: 'now-1m', to: 'now' } },
    targets: [{ refId: 'A', expr: 'up', range: true, instant: false, ...target }],
  } as DataQueryRequest<PromQuery>;
}

describe('chunked query transport', () => {
  it('requires a stable Grafana release at or above 13.1', () => {
    expect(supportsChunkedQueries('13.0.9')).toBe(false);
    expect(supportsChunkedQueries('13.1.0-beta.1')).toBe(false);
    expect(supportsChunkedQueries('13.1.0')).toBe(true);
    expect(supportsChunkedQueries('13.2.0')).toBe(true);
    expect(supportsChunkedQueries('dev')).toBe(false);
  });

  it('accepts only supported range targets', () => {
    expect(isChunkedQueryEligible(request(), datasource.uid)).toBe(true);
    expect(isChunkedQueryEligible(request({ instant: true }), datasource.uid)).toBe(false);
    expect(isChunkedQueryEligible(request({ exemplar: true }), datasource.uid)).toBe(false);
    expect(isChunkedQueryEligible(request({ format: 'heatmap' }), datasource.uid)).toBe(false);
    expect(isChunkedQueryEligible(request({ range: false }), datasource.uid)).toBe(false);
  });

  it('builds an encoded plugin endpoint', () => {
    expect(createChunkedQueryURL('/grafana', 'stack/1', 'prometheus/dev')).toBe(
      '/grafana/apis/prometheus.datasource.grafana.app/v0alpha1/namespaces/stack%2F1/datasources/prometheus%2Fdev/query'
    );
  });

  it('decodes split JSONL frames and emits accumulated snapshots', async () => {
    const event =
      '{"refId":"A","frameId":"range/0","frame":{"schema":{"refId":"A","fields":[{"name":"Time","type":"time"},{"name":"Value","type":"number"}]},"data":{"values":[[1],[2]]}}}\n';
    const bytes = new TextEncoder().encode(event);
    chunked.mockReturnValue(
      of(
        { ok: true, data: bytes.slice(0, 27) },
        { ok: true, data: bytes.slice(27) },
        { ok: true, data: new TextEncoder().encode('{"complete":true}\n') },
        { ok: true, data: undefined }
      )
    );

    const responses = await lastValueFrom(queryChunked(datasource, request()).pipe(toArray()));

    expect(chunked).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        requestId: 'request-1',
        headers: { Accept: 'text/jsonl', 'Content-Type': 'application/json' },
      })
    );
    expect(responses.map((response) => response.state)).toEqual([LoadingState.Streaming, LoadingState.Done]);
    expect(responses[0].data[0].fields[1].values).toEqual([2]);
  });

  it('builds the same datasource query envelope as the buffered transport', () => {
    const body = buildChunkedQueryBody(datasource, request());

    expect(body).toMatchObject({
      from: '0',
      to: '1000',
      queries: [
        expect.objectContaining({
          refId: 'A',
          expr: 'up_interpolated',
          datasource: { uid: 'prometheus/dev', type: 'prometheus' },
          datasourceId: 1,
        }),
      ],
    });
  });
});
