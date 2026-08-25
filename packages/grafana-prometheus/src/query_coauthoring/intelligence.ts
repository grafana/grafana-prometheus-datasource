import { type DataQuery } from '@grafana/data';

import { type PromMetricsMetadata } from '../types';

import {
  type QueryEditorCoauthoringInvocationV1,
  type QueryEditorCoauthoringProposalResultV1,
} from './internalCoauthoringContract';
import {
  buildStagedQueryDiff,
  extractMetricNames,
  normalizeFocusRanges,
  validatePromQL,
  type EditorSelection,
} from './structure';

interface CodeEditorPosition {
  lineNumber: number;
  column: number;
}

interface CodeEditorSelection {
  selectionStartLineNumber: number;
  selectionStartColumn: number;
  positionLineNumber: number;
  positionColumn: number;
}

interface CodeEditorModel {
  getOffsetAt(position: CodeEditorPosition): number;
}

interface CodeEditor {
  getValue(): string;
  getSelections(): CodeEditorSelection[] | null;
  getModel(): CodeEditorModel | null;
}

interface CreateIntelligenceOptions<TQuery extends DataQuery> {
  editor: CodeEditor;
  createQuery(value: string): TQuery;
  interpolate(value: string): string;
  retrieveMetricsMetadata(): PromMetricsMetadata;
  queryMetricsMetadata(): Promise<PromMetricsMetadata>;
  queryMetricLabels(metricName: string): Promise<string[]>;
}

export interface PrometheusCoauthoringCapturedInvocation<TQuery extends DataQuery = DataQuery> {
  baseline: TQuery;
  focusRanges: Array<{ from: number; to: number }>;
  query: string;
  revision: string;
}

export interface PrometheusCoauthoringIntelligence<TQuery extends DataQuery = DataQuery> {
  captureInvocation(revision: string): PrometheusCoauthoringCapturedInvocation<TQuery>;
  readInvocation(
    invocation: PrometheusCoauthoringCapturedInvocation<TQuery>
  ): Promise<QueryEditorCoauthoringInvocationV1<TQuery>>;
  prepareProposal(
    invocation: PrometheusCoauthoringCapturedInvocation<TQuery>,
    source: string
  ): QueryEditorCoauthoringProposalResultV1<TQuery>;
}

const PROMQL_COAUTHORING_GUIDANCE = [
  'Preserve existing label matchers and Grafana template variables unless the user explicitly asks to change them.',
  'Metric metadata is advisory. Do not invent metadata that is not provided.',
  'Use only metric labels provided in the relevant metric context. If the requested grouping is ambiguous or unavailable, ask one concise clarification question.',
  'Treat slash-separated label names in the user request as alternatives or synonyms, not a request to use every listed label. Choose the single exact available label that best matches.',
  'For a counter breakdown, place the rate expression inside an aggregation, for example: sum by (label) (rate(metric[range])). A by/without modifier cannot follow a function call.',
];

const MAX_CONTEXT_METRICS = 20;
const MAX_LABEL_METRICS = 5;
/** Shared by the Prometheus label request and the returned coauthoring context's per-metric label budget. @internal */
export const QUERY_COAUTHORING_MAX_CONTEXT_LABELS = 30;
const MAX_METADATA_HELP_LENGTH = 500;

export function createPrometheusCoauthoringIntelligence<TQuery extends DataQuery>({
  editor,
  createQuery,
  interpolate,
  retrieveMetricsMetadata,
  queryMetricsMetadata,
  queryMetricLabels,
}: CreateIntelligenceOptions<TQuery>): PrometheusCoauthoringIntelligence<TQuery> {
  // Read the editor synchronously so the baseline includes edits the user has not blurred yet, and so the
  // query and the selections that describe it cannot drift apart. Everything downstream — enrichment, diffing,
  // staleness checks — is measured against this one snapshot.
  const captureInvocation = (revision: string): PrometheusCoauthoringCapturedInvocation<TQuery> => {
    const query = editor.getValue();
    const model = editor.getModel();
    const selections = editor.getSelections()?.map((selection) => ({ ...selection })) ?? [];
    const editorSelections: EditorSelection[] = model
      ? selections.map((selection) => ({
          anchor: model.getOffsetAt({
            lineNumber: selection.selectionStartLineNumber,
            column: selection.selectionStartColumn,
          }),
          head: model.getOffsetAt({ lineNumber: selection.positionLineNumber, column: selection.positionColumn }),
        }))
      : [];

    return {
      baseline: createQuery(query),
      focusRanges: normalizeFocusRanges(query, editorSelections),
      query,
      revision,
    };
  };

  const readInvocation = async (
    invocation: PrometheusCoauthoringCapturedInvocation<TQuery>
  ): Promise<QueryEditorCoauthoringInvocationV1<TQuery>> => {
    const metricNames = extractMetricNames(interpolate(invocation.query)).slice(0, MAX_CONTEXT_METRICS);
    let cachedMetadata: PromMetricsMetadata = {};
    try {
      cachedMetadata = retrieveMetricsMetadata();
    } catch {
      // Cached metadata is optional enrichment and must not prevent the remaining context from loading.
    }
    const metadataPromise = metricNames.some((name) => !cachedMetadata[name])
      ? Promise.resolve()
          .then(queryMetricsMetadata)
          .then((freshMetadata) => ({ ...cachedMetadata, ...freshMetadata }))
          .catch(() => cachedMetadata)
      : Promise.resolve(cachedMetadata);
    const metricLabelsPromise = Promise.all(
      metricNames.slice(0, MAX_LABEL_METRICS).map(async (name) => {
        const labels = await Promise.resolve()
          .then(() => queryMetricLabels(name))
          .catch(() => []);
        return [
          name,
          labels
            .filter((label) => label !== '__name__')
            .sort()
            .slice(0, QUERY_COAUTHORING_MAX_CONTEXT_LABELS),
        ] as const;
      })
    );
    const [metadata, metricLabelEntries] = await Promise.all([metadataPromise, metricLabelsPromise]);
    const metricLabels = new Map(metricLabelEntries);

    return {
      baseline: invocation.baseline,
      context: {
        revision: invocation.revision,
        query: invocation.query,
        focusRanges: invocation.focusRanges,
        language: { id: 'promql', displayName: 'PromQL', guidance: PROMQL_COAUTHORING_GUIDANCE },
        metadata: metricNames.map((name) => {
          const item = metadata[name];
          const labels = metricLabels.get(name);
          return {
            kind: 'metric',
            name,
            attributes: {
              ...(item?.type ? { type: item.type } : {}),
              ...(item?.help ? { help: item.help.slice(0, MAX_METADATA_HELP_LENGTH) } : {}),
              ...(item?.unit ? { unit: item.unit } : {}),
              ...(labels?.length ? { labels } : {}),
            },
          };
        }),
      },
    };
  };

  return {
    captureInvocation,
    readInvocation,
    prepareProposal: (invocation, source) => {
      if (!validatePromQL(source, interpolate(source)).valid) {
        return { status: 'rejected', reason: 'invalid' };
      }

      const diff = buildStagedQueryDiff(invocation.query, source, invocation.focusRanges, {
        originalInterpolatedQuery: interpolate(invocation.query),
        proposedInterpolatedQuery: interpolate(source),
      });
      if (!diff.valid) {
        return { status: 'rejected', reason: 'invalid' };
      }
      if (diff.changes.length === 0) {
        return { status: 'rejected', reason: 'unchanged' };
      }

      return {
        status: 'ready',
        query: createQuery(source),
        changes: diff.changes.map((change) => ({
          id: change.id,
          original: invocation.query.slice(change.originalRange.from, change.originalRange.to),
          proposed: source.slice(change.proposedRange.from, change.proposedRange.to),
          kind: change.proposedAnchor?.kind ?? change.originalAnchor?.kind,
          focus: change.focus,
        })),
      };
    },
  };
}
