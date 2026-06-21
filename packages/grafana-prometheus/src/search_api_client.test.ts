import { Subject } from 'rxjs';

import { dateTime, LiveChannelEventType, type LiveChannelEvent, type TimeRange } from '@grafana/data';
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
    stream$ = new Subject<LiveChannelEvent<Frame>>();
    publish = jest.fn().mockResolvedValue(undefined);
    getStream = jest.fn().mockReturnValue(stream$.asObservable());
    mockGetGrafanaLiveSrv.mockReturnValue({ getStream, publish });
  });

  const lastPayload = () => publish.mock.calls.at(-1)![1];

  it('subscribes to the Live channel exactly once across multiple searches', async () => {
    const client = new SearchApiClient(mockRequest, makeDatasource());
    expect(getStream).toHaveBeenCalledTimes(1);
    const addr = getStream.mock.calls[0][0];
    expect(addr.scope).toBe('ds');
    expect(addr.path).toMatch(/^search\//);

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
});
