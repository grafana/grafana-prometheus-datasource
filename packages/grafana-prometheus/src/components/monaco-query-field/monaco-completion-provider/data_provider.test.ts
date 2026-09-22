import { type HistoryItem, type TimeRange } from '@grafana/data';

import { DEFAULT_COMPLETION_LIMIT, METRIC_LABEL } from '../../../constants';
import { SearchApiUnavailableError } from '../../../search_api_stream';
import { type PromQuery } from '../../../types';

import { DataProvider, type DataProviderParams } from './data_provider';

const createLanguageProviderMock = (existingMetadata: Record<string, unknown> = {}) => ({
  queryLabelKeys: jest.fn(),
  queryLabelValues: jest.fn(),
  queryMetricsMetadata: jest.fn().mockResolvedValue({}),
  retrieveMetrics: jest.fn().mockReturnValue([]),
  retrieveMetricsMetadata: jest.fn().mockReturnValue(existingMetadata),
  getSearchApiClient: jest.fn().mockReturnValue(undefined),
  datasource: {
    interpolateString: (value: string) => value,
  },
});

const createDataProvider = (
  languageProvider: ReturnType<typeof createLanguageProviderMock>,
  historyProvider: Array<HistoryItem<PromQuery>> = []
) => {
  return new DataProvider({ languageProvider, historyProvider } as unknown as DataProviderParams);
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

    it('uses fuzzy search and aborts the superseded metric request', async () => {
      const languageProvider = createLanguageProviderMock();
      const searchMetricNames = jest
        .fn()
        .mockResolvedValue({ results: [{ name: 'http_requests_total' }], warnings: [], hasMore: false });
      languageProvider.getSearchApiClient.mockReturnValue({ searchMetricNames });
      const dataProvider = createDataProvider(languageProvider);

      await expect(dataProvider.queryMetricNames(timeRange, 'http   req')).resolves.toEqual(['http_requests_total']);
      const firstSignal = searchMetricNames.mock.calls[0][2].signal as AbortSignal;
      await dataProvider.queryMetricNames(timeRange, 'http requ');

      expect(searchMetricNames).toHaveBeenNthCalledWith(
        1,
        timeRange,
        'http   req',
        expect.objectContaining({ limit: DEFAULT_COMPLETION_LIMIT, signal: expect.any(AbortSignal) })
      );
      expect(searchMetricNames).toHaveBeenLastCalledWith(
        timeRange,
        'http requ',
        expect.objectContaining({ limit: DEFAULT_COMPLETION_LIMIT, signal: expect.any(AbortSignal) })
      );
      expect(firstSignal.aborted).toBe(true);
      expect(languageProvider.queryLabelValues).not.toHaveBeenCalled();
    });

    it('falls back to standard discovery when fuzzy search is unavailable', async () => {
      const languageProvider = createLanguageProviderMock();
      languageProvider.queryLabelValues.mockResolvedValue(['standard_metric']);
      languageProvider.getSearchApiClient.mockReturnValue({
        searchMetricNames: jest.fn().mockRejectedValue(new SearchApiUnavailableError('disabled')),
      });
      const dataProvider = createDataProvider(languageProvider);

      await expect(dataProvider.queryMetricNames(timeRange, 'metric')).resolves.toEqual(['standard_metric']);

      expect(languageProvider.queryLabelValues).toHaveBeenCalledWith(
        timeRange,
        METRIC_LABEL,
        '{__name__=~".*metric.*"}',
        DEFAULT_COMPLETION_LIMIT
      );
    });
  });

  describe('fuzzy label search', () => {
    it('searches label values using the typed term', async () => {
      const languageProvider = createLanguageProviderMock();
      const searchLabelValues = jest
        .fn()
        .mockResolvedValue({ results: [{ value: 'production' }], warnings: [], hasMore: false });
      languageProvider.getSearchApiClient.mockReturnValue({ searchLabelValues });
      const dataProvider = createDataProvider(languageProvider);

      await expect(
        dataProvider.queryLabelValues(
          timeRange,
          'environment',
          '{job="api"}',
          DEFAULT_COMPLETION_LIMIT,
          'datasource uid'
        )
      ).resolves.toEqual(['production']);

      expect(searchLabelValues).toHaveBeenCalledWith(
        timeRange,
        'environment',
        'datasource uid',
        expect.objectContaining({
          match: '{job="api"}',
          limit: DEFAULT_COMPLETION_LIMIT,
          signal: expect.any(AbortSignal),
        })
      );
      expect(languageProvider.queryLabelValues).not.toHaveBeenCalled();
    });

    it('returns an empty list when a search is aborted and does not fall back', async () => {
      const languageProvider = createLanguageProviderMock();
      const abortError = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
      languageProvider.getSearchApiClient.mockReturnValue({
        searchMetricNames: jest.fn().mockRejectedValue(abortError),
        searchLabelNames: jest.fn().mockRejectedValue(abortError),
        searchLabelValues: jest.fn().mockRejectedValue(abortError),
      });
      const dataProvider = createDataProvider(languageProvider);

      await expect(dataProvider.queryMetricNames(timeRange, 'up')).resolves.toEqual([]);
      await expect(
        dataProvider.queryLabelKeys(timeRange, undefined, DEFAULT_COMPLETION_LIMIT, 'job')
      ).resolves.toEqual([]);
      await expect(
        dataProvider.queryLabelValues(timeRange, 'job', undefined, DEFAULT_COMPLETION_LIMIT, 'api')
      ).resolves.toEqual([]);

      expect(languageProvider.queryLabelKeys).not.toHaveBeenCalled();
      expect(languageProvider.queryLabelValues).not.toHaveBeenCalled();
    });
  });

  describe('search lifecycle', () => {
    it('does not cancel a metric search when a label search starts', async () => {
      const languageProvider = createLanguageProviderMock();
      const searchMetricNames = jest
        .fn()
        .mockResolvedValue({ results: [{ name: 'up' }], warnings: [], hasMore: false });
      const searchLabelNames = jest
        .fn()
        .mockResolvedValue({ results: [{ name: 'job' }], warnings: [], hasMore: false });
      languageProvider.getSearchApiClient.mockReturnValue({ searchMetricNames, searchLabelNames });
      const dataProvider = createDataProvider(languageProvider);

      await dataProvider.queryMetricNames(timeRange, 'up');
      const metricSignal = searchMetricNames.mock.calls[0][2].signal as AbortSignal;
      await dataProvider.queryLabelKeys(timeRange, undefined, DEFAULT_COMPLETION_LIMIT, 'job');

      expect(metricSignal.aborted).toBe(false);
    });

    it('aborts every active search when disposed', () => {
      const languageProvider = createLanguageProviderMock();
      const never = new Promise(() => {});
      const searchMetricNames = jest.fn().mockReturnValue(never);
      const searchLabelNames = jest.fn().mockReturnValue(never);
      const searchLabelValues = jest.fn().mockReturnValue(never);
      languageProvider.getSearchApiClient.mockReturnValue({
        searchMetricNames,
        searchLabelNames,
        searchLabelValues,
      });
      const dataProvider = createDataProvider(languageProvider);

      void dataProvider.queryMetricNames(timeRange, 'up');
      void dataProvider.queryLabelKeys(timeRange, undefined, DEFAULT_COMPLETION_LIMIT, 'job');
      void dataProvider.queryLabelValues(timeRange, 'job', undefined, DEFAULT_COMPLETION_LIMIT, 'api');

      const metricSignal = searchMetricNames.mock.calls[0][2].signal as AbortSignal;
      const labelKeySignal = searchLabelNames.mock.calls[0][2].signal as AbortSignal;
      const labelValueSignal = searchLabelValues.mock.calls[0][3].signal as AbortSignal;

      dataProvider.dispose();

      expect(metricSignal.aborted).toBe(true);
      expect(labelKeySignal.aborted).toBe(true);
      expect(labelValueSignal.aborted).toBe(true);
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
