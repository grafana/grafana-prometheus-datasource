import { type BackendSrvRequest, getBackendSrv } from '@grafana/runtime';

import { type SearchChunkSource, SearchApiUnavailableError } from './search_api_stream';

interface QueuedChunk {
  done: boolean;
  value?: Uint8Array;
}

// getBackendSrv().chunked() is push-based (an Observable that calls next()
// once per reader.read() result, mirroring `{ done, value }`, with a final
// next({ data: undefined }) before complete()). readSearchStream is
// pull-based. This bridges the two without buffering the whole body: each
// read() call either drains an already-arrived chunk or waits for the next
// one to be pushed in. Consumers only ever have one read() in flight, so a
// single pending waiter is enough (no queue of readers needed).
export async function bridgeChunkedResponse(
  request: BackendSrvRequest,
  signal?: AbortSignal
): Promise<{ source: SearchChunkSource; cancel: () => void }> {
  const backendSrv = getBackendSrv();
  // chunked() arrived in Grafana 11.6.0. On an older host the Search API
  // cannot be reached at all, which is a capability signal rather than a
  // failure, so callers may fall back to legacy discovery.
  if (typeof backendSrv.chunked !== 'function') {
    throw new SearchApiUnavailableError('Search API requires Grafana 11.6.0 or later');
  }

  const queue: QueuedChunk[] = [];
  let waiting: { resolve: (chunk: QueuedChunk) => void; reject: (err: unknown) => void } | undefined;
  let terminalError: unknown;
  let hasTerminalError = false;

  const read = (): Promise<QueuedChunk> => {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift()!);
    }
    if (hasTerminalError) {
      hasTerminalError = false;
      return Promise.reject(terminalError);
    }
    return new Promise<QueuedChunk>((resolve, reject) => {
      waiting = { resolve, reject };
    });
  };

  // The error branch of readSearchStream needs the fully assembled body, so
  // this drains the (typically small) error payload through the same read()
  // path rather than requiring a separate buffered accessor on the source.
  const json = async (): Promise<unknown> => {
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const chunk = await read();
      if (chunk.value) {
        text += decoder.decode(chunk.value, { stream: true });
      }
      if (chunk.done) {
        break;
      }
    }
    return JSON.parse(text + decoder.decode());
  };

  const deliver = (chunk: QueuedChunk) => {
    if (waiting) {
      const pending = waiting;
      waiting = undefined;
      pending.resolve(chunk);
    } else {
      queue.push(chunk);
    }
  };

  const fail = (err: unknown) => {
    if (waiting) {
      const pending = waiting;
      waiting = undefined;
      pending.reject(err);
    } else {
      terminalError = err;
      hasTerminalError = true;
    }
  };

  return new Promise((resolve, reject) => {
    let settled = false;

    const subscription = backendSrv.chunked(request).subscribe({
      next: (response) => {
        if (!settled) {
          settled = true;
          resolve({
            source: { ok: response.ok, status: response.status, statusText: response.statusText, read, json },
            cancel: () => subscription.unsubscribe(),
          });
        }
        deliver({ done: response.data === undefined, value: response.data });
      },
      error: (err) => {
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        fail(err);
      },
      complete: () => {
        if (!settled) {
          settled = true;
          resolve({
            source: { ok: true, status: 200, statusText: 'OK', read, json },
            cancel: () => subscription.unsubscribe(),
          });
        }
        // Defensive: chunked() always emits a final `data: undefined` chunk
        // before completing, but any Observable meeting the same contract
        // (e.g. a test double) may complete without one.
        deliver({ done: true });
      },
    });

    if (!signal) {
      return;
    }

    const onAbort = () => {
      subscription.unsubscribe();
      const abortError = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
      if (!settled) {
        settled = true;
        reject(abortError);
      } else {
        fail(abortError);
      }
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
