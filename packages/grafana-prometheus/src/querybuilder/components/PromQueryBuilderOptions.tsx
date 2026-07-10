// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/querybuilder/components/PromQueryBuilderOptions.tsx
import { map } from 'lodash';
import { type SyntheticEvent } from 'react';
import * as React from 'react';

import { CoreApp, type SelectableValue } from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors';
import { Trans, t } from '@grafana/i18n';
import { EditorField, EditorSwitch } from '@grafana/plugin-ui';
import { AutoSizeInput, Box, RadioButtonGroup, Select } from '@grafana/ui';

import { getQueryTypeChangeHandler, getQueryTypeOptions } from '../../components/PromExploreExtraField';
import { type PromQueryFormat } from '../../dataquery';
import { type PromQuery } from '../../types';
import { QueryOptionGroup } from '../shared/QueryOptionGroup';

import { getLegendModeLabel, PromQueryLegendEditor } from './PromQueryLegendEditor';

/**
 * Per-section visibility flags. Each defaults to `true` when undefined,
 * so the default rendering is unchanged. Useful for embedders (non-Prometheus
 * datasources) that only support a subset of these options.
 *
 * Note: `exemplars` and `resolution` are also subject to existing conditional
 * logic — exemplars are still hidden in UnifiedAlerting or when range is off,
 * and resolution still requires `query.intervalFactor > 1`.
 */
export interface PromQueryBuilderUIOptions {
  legend?: boolean;
  minStep?: boolean;
  format?: boolean;
  type?: boolean;
  disableTypeBoth?: boolean;
  exemplars?: boolean;
  resolution?: boolean;
}

interface PromQueryBuilderOptionsProps {
  query: PromQuery;
  app?: CoreApp;
  onChange: (update: PromQuery) => void;
  onRunQuery: () => void;
  uiOptions?: PromQueryBuilderUIOptions;
  formatOptions?: Array<SelectableValue<PromQueryFormat>>;
}

const INTERVAL_FACTOR_OPTIONS: Array<SelectableValue<number>> = map([1, 2, 3, 4, 5, 10], (value: number) => ({
  value,
  label: '1/' + value,
}));

export const PromQueryBuilderOptions = React.memo<PromQueryBuilderOptionsProps>(
  ({ query, app, onChange, onRunQuery, uiOptions, formatOptions }) => {
    const showLegend = uiOptions?.legend ?? true;
    const showMinStep = uiOptions?.minStep ?? true;
    const showFormat = uiOptions?.format ?? true;
    const showType = uiOptions?.type ?? true;
    const showExemplars = uiOptions?.exemplars ?? true;
    const showResolution = uiOptions?.resolution ?? true;

    const FORMAT_OPTIONS: Array<SelectableValue<PromQueryFormat>> = formatOptions ?? [
      {
        label: t(
          'grafana-prometheus.querybuilder.prom-query-builder-options.format-options.label-time-series',
          'Time series'
        ),
        value: 'time_series',
      },
      {
        label: t('grafana-prometheus.querybuilder.prom-query-builder-options.format-options.label-table', 'Table'),
        value: 'table',
      },
      {
        label: t('grafana-prometheus.querybuilder.prom-query-builder-options.format-options.label-heatmap', 'Heatmap'),
        value: 'heatmap',
      },
    ];

    const onChangeFormat = (value: SelectableValue<PromQueryFormat>) => {
      onChange({ ...query, format: value.value });
      onRunQuery();
    };

    const onChangeStep = (evt: React.FormEvent<HTMLInputElement>) => {
      onChange({ ...query, interval: evt.currentTarget.value.trim() });
      onRunQuery();
    };

    const queryTypeOptions = getQueryTypeOptions(
      !uiOptions?.disableTypeBoth &&
        (app === CoreApp.Explore || app === CoreApp.Correlations || app === CoreApp.PanelEditor)
    );

    const onQueryTypeChange = getQueryTypeChangeHandler(query, onChange);

    const onExemplarChange = (event: SyntheticEvent<HTMLInputElement>) => {
      const isEnabled = event.currentTarget.checked;
      onChange({ ...query, exemplar: isEnabled });
      onRunQuery();
    };

    const onIntervalFactorChange = (value: SelectableValue<number>) => {
      onChange({ ...query, intervalFactor: value.value });
      onRunQuery();
    };

    const formatOption = FORMAT_OPTIONS.find((option) => option.value === query.format) || FORMAT_OPTIONS[0];
    const queryTypeValue = getQueryTypeValue(query);
    const queryTypeLabel = queryTypeOptions.find((x) => x.value === queryTypeValue)!.label;

    return (
      <Box backgroundColor={'secondary'} borderRadius="default">
        <div data-testid={selectors.components.DataSource.Prometheus.queryEditor.options}>
          <QueryOptionGroup
            title={t('grafana-prometheus.querybuilder.prom-query-builder-options.title-options', 'Options')}
            collapsedInfo={getCollapsedInfo(query, formatOption.label!, queryTypeLabel, app, {
              legend: showLegend,
              minStep: showMinStep,
              format: showFormat,
              type: showType,
              exemplars: showExemplars,
            })}
          >
            {showLegend && (
              <PromQueryLegendEditor
                legendFormat={query.legendFormat}
                onChange={(legendFormat) => onChange({ ...query, legendFormat })}
                onRunQuery={onRunQuery}
              />
            )}
            {showMinStep && (
              <EditorField
                label={t('grafana-prometheus.querybuilder.prom-query-builder-options.label-min-step', 'Min step')}
                tooltip={
                  <>
                    <Trans
                      i18nKey="grafana-prometheus.querybuilder.prom-query-builder-options.tooltip-min-step"
                      values={{
                        interval: '$__interval',
                        rateInterval: '$__rate_interval',
                      }}
                    >
                      An additional lower limit for the step parameter of the Prometheus query and for the{' '}
                      <code>{'{{interval}}'}</code> and <code>{'{{rateInterval}}'}</code> variables.
                    </Trans>
                  </>
                }
              >
                <AutoSizeInput
                  type="text"
                  aria-label={t(
                    'grafana-prometheus.querybuilder.prom-query-builder-options.aria-label-lower-limit-parameter',
                    'Min step text box, set lower limit for the step parameter'
                  )}
                  placeholder={t('grafana-prometheus.querybuilder.prom-query-builder-options.placeholder-auto', 'auto')}
                  minWidth={10}
                  onCommitChange={onChangeStep}
                  defaultValue={query.interval}
                  data-testid={selectors.components.DataSource.Prometheus.queryEditor.step}
                />
              </EditorField>
            )}
            {showFormat && (
              <EditorField
                label={t('grafana-prometheus.querybuilder.prom-query-builder-options.label-format', 'Format')}
              >
                <Select
                  data-testid={selectors.components.DataSource.Prometheus.queryEditor.format}
                  value={formatOption}
                  allowCustomValue
                  onChange={onChangeFormat}
                  options={FORMAT_OPTIONS}
                  aria-label={t(
                    'grafana-prometheus.querybuilder.prom-query-builder-options.aria-label-format',
                    'Format combobox'
                  )}
                />
              </EditorField>
            )}
            {showType && (
              <EditorField
                label={t('grafana-prometheus.querybuilder.prom-query-builder-options.label-type', 'Type')}
                data-testid={selectors.components.DataSource.Prometheus.queryEditor.type}
                useFieldset={false}
              >
                <RadioButtonGroup
                  options={queryTypeOptions}
                  value={queryTypeValue}
                  onChange={onQueryTypeChange}
                  aria-label={t(
                    'grafana-prometheus.querybuilder.prom-query-builder-options.aria-label-type',
                    'Type radio button group'
                  )}
                />
              </EditorField>
            )}
            {showExemplars && shouldShowExemplarSwitch(query, app) && (
              <EditorField
                label={t('grafana-prometheus.querybuilder.prom-query-builder-options.label-exemplars', 'Exemplars')}
              >
                <EditorSwitch
                  value={query.exemplar || false}
                  onChange={onExemplarChange}
                  data-testid={selectors.components.DataSource.Prometheus.queryEditor.exemplars}
                  aria-label={t(
                    'grafana-prometheus.querybuilder.prom-query-builder-options.aria-label-exemplars',
                    'Exemplars switch.'
                  )}
                />
              </EditorField>
            )}
            {showResolution && query.intervalFactor && query.intervalFactor > 1 && (
              <EditorField
                label={t('grafana-prometheus.querybuilder.prom-query-builder-options.label-resolution', 'Resolution')}
              >
                <Select
                  aria-label={t(
                    'grafana-prometheus.querybuilder.prom-query-builder-options.aria-label-select-resolution',
                    'Select resolution'
                  )}
                  isSearchable={false}
                  options={INTERVAL_FACTOR_OPTIONS}
                  onChange={onIntervalFactorChange}
                  value={INTERVAL_FACTOR_OPTIONS.find((option) => option.value === query.intervalFactor)}
                />
              </EditorField>
            )}
          </QueryOptionGroup>
        </div>
      </Box>
    );
  }
);

function shouldShowExemplarSwitch(query: PromQuery, app?: CoreApp) {
  if (app === CoreApp.UnifiedAlerting || !query.range) {
    return false;
  }

  return true;
}

function getQueryTypeValue(query: PromQuery) {
  return query.range && query.instant ? 'both' : query.instant ? 'instant' : 'range';
}

function getCollapsedInfo(
  query: PromQuery,
  formatOption: string,
  queryType: string,
  app: CoreApp | undefined,
  visible: { legend: boolean; minStep: boolean; format: boolean; type: boolean; exemplars: boolean }
): string[] {
  const items: string[] = [];

  if (visible.legend) {
    items.push(
      t('grafana-prometheus.querybuilder.get-collapsed-info.legend', 'Legend: {{value}}', {
        value: getLegendModeLabel(query.legendFormat),
      })
    );
  }
  if (visible.format) {
    items.push(
      t('grafana-prometheus.querybuilder.get-collapsed-info.format', 'Format: {{value}}', { value: formatOption })
    );
  }
  if (visible.minStep) {
    items.push(
      t('grafana-prometheus.querybuilder.get-collapsed-info.step', 'Step: {{value}}', {
        value: query.interval ?? 'auto',
      })
    );
  }
  if (visible.type) {
    items.push(t('grafana-prometheus.querybuilder.get-collapsed-info.type', 'Type: {{value}}', { value: queryType }));
  }

  if (visible.exemplars && shouldShowExemplarSwitch(query, app)) {
    items.push(
      t('grafana-prometheus.querybuilder.get-collapsed-info.exemplars', 'Exemplars: {{value}}', {
        value: query.exemplar ? 'true' : 'false',
      })
    );
  }
  return items;
}

PromQueryBuilderOptions.displayName = 'PromQueryBuilderOptions';
