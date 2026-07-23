import { type HistoryItem, type TimeRange } from '@grafana/data';

import { DEFAULT_COMPLETION_LIMIT, METRIC_LABEL } from '../../../constants';
import { type PrometheusLanguageProviderInterface } from '../../../language_provider';
import { removeQuotesIfExist } from '../../../language_utils';
import { type InfoLabelRecord } from '../../../resource_clients';
import { type PromQuery } from '../../../types';
import { escapeForUtf8Support, isValidLegacyName } from '../../../utf8_support';

interface Metric {
  name: string;
  help: string;
  type: string;
  isUtf8?: boolean;
}

export interface DataProviderParams {
  languageProvider: PrometheusLanguageProviderInterface;
  historyProvider: Array<HistoryItem<PromQuery>>;
}

export class DataProvider {
  readonly languageProvider: PrometheusLanguageProviderInterface;
  readonly historyProvider: Array<HistoryItem<PromQuery>>;

  readonly queryLabelKeys: typeof this.languageProvider.queryLabelKeys;
  readonly queryLabelValues: typeof this.languageProvider.queryLabelValues;
  readonly queryInfoLabels: typeof this.languageProvider.queryInfoLabels;

  // Memoizes the info-labels fetch per `info()` base expression (+ metric_match + search) for the
  // lifetime of this provider instance, so the label-name completion and a subsequent label-value
  // completion (for the same expr/metric_match/search) share a single network round-trip.
  private infoLabelsCache: Map<string, Promise<InfoLabelRecord[]>> = new Map();

  constructor(params: DataProviderParams) {
    this.languageProvider = params.languageProvider;
    this.historyProvider = params.historyProvider;

    this.queryLabelKeys = this.languageProvider.queryLabelKeys.bind(this.languageProvider);
    this.queryLabelValues = this.languageProvider.queryLabelValues.bind(this.languageProvider);
    this.queryInfoLabels = this.languageProvider.queryInfoLabels.bind(this.languageProvider);

    // Ensure metadata is loaded for completions. The builder mode triggers this via its own
    // components, but the code editor does not, so we need to fetch it here if not already cached.
    const existingMetadata = this.languageProvider.retrieveMetricsMetadata();
    if (Object.keys(existingMetadata).length === 0) {
      this.languageProvider.queryMetricsMetadata();
    }
  }

  /**
   * Queries metric names with optional filtering.
   * Safely constructs regex patterns and handles errors.
   */
  queryMetricNames = async (timeRange: TimeRange, searchTerm: string | undefined): Promise<string[]> => {
    try {
      let match: string | undefined;
      if (searchTerm) {
        const escapedWord = escapeForUtf8Support(removeQuotesIfExist(searchTerm));
        match = `{__name__=~".*${escapedWord}.*"}`;
      }

      const result = await this.languageProvider.queryLabelValues(
        timeRange,
        METRIC_LABEL,
        match,
        DEFAULT_COMPLETION_LIMIT
      );

      return Array.isArray(result) ? result : [];
    } catch (error) {
      console.warn('Failed to query metric names:', error);
      return [];
    }
  };

  /**
   * Fetches info-metric data-labels for a given `info()` base expression.
   *
   * Results are memoized per `expr` + `metricMatch` + `search` for the lifetime of this provider
   * instance so the label-name completion and a subsequent label-value completion (with the same
   * inputs) reuse one round-trip. Errors are swallowed and surfaced as an empty list so completion
   * never throws.
   *
   * @param timeRange   - Time range to search.
   * @param expr        - The `info()` first argument, used server-side to scope identifying labels.
   * @param metricMatch - Encoded `__name__` matcher narrowing which info metric is queried.
   * @param search      - Case-insensitive substring used to server-filter/rank label names.
   */
  getInfoLabels = (
    timeRange: TimeRange,
    expr: string | undefined,
    metricMatch?: string,
    search?: string
  ): Promise<InfoLabelRecord[]> => {
    const key = [expr ?? '', metricMatch ?? '', search ?? ''].join('|');
    const cached = this.infoLabelsCache.get(key);
    if (cached) {
      return cached;
    }

    const promise = this.queryInfoLabels(timeRange, expr, metricMatch, DEFAULT_COMPLETION_LIMIT, undefined, search)
      .then((records) => (Array.isArray(records) ? records : []))
      .catch((error) => {
        console.warn('Failed to query info labels:', error);
        return [];
      });

    this.infoLabelsCache.set(key, promise);
    return promise;
  };

  getHistory(): string[] {
    return this.historyProvider.map((h) => h.query.expr).filter(Boolean);
  }

  metricNamesToMetrics(metricNames: string[]): Metric[] {
    const metricsMetadata = this.languageProvider.retrieveMetricsMetadata();
    const result: Metric[] = metricNames.map((m) => {
      const metaItem = metricsMetadata?.[m];
      return {
        name: m,
        help: metaItem?.help ?? '',
        type: metaItem?.type ?? '',
        isUtf8: !isValidLegacyName(m),
      };
    });

    return result;
  }
}
