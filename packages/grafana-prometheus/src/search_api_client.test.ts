import { dateTime, type TimeRange } from '@grafana/data';
import { config } from '@grafana/runtime';

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
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('searches metric names with metadata and score ordering', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        streamResponse([
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
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/datasources/uid/prometheus%2Fprimary/resources/api/v1/search/metric_names?' +
        'start=1681300260&end=1681300320&limit=100&search%5B%5D=http+req&sort_by=score&batch_size=100&include_metadata=true',
      {
        method: 'GET',
        credentials: 'same-origin',
        signal: undefined,
      }
    );
  });

  it('adapts metric search results to the resource client interface', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        streamResponse([
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

  it('uses the Grafana application subpath', async () => {
    jest.replaceProperty(config, 'appSubUrl', '/grafana');
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(streamResponse(['{"results":[]}\n', '{"status":"success","has_more":false}\n']));
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up', { limit: 10 });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/grafana\/api\/datasources\/uid\/prometheus%2Fprimary\/resources\/api\/v1\/search\/metric_names\?/
      ),
      expect.anything()
    );
  });

  it('caps legacy unlimited and default limits at the Prometheus search maximum', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(streamResponse(['{"results":[]}\n', '{"status":"success","has_more":true}\n']));
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchLabelNames(timeRange, '', { limit: 0 });

    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('limit=10000'), expect.anything());
  });

  it('passes abort signals to fetch', async () => {
    globalThis.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const client = new SearchApiClient(jest.fn(), datasource);
    const controller = new AbortController();

    const promise = client.searchLabelNames(timeRange, 'inst', { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toThrow('aborted');
  });

  it('sends batch_size when a batch size is provided', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(streamResponse(['{"results":[]}\n', '{"status":"success","has_more":false}\n']));
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up', { limit: 100, batchSize: 25 });

    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('batch_size=25'), expect.anything());
  });

  it('defaults batch_size to the streaming batch size when none is provided', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(streamResponse(['{"results":[]}\n', '{"status":"success","has_more":false}\n']));
    const client = new SearchApiClient(jest.fn(), datasource);

    await client.searchMetricNames(timeRange, 'up', { limit: 100 });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`batch_size=${SEARCH_STREAM_BATCH_SIZE}`),
      expect.anything()
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

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = {
    getReader: () => ({
      read: async () =>
        index < chunks.length
          ? { done: false, value: encoder.encode(chunks[index++]) }
          : { done: true, value: undefined },
    }),
  };
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: body as ReadableStream<Uint8Array>,
  } as Response;
}
