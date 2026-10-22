import { type BackendSrvRequest, getBackendSrv } from '@grafana/runtime';

import { type SearchChunkSource, SearchApiError, SearchApiUnavailableError } from './search_api_stream';

export const MAX_SEARCH_QUEUE_BYTES = 64 * 1024 * 1024;
export const MAX_SEARCH_QUEUE_CHUNKS = 1_024;

export interface SearchTransportStats {
  queuedBytes: number;
  queuedChunks: number;
  peakQueuedBytes: number;
  peakQueuedChunks: number;
}

export interface SearchQueueLimits {
  maxQueuedBytes?: number;
  maxQueuedChunks?: number;
}

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
  signal?: AbortSignal,
  limits: SearchQueueLimits = {}
): Promise<{ source: SearchChunkSource; cancel: () => void; stats: SearchTransportStats }> {
  const backendSrv = getBackendSrv();
  // chunked() arrived in Grafana 11.6.0. On an older host the Search API
  // cannot be reached at all, which is a capability signal rather than a
  // failure, so callers may fall back to standard Prometheus discovery.
  if (typeof backendSrv.chunked !== 'function') {
    throw new SearchApiUnavailableError('Search API requires Grafana 11.6.0 or later');
  }

  const queue: QueuedChunk[] = [];
  const stats: SearchTransportStats = {
    queuedBytes: 0,
    queuedChunks: 0,
    peakQueuedBytes: 0,
    peakQueuedChunks: 0,
  };
  const maxQueuedBytes = limits.maxQueuedBytes ?? MAX_SEARCH_QUEUE_BYTES;
  const maxQueuedChunks = limits.maxQueuedChunks ?? MAX_SEARCH_QUEUE_CHUNKS;
  let waiting: { resolve: (chunk: QueuedChunk) => void; reject: (err: unknown) => void } | undefined;
  let terminalError: unknown;
  let hasTerminalError = false;
  let subscription: { unsubscribe: () => void } | undefined;
  let unsubscribeRequested = false;
  let terminal = false;

  const unsubscribe = () => {
    if (subscription) {
      subscription.unsubscribe();
    } else {
      unsubscribeRequested = true;
    }
  };

  const read = (): Promise<QueuedChunk> => {
    if (queue.length > 0) {
      const chunk = queue.shift()!;
      stats.queuedBytes -= chunk.value?.byteLength ?? 0;
      stats.queuedChunks -= chunk.done ? 0 : 1;
      return Promise.resolve(chunk);
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

  const deliver = (chunk: QueuedChunk) => {
    if (terminal) {
      return;
    }
    if (waiting) {
      const pending = waiting;
      waiting = undefined;
      pending.resolve(chunk);
    } else {
      const chunkBytes = chunk.value?.byteLength ?? 0;
      const chunkCount = chunk.done ? 0 : 1;
      const queuedBytes = stats.queuedBytes + chunkBytes;
      const queuedChunks = stats.queuedChunks + chunkCount;
      if (queuedBytes > maxQueuedBytes || queuedChunks > maxQueuedChunks) {
        terminal = true;
        queue.length = 0;
        stats.queuedBytes = 0;
        stats.queuedChunks = 0;
        unsubscribe();
        fail(
          new SearchApiError(
            `Search stream queue exceeded its limit (${queuedBytes} bytes, ${queuedChunks} chunks)`
          )
        );
        return;
      }
      queue.push(chunk);
      stats.queuedBytes = queuedBytes;
      stats.queuedChunks = queuedChunks;
      stats.peakQueuedBytes = Math.max(stats.peakQueuedBytes, queuedBytes);
      stats.peakQueuedChunks = Math.max(stats.peakQueuedChunks, queuedChunks);
    }
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let sawDone = false;

    subscription = backendSrv.chunked(request).subscribe({
      next: (response) => {
        if (!settled) {
          settled = true;
          resolve({
            source: { ok: response.ok, status: response.status, statusText: response.statusText, read, json },
            cancel: unsubscribe,
            stats,
          });
        }
        sawDone ||= response.data === undefined;
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
            cancel: unsubscribe,
            stats,
          });
        }
        // Defensive: chunked() always emits a final `data: undefined` chunk
        // before completing, but any Observable meeting the same contract
        // (e.g. a test double) may complete without one.
        if (!sawDone) {
          deliver({ done: true });
        }
      },
    });
    if (unsubscribeRequested) {
      subscription.unsubscribe();
    }

    if (!signal) {
      return;
    }

    const onAbort = () => {
      terminal = true;
      queue.length = 0;
      stats.queuedBytes = 0;
      stats.queuedChunks = 0;
      unsubscribe();
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
