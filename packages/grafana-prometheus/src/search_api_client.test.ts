import { Observable } from 'rxjs';

import { dateTime, type TimeRange } from '@grafana/data';
import { config, type FetchResponse, getBackendSrv, setBackendSrv } from '@grafana/runtime';

import { SEARCH_STREAM_BATCH_SIZE } from './constants';
import { type PrometheusDatasource } from './datasource';
import { SearchApiClient } from './search_api_client';
import { SearchApiUnavailableError } from './search_api_stream';
import { chunkedStream } from './test/mocks/chunked';
import { PrometheusCacheLevel } from './types';

const timeRange: TimeRange = {
  from: dateTime(1681300292392),
  to: dateTime(1681300293392),
  raw: { from: 'now-1s', to: 'now' },
};

const hasLabelsMatchAPISupport = jest.fn().mockReturnValue(true);
const datasource = {
  uid: 'prometheus/primary',
  cacheLevel: PrometheusCacheLevel.None,
  seriesLimit: 40000,
  getAdjustedInterval: jest.fn().mockReturnValue({ start: '1681300260', end: '1681300320' }),
  getTimeRangeParams: jest.fn().mockReturnValue({ start: '1681300260', end: '1681300320' }),
  interpolateString: jest.fn((value: string) => value),
  hasLabelsMatchAPISupport,
} as unknown as PrometheusDatasource;

describe('SearchApiClient', () => {
  const originalBackendSrv = getBackendSrv();
  const chunkedMock = jest.fn();
  const getMock = jest.fn().mockResolvedValue(undefined);
  const requestMock = jest.fn();

  beforeEach(() => {
    setBackendSrv({ ...originalBackendSrv, chunked: chunkedMock, get: getMock });
    chunkedMock.mockReturnValue(successfulStream());
    requestMock.mockReset().mockResolvedValue([]);
    hasLabelsMatchAPISupport.mockReturnValue(true);
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    setBackendSrv(originalBackendSrv);
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('starts metric and label discovery through the resource client contract', async () => {
    chunkedMock
      .mockReturnValueOnce(searchResultsStream([{ name: 'up' }]))
      .mockReturnValueOnce(searchResultsStream([{ name: 'instance' }, { name: 'job' }]));
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.start(timeRange);

    expect(client.metrics).toEqual(['up']);
    expect(client.labelKeys).toEqual(['instance', 'job']);
    expect(chunkedMock).toHaveBeenCalledTimes(2);
  });

  it('adapts metric records and identifies histogram metrics', async () => {
    chunkedMock.mockReturnValue(searchResultsStream([{ name: 'request_duration_bucket' }, { name: 'up' }]));
    const client = new SearchApiClient(jest.fn(), datasource);

    await expect(client.queryMetrics(timeRange, 20)).resolves.toEqual({
      metrics: ['request_duration_bucket', 'up'],
      histogramMetrics: ['request_duration_bucket'],
    });
  });

  it('caches adapted metric names', async () => {
    chunkedMock.mockReturnValue(searchResultsStream([{ name: 'up' }]));
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.queryMetrics(timeRange, 20);
    await expect(client.queryMetrics(timeRange, 20)).resolves.toEqual({
      metrics: ['up'],
      histogramMetrics: [],
    });

    expect(chunkedMock).toHaveBeenCalledTimes(1);
  });

  it('adapts and caches label names', async () => {
    chunkedMock.mockReturnValue(searchResultsStream([{ name: 'instance' }, { name: 'job' }]));
    const client = new SearchApiClient(jest.fn(), datasource);

    const first = await client.queryLabelKeys(timeRange, '{job="grafana"}', 50);
    first.push('modified');
    const second = await client.queryLabelKeys(timeRange, '{job="grafana"}', 50);

    expect(second).toEqual(['instance', 'job']);
    expect(chunkedMock).toHaveBeenCalledTimes(1);
  });

  it('interpolates label names and caches adapted label values', async () => {
    chunkedMock.mockReturnValue(searchResultsStream([{ value: 'dev' }, { value: 'prod' }]));
    const client = new SearchApiClient(jest.fn(), datasource);

    const first = await client.queryLabelValues(timeRange, '"service.name"', '{job="grafana"}', 50);
    const second = await client.queryLabelValues(timeRange, '"service.name"', '{job="grafana"}', 50);

    expect(first).toEqual(['dev', 'prod']);
    expect(second).toEqual(['dev', 'prod']);
    expect(chunkedMock).toHaveBeenCalledTimes(1);
    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ label: 'service.name', 'match[]': '{job="grafana"}' }),
      })
    );
  });

  it('keeps label-value cache keys distinct for delimiter-colliding input pairs', async () => {
    chunkedMock
      .mockReturnValueOnce(searchResultsStream([{ value: 'first' }]))
      .mockReturnValueOnce(searchResultsStream([{ value: 'second' }]));
    const client = new SearchApiClient(jest.fn(), datasource);

    const first = await client.queryLabelValues(timeRange, 'b-c', 'a', 50);
    const second = await client.queryLabelValues(timeRange, 'c', 'a-b', 50);

    expect(first).toEqual(['first']);
    expect(second).toEqual(['second']);
    expect(chunkedMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the labels client when the Search API reports unavailable', async () => {
    chunkedMock.mockReturnValue(unavailableStream());
    requestMock.mockResolvedValue(['standard-b', 'standard-a']);
    const client = new SearchApiClient(requestMock, datasource);

    expect(client.isAvailable()).toBe(true);
    await expect(client.queryLabelKeys(timeRange)).resolves.toEqual(['standard-a', 'standard-b']);

    expect(requestMock).toHaveBeenCalledWith('/api/v1/labels', expect.anything(), undefined);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(client.isAvailable()).toBe(false);
  });

  it('falls back for a missing Search API route', async () => {
    chunkedMock.mockReturnValue(chunkedStream([], { ok: false, status: 404, statusText: 'Not Found' }));
    requestMock.mockResolvedValue(['standard-value']);
    const client = new SearchApiClient(requestMock, datasource);

    await expect(client.queryLabelValues(timeRange, 'job')).resolves.toEqual(['standard-value']);

    expect(requestMock).toHaveBeenCalledWith('/api/v1/label/job/values', expect.anything(), undefined);
  });

  it('does not fall back for a Search API server error', async () => {
    chunkedMock.mockReturnValue(
      chunkedStream(['{"status":"error","errorType":"internal","error":"search failed"}'], {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })
    );
    const client = new SearchApiClient(requestMock, datasource);

    await expect(client.queryMetrics(timeRange)).rejects.toMatchObject({
      message: 'search failed',
      errorType: 'internal',
    });
    expect(requestMock).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('uses the sticky flag after the first unavailable response', async () => {
    chunkedMock.mockReturnValue(unavailableStream());
    requestMock.mockResolvedValue(['standard-label']);
    const client = new SearchApiClient(requestMock, datasource);

    await expect(client.queryLabelKeys(timeRange)).resolves.toEqual(['standard-label']);
    await expect(client.queryLabelValues(timeRange, 'job')).resolves.toEqual(['standard-label']);

    expect(chunkedMock).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('marks structured searches unavailable and lets their caller choose the fallback', async () => {
    chunkedMock.mockReturnValue(unavailableStream());
    requestMock.mockResolvedValue(['standard-label']);
    const client = new SearchApiClient(requestMock, datasource);

    await expect(client.searchMetricNames(timeRange, 'up')).rejects.toBeInstanceOf(SearchApiUnavailableError);
    await expect(client.queryLabelKeys(timeRange)).resolves.toEqual(['standard-label']);

    expect(chunkedMock).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('uses the series client when the labels API is unsupported', async () => {
    hasLabelsMatchAPISupport.mockReturnValue(false);
    chunkedMock.mockReturnValue(unavailableStream());
    requestMock.mockResolvedValue([{ __name__: 'up', job: 'grafana' }]);
    const client = new SearchApiClient(requestMock, datasource);

    await expect(client.queryLabelKeys(timeRange)).resolves.toEqual(['job']);

    expect(requestMock).toHaveBeenCalledWith(
      '/api/v1/series',
      expect.objectContaining({ 'match[]': '{__name__!=""}' }),
      undefined
    );
  });

  it('copies standard discovery state when start falls back', async () => {
    chunkedMock.mockReturnValue(unavailableStream());
    requestMock.mockResolvedValueOnce(['request_duration_bucket', 'up']).mockResolvedValueOnce(['instance', 'job']);
    const client = new SearchApiClient(requestMock, datasource);

    await client.start(timeRange);

    expect(client.metrics).toEqual(['request_duration_bucket', 'up']);
    expect(client.histogramMetrics).toEqual(['request_duration_bucket']);
    expect(client.labelKeys).toEqual(['instance', 'job']);
  });

  it('searches metric names with metadata and score ordering', async () => {
    chunkedMock.mockReturnValue(
      chunkedStream([
        '{"results":[{"name":"http_requests_total","score":0.9,"type":"counter","help":"Requests"}]}\n',
        '{"status":"success","has_more":false}\n',
      ])
    );
    const client = new SearchApiClient(jest.fn(), datasource);

    const result = await client.searchMetricNames(timeRange, 'http req', {
      limit: 100,
      includeMetadata: true,
    });

    expect(result.results).toEqual([{ name: 'http_requests_total', score: 0.9, type: 'counter', help: 'Requests' }]);
    expect(chunkedMock).toHaveBeenCalledWith({
      url: 'api/datasources/uid/prometheus%2Fprimary/resources/api/v1/search/metric_names',
      method: 'GET',
      params: {
        start: '1681300260',
        end: '1681300320',
        limit: '100',
        'search[]': 'httpreq',
        sort_by: 'score',
        batch_size: '100',
        include_metadata: 'true',
      },
      headers: {},
    });
  });

  it.each([
    ['leading and trailing whitespace', '  http req  ', 'httpreq'],
    ['tabs and repeated spaces', '\thttp \t  req\t', 'httpreq'],
    ['a quoted UTF-8 value', '  "café au lait"  ', '"caféaulait"'],
    ['a value containing spaces', 'New York City', 'NewYorkCity'],
  ])('normalizes %s into one Search API term', async (_name, term, expected) => {
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, term);

    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          'search[]': expected,
          sort_by: 'score',
        }),
      })
    );
  });

  it('uses snapped range parameters and match filters for label names', async () => {
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchLabelNames(timeRange, 'extra lab', { match: '{job="grafana"}', limit: 20 });

    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringMatching(/\/label_names$/),
        params: {
          start: '1681300293',
          end: '1681300294',
          limit: '20',
          'search[]': 'extralab',
          sort_by: 'score',
          'match[]': '{job="grafana"}',
          batch_size: '100',
        },
      })
    );
  });

  it('sends the label name and adjusted range when searching label values', async () => {
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchLabelValues(timeRange, 'service.name', 'datasource uid', { limit: 25 });

    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringMatching(/\/label_values$/),
        params: expect.objectContaining({
          start: '1681300260',
          end: '1681300320',
          label: 'service.name',
          'search[]': 'datasourceuid',
        }),
      })
    );
  });

  it('omits the leading slash so subpath installs resolve the resource URL correctly', async () => {
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up');

    expect(chunkedMock).toHaveBeenCalledWith(expect.objectContaining({ url: expect.not.stringMatching(/^\//) }));
  });

  it('sends X-Grafana-Org-Id when the current org is known', async () => {
    jest.replaceProperty(config, 'bootData', { ...config.bootData, user: { ...config.bootData.user, orgId: 7 } });
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up');

    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Grafana-Org-Id': '7' }) })
    );
  });

  it('omits X-Grafana-Org-Id when the current org is unknown', async () => {
    jest.replaceProperty(config, 'bootData', { ...config.bootData, user: { ...config.bootData.user, orgId: 0 } });
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up');

    expect(chunkedMock).toHaveBeenCalledWith(expect.objectContaining({ headers: {} }));
  });

  it.each([
    ['the datasource default', undefined, '10000'],
    ['zero, which means unlimited in standard discovery', 0, '10000'],
    ['a limit above the cap', 20000, '10000'],
    ['a limit below the cap', 250, '250'],
  ])('normalizes %s to the Search API limit', async (_name, limit, expected) => {
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up', { limit });

    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ limit: expected }) })
    );
  });

  it('surfaces unavailable non-success responses', async () => {
    chunkedMock.mockReturnValue(
      chunkedStream(['{"status":"error","errorType":"unavailable","error":"search API disabled"}'], {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })
    );
    const client = new SearchApiClient(jest.fn(), datasource);

    expect(client.isAvailable()).toBe(true);
    await expect(client.searchMetricNames(timeRange, 'up')).rejects.toBeInstanceOf(SearchApiUnavailableError);
    expect(client.isAvailable()).toBe(false);
  });

  it('retries once after a 401 through the login ping', async () => {
    chunkedMock
      .mockReturnValueOnce(chunkedStream([], { ok: false, status: 401, statusText: 'Unauthorized' }))
      .mockReturnValueOnce(chunkedStream(['{"results":[{"name":"up"}]}\n', '{"status":"success","has_more":false}\n']));
    const client = new SearchApiClient(jest.fn(), datasource);

    await expect(client.searchMetricNames(timeRange, 'up')).resolves.toMatchObject({ results: [{ name: 'up' }] });
    expect(getMock).toHaveBeenCalledWith('/api/login/ping');
    expect(chunkedMock).toHaveBeenCalledTimes(2);
  });

  it('retries after a failed login ping and surfaces a persistent 401', async () => {
    getMock.mockRejectedValueOnce(new Error('session expired'));
    chunkedMock.mockReturnValue(chunkedStream([], { ok: false, status: 401, statusText: 'Unauthorized' }));
    const client = new SearchApiClient(jest.fn(), datasource);

    await expect(client.searchMetricNames(timeRange, 'up')).rejects.toMatchObject({ message: 'Unauthorized' });
    expect(chunkedMock).toHaveBeenCalledTimes(2);
  });

  it('propagates abort by unsubscribing the chunked request', async () => {
    const unsubscribe = jest.fn();
    chunkedMock.mockReturnValue(new Observable<FetchResponse<Uint8Array | undefined>>(() => unsubscribe));
    const client = new SearchApiClient(jest.fn(), datasource);
    const controller = new AbortController();

    const result = client.searchLabelNames(timeRange, 'instance', { signal: controller.signal });
    controller.abort();

    await expect(result).rejects.toThrow(/aborted/i);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('uses the default batch size and accepts an override', async () => {
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up');
    expect(chunkedMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ batch_size: String(SEARCH_STREAM_BATCH_SIZE) }),
      })
    );

    await client.searchMetricNames(timeRange, 'up', { batchSize: 25 });
    expect(chunkedMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ batch_size: '25' }) })
    );
  });

  it('omits non-positive batch sizes', async () => {
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up', { batchSize: 0 });

    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.not.objectContaining({ batch_size: expect.anything() }) })
    );
  });

  it('forwards batches while returning the accumulated stream result', async () => {
    chunkedMock.mockReturnValue(
      chunkedStream([
        '{"results":[{"value":"api-1"}]}\n',
        '{"results":[{"value":"api-2"}]}\n',
        '{"status":"success","has_more":true,"warnings":["limited"]}\n',
      ])
    );
    const onBatch = jest.fn();
    const client = new SearchApiClient(jest.fn(), datasource);

    const result = await client.searchLabelValues(timeRange, 'service', 'api', { onBatch });

    expect(onBatch).toHaveBeenNthCalledWith(1, [{ value: 'api-1' }]);
    expect(onBatch).toHaveBeenNthCalledWith(2, [{ value: 'api-2' }]);
    expect(result).toEqual({
      results: [{ value: 'api-1' }, { value: 'api-2' }],
      warnings: ['limited'],
      hasMore: true,
    });
  });
});

function successfulStream() {
  return chunkedStream(['{"results":[]}\n', '{"status":"success","has_more":false}\n']);
}

function searchResultsStream(results: Array<Record<string, unknown>>) {
  return chunkedStream([`${JSON.stringify({ results })}\n`, '{"status":"success","has_more":false}\n']);
}

function unavailableStream() {
  return chunkedStream(['{"status":"error","errorType":"unavailable","error":"search API disabled"}'], {
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
  });
}
