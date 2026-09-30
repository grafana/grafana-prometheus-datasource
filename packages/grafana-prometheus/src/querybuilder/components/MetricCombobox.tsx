import { css } from '@emotion/css';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type GrafanaTheme2, type SelectableValue, type TimeRange } from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors';
import { Trans, t } from '@grafana/i18n';
import { EditorField, EditorFieldGroup } from '@grafana/plugin-ui';
import { reportInteraction } from '@grafana/runtime';
import { Button, InlineField, InlineFieldRow, Select, useTheme2 } from '@grafana/ui';

import { DEFAULT_COMPLETION_LIMIT, METRIC_LABEL } from '../../constants';
import { type PrometheusDatasource } from '../../datasource';
import { isAbortError, SearchApiUnavailableError } from '../../search_api_stream';
import { type QueryBuilderLabelFilter } from '../shared/types';
import { type PromVisualQuery } from '../types';

import { formatKeyValueStrings, formatLabelFiltersToString } from './formatter';
import { MetricsModal } from './metrics-modal/MetricsModal';

export interface MetricComboboxProps {
  metricLookupDisabled: boolean;
  query: PromVisualQuery;
  onChange: (query: PromVisualQuery) => void;
  onGetMetrics: () => Promise<SelectableValue[]>;
  datasource: PrometheusDatasource;
  labelsFilters: QueryBuilderLabelFilter[];
  onBlur?: () => void;
  variableEditor?: boolean;
  timeRange: TimeRange;
}

export function MetricCombobox({
  datasource,
  query,
  onChange,
  onGetMetrics,
  labelsFilters,
  variableEditor,
  timeRange,
}: Readonly<MetricComboboxProps>) {
  const [metricsModalOpen, setMetricsModalOpen] = useState(false);
  const [options, setOptions] = useState<Array<SelectableValue<string>>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const searchAbortControllerRef = useRef<AbortController>();
  const requestIdRef = useRef(0);
  const typedInputRef = useRef('');
  const styles = getStyles(useTheme2());

  /**
   * Gets label_values response from prometheus API for current autocomplete query string and any existing labels filters
   */
  const getMetricLabels = useCallback(
    async (query: string, onBatch?: (options: Array<SelectableValue<string>>) => void) => {
      const searchClient = datasource.languageProvider.getSearchApiClient?.();
      if (searchClient) {
        searchAbortControllerRef.current?.abort();
        const abortController = new AbortController();
        searchAbortControllerRef.current = abortController;
        const rawMatch = formatLabelFiltersToString(labelsFilters) || undefined;
        const match = rawMatch ? datasource.interpolateString(rawMatch) : undefined;

        try {
          const response = await searchClient.searchMetricNames(timeRange, query, {
            limit: DEFAULT_COMPLETION_LIMIT,
            match,
            signal: abortController.signal,
            retainResults: false,
            includeMetadata: false,
            sortBy: 'alpha',
            onBatch: (batch) => {
              onBatch?.(batch.map((result) => ({ label: result.name, value: result.name })));
            },
          });
          return response.results.map((result) => ({
            label: result.name,
            value: result.name,
          }));
        } catch (error) {
          if (isAbortError(error)) {
            return [];
          }
          if (!(error instanceof SearchApiUnavailableError)) {
            throw error;
          }
        }
      }

      const match = formatKeyValueStrings(query, labelsFilters);
      const results = await datasource.languageProvider.queryLabelValues(timeRange, METRIC_LABEL, match);

      const resultsOptions = results.map((result) => {
        return {
          label: result,
          value: result,
        };
      });
      return resultsOptions;
    },
    [datasource, labelsFilters, timeRange]
  );

  useEffect(() => () => searchAbortControllerRef.current?.abort(), []);

  const loadMetrics = useCallback(
    async (input: string) => {
      const requestId = ++requestIdRef.current;
      setIsLoading(true);
      setOptions([]);
      const useSearch = Boolean(datasource.languageProvider.getSearchApiClient?.()) || input.length > 0;
      let streamed = false;
      const collected: Array<SelectableValue<string>> = [];
      try {
        const metrics = useSearch
          ? await getMetricLabels(input, (batch) => {
              if (requestId !== requestIdRef.current) {
                return;
              }
              streamed = true;
              for (const option of batch) {
                if (collected.length >= DEFAULT_COMPLETION_LIMIT) {
                  break;
                }
                collected.push(option);
              }
              setOptions(collected.slice());
            })
          : await onGetMetrics();
        if (requestId !== requestIdRef.current || streamed) {
          return;
        }
        setOptions(
          metrics.map((option) => ({
            label: option.label ?? option.value,
            value: option.value ?? '',
          }))
        );
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    },
    [datasource.languageProvider, getMetricLabels, onGetMetrics]
  );

  const onMetricChange = useCallback(
    (opt: SelectableValue<string> | null) => {
      onChange({ ...query, metric: opt?.value ?? '' });
    },
    [onChange, query]
  );

  const asyncSelect = () => {
    return (
      <div className={styles.wrapper}>
        <Select
          placeholder={t(
            'grafana-prometheus.querybuilder.metric-combobox.async-select.placeholder-select-metric',
            'Select metric'
          )}
          width="auto"
          options={options}
          value={query.metric ? { label: query.metric, value: query.metric } : null}
          onChange={onMetricChange}
          onOpenMenu={() => {
            // Typing into a closed menu already called onInputChange. Opening
            // the menu right after that must not replace it with an empty search.
            if (typedInputRef.current.length > 0) {
              return;
            }
            void loadMetrics('');
          }}
          onInputChange={(value, meta) => {
            if (meta.action === 'input-change') {
              typedInputRef.current = value;
              void loadMetrics(value);
              return;
            }
            if (meta.action === 'menu-close' || meta.action === 'input-blur' || meta.action === 'set-value') {
              typedInputRef.current = '';
            }
          }}
          onCloseMenu={() => {
            typedInputRef.current = '';
            searchAbortControllerRef.current?.abort();
            requestIdRef.current += 1;
            setIsLoading(false);
          }}
          isLoading={isLoading}
          allowCustomValue
          filterOption={() => true}
          data-testid={selectors.components.DataSource.Prometheus.queryEditor.builder.metricSelect}
        />
        <Button
          tooltip={t(
            'grafana-prometheus.querybuilder.metric-combobox.async-select.tooltip-open-metrics-explorer',
            'Open metrics explorer'
          )}
          aria-label={t(
            'grafana-prometheus.querybuilder.metric-combobox.async-select.aria-label-open-metrics-explorer',
            'Open metrics explorer'
          )}
          variant="secondary"
          icon="book-open"
          className={styles.button}
          disabled={datasource.lookupsDisabled}
          onClick={() => {
            reportInteraction('grafana_prometheus_metrics_explorer_opened', {
              hasSelectedMetric: !!query.metric,
            });
            setMetricsModalOpen(true);
          }}
        />
      </div>
    );
  };

  return (
    <>
      {!datasource.lookupsDisabled && metricsModalOpen && (
        <MetricsModal
          datasource={datasource}
          isOpen={metricsModalOpen}
          onClose={() => setMetricsModalOpen(false)}
          query={query}
          onChange={onChange}
          timeRange={timeRange}
        />
      )}
      {variableEditor ? (
        <InlineFieldRow>
          <InlineField
            label={t('grafana-prometheus.querybuilder.metric-combobox.label-metric', 'Metric')}
            labelWidth={20}
            tooltip={
              <div>
                <Trans i18nKey="grafana-prometheus.querybuilder.metric-combobox.tooltip-metric">
                  Optional: returns a list of label values for the label name in the specified metric.
                </Trans>
              </div>
            }
          >
            {asyncSelect()}
          </InlineField>
        </InlineFieldRow>
      ) : (
        <EditorFieldGroup>
          <EditorField label={t('grafana-prometheus.querybuilder.metric-combobox.label-metric', 'Metric')}>
            {asyncSelect()}
          </EditorField>
        </EditorFieldGroup>
      )}
    </>
  );
}

const getStyles = (theme: GrafanaTheme2) => {
  return {
    wrapper: css({
      display: 'flex',
      input: {
        borderTopRightRadius: 'unset',
        borderBottomRightRadius: 'unset',
      },
    }),
    button: css({
      borderTopLeftRadius: 'unset',
      borderBottomLeftRadius: 'unset',
    }),
  };
};
