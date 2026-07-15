import { BehaviorSubject, Subject } from 'rxjs';

import {
  dateTime,
  LiveChannelConnectionState,
  LiveChannelEventType,
  type LiveChannelEvent,
  type TimeRange,
} from '@grafana/data';
import { getGrafanaLiveSrv } from '@grafana/runtime';

import { DEFAULT_SERIES_LIMIT } from './constants';
import { type PrometheusDatasource } from './datasource';
import { SearchApiClient } from './resource_clients';
import { PrometheusCacheLevel } from './types';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getGrafanaLiveSrv: jest.fn(),
}));

const mockGetGrafanaLiveSrv = getGrafanaLiveSrv as jest.Mock;

const mockTimeRange: TimeRange = {
  from: dateTime(1681300292392),
  to: dateTime(1681300293392),
  raw: { from: 'now-1s', to: 'now' },
};

interface Frame {
  requestId: string;
  slotId?: string;
  type: 'batch' | 'terminal' | 'error';
  results?: Array<Record<string, unknown>>;
  warnings?: string[];
  hasMore?: boolean;
  error?: string;
}

function messageEvent(frame: Frame): LiveChannelEvent<Frame> {
  return { type: LiveChannelEventType.Message, message: frame };
}

function connectedEvent(): LiveChannelEvent<Frame> {
  return {
    type: LiveChannelEventType.Status,
    id: 'ds/ds-uid/search/test',
    timestamp: Date.now(),
    state: LiveChannelConnectionState.Connected,
  };
}

function disconnectedEvent(): LiveChannelEvent<Frame> {
  return {
    type: LiveChannelEventType.Status,
    id: 'ds/ds-uid/search/test',
    timestamp: Date.now(),
    state: LiveChannelConnectionState.Disconnected,
  };
}

function makeDatasource(overrides: Partial<PrometheusDatasource> = {}): PrometheusDatasource {
  return {
    uid: 'ds-uid',
    cacheLevel: PrometheusCacheLevel.None,
    seriesLimit: DEFAULT_SERIES_LIMIT,
    getAdjustedInterval: jest.fn().mockReturnValue({ start: '1681300260', end: '1681300320' }),
    getTimeRangeParams: jest.fn().mockReturnValue({ start: '1681300260', end: '1681300320' }),
    interpolateString: jest.fn((s: string) => s),
    hasLabelsMatchAPISupport: jest.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as PrometheusDatasource;
}

describe('SearchApiClient', () => {
  let stream$: Subject<LiveChannelEvent<Frame>>;
  let publish: jest.Mock;
  let getStream: jest.Mock;
  const mockRequest = jest.fn().mockResolvedValue([]);

  beforeEach(() => {
    jest.clearAllMocks();
    stream$ = new BehaviorSubject<LiveChannelEvent<Frame>>(connectedEvent());
    publish = jest.fn().mockResolvedValue(undefined);
    getStream = jest.fn().mockImplementation(() => stream$.asObservable());
    mockGetGrafanaLiveSrv.mockReturnValue({ getStream, publish });
  });

  const lastPayload = () => publish.mock.calls.at(-1)![1];

  it('subscribes to the Live channel exactly once across multiple searches', async () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());
    expect(getStream).toHaveBeenCalledTimes(1);
    const addr = getStream.mock.calls[0][0];
    expect(addr.scope).toBe('ds');
    expect(addr.path).toMatch(
      /^search\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    const p1 = client.queryLabelKeys(mockTimeRange);
    const r1 = lastPayload().requestId;
    stream$.next(messageEvent({ requestId: r1, type: 'terminal' }));
    await p1;

    const p2 = client.queryMetrics(mockTimeRange);
    const r2 = lastPayload().requestId;
    stream$.next(messageEvent({ requestId: r2, type: 'terminal' }));
    await p2;

    // Still only one subscription despite two searches.
    expect(getStream).toHaveBeenCalledTimes(1);
  });

  it('uses the authenticated HTTP fallback when a secure channel nonce is unavailable', async () => {
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    try {
      mockRequest.mockResolvedValueOnce(['label']);
      const client = new SearchApiClient(mockRequest, makeDatasource());

      expect(getStream).not.toHaveBeenCalled();
      await expect(client.queryLabelKeys(mockTimeRange)).resolves.toEqual(['label']);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      if (cryptoDescriptor) {
        Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'crypto');
      }
    }
  });

  it('publishes a well-formed payload for label values (label + alpha sort, case-insensitive)', async () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());
    const p = client.queryLabelValues(mockTimeRange, 'job');
    const payload = lastPayload();
    expect(payload.endpoint).toBe('label_values');
    expect(payload.requestId).toBeTruthy();
    expect(payload.slotId).toBe('labelValues-job');
    expect(payload.params.label).toEqual(['job']);
    expect(payload.params.sort_by).toEqual(['alpha']);
    expect(payload.params.case_sensitive).toEqual(['false']);
    expect(payload.params['search[]']).toBeUndefined();

    stream$.next(messageEvent({ requestId: payload.requestId, type: 'terminal' }));
    await p;
  });

  it('publishes requests over the subscribed websocket for HA node affinity', () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());

    client.searchMetricNames(mockTimeRange, { search: 'up' }).subscribe();

    expect(publish).toHaveBeenCalledWith(expect.anything(), expect.anything(), { useSocket: true });
  });

  it('waits for the Live channel to connect before the first publish', async () => {
    stream$ = new Subject<LiveChannelEvent<Frame>>();
    const client = new SearchApiClient(mockRequest, makeDatasource());

    client.searchMetricNames(mockTimeRange, { search: 'up' }).subscribe();
    expect(publish).not.toHaveBeenCalled();

    stream$.next(connectedEvent());
    await Promise.resolve();

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the Live channel does not become ready', async () => {
    jest.useFakeTimers();
    try {
      stream$ = new Subject<LiveChannelEvent<Frame>>();
      const client = new SearchApiClient(mockRequest, makeDatasource());

      client.searchMetricNames(mockTimeRange, { search: 'up' }).subscribe();
      await jest.advanceTimersByTimeAsync(5000);

      expect(publish).not.toHaveBeenCalled();
      client.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clamps the streaming limit to the search default (never the 40k series limit)', () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());
    // Caller passes the large series limit (40000); streaming must cap it at 10000.
    client.searchMetricNames(mockTimeRange, { search: 'up', limit: DEFAULT_SERIES_LIMIT }).subscribe();
    expect(lastPayload().params.limit).toEqual(['10000']);

    // An explicit smaller limit is honored as-is.
    client.searchMetricNames(mockTimeRange, { search: 'up', limit: 25 }).subscribe();
    expect(lastPayload().params.limit).toEqual(['25']);

    // No explicit limit -> the search default (10000).
    client.searchMetricNames(mockTimeRange, { search: 'up' }).subscribe();
    expect(lastPayload().params.limit).toEqual(['10000']);

    // Unlimited semantics are rejected for interactive multi-tenant search.
    client.searchMetricNames(mockTimeRange, { search: 'up', limit: 0 }).subscribe();
    expect(lastPayload().params.limit).toEqual(['10000']);
  });

  it('uses score sort + search[] + fuzz params when a search term is present', () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());
    client.searchMetricNames(mockTimeRange, { search: 'up' }).subscribe();
    const payload = lastPayload();
    expect(payload.endpoint).toBe('metric_names');
    expect(payload.params['search[]']).toEqual(['up']);
    expect(payload.params.sort_by).toEqual(['score']);
    expect(payload.params.fuzz_alg).toEqual(['subsequence']);
    expect(payload.params.fuzz_threshold).toEqual(['50']);
  });

  it('resolves drop-in queries on the terminal frame, preserving server order and de-duplicating', async () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());
    const p = client.queryLabelKeys(mockTimeRange);
    const rid = lastPayload().requestId;

    stream$.next(messageEvent({ requestId: rid, type: 'batch', results: [{ name: 'zeta' }, { name: 'alpha' }] }));
    stream$.next(messageEvent({ requestId: rid, type: 'batch', results: [{ name: 'alpha' }, { name: 'beta' }] }));
    stream$.next(messageEvent({ requestId: rid, type: 'terminal', hasMore: false }));

    await expect(p).resolves.toEqual(['zeta', 'alpha', 'beta']);
  });

  it('ignores the echoed publish request (Grafana Live broadcasts our own payload back)', async () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());
    const p = client.queryLabelKeys(mockTimeRange);
    const payload = lastPayload();

    // Centrifuge echoes the client's own publish payload ({requestId, slotId, endpoint,
    // params} — no `type`) to all subscribers before the real response frames arrive.
    // It must not settle the promise (previously it hit the error branch and resolved []).
    stream$.next({ type: LiveChannelEventType.Message, message: payload });
    stream$.next(messageEvent({ requestId: payload.requestId, type: 'batch', results: [{ name: 'real_metric' }] }));
    stream$.next(messageEvent({ requestId: payload.requestId, type: 'terminal' }));

    await expect(p).resolves.toEqual(['real_metric']);
  });

  it('ignores stale frames whose requestId is not the active one', async () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());
    const p = client.queryLabelKeys(mockTimeRange);
    const rid = lastPayload().requestId;

    // Stale frame from a superseded request must be ignored.
    stream$.next(messageEvent({ requestId: 'stale-id', type: 'batch', results: [{ name: 'should-not-appear' }] }));
    stream$.next(messageEvent({ requestId: rid, type: 'batch', results: [{ name: 'real' }] }));
    stream$.next(messageEvent({ requestId: rid, type: 'terminal' }));

    await expect(p).resolves.toEqual(['real']);
  });

  it('resolves drop-in queries with the partial snapshot on an error frame (never rejects)', async () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());
    const p = client.queryMetrics(mockTimeRange);
    const rid = lastPayload().requestId;

    stream$.next(messageEvent({ requestId: rid, type: 'batch', results: [{ name: 'partial_metric' }] }));
    stream$.next(messageEvent({ requestId: rid, type: 'error', error: 'boom' }));

    const result = await p;
    expect(result.metrics).toEqual(['partial_metric']);
  });

  it('does not cache a partial response terminated by an error', async () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());
    const first = client.queryLabelKeys(mockTimeRange);
    const firstRequestId = lastPayload().requestId;
    stream$.next(messageEvent({ requestId: firstRequestId, type: 'batch', results: [{ name: 'partial' }] }));
    stream$.next(messageEvent({ requestId: firstRequestId, type: 'error', error: 'failed' }));
    await expect(first).resolves.toEqual(['partial']);

    const second = client.queryLabelKeys(mockTimeRange);
    const secondRequestId = lastPayload().requestId;
    expect(secondRequestId).not.toBe(firstRequestId);
    stream$.next(messageEvent({ requestId: secondRequestId, type: 'terminal' }));
    await second;
  });

  it('emits accumulating results progressively then completes on the terminal frame', () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());
    const emissions: string[][] = [];
    let completed = false;

    client.searchLabelValues(mockTimeRange, 'instance', { search: 'web' }).subscribe({
      next: (v) => emissions.push(v),
      complete: () => {
        completed = true;
      },
    });
    const rid = lastPayload().requestId;

    stream$.next(messageEvent({ requestId: rid, type: 'batch', results: [{ value: 'web-1' }] }));
    stream$.next(messageEvent({ requestId: rid, type: 'batch', results: [{ value: 'web-2' }] }));
    stream$.next(messageEvent({ requestId: rid, type: 'terminal' }));

    expect(emissions).toEqual([['web-1'], ['web-1', 'web-2'], ['web-1', 'web-2']]);
    expect(completed).toBe(true);
  });

  it('falls back to the labels/series client when Grafana Live is unavailable', async () => {
    mockGetGrafanaLiveSrv.mockReturnValue(undefined);
    const client = new SearchApiClient(mockRequest, makeDatasource());

    mockRequest.mockResolvedValueOnce(['l2', 'l1']);
    const keys = await client.queryLabelKeys(mockTimeRange);

    // Fallback (LabelsApiClient) hits the HTTP request path and sorts; publish never used.
    expect(keys).toEqual(['l1', 'l2']);
    expect(publish).not.toHaveBeenCalled();
  });

  it('settles a Promise search through authenticated HTTP when publish rejects', async () => {
    publish.mockRejectedValueOnce(new Error('socket closed'));
    mockRequest.mockResolvedValueOnce(['fallback-label']);
    const client = new SearchApiClient(mockRequest, makeDatasource());

    await expect(client.queryLabelKeys(mockTimeRange)).resolves.toEqual(['fallback-label']);
    expect(mockRequest).toHaveBeenCalledWith('/api/v1/labels', expect.anything(), undefined);
  });

  it('completes a progressive search through HTTP when publish rejects', async () => {
    publish.mockRejectedValueOnce(new Error('socket closed'));
    mockRequest.mockResolvedValueOnce(['fallback-value']);
    const client = new SearchApiClient(mockRequest, makeDatasource());

    await expect(
      new Promise<string[]>((resolve) => {
        client.searchLabelValues(mockTimeRange, 'job', { search: 'graf' }).subscribe({
          next: resolve,
        });
      })
    ).resolves.toEqual(['fallback-value']);
  });

  it('settles an active Promise through HTTP when Live disconnects', async () => {
    mockRequest.mockResolvedValueOnce(['after-disconnect']);
    const client = new SearchApiClient(mockRequest, makeDatasource());
    const result = client.queryLabelKeys(mockTimeRange);

    stream$.next(disconnectedEvent());

    await expect(result).resolves.toEqual(['after-disconnect']);
  });

  it('completes progressive search through HTTP when readiness times out', async () => {
    jest.useFakeTimers();
    try {
      stream$ = new Subject<LiveChannelEvent<Frame>>();
      mockRequest.mockResolvedValueOnce(['ready-timeout-fallback']);
      const client = new SearchApiClient(mockRequest, makeDatasource());
      const result = new Promise<string[]>((resolve) => {
        client.searchLabelNames(mockTimeRange, { search: 'job' }).subscribe({ next: resolve });
      });

      await jest.advanceTimersByTimeAsync(5000);

      await expect(result).resolves.toEqual(['ready-timeout-fallback']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels timers and fallback work when a progressive caller unsubscribes', async () => {
    jest.useFakeTimers();
    try {
      const client = new SearchApiClient(mockRequest, makeDatasource());
      const subscription = client.searchMetricNames(mockTimeRange, { search: 'up' }).subscribe();

      subscription.unsubscribe();
      await jest.advanceTimersByTimeAsync(15000);

      expect(mockRequest).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
