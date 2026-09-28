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

  it('tracks current and peak queue usage', async () => {
    chunkedMock.mockReturnValue(chunkedStream(['one', 'second']));

    const { source, stats } = await bridgeChunkedResponse(request);

    expect(stats).toEqual({
      queuedBytes: 9,
      queuedChunks: 2,
      peakQueuedBytes: 9,
      peakQueuedChunks: 2,
    });

    await source.read();
    expect(stats).toMatchObject({ queuedBytes: 6, queuedChunks: 1 });

    await readAll(source);
    expect(stats).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  it('unsubscribes and fails when queued bytes exceed the high-water mark', async () => {
    const subject = manualStream();
    chunkedMock.mockReturnValue(subject.observable);

    const bridged = bridgeChunkedResponse(request, undefined, { maxQueuedBytes: 5 });
    subject.emit('1234');
    const { source, stats } = await bridged;
    subject.emit('56');

    await expect(source.read()).rejects.toThrow(/queue exceeded its limit/i);
    expect(subject.unsubscribe).toHaveBeenCalled();
    expect(stats).toMatchObject({ queuedBytes: 0, queuedChunks: 0, peakQueuedBytes: 4 });
  });

  it('preserves an overflow error when the stream emits synchronously', async () => {
    chunkedMock.mockReturnValue(chunkedStream(['1234', '56']));

    const { source, stats } = await bridgeChunkedResponse(request, undefined, { maxQueuedBytes: 5 });

    await expect(source.read()).rejects.toThrow(/queue exceeded its limit/i);
    expect(stats).toMatchObject({ queuedBytes: 0, queuedChunks: 0, peakQueuedBytes: 4 });
  });

  it('unsubscribes and fails when queued chunks exceed the high-water mark', async () => {
    const subject = manualStream();
    chunkedMock.mockReturnValue(subject.observable);

    const bridged = bridgeChunkedResponse(request, undefined, { maxQueuedChunks: 1 });
    subject.emit('first');
    const { source } = await bridged;
    subject.emit('second');

    await expect(source.read()).rejects.toThrow(/queue exceeded its limit/i);
    expect(subject.unsubscribe).toHaveBeenCalled();
  });

  it('accepts queue usage exactly at both high-water marks', async () => {
    const subject = manualStream();
    chunkedMock.mockReturnValue(subject.observable);

    const bridged = bridgeChunkedResponse(request, undefined, { maxQueuedBytes: 6, maxQueuedChunks: 2 });
    subject.emit('1234');
    const { source, stats } = await bridged;
    subject.emit('56');

    expect(stats).toMatchObject({ queuedBytes: 6, queuedChunks: 2 });
    await source.read();
    await source.read();
    expect(stats).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
    expect(subject.unsubscribe).not.toHaveBeenCalled();
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

  it('clears queued data when the signal aborts', async () => {
    const subject = manualStream();
    chunkedMock.mockReturnValue(subject.observable);
    const controller = new AbortController();

    const bridged = bridgeChunkedResponse(request, controller.signal);
    subject.emit('queued');
    const { source, stats } = await bridged;
    expect(stats).toMatchObject({ queuedBytes: 6, queuedChunks: 1 });

    controller.abort();

    await expect(source.read()).rejects.toThrow(/aborted/i);
    expect(stats).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
    expect(subject.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects a synchronous stream when the signal is already aborted', async () => {
    chunkedMock.mockReturnValue(chunkedStream(['queued']));
    const controller = new AbortController();
    controller.abort();

    const { source, stats } = await bridgeChunkedResponse(request, controller.signal);

    await expect(source.read()).rejects.toThrow(/aborted/i);
    expect(stats).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
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
  const unsubscribe = jest.fn();
  let subscriber: { next: (value: FetchResponse<Uint8Array | undefined>) => void; error: (err: unknown) => void };
  const observable = new Observable<FetchResponse<Uint8Array | undefined>>((sub) => {
    subscriber = sub;
    return unsubscribe;
  });
  return {
    observable,
    emit: (chunk: string) => subscriber.next({ ...chunkedResponseBase(), data: encoder.encode(chunk) }),
    fail: (err: unknown) => subscriber.error(err),
    unsubscribe,
  };
}
