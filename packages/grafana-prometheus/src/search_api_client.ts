import { type TimeRange } from '@grafana/data';

import { getRangeSnapInterval, processHistogramMetrics, removeQuotesIfExist } from './language_utils';
import { BaseResourceClient, type ResourceApiClient, ResourceClientsCache } from './resource_clients';
import { escapeForUtf8Support } from './utf8_support';

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

export interface SearchStreamResult<T> {
  results: T[];
  warnings: string[];
  hasMore: boolean;
}

export interface SearchOptions<T> {
  limit?: number;
  match?: string;
  signal?: AbortSignal;
  onBatch?: (results: T[]) => void;
}

export interface SearchMetricOptions extends SearchOptions<SearchMetricResult> {
  includeMetadata?: boolean;
}

interface SearchBatch<T> {
  results: T[];
  warnings?: string[];
}

interface SearchTrailer {
  status: 'success';
  has_more: boolean;
  warnings?: string[];
}

interface SearchErrorLine {
  status: 'error';
  errorType?: string;
  error?: string;
}

export class SearchApiError<T = unknown> extends Error {
  constructor(
    message: string,
    public readonly partialResults: T[] = [],
    public readonly errorType?: string
  ) {
    super(message);
    this.name = 'SearchApiError';
  }
}

export async function readSearchStream<T>(
  response: Response,
  onBatch?: (results: T[]) => void
): Promise<SearchStreamResult<T>> {
  if (!response.ok) {
    let error: SearchErrorLine | undefined;
    try {
      error = (await response.json()) as SearchErrorLine;
    } catch {
      // The status text is the best available error when an upstream proxy returns a non-JSON body.
    }
    throw new SearchApiError(
      error?.error || response.statusText || `Search API request failed (${response.status})`,
      [],
      error?.errorType
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return { results: [], warnings: [], hasMore: false };
  }

  const decoder = new TextDecoder();
  const results: T[] = [];
  const warnings: string[] = [];
  let hasMore = false;
  let buffer = '';

  const processLine = (line: string, tolerateIncomplete: boolean) => {
    if (!line.trim()) {
      return;
    }

    let parsed: SearchBatch<T> | SearchTrailer | SearchErrorLine;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (tolerateIncomplete) {
        return;
      }
      throw error;
    }

    if ('status' in parsed) {
      if (parsed.status === 'error') {
        throw new SearchApiError(parsed.error || 'Search API request failed', results.slice(), parsed.errorType);
      }
      hasMore = parsed.has_more;
      if (parsed.warnings) {
        warnings.push(...parsed.warnings);
      }
      return;
    }

    if (Array.isArray(parsed.results)) {
      results.push(...parsed.results);
      if (parsed.warnings) {
        warnings.push(...parsed.warnings);
      }
      onBatch?.(parsed.results);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      processLine(buffer, true);
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      processLine(line, false);
    }
  }

  return { results, warnings, hasMore };
}

export class SearchApiClient extends BaseResourceClient implements ResourceApiClient {
  private _cache: ResourceClientsCache = new ResourceClientsCache(this.datasource.cacheLevel);

  public histogramMetrics: string[] = [];
  public metrics: string[] = [];
  public labelKeys: string[] = [];
  public cachedLabelValues: Record<string, string[]> = {};

  public start = async (timeRange: TimeRange) => {
    await this.queryMetrics(timeRange);
    this.labelKeys = await this.queryLabelKeys(timeRange);
  };

  public queryMetrics = async (
    timeRange: TimeRange,
    limit?: number
  ): Promise<{ metrics: string[]; histogramMetrics: string[] }> => {
    const effectiveLimit = this.getEffectiveLimit(limit);
    const response = await this.searchMetricNames(timeRange, '', { limit: effectiveLimit });
    this.metrics = response.results.map((result) => result.name);
    this.histogramMetrics = processHistogramMetrics(this.metrics);
    this._cache.setLabelValues(timeRange, undefined, effectiveLimit, this.metrics);
    return { metrics: this.metrics, histogramMetrics: this.histogramMetrics };
  };

  public queryLabelKeys = async (timeRange: TimeRange, match?: string, limit?: number): Promise<string[]> => {
    const effectiveLimit = this.getEffectiveLimit(limit);
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
    const effectiveLimit = this.getEffectiveLimit(limit);
    const interpolatedName = this.datasource.interpolateString(labelKey);
    const escapedName = escapeForUtf8Support(removeQuotesIfExist(interpolatedName));
    const effectiveMatch = `${match ?? ''}-${escapedName}`;
    const cached = this._cache.getLabelValues(timeRange, effectiveMatch, effectiveLimit);
    if (cached) {
      return cached.slice();
    }

    const response = await this.searchLabelValues(timeRange, escapedName, '', { limit: effectiveLimit, match });
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
    labelKey: string,
    term: string,
    options: SearchOptions<SearchLabelValueResult> = {}
  ): Promise<SearchStreamResult<SearchLabelValueResult>> => {
    return this.search('label_values', timeRange, term, options, { label: labelKey });
  };

  private async search<T>(
    endpoint: 'metric_names' | 'label_names' | 'label_values',
    timeRange: TimeRange,
    term: string,
    options: SearchOptions<T>,
    extraParams: Record<string, string | undefined> = {}
  ): Promise<SearchStreamResult<T>> {
    const timeParams =
      endpoint === 'label_names'
        ? getRangeSnapInterval(this.datasource.cacheLevel, timeRange)
        : this.datasource.getAdjustedInterval(timeRange);
    const params = new URLSearchParams({
      start: String(timeParams.start),
      end: String(timeParams.end),
      limit: String(this.getEffectiveLimit(options.limit)),
    });

    if (term) {
      params.append('search[]', term);
      params.set('sort_by', 'score');
    }
    if (options.match) {
      params.append('match[]', options.match);
    }
    for (const [key, value] of Object.entries(extraParams)) {
      if (value !== undefined) {
        params.set(key, value);
      }
    }

    const uid = encodeURIComponent(this.datasource.uid);
    const response = await fetch(
      `/api/datasources/uid/${uid}/resources/api/v1/search/${endpoint}?${params.toString()}`,
      {
        method: 'GET',
        credentials: 'same-origin',
        signal: options.signal,
      }
    );
    return readSearchStream<T>(response, options.onBatch);
  }
}
