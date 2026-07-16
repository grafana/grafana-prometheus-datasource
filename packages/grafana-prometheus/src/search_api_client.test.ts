import { Observable } from 'rxjs';

import { dateTime, type TimeRange } from '@grafana/data';
import { type BackendSrvRequest, type FetchResponse, getBackendSrv, setBackendSrv } from '@grafana/runtime';

import { SEARCH_STREAM_BATCH_SIZE } from './constants';
import { type PrometheusDatasource } from './datasource';
import {
  readSearchStream,
  type SearchChunkSource,
  SearchApiClient,
  type SearchMetricResult,
} from './search_api_client';
import { PrometheusCacheLevel } from './types';

const timeRange: TimeRange = {
  from: dateTime(1681300292392),
  to: dateTime(1681300293392),
  raw: { from: 'now-1s', to: 'now' },
};

const datasource = {
  uid: 'prometheus/primary',
  cacheLevel: PrometheusCacheLevel.Low,
  seriesLimit: 40000,
  getAdjustedInterval: jest.fn().mockReturnValue({ start: '1681300260', end: '1681300320' }),
  getTimeRangeParams: jest.fn().mockReturnValue({ start: '1681300260', end: '1681300320' }),
  interpolateString: jest.fn((value: string) => value),
} as unknown as PrometheusDatasource;

describe('readSearchStream', () => {
  it('reads multiple batches and the success trailer', async () => {
    const onBatch = jest.fn();
    const source = chunkSource([
      '{"results":[{"name":"http_requests_total"}]}\n{"res',
      'ults":[{"name":"http_request_duration_seconds"}],"warnings":["partial"]}\n',
      '{"status":"success","has_more":true}\n',
    ]);

    const result = await readSearchStream<SearchMetricResult>(source, onBatch);

    expect(result).toEqual({
      results: [{ name: 'http_requests_total' }, { name: 'http_request_duration_seconds' }],
      warnings: ['partial'],
      hasMore: true,
    });
    expect(onBatch).toHaveBeenNthCalledWith(1, [{ name: 'http_requests_total' }]);
    expect(onBatch).toHaveBeenNthCalledWith(2, [{ name: 'http_request_duration_seconds' }]);
  });

  it('surfaces mid-stream errors with partial results', async () => {
    const source = chunkSource([
      '{"results":[{"name":"up"}]}\n',
      '{"status":"error","errorType":"internal","error":"search failed"}\n',
    ]);

    await expect(readSearchStream<SearchMetricResult>(source)).rejects.toMatchObject({
      message: 'search failed',
      errorType: 'internal',
      partialResults: [{ name: 'up' }],
    });
  });

  it('flags a truncated stream (missing trailer) as incomplete', async () => {
    const source = chunkSource(['{"results":[{"name":"up"}]}\n{"status":"succ']);

    await expect(readSearchStream<SearchMetricResult>(source)).resolves.toEqual({
      results: [{ name: 'up' }],
      warnings: ['Search stream ended before completion; results may be incomplete.'],
      hasMore: true,
    });
  });

  it('rejects a stream line that exceeds the maximum length', async () => {
    // A single unterminated line larger than the cap must fail fast instead of
    // buffering without bound.
    const source = chunkSource(['{"results":[' + 'x'.repeat(100)]);

    await expect(readSearchStream<SearchMetricResult>(source, undefined, 16)).rejects.toThrow(/exceeded the maximum/i);
  });

  it('throws the upstream message for non-success responses', async () => {
    const source = chunkSource([], {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({
        status: 'error',
        errorType: 'unavailable',
        error: 'search API disabled',
      }),
    });

    await expect(readSearchStream(source)).rejects.toEqual(
      expect.objectContaining({
        message: 'search API disabled',
        errorType: 'unavailable',
        partialResults: [],
      })
    );
  });
});

describe('SearchApiClient', () => {
  const originalBackendSrv = getBackendSrv();
  const chunkedMock = jest.fn();

  beforeEach(() => {
    setBackendSrv({ ...originalBackendSrv, chunked: chunkedMock });
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
    });
  });

  it('adapts metric search results to the resource client interface', async () => {
    chunkedMock.mockReturnValue(
      chunkedStream([
        '{"results":[{"name":"request_duration_bucket"},{"name":"up"}]}\n',
        '{"status":"success","has_more":false}\n',
      ])
    );
    const client = new SearchApiClient(jest.fn(), datasource);

    await expect(client.queryMetrics(timeRange, 20)).resolves.toEqual({
      metrics: ['request_duration_bucket', 'up'],
      histogramMetrics: ['request_duration_bucket'],
    });
  });

  it('omits the leading slash so the request resolves under a Grafana subpath install', async () => {
    chunkedMock.mockReturnValue(chunkedStream(['{"results":[]}\n', '{"status":"success","has_more":false}\n']));
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up', { limit: 10 });

    expect(chunkedMock).toHaveBeenCalledWith(expect.objectContaining({ url: expect.not.stringMatching(/^\//) }));
  });

  it('caps legacy unlimited and default limits at the Prometheus search maximum', async () => {
    chunkedMock.mockReturnValue(chunkedStream(['{"results":[]}\n', '{"status":"success","has_more":true}\n']));
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchLabelNames(timeRange, '', { limit: 0 });

    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ limit: '10000' }) })
    );
  });

  it('surfaces a SearchApiError when the chunked response is not ok', async () => {
    chunkedMock.mockReturnValue(
      chunkedStream(['{"status":"error","errorType":"unavailable","error":"search API disabled"}'], {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })
    );
    const client = new SearchApiClient(jest.fn(), datasource);

    await expect(client.searchMetricNames(timeRange, 'up', { limit: 10 })).rejects.toMatchObject({
      message: 'search API disabled',
      errorType: 'unavailable',
    });
  });

  it('propagates abort by unsubscribing the chunked request', async () => {
    const unsubscribe = jest.fn();
    chunkedMock.mockReturnValue(
      new Observable<FetchResponse<Uint8Array | undefined>>(() => {
        // Never emits; simulates a long-running request that only ends via unsubscribe.
        return unsubscribe;
      })
    );
    const client = new SearchApiClient(jest.fn(), datasource);
    const controller = new AbortController();

    const promise = client.searchLabelNames(timeRange, 'inst', { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/i);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('sends batch_size when a batch size is provided', async () => {
    chunkedMock.mockReturnValue(chunkedStream(['{"results":[]}\n', '{"status":"success","has_more":false}\n']));
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up', { limit: 100, batchSize: 25 });

    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ batch_size: '25' }) })
    );
  });

  it('defaults batch_size to the streaming batch size when none is provided', async () => {
    chunkedMock.mockReturnValue(chunkedStream(['{"results":[]}\n', '{"status":"success","has_more":false}\n']));
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up', { limit: 100 });

    expect(chunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ batch_size: String(SEARCH_STREAM_BATCH_SIZE) }) })
    );
  });
});

// Builds a fake SearchChunkSource that yields the given NDJSON fragments one
// read() at a time, mirroring how a real chunked transport delivers bytes.
function chunkSource(
  chunks: string[],
  opts: { ok?: boolean; status?: number; statusText?: string; json?: () => Promise<unknown> } = {}
): SearchChunkSource {
  const encoder = new TextEncoder();
  let index = 0;
  const { ok = true, status = 200, statusText = 'OK', json = async () => ({}) } = opts;
  return {
    ok,
    status,
    statusText,
    read: async () =>
      index < chunks.length
        ? { done: false, value: encoder.encode(chunks[index++]) }
        : { done: true, value: undefined },
    json,
  };
}

// Builds a fake getBackendSrv().chunked() Observable that mirrors the real
// contract: one next() per chunk (each carrying the invariant ok/status
// fields), a final next() with `data: undefined`, then complete().
function chunkedStream(
  chunks: string[],
  opts: { ok?: boolean; status?: number; statusText?: string } = {}
): Observable<FetchResponse<Uint8Array | undefined>> {
  const encoder = new TextEncoder();
  const { ok = true, status = 200, statusText = 'OK' } = opts;
  return new Observable<FetchResponse<Uint8Array | undefined>>((subscriber) => {
    const base = {
      ok,
      status,
      statusText,
      headers: new Headers(),
      url: '',
      type: 'basic' as ResponseType,
      redirected: false,
      config: {} as BackendSrvRequest,
    };
    for (const chunk of chunks) {
      subscriber.next({ ...base, data: encoder.encode(chunk) });
    }
    subscriber.next({ ...base, data: undefined });
    subscriber.complete();
  });
}
