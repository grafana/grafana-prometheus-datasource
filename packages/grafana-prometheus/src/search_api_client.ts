import { type TimeRange } from '@grafana/data';
import { type BackendSrvRequest, config, getBackendSrv } from '@grafana/runtime';

import { SEARCH_STREAM_BATCH_SIZE } from './constants';
import { getRangeSnapInterval, processHistogramMetrics, removeQuotesIfExist } from './language_utils';
import {
  BaseResourceClient,
  LabelsApiClient,
  type ResourceApiClient,
  ResourceClientsCache,
  SeriesApiClient,
} from './resource_clients';
import { readSearchStream, SearchApiUnavailableError, type SearchStreamResult } from './search_api_stream';
import { bridgeChunkedResponse, type SearchTransportStats } from './search_api_transport';

export const DEFAULT_SEARCH_API_MAX_LIMIT = 10_000;
export const DEFAULT_SEARCH_FUZZ_THRESHOLD = 80;
export const DEFAULT_SEARCH_FUZZ_ALGORITHM: SearchFuzzAlgorithm = 'jarowinkler';

export type SearchFuzzAlgorithm = 'subsequence' | 'jarowinkler';

export interface SearchMetricResult {
  name: string;
  score?: number;
  type?: string;
  help?: string;
  unit?: string;
}

export interface SearchLabelNameResult {
  name: string;
  score?: number;
}

export interface SearchLabelValueResult {
  value: string;
  score?: number;
}

export interface SearchOptions<T> {
  limit?: number;
  match?: string;
  signal?: AbortSignal;
  onBatch?: (results: T[]) => void;
  onTransportStats?: (stats: Readonly<SearchTransportStats>) => void;
  retainResults?: boolean;
  batchSize?: number;
  fuzzThreshold?: number;
  fuzzAlgorithm?: SearchFuzzAlgorithm;
  caseSensitive?: boolean;
}

export interface SearchMetricOptions extends SearchOptions<SearchMetricResult> {
  includeMetadata?: boolean;
}

type SearchEndpoint = 'metric_names' | 'label_names' | 'label_values';

export class SearchApiClient extends BaseResourceClient implements ResourceApiClient {
  private _cache = new ResourceClientsCache(this.datasource.cacheLevel);
  private searchUnavailable = false;
  private _fallbackClient?: ResourceApiClient;

  public histogramMetrics: string[] = [];
  public metrics: string[] = [];
  public labelKeys: string[] = [];
  public cachedLabelValues: Record<string, string[]> = {};

  // True means capability has not been disproved for this datasource instance;
  // the first request still performs the actual probe.
  public isAvailable(): boolean {
    return !this.searchUnavailable;
  }

  public start = async (timeRange: TimeRange): Promise<void> => {
    return this.withFallback(
      async () => {
        await this.queryMetricsFromSearch(timeRange);
        this.labelKeys = await this.queryLabelKeysFromSearch(timeRange);
      },
      async () => {
        await this.fallbackClient.start(timeRange);
        this.copyFallbackState();
      }
    );
  };

  public queryMetrics = async (
    timeRange: TimeRange,
    limit?: number
  ): Promise<{ metrics: string[]; histogramMetrics: string[] }> => {
    return this.withFallback(
      () => this.queryMetricsFromSearch(timeRange, limit),
      async () => {
        const result = await this.fallbackClient.queryMetrics(timeRange);
        this.copyFallbackState();
        return result;
      }
    );
  };

  public queryLabelKeys = async (timeRange: TimeRange, match?: string, limit?: number): Promise<string[]> => {
    return this.withFallback(
      () => this.queryLabelKeysFromSearch(timeRange, match, limit),
      async () => {
        const result = await this.fallbackClient.queryLabelKeys(timeRange, match, limit);
        this.labelKeys = result.slice();
        return result;
      }
    );
  };

  public queryLabelValues = async (
    timeRange: TimeRange,
    labelKey: string,
    match?: string,
    limit?: number
  ): Promise<string[]> => {
    return this.withFallback(
      () => this.queryLabelValuesFromSearch(timeRange, labelKey, match, limit),
      () => this.fallbackClient.queryLabelValues(timeRange, labelKey, match, limit)
    );
  };

  private async queryMetricsFromSearch(
    timeRange: TimeRange,
    limit?: number
  ): Promise<{ metrics: string[]; histogramMetrics: string[] }> {
    const effectiveLimit = this.getEffectiveSearchLimit(limit);
    const cached = this._cache.getLabelValues(timeRange, undefined, effectiveLimit);
    if (cached) {
      this.metrics = cached.slice();
      this.histogramMetrics = processHistogramMetrics(this.metrics);
      return { metrics: this.metrics, histogramMetrics: this.histogramMetrics };
    }

    const response = await this.searchMetricNames(timeRange, '', { limit: effectiveLimit });
    this.metrics = response.results.map((result) => result.name);
    this.histogramMetrics = processHistogramMetrics(this.metrics);
    this._cache.setLabelValues(timeRange, undefined, effectiveLimit, this.metrics);
    return { metrics: this.metrics, histogramMetrics: this.histogramMetrics };
  }

  private async queryLabelKeysFromSearch(timeRange: TimeRange, match?: string, limit?: number): Promise<string[]> {
    const effectiveLimit = this.getEffectiveSearchLimit(limit);
    const effectiveMatch = match ?? '';
    const cached = this._cache.getLabelKeys(timeRange, effectiveMatch, effectiveLimit);
    if (cached) {
      return cached.slice();
    }

    const response = await this.searchLabelNames(timeRange, '', { limit: effectiveLimit, match });
    this.labelKeys = response.results.map((result) => result.name);
    this._cache.setLabelKeys(timeRange, effectiveMatch, effectiveLimit, this.labelKeys);
    return this.labelKeys.slice();
  }

  private async queryLabelValuesFromSearch(
    timeRange: TimeRange,
    labelKey: string,
    match?: string,
    limit?: number
  ): Promise<string[]> {
    const effectiveLimit = this.getEffectiveSearchLimit(limit);
    const interpolatedName = this.datasource.interpolateString(labelKey);
    const labelName = removeQuotesIfExist(interpolatedName);
    const effectiveMatch = JSON.stringify(['label_values', labelName, match ?? '']);
    const cached = this._cache.getLabelValues(timeRange, effectiveMatch, effectiveLimit);
    if (cached) {
      return cached.slice();
    }

    const response = await this.searchLabelValues(timeRange, labelName, '', { limit: effectiveLimit, match });
    const values = response.results.map((result) => result.value);
    this._cache.setLabelValues(timeRange, effectiveMatch, effectiveLimit, values);
    return values;
  }

  public searchMetricNames = (
    timeRange: TimeRange,
    term: string,
    options: SearchMetricOptions = {}
  ): Promise<SearchStreamResult<SearchMetricResult>> => {
    return this.trackAvailability(
      this.search('metric_names', timeRange, term, options, {
        include_metadata: options.includeMetadata ? 'true' : undefined,
      })
    );
  };

  public searchLabelNames = (
    timeRange: TimeRange,
    term: string,
    options: SearchOptions<SearchLabelNameResult> = {}
  ): Promise<SearchStreamResult<SearchLabelNameResult>> => {
    return this.trackAvailability(this.search('label_names', timeRange, term, options));
  };

  public searchLabelValues = (
    timeRange: TimeRange,
    labelName: string,
    term: string,
    options: SearchOptions<SearchLabelValueResult> = {}
  ): Promise<SearchStreamResult<SearchLabelValueResult>> => {
    return this.trackAvailability(this.search('label_values', timeRange, term, options, { label: labelName }));
  };

  private get fallbackClient(): ResourceApiClient {
    if (!this._fallbackClient) {
      this._fallbackClient = this.datasource.hasLabelsMatchAPISupport()
        ? new LabelsApiClient(this.request, this.datasource)
        : new SeriesApiClient(this.request, this.datasource);
    }
    return this._fallbackClient;
  }

  private async withFallback<T>(search: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.searchUnavailable) {
      return fallback();
    }

    try {
      return await search();
    } catch (error) {
      if (!(error instanceof SearchApiUnavailableError)) {
        throw error;
      }
      this.markSearchUnavailable(error);
      return fallback();
    }
  }

  private async trackAvailability<T>(search: Promise<T>): Promise<T> {
    try {
      return await search;
    } catch (error) {
      if (error instanceof SearchApiUnavailableError) {
        this.markSearchUnavailable(error);
      }
      throw error;
    }
  }

  private markSearchUnavailable(error: SearchApiUnavailableError): void {
    if (this.searchUnavailable) {
      return;
    }
    this.searchUnavailable = true;
    console.warn('Search API unavailable; using standard Prometheus discovery.', error);
  }

  private copyFallbackState(): void {
    this.metrics = this.fallbackClient.metrics;
    this.histogramMetrics = this.fallbackClient.histogramMetrics;
    this.labelKeys = this.fallbackClient.labelKeys;
    this.cachedLabelValues = this.fallbackClient.cachedLabelValues;
  }

  private async search<T>(
    endpoint: SearchEndpoint,
    timeRange: TimeRange,
    term: string,
    options: SearchOptions<T>,
    extraParams: Record<string, string | undefined> = {}
  ): Promise<SearchStreamResult<T>> {
    const timeParams =
      endpoint === 'label_names'
        ? getRangeSnapInterval(this.datasource.cacheLevel, timeRange)
        : this.datasource.getAdjustedInterval(timeRange);
    const params: Record<string, string> = {
      start: String(timeParams.start),
      end: String(timeParams.end),
      limit: String(this.getEffectiveSearchLimit(options.limit)),
    };

    const normalizedTerm = term.trim().replace(/\s+/g, '');
    if (normalizedTerm) {
      params['search[]'] = normalizedTerm;
      params.sort_by = 'score';
      params.fuzz_threshold = String(options.fuzzThreshold ?? DEFAULT_SEARCH_FUZZ_THRESHOLD);
      params.fuzz_alg = options.fuzzAlgorithm ?? DEFAULT_SEARCH_FUZZ_ALGORITHM;
      params.case_sensitive = String(options.caseSensitive ?? false);
    }
    if (options.match) {
      params['match[]'] = options.match;
    }

    const batchSize = options.batchSize ?? SEARCH_STREAM_BATCH_SIZE;
    if (batchSize > 0) {
      params.batch_size = String(batchSize);
    }

    for (const [key, value] of Object.entries(extraParams)) {
      if (value !== undefined) {
        params[key] = value;
      }
    }

    const uid = encodeURIComponent(this.datasource.uid);
    const url = `api/datasources/uid/${uid}/resources/api/v1/search/${endpoint}`;
    const headers: Record<string, string> = {};
    const orgId = config.bootData?.user?.orgId;
    if (orgId) {
      headers['X-Grafana-Org-Id'] = String(orgId);
    }

    const request: BackendSrvRequest = { url, method: 'GET', params, headers };
    let { source, cancel, stats } = await bridgeChunkedResponse(request, options.signal);
    if (source.status === 401) {
      cancel();
      await this.pingLoginToRefreshSession();
      ({ source, cancel, stats } = await bridgeChunkedResponse(request, options.signal));
    }

    try {
      return await readSearchStream<T>(source, options.onBatch, undefined, options.retainResults);
    } finally {
      options.onTransportStats?.({ ...stats });
      cancel();
    }
  }

  private async pingLoginToRefreshSession(): Promise<void> {
    try {
      await getBackendSrv().get('/api/login/ping');
    } catch {
      // The retried search reports the authentication error if refresh fails.
    }
  }

  private getEffectiveSearchLimit(limit?: number): number {
    const effectiveLimit = this.getEffectiveLimit(limit);
    if (effectiveLimit <= 0) {
      return DEFAULT_SEARCH_API_MAX_LIMIT;
    }
    return Math.min(effectiveLimit, DEFAULT_SEARCH_API_MAX_LIMIT);
  }
}
