// Core grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/components/monaco-query-field/monaco-completion-provider/completions.ts
import { type languages } from 'monaco-editor';

import { type TimeRange } from '@grafana/data';
import { config } from '@grafana/runtime';

import { DEFAULT_COMPLETION_LIMIT } from '../../../constants';
import { escapeLabelValueInExactSelector, prometheusRegularEscape } from '../../../escaping';
import { getFunctions } from '../../../promql';
import { rangeModifierDocumentation } from '../../../rangeModifiers';
import { isValidLegacyName } from '../../../utf8_support';

import { type DataProvider } from './data_provider';
import { type TriggerType } from './monaco-completion-provider';
import type { Label, Situation } from './situation';
import { NeverCaseError } from './util';
// FIXME: we should not load this from the "outside", but we cannot do that while we have the "old" query-field too

export type CompletionType =
  | 'HISTORY'
  | 'FUNCTION'
  | 'METRIC_NAME'
  | 'DURATION'
  | 'LABEL_NAME'
  | 'LABEL_VALUE'
  | 'KEYWORD';

// We cannot use languages.CompletionItemInsertTextRule.InsertAsSnippet because grafana-prometheus package isn't compatible
// It should first change the moduleResolution to bundler for TS to correctly resolve the types
// https://github.com/grafana/grafana/pull/96450
const InsertAsSnippet = 4;

export type Completion = {
  type: CompletionType;
  label: string;
  insertText: string;
  insertTextRules?: languages.CompletionItemInsertTextRule;
  detail?: string;
  documentation?: string;
  triggerOnInsert?: boolean;
};

export type CompletionBatchListener = (batch: Completion[]) => void;

function publishCompletions(onBatch: CompletionBatchListener | undefined, batch: Completion[]) {
  if (onBatch && batch.length > 0) {
    onBatch(batch);
  }
}

// Snippet Marker is  telling monaco where to show the cursor and maybe a help text
// With help text example: ${1:labelName}
// labelName will be shown as selected. So user would know what to type next
const snippetMarker = '${1:}';

// Maximum number of recent queries surfaced as history completions.
const MAX_HISTORY_COMPLETIONS = 10;

function metricNamesToCompletions(dataProvider: DataProvider, metricNames: string[]): Completion[] {
  return dataProvider.metricNamesToMetrics(metricNames).map((metric) => ({
    type: 'METRIC_NAME',
    label: metric.name,
    detail: `${metric.name} : ${metric.type}`,
    documentation: metric.help,
    ...(metric.isUtf8
      ? {
          insertText: `{"${metric.name}"${snippetMarker}}`,
          insertTextRules: InsertAsSnippet,
        }
      : {
          insertText: metric.name,
        }),
  }));
}

// we order items like: history, functions, metrics
async function getAllMetricNamesCompletions(
  searchTerm: string | undefined,
  dataProvider: DataProvider,
  timeRange: TimeRange,
  onBatch?: CompletionBatchListener
): Promise<Completion[]> {
  const metricNames = onBatch
    ? await dataProvider.queryMetricNames(timeRange, searchTerm, (names) => {
        publishCompletions(onBatch, metricNamesToCompletions(dataProvider, names));
      })
    : await dataProvider.queryMetricNames(timeRange, searchTerm);

  return metricNamesToCompletions(dataProvider, metricNames);
}

const getFunctionCompletions: () => Completion[] = () => {
  return getFunctions().map((f) => ({
    type: 'FUNCTION',
    label: f.label,
    insertText: f.insertText ?? '', // i don't know what to do when this is nullish. it should not be.
    detail: f.detail,
    documentation: f.documentation,
  }));
};

async function getFunctionsOnlyCompletions(): Promise<Completion[]> {
  return Promise.resolve(getFunctionCompletions());
}

async function getAllFunctionsAndMetricNamesCompletions(
  searchTerm: string | undefined,
  dataProvider: DataProvider,
  timeRange: TimeRange,
  onBatch?: CompletionBatchListener
): Promise<Completion[]> {
  const metricNames = await getAllMetricNamesCompletions(searchTerm, dataProvider, timeRange, onBatch);
  return [...getFunctionCompletions(), ...metricNames];
}

const DURATION_COMPLETIONS: Completion[] = [
  '$__interval',
  '$__range',
  '$__rate_interval',
  '1m',
  '5m',
  '10m',
  '30m',
  '1h',
  '1d',
].map((text) => ({
  type: 'DURATION',
  label: text,
  insertText: text,
}));

function getAllHistoryCompletions(dataProvider: DataProvider): Completion[] {
  // function getAllHistoryCompletions(queryHistory: PromHistoryItem[]): Completion[] {
  // NOTE: the typescript types are wrong. historyItem.query.expr can be undefined
  const allHistory = dataProvider.getHistory();
  // FIXME: find a better history-limit
  return allHistory.slice(0, MAX_HISTORY_COMPLETIONS).map((expr) => ({
    type: 'HISTORY',
    label: expr,
    insertText: expr,
  }));
}

function makeSelector(metricName: string | undefined, labels: Label[]): string | undefined {
  if (metricName === undefined && labels.length === 0) {
    return undefined;
  }

  const allLabels = [...labels];

  // we transform the metricName to a label, if it exists
  if (metricName !== undefined) {
    allLabels.push({ name: '__name__', value: metricName, op: '=' });
  }

  const allLabelTexts = allLabels.map(
    (label) => `${label.name}${label.op}"${escapeLabelValueInExactSelector(label.value)}"`
  );

  return `{${allLabelTexts.join(',')}}`;
}

function labelNameCompletions(names: string[], suffix: string, triggerOnInsert: boolean): Completion[] {
  return names.map((text) => {
    const isUtf8 = !isValidLegacyName(text);
    return {
      type: 'LABEL_NAME',
      label: text,
      ...(isUtf8
        ? {
            insertText: `"${text}"${suffix}`,
            insertTextRules: InsertAsSnippet,
          }
        : {
            insertText: `${text}${suffix}`,
          }),
      triggerOnInsert,
    };
  });
}

function unusedLabelNames(names: string[], otherLabels: Label[]): string[] {
  const usedLabelNames = new Set([...otherLabels.map((label) => label.name), '__name__']);
  return names.filter((name) => !usedLabelNames.has(name));
}

async function getLabelNames(
  metric: string | undefined,
  otherLabels: Label[],
  dataProvider: DataProvider,
  timeRange: TimeRange,
  searchTerm: string | undefined,
  onBatch: CompletionBatchListener | undefined,
  suffix: string,
  triggerOnInsert: boolean
): Promise<string[]> {
  const selector = makeSelector(metric, otherLabels);
  const labelNames = onBatch
    ? await dataProvider.queryLabelKeys(timeRange, selector, DEFAULT_COMPLETION_LIMIT, searchTerm, (names) => {
        publishCompletions(onBatch, labelNameCompletions(unusedLabelNames(names, otherLabels), suffix, triggerOnInsert));
      })
    : await dataProvider.queryLabelKeys(timeRange, selector, DEFAULT_COMPLETION_LIMIT, searchTerm);
  // Exclude __name__ from output. Callers observe this mutation on the selector's label list.
  otherLabels.push({ name: '__name__', value: '', op: '!=' });
  return unusedLabelNames(labelNames, otherLabels);
}

async function getLabelNamesForCompletions(
  metric: string | undefined,
  suffix: string,
  triggerOnInsert: boolean,
  otherLabels: Label[],
  dataProvider: DataProvider,
  timeRange: TimeRange,
  searchTerm?: string,
  onBatch?: CompletionBatchListener
): Promise<Completion[]> {
  const labelNames = await getLabelNames(
    metric,
    otherLabels,
    dataProvider,
    timeRange,
    searchTerm,
    onBatch,
    suffix,
    triggerOnInsert
  );
  return labelNameCompletions(labelNames, suffix, triggerOnInsert);
}

async function getLabelNamesForSelectorCompletions(
  metric: string | undefined,
  otherLabels: Label[],
  dataProvider: DataProvider,
  timeRange: TimeRange,
  searchTerm?: string,
  onBatch?: CompletionBatchListener
): Promise<Completion[]> {
  return getLabelNamesForCompletions(metric, '=', true, otherLabels, dataProvider, timeRange, searchTerm, onBatch);
}

async function getLabelNamesForByCompletions(
  metric: string | undefined,
  otherLabels: Label[],
  dataProvider: DataProvider,
  timeRange: TimeRange,
  searchTerm?: string,
  onBatch?: CompletionBatchListener
): Promise<Completion[]> {
  return getLabelNamesForCompletions(metric, '', false, otherLabels, dataProvider, timeRange, searchTerm, onBatch);
}

function labelValueCompletions(values: string[], betweenQuotes: boolean): Completion[] {
  return values.map((text) => ({
    type: 'LABEL_VALUE',
    label: text,
    insertText: formatLabelValueForCompletion(text, betweenQuotes),
  }));
}

async function getLabelValues(
  metric: string | undefined,
  labelName: string,
  otherLabels: Label[],
  dataProvider: DataProvider,
  timeRange: TimeRange,
  searchTerm: string | undefined,
  onBatch: CompletionBatchListener | undefined,
  betweenQuotes: boolean
): Promise<string[]> {
  const selector = makeSelector(metric, otherLabels);
  if (!onBatch) {
    return dataProvider.queryLabelValues(timeRange, labelName, selector, DEFAULT_COMPLETION_LIMIT, searchTerm);
  }
  return dataProvider.queryLabelValues(timeRange, labelName, selector, DEFAULT_COMPLETION_LIMIT, searchTerm, (values) => {
    publishCompletions(onBatch, labelValueCompletions(values, betweenQuotes));
  });
}

async function getLabelValuesForMetricCompletions(
  metric: string | undefined,
  labelName: string,
  betweenQuotes: boolean,
  otherLabels: Label[],
  dataProvider: DataProvider,
  timeRange: TimeRange,
  searchTerm?: string,
  onBatch?: CompletionBatchListener
): Promise<Completion[]> {
  const values = await getLabelValues(
    metric,
    labelName,
    otherLabels,
    dataProvider,
    timeRange,
    searchTerm,
    onBatch,
    betweenQuotes
  );
  return labelValueCompletions(values, betweenQuotes);
}

function formatLabelValueForCompletion(value: string, betweenQuotes: boolean): string {
  const text = config.featureToggles.prometheusSpecialCharsInLabelValues ? prometheusRegularEscape(value) : value;
  return betweenQuotes ? text : `"${text}"`;
}

export async function getCompletions(
  situation: Situation,
  dataProvider: DataProvider,
  timeRange: TimeRange,
  searchTerm?: string,
  triggerType: TriggerType = 'full',
  onBatch?: CompletionBatchListener
): Promise<Completion[]> {
  switch (situation.type) {
    case 'RANGE_MODIFIER':
      return situation.modifiers.map((modifier) => ({
        type: 'KEYWORD',
        label: modifier,
        insertText: modifier,
        documentation: rangeModifierDocumentation[modifier],
      }));
    case 'IN_DURATION':
      return Promise.resolve(DURATION_COMPLETIONS);
    case 'IN_FUNCTION':
      return triggerType === 'full'
        ? getAllFunctionsAndMetricNamesCompletions(searchTerm, dataProvider, timeRange, onBatch)
        : getFunctionsOnlyCompletions();
    case 'AT_ROOT': {
      return triggerType === 'full'
        ? getAllFunctionsAndMetricNamesCompletions(searchTerm, dataProvider, timeRange, onBatch)
        : getFunctionsOnlyCompletions();
    }
    case 'EMPTY': {
      if (triggerType === 'partial') {
        return Promise.resolve(getFunctionCompletions());
      }
      const metricNames = await getAllMetricNamesCompletions(searchTerm, dataProvider, timeRange, onBatch);
      const historyCompletions = getAllHistoryCompletions(dataProvider);
      return Promise.resolve([...historyCompletions, ...getFunctionCompletions(), ...metricNames]);
    }
    case 'IN_LABEL_SELECTOR_NO_LABEL_NAME':
      return getLabelNamesForSelectorCompletions(
        situation.metricName,
        situation.otherLabels,
        dataProvider,
        timeRange,
        searchTerm,
        onBatch
      );
    case 'IN_GROUPING':
      return getLabelNamesForByCompletions(
        situation.metricName,
        situation.otherLabels,
        dataProvider,
        timeRange,
        searchTerm,
        onBatch
      );
    case 'IN_LABEL_SELECTOR_WITH_LABEL_NAME':
      return getLabelValuesForMetricCompletions(
        situation.metricName,
        situation.labelName,
        situation.betweenQuotes,
        situation.otherLabels,
        dataProvider,
        timeRange,
        searchTerm,
        onBatch
      );
    default:
      throw new NeverCaseError(situation);
  }
}
