import { Observable } from 'rxjs';

import { type BackendSrvRequest, type FetchResponse, getBackendSrv, setBackendSrv } from '@grafana/runtime';

import { SearchApiUnavailableError } from './search_api_stream';
import { bridgeChunkedResponse } from './search_api_transport';
import { chunkedResponseBase, chunkedStream } from './test/mocks/chunked';

const request: BackendSrvRequest = { url: 'api/datasources/uid/prom/resources/api/v1/search/metric_names' };

const decoder = new TextDecoder();

describe('bridgeChunkedResponse', () => {
  const originalBackendSrv = getBackendSrv();
  const chunkedMock = jest.fn();

  beforeEach(() => {
    setBackendSrv({ ...originalBackendSrv, chunked: chunkedMock });
  });

  afterEach(() => {
    setBackendSrv(originalBackendSrv);
    jest.clearAllMocks();
  });

  it('replays chunks that arrived before the first read', async () => {
    // chunkedStream emits everything synchronously on subscribe, so the source
    // is only handed back once all chunks are already queued.
    chunkedMock.mockReturnValue(chunkedStream(['first', 'second']));

    const { source } = await bridgeChunkedResponse(request);

    await expect(readAll(source)).resolves.toBe('firstsecond');
    expect(source).toMatchObject({ ok: true, status: 200, statusText: 'OK' });
  });

  it('resolves a pending read once the next chunk is pushed', async () => {
    const subject = manualStream();
    chunkedMock.mockReturnValue(subject.observable);

    const bridged = bridgeChunkedResponse(request);
    subject.emit('first');
    const { source } = await bridged;
    // Drain the queued chunk so the next read has nothing buffered and must wait.
    await source.read();

    const pending = source.read();
    subject.emit('second');

    const { done, value } = await pending;

    expect(done).toBe(false);
    expect(decoder.decode(value)).toBe('second');
  });

  it('reports done when the stream completes without a final empty chunk', async () => {
    chunkedMock.mockReturnValue(chunkedStream(['only'], { omitFinalChunk: true }));

    const { source } = await bridgeChunkedResponse(request);

    await expect(readAll(source)).resolves.toBe('only');
  });

  it('rejects the bridge when the request fails before any chunk arrives', async () => {
    chunkedMock.mockReturnValue(
      new Observable<FetchResponse<Uint8Array | undefined>>((subscriber) => subscriber.error(new Error('network down')))
    );

    await expect(bridgeChunkedResponse(request)).rejects.toThrow('network down');
  });

  it('surfaces an error that arrives after the first chunk on the next read', async () => {
    const subject = manualStream();
    chunkedMock.mockReturnValue(subject.observable);

    const bridged = bridgeChunkedResponse(request);
    subject.emit('partial');
    const { source } = await bridged;
    await source.read();

    subject.fail(new Error('connection reset'));

    await expect(source.read()).rejects.toThrow('connection reset');
  });

  it('unsubscribes and rejects when the signal aborts', async () => {
    const unsubscribe = jest.fn();
    chunkedMock.mockReturnValue(
      // Never emits; simulates a long-running request that only ends via unsubscribe.
      new Observable<FetchResponse<Uint8Array | undefined>>(() => unsubscribe)
    );
    const controller = new AbortController();

    const bridged = bridgeChunkedResponse(request, controller.signal);
    controller.abort();

    await expect(bridged).rejects.toThrow(/aborted/i);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('assembles the error body through the same read path', async () => {
    chunkedMock.mockReturnValue(
      chunkedStream(['{"status":"error","errorType":"unav', 'ailable","error":"search API disabled"}'], {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })
    );

    const { source } = await bridgeChunkedResponse(request);

    await expect(source.json()).resolves.toEqual({
      status: 'error',
      errorType: 'unavailable',
      error: 'search API disabled',
    });
  });

  it('reports the search API as unavailable when the host predates chunked()', async () => {
    setBackendSrv({ ...originalBackendSrv, chunked: undefined as unknown as typeof chunkedMock });

    await expect(bridgeChunkedResponse(request)).rejects.toBeInstanceOf(SearchApiUnavailableError);
    expect(chunkedMock).not.toHaveBeenCalled();
  });
});

async function readAll(source: { read: () => Promise<{ done: boolean; value?: Uint8Array }> }): Promise<string> {
  let text = '';
  while (true) {
    const { done, value } = await source.read();
    if (value) {
      text += decoder.decode(value, { stream: true });
    }
    if (done) {
      return text + decoder.decode();
    }
  }
}

// A chunked() double whose emissions are driven by the test, so a read() can be
// left pending across an emission or a mid-stream error.
function manualStream() {
  const encoder = new TextEncoder();
  let subscriber: { next: (value: FetchResponse<Uint8Array | undefined>) => void; error: (err: unknown) => void };
  const observable = new Observable<FetchResponse<Uint8Array | undefined>>((sub) => {
    subscriber = sub;
  });
  return {
    observable,
    emit: (chunk: string) => subscriber.next({ ...chunkedResponseBase(), data: encoder.encode(chunk) }),
    fail: (err: unknown) => subscriber.error(err),
  };
}
