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

const datasource = {
  uid: 'prometheus/primary',
  cacheLevel: PrometheusCacheLevel.None,
  seriesLimit: 40000,
  getAdjustedInterval: jest.fn().mockReturnValue({ start: '1681300260', end: '1681300320' }),
} as unknown as PrometheusDatasource;

describe('SearchApiClient', () => {
  const originalBackendSrv = getBackendSrv();
  const chunkedMock = jest.fn();
  const getMock = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    setBackendSrv({ ...originalBackendSrv, chunked: chunkedMock, get: getMock });
    chunkedMock.mockReturnValue(successfulStream());
  });

  afterEach(() => {
    setBackendSrv(originalBackendSrv);
    jest.restoreAllMocks();
    jest.clearAllMocks();
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
        'search[]': 'http req',
        sort_by: 'score',
        batch_size: '100',
        include_metadata: 'true',
      },
      headers: {},
    });
  });

  it('uses snapped range parameters and match filters for label names', async () => {
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchLabelNames(timeRange, '', { match: '{job="grafana"}', limit: 20 });

    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringMatching(/\/label_names$/),
        params: {
          start: '1681300293',
          end: '1681300294',
          limit: '20',
          'match[]': '{job="grafana"}',
          batch_size: '100',
        },
      })
    );
  });

  it('sends the label name and adjusted range when searching label values', async () => {
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchLabelValues(timeRange, 'service.name', 'api', { limit: 25 });

    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringMatching(/\/label_values$/),
        params: expect.objectContaining({
          start: '1681300260',
          end: '1681300320',
          label: 'service.name',
          'search[]': 'api',
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
    ['legacy unlimited', 0, '10000'],
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

    await expect(client.searchMetricNames(timeRange, 'up')).rejects.toBeInstanceOf(SearchApiUnavailableError);
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
