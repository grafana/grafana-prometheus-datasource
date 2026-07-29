import { createContext, type PropsWithChildren, useCallback, useContext, useMemo } from 'react';

import { type TimeRange } from '@grafana/data';
import { reportInteraction } from '@grafana/runtime';

import { type PrometheusLanguageProviderInterface } from '../../language_provider';

import { buildSelector } from './selectorBuilder';
import { useMetricsLabelsValues } from './useMetricsLabelsValues';

export interface Metric {
  name: string;
  details?: string;
}

/**
 * Context for the Metrics Browser component
 * Provides state and handlers for browsing and selecting Prometheus metrics and labels
 */
interface MetricsBrowserContextType {
  // Error and status state
  err: string;
  setErr: (err: string) => void;
  status: string;
  setStatus: (status: string) => void;

  // Series limit settings
  seriesLimit: number;
  setSeriesLimit: (limit: number) => void;

  // Callback when selector changes
  onChange: (selector: string) => void;

  // Data and selection state
  metrics: Metric[];
  labelKeys: string[];
  isLoadingLabelKeys: boolean;
  isLoadingLabelValues: boolean;
  labelValues: Record<string, string[]>;
  selectedMetric: string;
  selectedLabelKeys: string[];
  selectedLabelValues: Record<string, string[]>;

  // Event handlers
  onMetricClick: (name: string) => void;
  onLabelKeyClick: (name: string) => void;
  onLabelValueClick: (labelKey: string, labelValue: string, isSelected: boolean) => void;
  getSelector: () => string;
  onClearClick: () => void;

  // Validation
  validationStatus: string;
  onValidationClick: () => void;
}

const MetricsBrowserContext = createContext<MetricsBrowserContextType | undefined>(undefined);

type MetricsBrowserProviderProps = {
  timeRange: TimeRange;
  languageProvider: PrometheusLanguageProviderInterface;
  onChange: (selector: string) => void;
};

/**
 * Provider component for the Metrics Browser context
 * Manages state and data fetching for metrics, labels, and values
 */
export function MetricsBrowserProvider({
  children,
  timeRange,
  languageProvider,
  onChange,
}: PropsWithChildren<MetricsBrowserProviderProps>) {
  const {
    err,
    setErr,
    status,
    setStatus,
    seriesLimit,
    setSeriesLimit,
    validationStatus,
    metrics,
    labelKeys,
    isLoadingLabelKeys,
    isLoadingLabelValues,
    labelValues,
    selectedMetric,
    selectedLabelKeys,
    selectedLabelValues,
    handleSelectedMetricChange,
    handleSelectedLabelKeyChange,
    handleSelectedLabelValueChange,
    handleValidation,
    handleClear,
  } = useMetricsLabelsValues(timeRange, languageProvider);

  // Build a Prometheus selector string from the current selections
  const getSelector = useCallback(
    () => buildSelector(selectedMetric, selectedLabelValues),
    [selectedLabelValues, selectedMetric]
  );

  const onMetricClick = useCallback(
    (name: string) => {
      reportInteraction('grafana_prometheus_metrics_browser_metric_clicked', {
        action: selectedMetric === name ? 'deselected' : 'selected',
      });
      return handleSelectedMetricChange(name);
    },
    [handleSelectedMetricChange, selectedMetric]
  );

  const onLabelKeyClick = useCallback(
    (name: string) => {
      reportInteraction('grafana_prometheus_metrics_browser_label_key_clicked', {
        action: selectedLabelKeys.includes(name) ? 'deselected' : 'selected',
      });
      return handleSelectedLabelKeyChange(name);
    },
    [handleSelectedLabelKeyChange, selectedLabelKeys]
  );

  const onLabelValueClick = useCallback(
    (labelKey: string, labelValue: string, isSelected: boolean) => {
      reportInteraction('grafana_prometheus_metrics_browser_label_value_clicked', {
        action: isSelected ? 'selected' : 'deselected',
      });
      return handleSelectedLabelValueChange(labelKey, labelValue, isSelected);
    },
    [handleSelectedLabelValueChange]
  );

  const onValidationClick = useCallback(() => {
    reportInteraction('grafana_prometheus_metrics_browser_validate_clicked');
    return handleValidation();
  }, [handleValidation]);

  const onClearClick = useCallback(() => {
    reportInteraction('grafana_prometheus_metrics_browser_clear_clicked');
    return handleClear();
  }, [handleClear]);

  // Memoize the context value to prevent unnecessary re-renders
  const value = useMemo(
    () => ({
      err,
      setErr,
      status,
      setStatus,
      seriesLimit,
      setSeriesLimit,
      validationStatus,
      onChange,
      getSelector,
      metrics,
      labelKeys,
      isLoadingLabelKeys,
      isLoadingLabelValues,
      labelValues,
      selectedMetric,
      selectedLabelKeys,
      selectedLabelValues,
      onMetricClick,
      onLabelKeyClick,
      onLabelValueClick,
      onValidationClick,
      onClearClick,
    }),
    [
      err,
      setErr,
      status,
      setStatus,
      seriesLimit,
      setSeriesLimit,
      validationStatus,
      onChange,
      getSelector,
      metrics,
      labelKeys,
      isLoadingLabelKeys,
      isLoadingLabelValues,
      labelValues,
      selectedMetric,
      selectedLabelKeys,
      selectedLabelValues,
      onMetricClick,
      onLabelKeyClick,
      onLabelValueClick,
      onValidationClick,
      onClearClick,
    ]
  );

  return <MetricsBrowserContext.Provider value={value}>{children}</MetricsBrowserContext.Provider>;
}

/**
 * Hook to access the MetricsBrowser context
 * Must be used within a MetricsBrowserProvider
 */
export function useMetricsBrowser() {
  const context = useContext(MetricsBrowserContext);
  if (context === undefined) {
    throw new Error('useMetricsBrowser must be used within a MetricsBrowserProvider');
  }
  return context;
}
