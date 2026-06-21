import { of } from 'rxjs';

import { type HistoryItem, type TimeRange } from '@grafana/data';

import { DEFAULT_COMPLETION_LIMIT, METRIC_LABEL } from '../../../constants';
import type { PrometheusLanguageProvider } from '../../../language_provider';
import { type PromQuery } from '../../../types';

import { DataProvider, type DataProviderParams } from './data_provider';

const createLanguageProviderMock = (existingMetadata: Record<string, unknown> = {}) => ({
  queryLabelKeys: jest.fn(),
  queryLabelValues: jest.fn(),
  queryMetricsMetadata: jest.fn().mockResolvedValue({}),
  retrieveMetrics: jest.fn().mockReturnValue([]),
  retrieveMetricsMetadata: jest.fn().mockReturnValue(existingMetadata),
});

const createDataProvider = (
  languageProvider: Partial<PrometheusLanguageProvider>,
  historyProvider: Array<HistoryItem<PromQuery>> = []
) => {
  return new DataProvider({ languageProvider, historyProvider } as DataProviderParams);
};

// queryMetricNames forwards a TimeRange to the language provider untouched; its concrete
// shape is irrelevant to the logic under test, so a sentinel cast keeps the tests focused.
const timeRange = { from: 'now-1h', to: 'now' } as unknown as TimeRange;

describe('DataProvider', () => {
  describe('metadata fetching', () => {
    it('calls queryMetricsMetadata when no metadata is cached', () => {
      const languageProvider = createLanguageProviderMock({});
      createDataProvider(languageProvider);
      expect(languageProvider.queryMetricsMetadata).toHaveBeenCalledTimes(1);
    });

    it('does not call queryMetricsMetadata when metadata is already cached', () => {
      const languageProvider = createLanguageProviderMock({
        http_requests_total: { type: 'counter', help: 'Total HTTP requests' },
      });
      createDataProvider(languageProvider);
      expect(languageProvider.queryMetricsMetadata).not.toHaveBeenCalled();
    });
  });

  describe('queryMetricNames', () => {
    it('queries without a matcher when no search term is provided', async () => {
      const languageProvider = createLanguageProviderMock();
      languageProvider.queryLabelValues.mockResolvedValue(['up', 'go_goroutines']);
      const dataProvider = createDataProvider(languageProvider);

      const result = await dataProvider.queryMetricNames(timeRange, undefined);

      expect(result).toEqual(['up', 'go_goroutines']);
      expect(languageProvider.queryLabelValues).toHaveBeenCalledWith(
        timeRange,
        METRIC_LABEL,
        undefined,
        DEFAULT_COMPLETION_LIMIT
      );
    });

    it('builds a fuzzy __name__ regex matcher from a legacy search term', async () => {
      const languageProvider = createLanguageProviderMock();
      languageProvider.queryLabelValues.mockResolvedValue([]);
      const dataProvider = createDataProvider(languageProvider);

      await dataProvider.queryMetricNames(timeRange, 'requests');

      expect(languageProvider.queryLabelValues).toHaveBeenCalledWith(
        timeRange,
        METRIC_LABEL,
        '{__name__=~".*requests.*"}',
        DEFAULT_COMPLETION_LIMIT
      );
    });

    it('strips wrapping quotes and UTF-8 escapes the search term', async () => {
      const languageProvider = createLanguageProviderMock();
      languageProvider.queryLabelValues.mockResolvedValue([]);
      const dataProvider = createDataProvider(languageProvider);

      await dataProvider.queryMetricNames(timeRange, '"metric.name"');

      // removeQuotesIfExist drops the quotes, then escapeForUtf8Support turns the
      // non-legacy "." into its escaped code-point form (_2e_).
      expect(languageProvider.queryLabelValues).toHaveBeenCalledWith(
        timeRange,
        METRIC_LABEL,
        '{__name__=~".*U__metric_2e_name.*"}',
        DEFAULT_COMPLETION_LIMIT
      );
    });

    it('routes the search term to the server-side search (no regex matcher) when supported', async () => {
      const languageProvider = {
        ...createLanguageProviderMock(),
        hasServerSideSearch: jest.fn().mockReturnValue(true),
        streamMetrics: jest.fn().mockReturnValue(of(['http_requests_total'])),
      };
      const dataProvider = createDataProvider(languageProvider);

      const result = await dataProvider.queryMetricNames(timeRange, 'requests');

      expect(result).toEqual(['http_requests_total']);
      // Typed text goes straight to the streaming search (search[]) — no __name__=~ regex.
      expect(languageProvider.streamMetrics).toHaveBeenCalledWith(
        timeRange,
        'requests',
        undefined,
        DEFAULT_COMPLETION_LIMIT,
        'monaco-metrics'
      );
      expect(languageProvider.queryLabelValues).not.toHaveBeenCalled();
    });

    it('returns an empty array when the language provider rejects', async () => {
      const languageProvider = createLanguageProviderMock();
      languageProvider.queryLabelValues.mockRejectedValue(new Error('network down'));
      const dataProvider = createDataProvider(languageProvider);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await dataProvider.queryMetricNames(timeRange, 'up');

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('returns an empty array when the result is not an array', async () => {
      const languageProvider = createLanguageProviderMock();
      languageProvider.queryLabelValues.mockResolvedValue(undefined);
      const dataProvider = createDataProvider(languageProvider);

      const result = await dataProvider.queryMetricNames(timeRange, undefined);

      expect(result).toEqual([]);
    });
  });

  describe('metricNamesToMetrics', () => {
    it('maps metadata help/type with empty-string fallbacks', () => {
      const languageProvider = createLanguageProviderMock({
        http_requests_total: { type: 'counter', help: 'Total HTTP requests' },
      });
      const dataProvider = createDataProvider(languageProvider);

      const metrics = dataProvider.metricNamesToMetrics(['http_requests_total', 'unknown_metric']);

      expect(metrics).toEqual([
        { name: 'http_requests_total', help: 'Total HTTP requests', type: 'counter', isUtf8: false },
        { name: 'unknown_metric', help: '', type: '', isUtf8: false },
      ]);
    });

    it('flags non-legacy names as UTF-8', () => {
      const languageProvider = createLanguageProviderMock({});
      const dataProvider = createDataProvider(languageProvider);

      const metrics = dataProvider.metricNamesToMetrics(['metric.with.dots']);

      expect(metrics).toEqual([{ name: 'metric.with.dots', help: '', type: '', isUtf8: true }]);
    });
  });

  describe('getHistory', () => {
    it('returns expressions and drops falsy entries', () => {
      const languageProvider = createLanguageProviderMock();
      const history: Array<HistoryItem<PromQuery>> = [
        { ts: 1, query: { refId: 'A', expr: 'up' } },
        { ts: 2, query: { refId: 'B', expr: '' } },
        { ts: 3, query: { refId: 'C', expr: 'rate(http_requests_total[5m])' } },
      ];
      const dataProvider = createDataProvider(languageProvider, history);

      expect(dataProvider.getHistory()).toEqual(['up', 'rate(http_requests_total[5m])']);
    });
  });
});
