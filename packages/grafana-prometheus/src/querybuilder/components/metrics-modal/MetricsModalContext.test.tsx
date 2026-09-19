import { act, render, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';

import { type TimeRange } from '@grafana/data';
import { reportInteraction } from '@grafana/runtime';

import { type PrometheusLanguageProviderInterface } from '../../../language_provider';
import { SearchApiUnavailableError } from '../../../search_api_stream';
import { getMockTimeRange } from '../../../test/mocks/datasource';
import { type QueryBuilderLabelFilter } from '../../shared/types';

import { DEFAULT_RESULTS_PER_PAGE, MetricsModalContextProvider, useMetricsModal } from './MetricsModalContext';
import { generateMetricData } from './helpers';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  reportInteraction: jest.fn(),
}));

// Mock dependencies
jest.mock('./helpers', () => ({
  generateMetricData: jest.fn(),
}));

const mockGenerateMetricData = generateMetricData as jest.MockedFunction<typeof generateMetricData>;

// Mock language provider
const mockLanguageProvider: PrometheusLanguageProviderInterface = {
  queryMetricsMetadata: jest.fn(),
  queryLabelValues: jest.fn(),
  retrieveMetricsMetadata: jest.fn(),
  hasSearchSupport: jest.fn().mockReturnValue(false),
  getSearchApiClient: jest.fn().mockReturnValue(undefined),
  datasource: {
    interpolateString: (value: string) => value,
  },
} as unknown as PrometheusLanguageProviderInterface;

// Helper to create wrapper component
const createWrapper = (
  languageProvider = mockLanguageProvider,
  queryLabels: QueryBuilderLabelFilter[] | undefined = undefined
) => {
  return ({ children }: { children: ReactNode }) => (
    <MetricsModalContextProvider
      languageProvider={languageProvider}
      queryLabels={queryLabels}
      timeRange={getMockTimeRange()}
    >
      {children}
    </MetricsModalContextProvider>
  );
};

// Sample time range for tests
const defaultTimeRange: TimeRange = {
  from: 'now-1h' as unknown as TimeRange['from'],
  to: 'now' as unknown as TimeRange['to'],
  raw: {
    from: 'now-1h',
    to: 'now',
  },
};

describe('MetricsModalContext', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (mockLanguageProvider.hasSearchSupport as jest.Mock).mockReturnValue(false);
    (mockLanguageProvider.getSearchApiClient as jest.Mock).mockReturnValue(undefined);
    // Mock console.error to suppress React act() warnings
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Default mock implementations
    mockGenerateMetricData.mockImplementation((metric) => ({
      value: metric,
      type: 'counter',
      description: 'Test metric',
    }));
    (mockLanguageProvider.queryMetricsMetadata as jest.Mock).mockResolvedValue({
      test_metric: { type: 'counter', help: 'Test metric' },
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('useMetricsModal hook', () => {
    it('should throw error when used outside provider', () => {
      expect(() => {
        renderHook(() => useMetricsModal());
      }).toThrow('useMetricsModal must be used within a MetricsModalContextProvider');
    });

    it('should provide context value when used within provider', () => {
      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBeDefined();
      expect(result.current.isLoading).toBe(true); // Initially loading
      expect(result.current.filteredMetricsData).toEqual([]);
      expect(result.current.pagination).toEqual({
        pageNum: 1,
        totalPageNum: 1,
        resultsPerPage: DEFAULT_RESULTS_PER_PAGE,
      });
      expect(result.current.selectedTypes).toEqual([]);
      expect(result.current.searchedText).toBe('');
    });
  });

  describe('State management', () => {
    it('should update pagination', () => {
      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      const expectedPagination = { pageNum: 1, resultsPerPage: 50, totalPageNum: 1 };

      act(() => {
        result.current.setPagination({ pageNum: 2, resultsPerPage: 50, totalPageNum: 3 });
      });

      expect(result.current.pagination).toEqual(expectedPagination);
    });

    it('should update selected types', () => {
      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      const newTypes = [{ value: 'counter', label: 'Counter' }];

      act(() => {
        result.current.setSelectedTypes(newTypes);
      });

      expect(result.current.selectedTypes).toEqual(newTypes);
    });

    it('should update searched text', () => {
      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.setSearchedText('test_metric');
      });

      expect(result.current.searchedText).toBe('test_metric');
    });

    it('should update loading state', () => {
      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.setIsLoading(false);
      });

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('Metadata fetching', () => {
    it('should load initial metadata on mount', async () => {
      const mockMetadata = {
        cpu_usage: { type: 'gauge', help: 'CPU usage percentage' },
        memory_usage: { type: 'gauge', help: 'Memory usage bytes' },
      };

      (mockLanguageProvider.queryMetricsMetadata as jest.Mock).mockResolvedValue(mockMetadata);

      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      // Wait for metadata to load
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockLanguageProvider.queryMetricsMetadata).toHaveBeenCalledWith(1000);
      expect(mockGenerateMetricData).toHaveBeenCalledWith('cpu_usage', mockLanguageProvider);
      expect(mockGenerateMetricData).toHaveBeenCalledWith('memory_usage', mockLanguageProvider);
      expect(result.current.filteredMetricsData).toHaveLength(2);
    });

    it('filters initial metric discovery with query labels', async () => {
      (mockLanguageProvider.queryMetricsMetadata as jest.Mock).mockResolvedValue({
        cpu_usage: { type: 'gauge', help: 'CPU usage percentage' },
        memory_usage: { type: 'gauge', help: 'Memory usage bytes' },
      });
      (mockLanguageProvider.queryLabelValues as jest.Mock).mockResolvedValue(['cpu_usage']);
      const queryLabels = [{ label: 'job', op: '!=', value: 'grafana' }];

      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(mockLanguageProvider, queryLabels),
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(mockLanguageProvider.queryLabelValues).toHaveBeenCalledWith(
        expect.anything(),
        '__name__',
        '{job!="grafana"}',
        1000
      );
      expect(result.current.filteredMetricsData).toHaveLength(1);
    });

    it('should handle empty metadata response', async () => {
      (mockLanguageProvider.queryMetricsMetadata as jest.Mock).mockResolvedValue({});
      (mockLanguageProvider.queryLabelValues as jest.Mock).mockResolvedValue(['metric1', 'metric2']);

      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.filteredMetricsData).toEqual([
        {
          value: 'metric1',
          type: 'counter',
          description: 'Test metric',
        },
        {
          value: 'metric2',
          type: 'counter',
          description: 'Test metric',
        },
      ]);
    });

    it('should handle metadata fetch error', async () => {
      (mockLanguageProvider.queryMetricsMetadata as jest.Mock).mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.filteredMetricsData).toEqual([]);
    });
  });

  describe('Backend search', () => {
    it('passes query labels to initial Search API discovery', async () => {
      const searchMetricNames = jest.fn().mockResolvedValue({ results: [], warnings: [], hasMore: false });
      const searchLanguageProvider = {
        ...mockLanguageProvider,
        hasSearchSupport: jest.fn().mockReturnValue(true),
        getSearchApiClient: jest.fn().mockReturnValue({ searchMetricNames }),
      } as unknown as PrometheusLanguageProviderInterface;

      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(searchLanguageProvider, [{ label: 'job', op: '!~', value: 'test.*' }]),
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(searchMetricNames).toHaveBeenCalledWith(
        expect.anything(),
        '',
        expect.objectContaining({ match: '{job!~"test.*"}' })
      );
    });

    it('appends Search API batches incrementally', async () => {
      let resolveSearch: (() => void) | undefined;
      const searchMetricNames = jest.fn().mockImplementation((_timeRange, term, options) => {
        if (term === '') {
          return Promise.resolve({ results: [], warnings: [], hasMore: false });
        }

        options.onBatch([{ name: 'first_metric', type: 'counter', help: 'First metric' }]);
        return new Promise((resolve) => {
          resolveSearch = () => {
            options.onBatch([{ name: 'second_metric', type: 'gauge', help: 'Second metric' }]);
            resolve({ results: [], warnings: [], hasMore: false });
          };
        });
      });
      const searchLanguageProvider = {
        ...mockLanguageProvider,
        hasSearchSupport: jest.fn().mockReturnValue(true),
        getSearchApiClient: jest.fn().mockReturnValue({ searchMetricNames }),
      } as unknown as PrometheusLanguageProviderInterface;
      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(searchLanguageProvider),
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let pendingSearch!: Promise<void>;
      act(() => {
        pendingSearch = result.current.debouncedBackendSearch(defaultTimeRange, 'http   req');
      });

      await waitFor(() => {
        expect(result.current.filteredMetricsData).toEqual([
          { value: 'first_metric', type: 'counter', description: 'First metric' },
        ]);
      });

      await act(async () => {
        resolveSearch?.();
        await pendingSearch;
      });

      expect(result.current.filteredMetricsData).toEqual([
        { value: 'first_metric', type: 'counter', description: 'First metric' },
        { value: 'second_metric', type: 'gauge', description: 'Second metric' },
      ]);
      expect(searchMetricNames).toHaveBeenCalledWith(
        defaultTimeRange,
        'http   req',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(searchLanguageProvider.queryLabelValues).not.toHaveBeenCalled();
      expect(reportInteraction).toHaveBeenCalledWith('grafana_prometheus_metrics_explorer_search_performed', {
        searchQuery: 'http   req',
        resultsCount: 2,
        discoveryApi: 'search',
      });
    });

    it('invalidates an active stream as soon as the search text changes', async () => {
      let resolveSearch: (() => void) | undefined;
      let activeSignal: AbortSignal | undefined;
      const searchMetricNames = jest.fn().mockImplementation((_timeRange, term, options) => {
        if (term === '') {
          return Promise.resolve({ results: [], warnings: [], hasMore: false });
        }

        activeSignal = options.signal;
        options.onBatch([{ name: 'first_metric' }]);
        return new Promise((resolve) => {
          resolveSearch = () => {
            options.onBatch([{ name: 'stale_metric' }]);
            resolve({ results: [], warnings: [], hasMore: false });
          };
        });
      });
      const searchLanguageProvider = {
        ...mockLanguageProvider,
        hasSearchSupport: jest.fn().mockReturnValue(true),
        getSearchApiClient: jest.fn().mockReturnValue({ searchMetricNames }),
      } as unknown as PrometheusLanguageProviderInterface;
      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(searchLanguageProvider),
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let pendingSearch!: Promise<void>;
      act(() => {
        pendingSearch = result.current.debouncedBackendSearch(defaultTimeRange, 'first');
      });
      await waitFor(() => expect(result.current.filteredMetricsData).toHaveLength(1));

      act(() => result.current.setSearchedText('second'));
      expect(activeSignal?.aborted).toBe(true);

      await act(async () => {
        resolveSearch?.();
        await pendingSearch;
      });

      expect(result.current.filteredMetricsData.map((metric) => metric.value)).toEqual(['first_metric']);
    });

    it('does not start a queued debounced search after unmount', async () => {
      const searchMetricNames = jest.fn().mockResolvedValue({ results: [], warnings: [], hasMore: false });
      const searchLanguageProvider = {
        ...mockLanguageProvider,
        hasSearchSupport: jest.fn().mockReturnValue(true),
        getSearchApiClient: jest.fn().mockReturnValue({ searchMetricNames }),
      } as unknown as PrometheusLanguageProviderInterface;
      const { result, unmount } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(searchLanguageProvider),
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let pendingSearch!: Promise<void>;
      act(() => {
        pendingSearch = result.current.debouncedBackendSearch(defaultTimeRange, 'queued');
      });
      unmount();
      await act(async () => pendingSearch);

      expect(searchMetricNames).toHaveBeenCalledTimes(1);
      expect(searchMetricNames).toHaveBeenCalledWith(expect.anything(), '', expect.anything());
    });

    it('falls back to standard discovery when the Search API is unavailable', async () => {
      const searchMetricNames = jest.fn().mockRejectedValue(new SearchApiUnavailableError('disabled'));
      const searchLanguageProvider = {
        ...mockLanguageProvider,
        hasSearchSupport: jest.fn().mockReturnValue(false),
        getSearchApiClient: jest.fn().mockReturnValue({ searchMetricNames }),
        queryLabelValues: jest.fn().mockResolvedValue(['standard_metric']),
      } as unknown as PrometheusLanguageProviderInterface;
      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(searchLanguageProvider),
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.debouncedBackendSearch(defaultTimeRange, 'standard');
      });

      expect(searchLanguageProvider.queryLabelValues).toHaveBeenCalledWith(
        defaultTimeRange,
        '__name__',
        '{__name__=~"(?i).*standard.*"}'
      );
      expect(result.current.filteredMetricsData).toEqual([
        { value: 'standard_metric', type: 'counter', description: 'Test metric' },
      ]);
    });

    it('does not fall back when a Search API request is aborted', async () => {
      const abortError = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
      const searchMetricNames = jest.fn().mockRejectedValue(abortError);
      const searchLanguageProvider = {
        ...mockLanguageProvider,
        hasSearchSupport: jest.fn().mockReturnValue(true),
        getSearchApiClient: jest.fn().mockReturnValue({ searchMetricNames }),
        queryLabelValues: jest.fn().mockResolvedValue(['standard_metric']),
      } as unknown as PrometheusLanguageProviderInterface;
      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(searchLanguageProvider),
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.debouncedBackendSearch(defaultTimeRange, 'standard');
      });

      expect(searchLanguageProvider.queryLabelValues).not.toHaveBeenCalled();
    });

    it('should perform backend search with results', async () => {
      (mockLanguageProvider.queryLabelValues as jest.Mock).mockResolvedValue(['test_metric', 'other_metric']);

      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.debouncedBackendSearch(defaultTimeRange, 'test');
      });

      expect(mockLanguageProvider.queryLabelValues).toHaveBeenCalledWith(
        defaultTimeRange,
        '__name__',
        '{__name__=~"(?i).*test.*"}'
      );
      expect(result.current.filteredMetricsData).toHaveLength(1);
    });

    it('should handle backend search error', async () => {
      (mockLanguageProvider.queryLabelValues as jest.Mock).mockRejectedValue(new Error('Search failed'));

      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.debouncedBackendSearch(defaultTimeRange, 'test');
      });

      expect(result.current.filteredMetricsData).toEqual([]);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('Filtering logic', () => {
    it('should return all metrics when no types are selected', async () => {
      mockGenerateMetricData.mockImplementation((metric) => ({
        value: metric,
        type: 'counter',
        description: 'Test metric',
      }));

      (mockLanguageProvider.queryMetricsMetadata as jest.Mock).mockResolvedValue({
        ALERTS: { type: 'gauge', help: 'Test alerts help' },
        test_metric: { type: 'counter', help: 'Test metric' },
      });

      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.filteredMetricsData).toHaveLength(2);
      expect(result.current.selectedTypes).toEqual([]);
    });

    it('should filter metrics by selected type', async () => {
      mockGenerateMetricData.mockImplementation((metric) => ({
        value: metric,
        type: metric === 'counter_metric' ? 'counter' : 'gauge',
        description: 'Test metric',
      }));

      (mockLanguageProvider.queryMetricsMetadata as jest.Mock).mockResolvedValue({
        counter_metric: { type: 'counter', help: 'Counter metric' },
        gauge_metric: { type: 'gauge', help: 'Gauge metric' },
      });

      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      act(() => {
        result.current.setSelectedTypes([{ value: 'counter', label: 'Counter' }]);
      });

      expect(result.current.filteredMetricsData).toHaveLength(1);
      expect(result.current.filteredMetricsData[0].value).toBe('counter_metric');
    });

    it('should handle metrics without type when "no type" is selected', async () => {
      mockGenerateMetricData.mockImplementation((metric) => ({
        value: metric,
        type: metric === 'no_type_metric' ? undefined : 'counter',
        description: 'Test metric',
      }));

      (mockLanguageProvider.queryMetricsMetadata as jest.Mock).mockResolvedValue({
        counter_metric: { type: 'counter', help: 'Counter metric' },
        no_type_metric: { help: 'Metric without type' },
      });

      const { result } = renderHook(() => useMetricsModal(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      act(() => {
        result.current.setSelectedTypes([{ value: 'no type', label: 'No Type' }]);
      });

      expect(result.current.filteredMetricsData).toHaveLength(1);
      expect(result.current.filteredMetricsData[0].value).toBe('no_type_metric');
    });
  });

  describe('Component integration', () => {
    it('should render provider without errors', () => {
      const TestComponent = () => {
        return <div data-testid="test">frontend</div>;
      };

      const { getByTestId } = render(
        <MetricsModalContextProvider languageProvider={mockLanguageProvider} timeRange={getMockTimeRange()}>
          <TestComponent />
        </MetricsModalContextProvider>
      );

      expect(getByTestId('test')).toHaveTextContent('frontend');
    });
  });
});
