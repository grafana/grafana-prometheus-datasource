import { type TimeRange } from '@grafana/data';
import { config } from '@grafana/runtime';

import { SEARCH_STREAM_BATCH_SIZE } from './constants';
import { getRangeSnapInterval, processHistogramMetrics, removeQuotesIfExist } from './language_utils';
import { BaseResourceClient, type ResourceApiClient, ResourceClientsCache } from './resource_clients';

const DEFAULT_SEARCH_API_MAX_LIMIT = 10_000;

// Upper bound on a single NDJSON line held in memory before a newline arrives.
// A legitimate batch is capped by batch_size, so this only guards against a
// misbehaving upstream that never terminates a line. Comfortably above the
// largest realistic single-batch line (limit 10k results with metadata).
const MAX_SEARCH_STREAM_LINE_LENGTH = 32 * 1024 * 1024;

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
  // Number of results per NDJSON batch line. This only affects streaming
  // granularity (time-to-first-batch and how often onBatch fires), not the
  // accumulated result. Omit to use the upstream default.
  batchSize?: number;
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

// Mid-stream failures keep the records already delivered to onBatch available
// to callers while still surfacing the upstream error.
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
  onBatch?: (results: T[]) => void,
  maxLineLength: number = MAX_SEARCH_STREAM_LINE_LENGTH
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
  let sawTrailer = false;
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
        // Abrupt EOF is valid for this API. Ignore only the unfinished final
        // line; malformed newline-terminated records still fail loudly.
        return;
      }
      throw error;
    }

    if ('status' in parsed) {
      if (parsed.status === 'error') {
        throw new SearchApiError(parsed.error || 'Search API request failed', results.slice(), parsed.errorType);
      }
      sawTrailer = true;
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
      // Incremental consumers render this batch immediately; conventional
      // callers still receive the accumulated result when the stream ends.
      onBatch?.(parsed.results);
    }
  };

  // HTTP chunk boundaries are unrelated to NDJSON line boundaries, so retain
  // the final fragment and prepend it to the next decoded chunk.
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
    // Fail fast on an unterminated line rather than buffering without bound.
    if (buffer.length > maxLineLength) {
      throw new SearchApiError(
        `Search stream line exceeded the maximum length of ${maxLineLength} bytes`,
        results.slice()
      );
    }
  }

  // A stream that never delivered the success trailer was cut short (a dropped
  // connection is indistinguishable from a clean EOF at the byte level), so
  // callers must not treat the partial results as the complete set.
  if (!sawTrailer) {
    hasMore = true;
    warnings.push('Search stream ended before completion; results may be incomplete.');
  }

  return { results, warnings, hasMore };
}

// This client preserves ResourceApiClient's string-array contract for existing
// consumers and exposes structured streaming methods to search-aware UIs.
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
    // Unlike the legacy /label/{name}/values endpoint, Search API carries the
    // label name in a query parameter and therefore expects the unescaped name.
    const labelName = removeQuotesIfExist(interpolatedName);
    // Encode the cache key as JSON so a label name or match containing the
    // delimiter cannot collide with a different (labelName, match) pair.
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
      limit: String(this.getEffectiveSearchLimit(options.limit)),
    });

    if (term) {
      params.append('search[]', term);
      params.set('sort_by', 'score');
    }
    if (options.match) {
      params.append('match[]', options.match);
    }
    // batch_size only affects streaming granularity, not the result set, so it
    // is applied to every Search API request. A single constant therefore tunes
    // delivery for all consumers; callers may still override it per request.
    const batchSize = options.batchSize ?? SEARCH_STREAM_BATCH_SIZE;
    if (batchSize > 0) {
      params.set('batch_size', String(batchSize));
    }
    for (const [key, value] of Object.entries(extraParams)) {
      if (value !== undefined) {
        params.set(key, value);
      }
    }

    const uid = encodeURIComponent(this.datasource.uid);
    const appSubUrl = config.appSubUrl?.replace(/\/$/, '') ?? '';
    // getBackendSrv materializes response bodies, so native fetch is required
    // here to retain browser ReadableStream access. appSubUrl keeps hosted
    // Grafana installations under a subpath working.
    const response = await fetch(
      `${appSubUrl}/api/datasources/uid/${uid}/resources/api/v1/search/${endpoint}?${params.toString()}`,
      {
        method: 'GET',
        credentials: 'same-origin',
        signal: options.signal,
      }
    );
    return readSearchStream<T>(response, options.onBatch);
  }

  private getEffectiveSearchLimit(limit?: number): number {
    const effectiveLimit = this.getEffectiveLimit(limit);
    // Legacy discovery treats zero as unlimited and defaults to 40,000.
    // Search API requires a positive limit and Prometheus caps it at 10,000 by
    // default, so normalize both values before the request reaches upstream.
    if (effectiveLimit <= 0) {
      return DEFAULT_SEARCH_API_MAX_LIMIT;
    }
    return Math.min(effectiveLimit, DEFAULT_SEARCH_API_MAX_LIMIT);
  }
}
