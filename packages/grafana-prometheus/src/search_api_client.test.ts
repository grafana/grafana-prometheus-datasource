import { dateTime, type TimeRange } from '@grafana/data';
import { config } from '@grafana/runtime';

import { type PrometheusDatasource } from './datasource';
import { readSearchStream, SearchApiClient, type SearchMetricResult } from './search_api_client';
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
    const response = streamResponse([
      '{"results":[{"name":"http_requests_total"}]}\n{"res',
      'ults":[{"name":"http_request_duration_seconds"}],"warnings":["partial"]}\n',
      '{"status":"success","has_more":true}\n',
    ]);

    const result = await readSearchStream<SearchMetricResult>(response, onBatch);

    expect(result).toEqual({
      results: [{ name: 'http_requests_total' }, { name: 'http_request_duration_seconds' }],
      warnings: ['partial'],
      hasMore: true,
    });
    expect(onBatch).toHaveBeenNthCalledWith(1, [{ name: 'http_requests_total' }]);
    expect(onBatch).toHaveBeenNthCalledWith(2, [{ name: 'http_request_duration_seconds' }]);
  });

  it('surfaces mid-stream errors with partial results', async () => {
    const response = streamResponse([
      '{"results":[{"name":"up"}]}\n',
      '{"status":"error","errorType":"internal","error":"search failed"}\n',
    ]);

    await expect(readSearchStream<SearchMetricResult>(response)).rejects.toMatchObject({
      message: 'search failed',
      errorType: 'internal',
      partialResults: [{ name: 'up' }],
    });
  });

  it('treats abrupt EOF as partial success', async () => {
    const response = streamResponse(['{"results":[{"name":"up"}]}\n{"status":"succ']);

    await expect(readSearchStream<SearchMetricResult>(response)).resolves.toEqual({
      results: [{ name: 'up' }],
      warnings: [],
      hasMore: false,
    });
  });

  it('throws the upstream message for non-success responses', async () => {
    const response = {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({
        status: 'error',
        errorType: 'unavailable',
        error: 'search API disabled',
      }),
    } as Response;

    await expect(readSearchStream(response)).rejects.toEqual(
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
        'start=1681300260&end=1681300320&limit=100&search%5B%5D=http+req&sort_by=score&include_metadata=true',
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
});

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
