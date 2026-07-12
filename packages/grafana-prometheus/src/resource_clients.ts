import { Observable, Subject, type Subscription, filter } from 'rxjs';

import {
  isLiveChannelMessageEvent,
  isLiveChannelStatusEvent,
  type LiveChannelAddress,
  LiveChannelConnectionState,
  LiveChannelScope,
  type TimeRange,
} from '@grafana/data';
import { type BackendSrvRequest, getGrafanaLiveSrv } from '@grafana/runtime';

import { getDefaultCacheHeaders } from './caching';
import {
  DEFAULT_SERIES_LIMIT,
  EMPTY_SELECTOR,
  MATCH_ALL_LABELS,
  METRIC_LABEL,
  SEARCH_API_DEFAULTS,
  SEARCH_ENDPOINTS,
  type SearchEndpoint,
} from './constants';
import { type PrometheusDatasource } from './datasource';
import { getRangeSnapInterval, processHistogramMetrics, removeQuotesIfExist } from './language_utils';
import { buildVisualQueryFromString } from './querybuilder/parsing';
import { PrometheusCacheLevel } from './types';
import { escapeForUtf8Support, utf8Support } from './utf8_support';

type PrometheusSeriesResponse = Array<{ [key: string]: string }>;
type PrometheusLabelsResponse = string[];

export interface ResourceApiClient {
  metrics: string[];
  histogramMetrics: string[];
  labelKeys: string[];
  cachedLabelValues: Record<string, string[]>;

  start: (timeRange: TimeRange) => Promise<void>;

  queryMetrics: (timeRange: TimeRange) => Promise<{ metrics: string[]; histogramMetrics: string[] }>;
  queryLabelKeys: (timeRange: TimeRange, match?: string, limit?: number) => Promise<string[]>;
  queryLabelValues: (timeRange: TimeRange, labelKey: string, match?: string, limit?: number) => Promise<string[]>;

  querySeries: (timeRange: TimeRange, match: string, limit: number) => Promise<PrometheusSeriesResponse>;
}

/**
 * Options for the search-term-aware (fuzzy, scored) methods exposed by the SearchApiClient.
 */
export interface SearchOptions {
  /** Free-text term routed to the upstream `search[]` param. */
  search?: string;
  /** PromQL selector(s) routed to `match[]`. */
  match?: string;
  limit?: number;
  /** Stable per-widget identifier used for backend cancel-previous scoping. */
  slotId?: string;
}

/**
 * Extends ResourceApiClient with progressive, server-side search methods. These return
 * Observables that emit accumulating results as NDJSON batches stream in, completing on
 * the terminal frame.
 */
export interface SearchCapableClient extends ResourceApiClient {
  searchMetricNames: (timeRange: TimeRange, options: SearchOptions) => Observable<string[]>;
  searchLabelNames: (timeRange: TimeRange, options: SearchOptions) => Observable<string[]>;
  searchLabelValues: (timeRange: TimeRange, labelKey: string, options: SearchOptions) => Observable<string[]>;
}

/**
 * Type guard for whether a resource client supports the progressive search methods.
 */
export function isSearchCapableClient(client: ResourceApiClient): client is SearchCapableClient {
  return typeof (client as SearchCapableClient).searchMetricNames === 'function';
}

/**
 * Wire shape of a single frame sent by the Go RunStream loop over the Live channel,
 * tagged with the originating requestId so the client can correlate and discard stale
 * frames.
 */
interface SearchFrame {
  requestId: string;
  slotId?: string;
  type: 'batch' | 'terminal' | 'error';
  results?: Array<Record<string, unknown>>;
  warnings?: string[];
  hasMore?: boolean;
  error?: string;
  errorType?: string;
}

type RequestFn = (
  url: string,
  params?: Record<string, unknown>,
  options?: Partial<BackendSrvRequest>
) => Promise<unknown>;

export abstract class BaseResourceClient {
  private seriesLimit: number;

  constructor(
    protected readonly request: RequestFn,
    protected readonly datasource: PrometheusDatasource
  ) {
    this.seriesLimit = this.datasource.seriesLimit;
  }

  /**
   * Returns the effective limit to use for API requests.
   * Uses the provided limit if specified, otherwise falls back to the datasource's configured series limit.
   * When zero is provided, it returns zero (which means no limit in Prometheus API).
   *
   * @param {number} [limit] - Optional limit parameter from the API call
   * @returns {number} The limit to use - either the provided limit or datasource's default series limit
   */
  protected getEffectiveLimit(limit?: number): number {
    return limit ?? this.seriesLimit;
  }

  protected async requestLabels(
    url: string,
    params?: Record<string, unknown>,
    options?: Partial<BackendSrvRequest>
  ): Promise<PrometheusLabelsResponse> {
    const response = await this.request(url, params, options);
    return Array.isArray(response) ? response : [];
  }

  protected async requestSeries(
    url: string,
    params?: Record<string, unknown>,
    options?: Partial<BackendSrvRequest>
  ): Promise<PrometheusSeriesResponse> {
    const response = await this.request(url, params, options);
    return Array.isArray(response) ? response : [];
  }

  /**
   * Fetches all time series that match a specific label matcher using **series** endpoint.
   *
   * @param {TimeRange} timeRange - Time range to use for the query
   * @param {string} match - Label matcher to filter time series
   * @param {string} limit - Maximum number of series to return
   */
  public querySeries = async (timeRange: TimeRange, match: string | undefined, limit: number) => {
    const effectiveMatch = !match || match === EMPTY_SELECTOR ? MATCH_ALL_LABELS : match;
    const timeParams = this.datasource.getTimeRangeParams(timeRange);
    const searchParams = { ...timeParams, 'match[]': effectiveMatch, limit };
    return await this.requestSeries('/api/v1/series', searchParams, getDefaultCacheHeaders(this.datasource.cacheLevel));
  };
}

export class LabelsApiClient extends BaseResourceClient implements ResourceApiClient {
  private _cache: ResourceClientsCache = new ResourceClientsCache(this.datasource.cacheLevel);

  public histogramMetrics: string[] = [];
  public metrics: string[] = [];
  public labelKeys: string[] = [];
  public cachedLabelValues: Record<string, string[]> = {};

  start = async (timeRange: TimeRange) => {
    await this.queryMetrics(timeRange);
    this.labelKeys = await this.queryLabelKeys(timeRange);
  };

  /**
   * Fetches all available metrics from Prometheus using the labels values endpoint for __name__.
   * Also processes and identifies histogram metrics (those ending with '_bucket').
   * Results are cached and stored in the client instance for future use.
   *
   * @param {TimeRange} timeRange - Time range to search for metrics
   * @param {number} [limit] - Optional maximum number of metrics to return, uses datasource default if not specified
   * @returns {Promise<{metrics: string[], histogramMetrics: string[]}>} Object containing all metrics and filtered histogram metrics
   */
  public queryMetrics = async (
    timeRange: TimeRange,
    limit?: number
  ): Promise<{ metrics: string[]; histogramMetrics: string[] }> => {
    const effectiveLimit = this.getEffectiveLimit(limit);
    this.metrics = await this.queryLabelValues(timeRange, METRIC_LABEL, undefined, effectiveLimit);
    this.histogramMetrics = processHistogramMetrics(this.metrics);
    this._cache.setLabelValues(timeRange, undefined, effectiveLimit, this.metrics);
    return { metrics: this.metrics, histogramMetrics: this.histogramMetrics };
  };

  /**
   * Fetches all available label keys from Prometheus using labels endpoint.
   * Uses the labels endpoint with optional match parameter for filtering.
   *
   * @param {TimeRange} timeRange - Time range to use for the query
   * @param {string} match - Optional label matcher to filter results
   * @param {string} limit - Maximum number of results to return
   * @returns {Promise<string[]>} Array of label keys sorted alphabetically
   */
  public queryLabelKeys = async (timeRange: TimeRange, match?: string, limit?: number): Promise<string[]> => {
    let url = '/api/v1/labels';
    const timeParams = getRangeSnapInterval(this.datasource.cacheLevel, timeRange);
    const effectiveLimit = this.getEffectiveLimit(limit);
    const searchParams = { limit: effectiveLimit, ...timeParams, ...(match ? { 'match[]': match } : {}) };
    const effectiveMatch = match ?? '';
    const maybeCachedKeys = this._cache.getLabelKeys(timeRange, effectiveMatch, effectiveLimit);
    if (maybeCachedKeys) {
      return maybeCachedKeys;
    }

    const res = await this.requestLabels(url, searchParams, getDefaultCacheHeaders(this.datasource.cacheLevel));
    if (Array.isArray(res)) {
      this.labelKeys = res.slice().sort();
      this._cache.setLabelKeys(timeRange, effectiveMatch, effectiveLimit, this.labelKeys);
      return this.labelKeys.slice();
    }

    return [];
  };

  /**
   * Fetches all values for a specific label key from Prometheus using labels values endpoint.
   *
   * @param {TimeRange} timeRange - Time range to use for the query
   * @param {string} labelKey - The label key to fetch values for
   * @param {string} match - Optional label matcher to filter results
   * @param {string} limit - Maximum number of results to return
   * @returns {Promise<string[]>} Array of label values
   */
  public queryLabelValues = async (
    timeRange: TimeRange,
    labelKey: string,
    match?: string,
    limit?: number
  ): Promise<string[]> => {
    const timeParams = this.datasource.getAdjustedInterval(timeRange);
    const effectiveLimit = this.getEffectiveLimit(limit);
    const searchParams = { limit: effectiveLimit, ...timeParams, ...(match ? { 'match[]': match } : {}) };
    const interpolatedName = this.datasource.interpolateString(labelKey);
    const interpolatedAndEscapedName = escapeForUtf8Support(removeQuotesIfExist(interpolatedName));
    const effectiveMatch = `${match ?? ''}-${interpolatedAndEscapedName}`;
    const maybeCachedValues = this._cache.getLabelValues(timeRange, effectiveMatch, effectiveLimit);
    if (maybeCachedValues) {
      return maybeCachedValues;
    }

    const url = `/api/v1/label/${interpolatedAndEscapedName}/values`;
    const value = await this.requestLabels(url, searchParams, getDefaultCacheHeaders(this.datasource.cacheLevel));
    this._cache.setLabelValues(timeRange, effectiveMatch, effectiveLimit, value ?? []);
    return value ?? [];
  };
}

export class SeriesApiClient extends BaseResourceClient implements ResourceApiClient {
  private _cache: ResourceClientsCache = new ResourceClientsCache(this.datasource.cacheLevel);

  public histogramMetrics: string[] = [];
  public metrics: string[] = [];
  public labelKeys: string[] = [];
  public cachedLabelValues: Record<string, string[]> = {};

  start = async (timeRange: TimeRange) => {
    await this.queryMetrics(timeRange);
  };

  public queryMetrics = async (timeRange: TimeRange): Promise<{ metrics: string[]; histogramMetrics: string[] }> => {
    const series = await this.querySeries(timeRange, undefined, DEFAULT_SERIES_LIMIT);
    const { metrics, labelKeys } = processSeries(series, METRIC_LABEL, this.datasource.hasLabelsMatchAPISupport());
    this.metrics = metrics;
    this.histogramMetrics = processHistogramMetrics(this.metrics);
    this.labelKeys = labelKeys;
    this._cache.setLabelValues(timeRange, undefined, DEFAULT_SERIES_LIMIT, metrics);
    this._cache.setLabelKeys(timeRange, undefined, DEFAULT_SERIES_LIMIT, labelKeys);
    return { metrics: this.metrics, histogramMetrics: this.histogramMetrics };
  };

  public queryLabelKeys = async (timeRange: TimeRange, match?: string, limit?: number): Promise<string[]> => {
    const effectiveLimit = this.getEffectiveLimit(limit);
    const effectiveMatch = !match || match === EMPTY_SELECTOR ? undefined : match;
    const maybeCachedKeys = this._cache.getLabelKeys(timeRange, effectiveMatch, effectiveLimit);
    if (maybeCachedKeys) {
      return maybeCachedKeys;
    }

    const series = await this.querySeries(timeRange, effectiveMatch, effectiveLimit);
    const { labelKeys } = processSeries(series, undefined, this.datasource.hasLabelsMatchAPISupport(), effectiveMatch);
    this._cache.setLabelKeys(timeRange, effectiveMatch, effectiveLimit, labelKeys);
    return labelKeys;
  };

  public queryLabelValues = async (
    timeRange: TimeRange,
    labelKey: string,
    match?: string,
    limit?: number
  ): Promise<string[]> => {
    let effectiveMatch = '';
    if (!match || match === EMPTY_SELECTOR) {
      // Just and empty matcher {} or no matcher
      effectiveMatch = `{${utf8Support(removeQuotesIfExist(labelKey))}!=""}`;
    } else {
      const {
        query: { metric, labels },
      } = buildVisualQueryFromString(match);
      labels.push({
        label: removeQuotesIfExist(labelKey),
        op: '!=',
        value: '',
      });
      const metricFilter = metric ? `__name__="${metric}",` : '';
      const labelFilters = labels.map((lf) => `${utf8Support(lf.label)}${lf.op}"${lf.value}"`).join(',');
      effectiveMatch = `{${metricFilter}${labelFilters}}`;
    }

    const effectiveLimit = this.getEffectiveLimit(limit);
    const maybeCachedValues = this._cache.getLabelValues(timeRange, effectiveMatch, effectiveLimit);
    if (maybeCachedValues) {
      return maybeCachedValues;
    }

    const series = await this.querySeries(timeRange, effectiveMatch, effectiveLimit);
    const { labelValues } = processSeries(
      series,
      removeQuotesIfExist(labelKey),
      this.datasource.hasLabelsMatchAPISupport(),
      effectiveMatch
    );
    this._cache.setLabelValues(timeRange, effectiveMatch, effectiveLimit, labelValues);
    return labelValues;
  };
}

/** How long a drop-in search promise waits before resolving with the partial snapshot. */
const SEARCH_DROP_IN_TIMEOUT_MS = 15000;
const SEARCH_LIVE_READY_TIMEOUT_MS = 5000;

function genSecureId(): string | undefined {
  if (typeof crypto === 'undefined') {
    return undefined;
  }
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return undefined;
}

function genId(): string {
  return genSecureId() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Extracts the string identifier (`value` for label_values, `name` otherwise) from the
 * raw result records, preserving server order (score/alpha) and de-duplicating.
 */
export function extractSearchValues(
  endpoint: SearchEndpoint,
  results: Array<Record<string, unknown>> | undefined,
  into: string[],
  seen: Set<string>
): void {
  if (!results) {
    return;
  }
  const key = endpoint === SEARCH_ENDPOINTS.labelValues ? 'value' : 'name';
  for (const record of results) {
    const v = record[key];
    if (typeof v === 'string' && !seen.has(v)) {
      seen.add(v);
      into.push(v);
    }
  }
}

/**
 * SearchApiClient implements the existing ResourceApiClient (drop-in replacement) AND the
 * progressive SearchCapableClient on top of the experimental NDJSON streaming search API.
 *
 * Transport: a single persistent, bidirectional Grafana Live channel per client instance
 * (`search/<sessionNonce>`). The client subscribes ONCE at construction, then publishes
 * `{requestId, slotId, endpoint, params}` per (debounced) search; the Go RunStream loop
 * streams requestId-tagged frames back down the same channel.
 *
 * Resilience: if Grafana Live is unavailable or the subscription errors, every method
 * transparently delegates to a LabelsApiClient/SeriesApiClient so autocomplete never
 * breaks. Drop-in promises always resolve (never reject) — on stream error/timeout they
 * resolve with the partial snapshot collected so far.
 */
export class SearchApiClient extends BaseResourceClient implements SearchCapableClient {
  private _cache: ResourceClientsCache = new ResourceClientsCache(this.datasource.cacheLevel);
  private readonly _fallback: ResourceApiClient;

  private readonly channelAddr: LiveChannelAddress;
  private readonly messages$ = new Subject<SearchFrame>();
  private readonly transportFailures$ = new Subject<void>();
  private liveSub?: Subscription;
  private useFallback = false;
  private connected = false;
  private readonly connectionWaiters = new Set<(connected: boolean) => void>();

  public histogramMetrics: string[] = [];
  public metrics: string[] = [];
  public labelKeys: string[] = [];
  public cachedLabelValues: Record<string, string[]> = {};

  constructor(request: RequestFn, datasource: PrometheusDatasource) {
    super(request, datasource);
    this._fallback = datasource.hasLabelsMatchAPISupport()
      ? new LabelsApiClient(request, datasource)
      : new SeriesApiClient(request, datasource);

    const channelNonce = genSecureId();
    this.channelAddr = {
      scope: LiveChannelScope.DataSource,
      // `stream` is the channel namespace; for DataSource scope it is the datasource uid.
      stream: datasource.uid,
      namespace: datasource.uid,
      path: `search/${channelNonce ?? 'unavailable'}`,
    };
    if (!channelNonce) {
      this.useFallback = true;
      return;
    }
    this.subscribeOnce();
  }

  /** Subscribes once to the persistent Live channel. Falls back on any failure. */
  private subscribeOnce(): void {
    try {
      const live = getGrafanaLiveSrv();
      if (!live) {
        this.useFallback = true;
        return;
      }
      this.liveSub = live.getStream<SearchFrame>(this.channelAddr).subscribe({
        next: (event) => {
          if (isLiveChannelMessageEvent(event)) {
            this.messages$.next(event.message);
          } else if (isLiveChannelStatusEvent(event)) {
            this.connected = event.state === LiveChannelConnectionState.Connected;
            if (this.connected) {
              this.resolveConnectionWaiters(true);
            } else if (
              event.error ||
              event.state === LiveChannelConnectionState.Invalid ||
              event.state === LiveChannelConnectionState.Shutdown
            ) {
              this.useFallback = true;
              this.resolveConnectionWaiters(false);
              this.transportFailures$.next();
            }
          }
        },
        error: () => {
          this.useFallback = true;
          this.resolveConnectionWaiters(false);
          this.transportFailures$.next();
        },
      });
    } catch {
      this.useFallback = true;
    }
  }

  /** Tears down the Live subscription. */
  public dispose(): void {
    this.liveSub?.unsubscribe();
    this.resolveConnectionWaiters(false);
    this.transportFailures$.next();
    this.transportFailures$.complete();
    this.messages$.complete();
  }

  private resolveConnectionWaiters(connected: boolean): void {
    for (const resolve of this.connectionWaiters) {
      resolve(connected);
    }
    this.connectionWaiters.clear();
  }

  private waitUntilConnected(): Promise<boolean> {
    if (this.connected) {
      return Promise.resolve(true);
    }
    if (this.useFallback) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (connected: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.connectionWaiters.delete(finish);
        resolve(connected);
      };
      const timer = setTimeout(() => finish(false), SEARCH_LIVE_READY_TIMEOUT_MS);
      this.connectionWaiters.add(finish);
    });
  }

  private publish(payload: {
    requestId: string;
    slotId: string;
    endpoint: SearchEndpoint;
    params: Record<string, string[]>;
  }): Promise<boolean> {
    const live = getGrafanaLiveSrv();
    if (!live) {
      return Promise.resolve(false);
    }
    if (this.connected) {
      return live
        .publish(this.channelAddr, payload, { useSocket: true })
        .then(() => true)
        .catch(() => false);
    }
    return this.waitUntilConnected().then((connected) => {
      if (!connected) {
        return false;
      }
      return live
        .publish(this.channelAddr, payload, { useSocket: true })
        .then(() => true)
        .catch(() => false);
    });
  }

  /**
   * Caps the limit sent to the streaming search API. Suggestions are scored/fuzzy, so we
   * never request more than SEARCH_API_DEFAULTS.limit (10000), even when a caller passes
   * the larger series limit (DEFAULT_SERIES_LIMIT=40000). `0` means unlimited and is
   * preserved; an explicit smaller limit is honored as-is.
   */
  private clampSearchLimit(limit?: number): number {
    if (limit === undefined) {
      return SEARCH_API_DEFAULTS.limit;
    }
    if (limit === 0) {
      return 0;
    }
    return Math.min(limit, SEARCH_API_DEFAULTS.limit);
  }

  /**
   * Builds the upstream search param set (as repeated-value records) from a logical
   * request. `sort_by=score` is only used when a search term is present (the API rejects
   * score without `search[]`); the empty-search "list everything" path falls back to
   * `alpha`.
   */
  private buildParams(opts: {
    timeParams: { start?: string; end?: string };
    search?: string;
    match?: string;
    label?: string;
    limit?: number;
  }): Record<string, string[]> {
    const params: Record<string, string[]> = {};
    const add = (key: string, value: string | number | undefined) => {
      if (value === undefined || value === '') {
        return;
      }
      params[key] = [...(params[key] ?? []), String(value)];
    };

    add('start', opts.timeParams.start);
    add('end', opts.timeParams.end);
    add('case_sensitive', String(SEARCH_API_DEFAULTS.caseSensitive));
    add('batch_size', SEARCH_API_DEFAULTS.batchSize);
    // Streaming search returns scored autocomplete suggestions, so it is clamped to
    // SEARCH_API_DEFAULTS.limit (10000) — it must never request the larger series limit
    // (DEFAULT_SERIES_LIMIT=40000) that callers commonly pass. `0` keeps its "unlimited"
    // meaning and is passed through unchanged.
    add('limit', this.clampSearchLimit(opts.limit));

    const term = opts.search?.trim();
    if (term) {
      add('search[]', term);
      add('sort_by', 'score');
      add('fuzz_alg', SEARCH_API_DEFAULTS.fuzzAlg);
      add('fuzz_threshold', SEARCH_API_DEFAULTS.fuzzThreshold);
    } else {
      add('sort_by', 'alpha');
    }

    if (opts.match && opts.match !== EMPTY_SELECTOR) {
      add('match[]', opts.match);
    }
    if (opts.label) {
      add('label', opts.label);
    }
    return params;
  }

  /**
   * Drop-in path: resolves Promise<string[]> on the terminal frame for the request, or
   * with the partial snapshot on error/timeout. Never rejects.
   */
  private runSearchPromise(
    endpoint: SearchEndpoint,
    params: Record<string, string[]>,
    slotId: string,
    fallback: () => Promise<string[]>
  ): Promise<string[]> {
    return new Promise<string[]>((resolve) => {
      const requestId = genId();
      const acc: string[] = [];
      const seen = new Set<string>();
      let settled = false;

      const finish = (values = acc) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        sub.unsubscribe();
        failureSub.unsubscribe();
        resolve(values);
      };
      const fallbackAndFinish = () => {
        if (settled) {
          return;
        }
        fallback()
          .then(finish)
          .catch(() => finish([]));
      };

      const sub = this.messages$.pipe(filter((f) => f.requestId === requestId)).subscribe((frame) => {
        if (frame.type === 'batch') {
          extractSearchValues(endpoint, frame.results, acc, seen);
        } else if (frame.type === 'terminal') {
          finish();
        } else {
          finish();
        }
      });
      const failureSub = this.transportFailures$.subscribe(fallbackAndFinish);

      const timer = setTimeout(fallbackAndFinish, SEARCH_DROP_IN_TIMEOUT_MS);
      this.publish({ requestId, slotId, endpoint, params }).then((published) => {
        if (!published) {
          fallbackAndFinish();
        }
      });
    });
  }

  /**
   * Progressive path: emits accumulating results as batches stream in, completes on the
   * terminal/error frame.
   */
  private runSearchObservable(
    endpoint: SearchEndpoint,
    params: Record<string, string[]>,
    slotId: string,
    fallback: () => Promise<string[]>
  ): Observable<string[]> {
    return new Observable<string[]>((subscriber) => {
      const requestId = genId();
      const acc: string[] = [];
      const seen = new Set<string>();
      let settled = false;
      let fallbackStarted = false;

      const completeWithFallback = () => {
        if (settled || fallbackStarted) {
          return;
        }
        fallbackStarted = true;
        sub.unsubscribe();
        failureSub.unsubscribe();
        clearTimeout(timer);
        fallback()
          .then((values) => {
            if (!settled && !subscriber.closed) {
              settled = true;
              subscriber.next(values);
              subscriber.complete();
            }
          })
          .catch(() => {
            if (!settled && !subscriber.closed) {
              settled = true;
              subscriber.next([]);
              subscriber.complete();
            }
          });
      };

      const sub = this.messages$.pipe(filter((f) => f.requestId === requestId)).subscribe((frame) => {
        if (frame.type === 'batch') {
          extractSearchValues(endpoint, frame.results, acc, seen);
          subscriber.next(acc.slice());
        } else if (frame.type === 'terminal') {
          settled = true;
          clearTimeout(timer);
          failureSub.unsubscribe();
          subscriber.next(acc.slice());
          subscriber.complete();
        } else {
          settled = true;
          clearTimeout(timer);
          failureSub.unsubscribe();
          subscriber.next(acc.slice());
          subscriber.complete();
        }
      });
      const failureSub = this.transportFailures$.subscribe(completeWithFallback);
      const timer = setTimeout(completeWithFallback, SEARCH_DROP_IN_TIMEOUT_MS);

      this.publish({ requestId, slotId, endpoint, params }).then((published) => {
        if (!published) {
          completeWithFallback();
        }
      });
      return () => {
        settled = true;
        clearTimeout(timer);
        sub.unsubscribe();
        failureSub.unsubscribe();
      };
    });
  }

  start = async (timeRange: TimeRange) => {
    if (this.useFallback) {
      await this._fallback.start(timeRange);
      this.metrics = this._fallback.metrics;
      this.histogramMetrics = this._fallback.histogramMetrics;
      this.labelKeys = this._fallback.labelKeys;
      return;
    }
    await this.queryMetrics(timeRange);
    this.labelKeys = await this.queryLabelKeys(timeRange);
  };

  public queryMetrics = async (
    timeRange: TimeRange,
    limit?: number
  ): Promise<{ metrics: string[]; histogramMetrics: string[] }> => {
    if (this.useFallback) {
      const res = await this._fallback.queryMetrics(timeRange);
      this.metrics = res.metrics;
      this.histogramMetrics = res.histogramMetrics;
      return res;
    }
    const params = this.buildParams({ timeParams: getRangeSnapInterval(this.datasource.cacheLevel, timeRange), limit });
    this.metrics = await this.runSearchPromise(SEARCH_ENDPOINTS.metricNames, params, 'metrics', () =>
      this._fallback.queryMetrics(timeRange).then((result) => result.metrics)
    );
    this.histogramMetrics = processHistogramMetrics(this.metrics);
    return { metrics: this.metrics, histogramMetrics: this.histogramMetrics };
  };

  public queryLabelKeys = async (timeRange: TimeRange, match?: string, limit?: number): Promise<string[]> => {
    if (this.useFallback) {
      return this._fallback.queryLabelKeys(timeRange, match, limit);
    }
    const effectiveLimit = this.getEffectiveLimit(limit);
    const effectiveMatch = match ?? '';
    const cached = this._cache.getLabelKeys(timeRange, effectiveMatch, effectiveLimit);
    if (cached) {
      return cached;
    }
    const params = this.buildParams({
      timeParams: getRangeSnapInterval(this.datasource.cacheLevel, timeRange),
      match,
      limit,
    });
    const keys = await this.runSearchPromise(SEARCH_ENDPOINTS.labelNames, params, 'labelKeys', () =>
      this._fallback.queryLabelKeys(timeRange, match, limit)
    );
    this.labelKeys = keys.slice();
    this._cache.setLabelKeys(timeRange, effectiveMatch, effectiveLimit, this.labelKeys);
    return keys;
  };

  public queryLabelValues = async (
    timeRange: TimeRange,
    labelKey: string,
    match?: string,
    limit?: number
  ): Promise<string[]> => {
    if (this.useFallback) {
      return this._fallback.queryLabelValues(timeRange, labelKey, match, limit);
    }
    const effectiveLimit = this.getEffectiveLimit(limit);
    const label = removeQuotesIfExist(this.datasource.interpolateString(labelKey));
    const effectiveMatch = `${match ?? ''}-${label}`;
    const cached = this._cache.getLabelValues(timeRange, effectiveMatch, effectiveLimit);
    if (cached) {
      return cached;
    }
    const params = this.buildParams({
      timeParams: this.datasource.getAdjustedInterval(timeRange),
      match,
      label,
      limit,
    });
    const values = await this.runSearchPromise(SEARCH_ENDPOINTS.labelValues, params, `labelValues-${label}`, () =>
      this._fallback.queryLabelValues(timeRange, labelKey, match, limit)
    );
    this._cache.setLabelValues(timeRange, effectiveMatch, effectiveLimit, values);
    return values;
  };

  public searchMetricNames = (timeRange: TimeRange, options: SearchOptions): Observable<string[]> => {
    const params = this.buildParams({
      timeParams: getRangeSnapInterval(this.datasource.cacheLevel, timeRange),
      search: options.search,
      match: options.match,
      limit: options.limit,
    });
    return this.runSearchObservable(SEARCH_ENDPOINTS.metricNames, params, options.slotId ?? 'metrics-search', () =>
      this._fallback.queryMetrics(timeRange).then((result) => result.metrics)
    );
  };

  public searchLabelNames = (timeRange: TimeRange, options: SearchOptions): Observable<string[]> => {
    const params = this.buildParams({
      timeParams: getRangeSnapInterval(this.datasource.cacheLevel, timeRange),
      search: options.search,
      match: options.match,
      limit: options.limit,
    });
    return this.runSearchObservable(SEARCH_ENDPOINTS.labelNames, params, options.slotId ?? 'labelKeys-search', () =>
      this._fallback.queryLabelKeys(timeRange, options.match, options.limit)
    );
  };

  public searchLabelValues = (timeRange: TimeRange, labelKey: string, options: SearchOptions): Observable<string[]> => {
    const label = removeQuotesIfExist(this.datasource.interpolateString(labelKey));
    const params = this.buildParams({
      timeParams: this.datasource.getAdjustedInterval(timeRange),
      search: options.search,
      match: options.match,
      label,
      limit: options.limit,
    });
    return this.runSearchObservable(
      SEARCH_ENDPOINTS.labelValues,
      params,
      options.slotId ?? `labelValues-search-${label}`,
      () => this._fallback.queryLabelValues(timeRange, labelKey, options.match, options.limit)
    );
  };
}

class ResourceClientsCache {
  private readonly MAX_CACHE_ENTRIES = 1000; // Maximum number of cache entries
  private readonly MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB max cache size

  private _cache: Record<string, string[]> = {};
  private _accessTimestamps: Record<string, number> = {};

  constructor(private cacheLevel: PrometheusCacheLevel = PrometheusCacheLevel.High) {}

  public setLabelKeys(timeRange: TimeRange, match: string | undefined, limit: number, keys: string[]) {
    if (keys.length === 0) {
      return;
    }
    // Check and potentially clean cache before adding new entry
    this.cleanCacheIfNeeded();
    const cacheKey = this.getCacheKey(timeRange, match, limit, 'key');
    this._cache[cacheKey] = keys.slice().sort();
    this._accessTimestamps[cacheKey] = Date.now();
  }

  public getLabelKeys(timeRange: TimeRange, match: string | undefined, limit: number): string[] | undefined {
    const cacheKey = this.getCacheKey(timeRange, match, limit, 'key');
    const result = this._cache[cacheKey];
    if (result) {
      // Update access timestamp on cache hit
      this._accessTimestamps[cacheKey] = Date.now();
    }
    return result;
  }

  public setLabelValues(timeRange: TimeRange, match: string | undefined, limit: number, values: string[]) {
    if (values.length === 0) {
      return;
    }
    // Check and potentially clean cache before adding new entry
    this.cleanCacheIfNeeded();
    const cacheKey = this.getCacheKey(timeRange, match, limit, 'value');
    this._cache[cacheKey] = values.slice().sort();
    this._accessTimestamps[cacheKey] = Date.now();
  }

  public getLabelValues(timeRange: TimeRange, match: string, limit: number): string[] | undefined {
    const cacheKey = this.getCacheKey(timeRange, match, limit, 'value');
    const result = this._cache[cacheKey];
    if (result) {
      // Update access timestamp on cache hit
      this._accessTimestamps[cacheKey] = Date.now();
    }
    return result;
  }

  private getCacheKey(timeRange: TimeRange, match: string | undefined, limit: number, type: 'key' | 'value') {
    const snappedTimeRange = getRangeSnapInterval(this.cacheLevel, timeRange);
    return [snappedTimeRange.start, snappedTimeRange.end, limit, match, type].join('|');
  }

  private cleanCacheIfNeeded() {
    // Check number of entries
    const currentEntries = Object.keys(this._cache).length;
    if (currentEntries >= this.MAX_CACHE_ENTRIES) {
      // Calculate 20% of current entries, but ensure we remove at least 1 entry
      const entriesToRemove = Math.max(1, Math.floor(currentEntries - this.MAX_CACHE_ENTRIES + 1));
      this.removeOldestEntries(entriesToRemove);
    }

    // Check cache size in bytes
    const currentSize = this.getCacheSizeInBytes();
    if (currentSize > this.MAX_CACHE_SIZE_BYTES) {
      // Calculate 20% of current entries, but ensure we remove at least 1 entry
      const entriesToRemove = Math.max(1, Math.floor(Object.keys(this._cache).length * 0.2));
      this.removeOldestEntries(entriesToRemove);
    }
  }

  private getCacheSizeInBytes(): number {
    let size = 0;
    for (const key in this._cache) {
      // Calculate size of key
      size += key.length * 2; // Approximate size of string in bytes (UTF-16)

      // Calculate size of value array
      const value = this._cache[key];
      for (const item of value) {
        size += item.length * 2; // Approximate size of each string in bytes
      }
    }
    return size;
  }

  private removeOldestEntries(count: number) {
    // Get all entries sorted by timestamp (oldest first)
    const entries = Object.entries(this._accessTimestamps).sort(
      ([, timestamp1], [, timestamp2]) => timestamp1 - timestamp2
    );

    // Take the oldest 'count' entries
    const entriesToRemove = entries.slice(0, count);

    // Remove these entries from both cache and timestamps
    for (const [key] of entriesToRemove) {
      delete this._cache[key];
      delete this._accessTimestamps[key];
    }
  }
}

export function processSeries(
  series: Array<{ [key: string]: string }>,
  findValuesForKey?: string,
  hasLabelsMatchAPISupport = true,
  matchSelector = ''
) {
  const metrics: Set<string> = new Set();
  const labelKeys: Set<string> = new Set();
  const labelValues: Set<string> = new Set();

  let filteredSeries = series;
  if (!hasLabelsMatchAPISupport) {
    // The datasource doesn't have match[] parameter support.
    // Manual filtering is required to avoid returning duplicate metrics.
    const {
      query: { labels },
    } = buildVisualQueryFromString(matchSelector);

    filteredSeries = series.filter((item) => {
      return labels.every((lbl) => matchesLabelCondition(item[lbl.label], lbl.op, lbl.value));
    });
  }

  // Extract metrics, label keys, and label values from the (filtered) series
  filteredSeries.forEach((item) => {
    // Add the __name__ value to metrics
    if (METRIC_LABEL in item) {
      metrics.add(item.__name__);
    }

    // Add all keys except __name__ to labelKeys
    Object.keys(item).forEach((key) => {
      if (key !== METRIC_LABEL) {
        labelKeys.add(key);
      }

      // If finding values for a specific key, add those values
      if (findValuesForKey && key === findValuesForKey) {
        labelValues.add(item[key]);
      }
    });
  });

  return {
    metrics: Array.from(metrics).sort(),
    labelKeys: Array.from(labelKeys).sort(),
    labelValues: Array.from(labelValues).sort(),
  };
}

/**
 * Evaluates whether a label value matches based on the operator.
 * Supports Prometheus label matching operators: =, !=, =~, !~
 *
 * @param itemValue - The actual value from the series item
 * @param operator - The comparison operator (=, !=, =~, !~)
 * @param matchValue - The value to match against
 * @returns true if the condition is satisfied, false otherwise
 */
function matchesLabelCondition(itemValue: string | undefined, operator: string, matchValue: string): boolean {
  // Handle case where label doesn't exist in the item
  if (itemValue === undefined) {
    // For != and !~, missing label is considered a match (it's "not equal" to the value)
    return operator === '!=' || operator === '!~';
  }

  switch (operator) {
    case '=':
      return itemValue === matchValue;
    case '!=':
      return itemValue !== matchValue;
    case '=~':
      try {
        const regex = new RegExp(matchValue);
        return regex.test(itemValue);
      } catch {
        // Invalid regex, treat as no match
        return false;
      }
    case '!~':
      try {
        const regex = new RegExp(matchValue);
        return !regex.test(itemValue);
      } catch {
        // Invalid regex, treat as match (doesn't match invalid pattern)
        return true;
      }
    default:
      // Unknown operator, default to exact match
      return itemValue === matchValue;
  }
}
