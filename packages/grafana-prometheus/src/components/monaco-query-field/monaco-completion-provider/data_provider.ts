import { type HistoryItem, type TimeRange } from '@grafana/data';

import { DEFAULT_COMPLETION_LIMIT, METRIC_LABEL } from '../../../constants';
import { type PrometheusLanguageProviderInterface } from '../../../language_provider';
import { removeQuotesIfExist } from '../../../language_utils';
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

  // Completion categories can request concurrently, but a newer request in the
  // same category always supersedes the previous typed prefix.
  private metricSearchAbortController?: AbortController;
  private labelKeySearchAbortController?: AbortController;
  private labelValueSearchAbortController?: AbortController;

  constructor(params: DataProviderParams) {
    this.languageProvider = params.languageProvider;
    this.historyProvider = params.historyProvider;

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
      const searchClient = this.languageProvider.getSearchApiClient();
      if (searchClient) {
        // Search API ranks the raw editor text server-side; the regex and UTF-8
        // escaping below belong only to the legacy label-values endpoint.
        this.metricSearchAbortController?.abort();
        this.metricSearchAbortController = new AbortController();
        const response = await searchClient.searchMetricNames(timeRange, searchTerm ?? '', {
          limit: DEFAULT_COMPLETION_LIMIT,
          signal: this.metricSearchAbortController.signal,
        });
        return response.results.map((result) => result.name);
      }

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

  queryLabelKeys = async (
    timeRange: TimeRange,
    match?: string,
    limit?: number,
    searchTerm?: string
  ): Promise<string[]> => {
    const searchClient = this.languageProvider.getSearchApiClient();
    if (searchClient && searchTerm) {
      // Empty-prefix requests use the drop-in ResourceApiClient path. Typed
      // prefixes use the fuzzy extension so Prometheus can rank matches.
      this.labelKeySearchAbortController?.abort();
      this.labelKeySearchAbortController = new AbortController();
      const response = await searchClient.searchLabelNames(timeRange, searchTerm, {
        limit: limit ?? DEFAULT_COMPLETION_LIMIT,
        match,
        signal: this.labelKeySearchAbortController.signal,
      });
      return response.results.map((result) => result.name);
    }
    return this.languageProvider.queryLabelKeys(timeRange, match, limit);
  };

  queryLabelValues = async (
    timeRange: TimeRange,
    labelKey: string,
    match?: string,
    limit?: number,
    searchTerm?: string
  ): Promise<string[]> => {
    const searchClient = this.languageProvider.getSearchApiClient();
    if (searchClient && searchTerm) {
      this.labelValueSearchAbortController?.abort();
      this.labelValueSearchAbortController = new AbortController();
      const response = await searchClient.searchLabelValues(
        timeRange,
        removeQuotesIfExist(labelKey),
        removeQuotesIfExist(searchTerm),
        {
          limit: limit ?? DEFAULT_COMPLETION_LIMIT,
          match,
          signal: this.labelValueSearchAbortController.signal,
        }
      );
      return response.results.map((result) => result.value);
    }
    return this.languageProvider.queryLabelValues(timeRange, labelKey, match, limit);
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
