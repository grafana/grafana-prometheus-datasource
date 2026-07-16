import debounce from 'debounce-promise';
import {
  createContext,
  type FC,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { type SelectableValue, type TimeRange } from '@grafana/data';

import { METRIC_LABEL, PROMETHEUS_QUERY_BUILDER_MAX_RESULTS } from '../../../constants';
import { type PrometheusLanguageProviderInterface } from '../../../language_provider';
import { type SearchMetricResult } from '../../../search_api_client';
import { regexifyLabelValuesQueryString } from '../../parsingUtils';
import { type QueryBuilderLabelFilter } from '../../shared/types';
import { formatPrometheusLabelFilters } from '../formatter';

import { generateMetricData } from './helpers';
import { type MetricData, type MetricsData } from './types';
import { fuzzySearch } from './uFuzzy';

export const DEFAULT_RESULTS_PER_PAGE = 25;

type Pagination = {
  pageNum: number;
  resultsPerPage: number;
  totalPageNum: number;
};

type MetricsModalContextValue = {
  isLoading: boolean;
  setIsLoading: (val: boolean) => void;
  filteredMetricsData: MetricData[];
  debouncedBackendSearch: (
    timeRange: TimeRange,
    metricText: string,
    queryLabels?: QueryBuilderLabelFilter[]
  ) => Promise<void>;
  pagination: Pagination;
  setPagination: (val: Pagination) => void;
  selectedTypes: Array<SelectableValue<string>>;
  setSelectedTypes: (val: Array<SelectableValue<string>>) => void;
  searchedText: string;
  setSearchedText: (val: string) => void;
};

const MetricsModalContext = createContext<MetricsModalContextValue | undefined>(undefined);

type MetricsModalContextProviderProps = {
  languageProvider: PrometheusLanguageProviderInterface;
  timeRange: TimeRange;
};

export const MetricsModalContextProvider: FC<PropsWithChildren<MetricsModalContextProviderProps>> = ({
  children,
  languageProvider,
  timeRange,
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const [metricsData, setMetricsData] = useState<MetricsData>([]);
  const [pagination, setPagination] = useState<Pagination>({
    pageNum: 1,
    totalPageNum: 1,
    resultsPerPage: DEFAULT_RESULTS_PER_PAGE,
  });
  const [selectedTypes, setSelectedTypes] = useState<Array<SelectableValue<string>>>([]);
  const [searchedText, setSearchedText] = useState('');
  const latestSearchIdRef = useRef<number>(0);
  const searchAbortControllerRef = useRef<AbortController>();

  const filteredMetricsData = useMemo(() => {
    if (selectedTypes.length === 0) {
      return metricsData;
    }

    // Filter metrics based on selected types
    return metricsData.filter((metric: MetricData) => {
      return selectedTypes.some((selectedType) => {
        // Handle metrics with defined types
        if (metric.type && selectedType.value) {
          return metric.type.includes(selectedType.value);
        }

        // Handle metrics without type when "no type" is selected
        if (!metric.type && selectedType.value === 'no type') {
          return true;
        }

        return false;
      });
    });
  }, [metricsData, selectedTypes]);

  useEffect(() => {
    const totalPageNum =
      filteredMetricsData.length === 0 ? 1 : Math.ceil(filteredMetricsData.length / pagination.resultsPerPage);
    const pageNum = pagination.pageNum > totalPageNum ? 1 : pagination.pageNum;

    setPagination((prevPagination) => ({
      ...prevPagination,
      totalPageNum,
      pageNum,
    }));
  }, [filteredMetricsData.length, pagination.resultsPerPage, pagination.pageNum]);

  const toMetricData = useCallback(
    (result: SearchMetricResult): MetricData => ({
      value: result.name,
      type: result.type,
      description: result.help,
    }),
    []
  );

  const streamSearch = useCallback(
    async (
      searchId: number,
      searchTimeRange: TimeRange,
      metricText: string,
      queryLabels?: QueryBuilderLabelFilter[]
    ): Promise<boolean> => {
      const searchClient = languageProvider.getSearchApiClient();
      if (!searchClient) {
        return false;
      }

      // Abort saves work across browser → Grafana → plugin → Prometheus. The
      // search ID remains necessary because an already queued batch callback
      // can run after cancellation.
      searchAbortControllerRef.current?.abort();
      const abortController = new AbortController();
      searchAbortControllerRef.current = abortController;
      const filterArray = queryLabels ? formatPrometheusLabelFilters(queryLabels) : [];
      const match = filterArray.length > 0 ? `{__name__=~".*"${filterArray.join('')}}` : undefined;

      setIsLoading(true);
      setMetricsData([]);
      await searchClient.searchMetricNames(searchTimeRange, metricText, {
        // Search API metadata lets each batch render without waiting for the
        // separate /metadata request used by the legacy path below.
        includeMetadata: true,
        limit: PROMETHEUS_QUERY_BUILDER_MAX_RESULTS,
        match,
        signal: abortController.signal,
        onBatch: (batch) => {
          if (searchId === latestSearchIdRef.current) {
            setMetricsData((current) => [...current, ...batch.map(toMetricData)]);
          }
        },
      });

      if (searchId === latestSearchIdRef.current) {
        setIsLoading(false);
      }
      return true;
    },
    [languageProvider, toMetricData]
  );

  const fetchMetadata = useCallback(
    async (searchId = ++latestSearchIdRef.current) => {
      try {
        setIsLoading(true);
        if (await streamSearch(searchId, timeRange, '')) {
          return;
        }

        const metadata = await languageProvider.queryMetricsMetadata(PROMETHEUS_QUERY_BUILDER_MAX_RESULTS);

        // We receive ALERTS metadata in any case
        if (Object.keys(metadata).length <= 1) {
          const fetchedMetrics = await languageProvider.queryLabelValues(
            timeRange,
            METRIC_LABEL,
            undefined,
            PROMETHEUS_QUERY_BUILDER_MAX_RESULTS
          );
          const processedData = fetchedMetrics.map((m) => generateMetricData(m, languageProvider));
          setMetricsData(processedData);
        } else {
          const processedData = Object.keys(metadata).map((m) => generateMetricData(m, languageProvider));
          setMetricsData(processedData);
        }
      } catch (error) {
        // Search batches may already be visible when a mid-stream error occurs.
        // Preserve those partial results; the legacy path has no partial data.
        if (!languageProvider.hasSearchSupport()) {
          setMetricsData([]);
        }
      } finally {
        if (searchId === latestSearchIdRef.current) {
          setIsLoading(false);
        }
      }
    },
    [languageProvider, streamSearch, timeRange]
  );

  const debouncedBackendSearch = useMemo(
    () =>
      debounce(async (timeRange: TimeRange, metricText: string, queryLabels?: QueryBuilderLabelFilter[]) => {
        // Generate unique search ID to handle race conditions
        const searchId = ++latestSearchIdRef.current;

        try {
          if (metricText === '') {
            await fetchMetadata(searchId);
            return;
          }

          if (await streamSearch(searchId, timeRange, metricText, queryLabels)) {
            return;
          }

          setIsLoading(true);

          const queryString = regexifyLabelValuesQueryString(metricText);
          const filterArray = queryLabels ? formatPrometheusLabelFilters(queryLabels) : [];
          const match = `{__name__=~"(?i).*${queryString}"${filterArray ? filterArray.join('') : ''}}`;

          const results = await languageProvider.queryLabelValues(timeRange, METRIC_LABEL, match);

          // Check if this is still the most recent search
          if (searchId !== latestSearchIdRef.current) {
            return; // Ignore outdated results
          }

          const [fuzzyOrderedMetrics] = fuzzySearch(results, queryString);
          const resultsOptions: MetricsData = fuzzyOrderedMetrics.map((m) => generateMetricData(m, languageProvider));

          setMetricsData(resultsOptions);
          setIsLoading(false);
        } catch (error) {
          // Only update state if this is still the latest search
          if (searchId === latestSearchIdRef.current) {
            console.error('Backend search failed:', error);
            // Keep batches already rendered by the streaming path.
            if (!languageProvider.hasSearchSupport()) {
              setMetricsData([]);
            }
            setIsLoading(false);
          }
        }
      }, 300),
    [fetchMetadata, languageProvider, streamSearch]
  );

  useEffect(() => {
    fetchMetadata();

    return () => searchAbortControllerRef.current?.abort();
  }, [fetchMetadata]);

  return (
    <MetricsModalContext.Provider
      value={{
        isLoading,
        setIsLoading,
        filteredMetricsData,
        debouncedBackendSearch,
        pagination,
        setPagination,
        selectedTypes,
        setSelectedTypes,
        searchedText,
        setSearchedText,
      }}
    >
      {children}
    </MetricsModalContext.Provider>
  );
};

export function useMetricsModal() {
  const context = useContext(MetricsModalContext);
  if (context === undefined) {
    throw new Error('useMetricsModal must be used within a MetricsModalContextProvider');
  }
  return context;
}
