import { type TimeRange } from '@grafana/data';
import { type BackendSrvRequest, config, getBackendSrv } from '@grafana/runtime';

import { SEARCH_STREAM_BATCH_SIZE } from './constants';
import { getRangeSnapInterval, processHistogramMetrics, removeQuotesIfExist } from './language_utils';
import { BaseResourceClient, type ResourceApiClient, ResourceClientsCache } from './resource_clients';
import { readSearchStream, type SearchStreamResult } from './search_api_stream';
import { bridgeChunkedResponse } from './search_api_transport';

export const DEFAULT_SEARCH_API_MAX_LIMIT = 10_000;

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
  batchSize?: number;
}

export interface SearchMetricOptions extends SearchOptions<SearchMetricResult> {
  includeMetadata?: boolean;
}

type SearchEndpoint = 'metric_names' | 'label_names' | 'label_values';

export class SearchApiClient extends BaseResourceClient implements ResourceApiClient {
  private _cache = new ResourceClientsCache(this.datasource.cacheLevel);

  public histogramMetrics: string[] = [];
  public metrics: string[] = [];
  public labelKeys: string[] = [];
  public cachedLabelValues: Record<string, string[]> = {};

  public start = async (timeRange: TimeRange): Promise<void> => {
    await this.queryMetrics(timeRange);
    this.labelKeys = await this.queryLabelKeys(timeRange);
  };

  public queryMetrics = async (
    timeRange: TimeRange,
    limit?: number
  ): Promise<{ metrics: string[]; histogramMetrics: string[] }> => {
    const effectiveLimit = this.getEffectiveSearchLimit(limit);
    const response = await this.searchMetricNames(timeRange, '', { limit: effectiveLimit });
    this.metrics = response.results.map((result) => result.name);
    this.histogramMetrics = processHistogramMetrics(this.metrics);
    this._cache.setLabelValues(timeRange, undefined, effectiveLimit, this.metrics);
    return { metrics: this.metrics, histogramMetrics: this.histogramMetrics };
  };

  public queryLabelKeys = async (timeRange: TimeRange, match?: string, limit?: number): Promise<string[]> => {
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
  };

  public queryLabelValues = async (
    timeRange: TimeRange,
    labelKey: string,
    match?: string,
    limit?: number
  ): Promise<string[]> => {
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
  };

  public searchMetricNames = (
    timeRange: TimeRange,
    term: string,
    options: SearchMetricOptions = {}
  ): Promise<SearchStreamResult<SearchMetricResult>> => {
    return this.search('metric_names', timeRange, term, options, {
      include_metadata: options.includeMetadata ? 'true' : undefined,
    });
  };

  public searchLabelNames = (
    timeRange: TimeRange,
    term: string,
    options: SearchOptions<SearchLabelNameResult> = {}
  ): Promise<SearchStreamResult<SearchLabelNameResult>> => {
    return this.search('label_names', timeRange, term, options);
  };

  public searchLabelValues = (
    timeRange: TimeRange,
    labelName: string,
    term: string,
    options: SearchOptions<SearchLabelValueResult> = {}
  ): Promise<SearchStreamResult<SearchLabelValueResult>> => {
    return this.search('label_values', timeRange, term, options, { label: labelName });
  };

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

    if (term) {
      params['search[]'] = term;
      params.sort_by = 'score';
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
    let { source, cancel } = await bridgeChunkedResponse(request, options.signal);
    if (source.status === 401) {
      cancel();
      await this.pingLoginToRefreshSession();
      ({ source, cancel } = await bridgeChunkedResponse(request, options.signal));
    }

    try {
      return await readSearchStream<T>(source, options.onBatch);
    } finally {
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
