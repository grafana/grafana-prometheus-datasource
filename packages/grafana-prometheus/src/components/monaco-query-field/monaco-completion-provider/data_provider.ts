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

  readonly queryLabelKeys: typeof this.languageProvider.queryLabelKeys;
  readonly queryLabelValues: typeof this.languageProvider.queryLabelValues;

  constructor(params: DataProviderParams) {
    this.languageProvider = params.languageProvider;
    this.historyProvider = params.historyProvider;

    this.queryLabelKeys = this.languageProvider.queryLabelKeys.bind(this.languageProvider);
    this.queryLabelValues = this.languageProvider.queryLabelValues.bind(this.languageProvider);

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
