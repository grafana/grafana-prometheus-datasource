import { Observable } from 'rxjs';

import { type BackendSrvRequest, type FetchResponse } from '@grafana/runtime';

// Builds a fake getBackendSrv().chunked() Observable that mirrors the real
// contract: one next() per chunk (each carrying the invariant ok/status
// fields), a final next() with `data: undefined`, then complete().
export function chunkedStream(
  chunks: string[],
  opts: { ok?: boolean; status?: number; statusText?: string; omitFinalChunk?: boolean } = {}
): Observable<FetchResponse<Uint8Array | undefined>> {
  const encoder = new TextEncoder();
  const { ok = true, status = 200, statusText = 'OK', omitFinalChunk = false } = opts;
  return new Observable<FetchResponse<Uint8Array | undefined>>((subscriber) => {
    for (const chunk of chunks) {
      subscriber.next({ ...chunkedResponseBase({ ok, status, statusText }), data: encoder.encode(chunk) });
    }
    if (!omitFinalChunk) {
      subscriber.next({ ...chunkedResponseBase({ ok, status, statusText }), data: undefined });
    }
    subscriber.complete();
  });
}

// The invariant fields every chunk of a chunked() response carries; exported so
// tests driving a subscriber by hand emit the same shape.
export function chunkedResponseBase({
  ok = true,
  status = 200,
  statusText = 'OK',
}: { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok,
    status,
    statusText,
    headers: new Headers(),
    url: '',
    type: 'basic' as ResponseType,
    redirected: false,
    config: {} as BackendSrvRequest,
  };
}
