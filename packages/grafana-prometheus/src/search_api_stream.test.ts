import {
  readSearchStream,
  SearchApiError,
  SearchApiUnavailableError,
  type SearchChunkSource,
} from './search_api_stream';

interface TestResult {
  name: string;
}

describe('readSearchStream', () => {
  it('reads multiple batches and the success trailer', async () => {
    const onBatch = jest.fn();
    const source = chunkSource([
      '{"results":[{"name":"http_requests_total"}]}\n{"res',
      'ults":[{"name":"http_request_duration_seconds"}],"warnings":["partial"]}\n',
      '{"status":"success","has_more":true}\n',
    ]);

    const result = await readSearchStream<TestResult>(source, onBatch);

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

    await expect(readSearchStream<TestResult>(source)).rejects.toMatchObject({
      message: 'search failed',
      errorType: 'internal',
      partialResults: [{ name: 'up' }],
    });
  });

  it('flags a truncated stream (missing trailer) as incomplete', async () => {
    const source = chunkSource(['{"results":[{"name":"up"}]}\n{"status":"succ']);

    await expect(readSearchStream<TestResult>(source)).resolves.toEqual({
      results: [{ name: 'up' }],
      warnings: ['Search stream ended before completion; results may be incomplete.'],
      hasMore: true,
    });
  });

  it('rejects a stream line that exceeds the maximum length', async () => {
    // A single unterminated line larger than the cap must fail fast instead of
    // buffering without bound.
    const source = chunkSource(['{"results":[' + 'x'.repeat(100)]);

    await expect(readSearchStream<TestResult>(source, undefined, 16)).rejects.toThrow(/exceeded the maximum/i);
  });

  it('throws the upstream message for non-success responses', async () => {
    const source = chunkSource([], {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ status: 'error', errorType: 'internal', error: 'something broke' }),
    });

    await expect(readSearchStream(source)).rejects.toEqual(
      expect.objectContaining({
        message: 'something broke',
        errorType: 'internal',
        partialResults: [],
      })
    );
  });

  describe('capability classification', () => {
    it('treats errorType "unavailable" as the search API being absent', async () => {
      // Prometheus answers a disabled search feature with a 500 whose body
      // carries the errorType, so the status alone cannot be the signal.
      const source = chunkSource([], {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ status: 'error', errorType: 'unavailable', error: 'search API disabled' }),
      });

      await expect(readSearchStream(source)).rejects.toBeInstanceOf(SearchApiUnavailableError);
    });

    it('treats a plain 500 as a genuine failure', async () => {
      const source = chunkSource([], {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ status: 'error', errorType: 'internal', error: 'boom' }),
      });

      const error = await readSearchStream(source).catch((err) => err);

      expect(error).toBeInstanceOf(SearchApiError);
      expect(error).not.toBeInstanceOf(SearchApiUnavailableError);
    });

    it.each([404, 405, 501])('treats HTTP %i as the search API being absent', async (status) => {
      const source = chunkSource([], {
        ok: false,
        status,
        statusText: 'Not Found',
        json: async () => {
          throw new Error('not json');
        },
      });

      await expect(readSearchStream(source)).rejects.toBeInstanceOf(SearchApiUnavailableError);
    });

    it('falls back to the status text when the error body is not JSON', async () => {
      const source = chunkSource([], {
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new Error('not json');
        },
      });

      await expect(readSearchStream(source)).rejects.toMatchObject({ message: 'Bad Gateway' });
    });
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
