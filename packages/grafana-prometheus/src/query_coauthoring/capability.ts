import { type DataQuery } from '@grafana/data';

import { type PromMetricsMetadata } from '../types';
import {
  buildStagedQueryDiff,
  extractMetricNames,
  normalizeFocusRanges,
  validatePromQL,
  type EditorSelection,
  type TextRange,
} from './structure';

/** @internal */
export interface QueryEditorCoauthoringMetricMetadata {
  name: string;
  /** May be absent when lookup fails, enrichment is budgeted out, or Prometheus has no value. */
  type?: string;
  /** May be absent when lookup fails, enrichment is budgeted out, or Prometheus has no value. */
  help?: string;
  /** May be absent when lookup fails, enrichment is budgeted out, or Prometheus has no value. */
  unit?: string;
  /** May be absent when lookup fails, label enrichment is budgeted out, or the metric has no labels. */
  labels?: string[];
}

/** @internal */
export interface QueryEditorCoauthoringContext {
  query: string;
  focusRanges: TextRange[];
  metricMetadata: QueryEditorCoauthoringMetricMetadata[];
}

/** @internal */
export interface QueryEditorCoauthoringPreviewChange {
  id: string;
  original: string;
  proposed: string;
  kind?: string;
  focus: 'inside' | 'outside' | 'mixed';
}

/** @internal */
export interface QueryEditorCoauthoringPreview {
  changes: QueryEditorCoauthoringPreviewChange[];
}

/**
 * Experimental contract between Grafana and the Prometheus query editor's coauthoring adapter.
 *
 * @remarks
 * This interface is internal to Grafana and can change without notice. It is not a plugin API.
 * Data source context is limited to the query, its focused ranges, and Prometheus metric metadata. The host supplies
 * data source identity and the current panel time range separately.
 * Context includes at most 20 metrics. Label lookup is attempted for at most five metrics and returns at most 30
 * labels per metric; metadata help is truncated to 500 characters. Optional metadata and labels can be absent because
 * of those budgets, lookup failure, or genuinely absent Prometheus data.
 *
 * @internal
 */
export interface QueryEditorCoauthoringCapability<TQuery extends DataQuery = DataQuery> {
  getValue: () => string;
  getContext: () => Promise<QueryEditorCoauthoringContext>;
  /** Re-captures the current query and editor focus as the active invocation baseline. */
  refreshContext: () => Promise<QueryEditorCoauthoringContext>;
  createQuery: (value: string) => TQuery;
  validateQuery: (value: string) => boolean;
  stagePreview: (value: string) => QueryEditorCoauthoringPreview | undefined;
  clearPreview: () => void;
  focus: () => void;
}

/** @internal */
export interface PrometheusCoauthoringCapability<
  TQuery extends DataQuery = DataQuery,
> extends QueryEditorCoauthoringCapability<TQuery> {
  captureContext: () => void;
}

interface CodeEditor {
  deltaDecorations: (
    oldDecorations: string[],
    newDecorations: Array<{
      range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      };
      options: {
        inlineClassName?: string;
        before?: { content: string; inlineClassName: string };
        after?: { content: string; inlineClassName: string };
      };
    }>
  ) => string[];
  getValue: () => string;
  getSelections: () => CodeEditorSelection[] | null;
  getModel: () => CodeEditorModel | null;
  getRawOptions: () => { readOnly?: boolean };
  updateOptions: (options: { readOnly: boolean }) => void;
  focus: () => void;
}

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
  getOffsetAt: (position: CodeEditorPosition) => number;
  getPositionAt: (offset: number) => CodeEditorPosition;
}

interface CreateCapabilityOptions<TQuery extends DataQuery> {
  editor: CodeEditor;
  createQuery: (value: string) => TQuery;
  interpolate: (value: string) => string;
  retrieveMetricsMetadata: () => PromMetricsMetadata;
  queryMetricsMetadata: () => Promise<PromMetricsMetadata>;
  queryMetricLabels: (metricName: string) => Promise<string[]>;
  getPreviewChangeClassName: () => string;
  getPreviewOriginalClassName: () => string;
}

interface InvocationSnapshot {
  query: string;
  selections: CodeEditorSelection[];
  focusRanges: TextRange[];
}

interface PreviewState {
  readOnly: boolean;
  decorations: string[];
}

const MAX_CONTEXT_METRICS = 20;
const MAX_LABEL_METRICS = 5;
/** Shared by the Prometheus label request and the returned coauthoring context's per-metric label budget. @internal */
export const QUERY_COAUTHORING_MAX_CONTEXT_LABELS = 30;
const MAX_METADATA_HELP_LENGTH = 500;

/**
 * Creates the Prometheus adapter for Grafana's experimental query coauthoring interface.
 *
 * @internal
 */
export function createPrometheusCoauthoringCapability<TQuery extends DataQuery>({
  editor,
  createQuery,
  interpolate,
  retrieveMetricsMetadata,
  queryMetricsMetadata,
  queryMetricLabels,
  getPreviewChangeClassName,
  getPreviewOriginalClassName,
}: CreateCapabilityOptions<TQuery>): PrometheusCoauthoringCapability<TQuery> {
  let invocationSnapshot: InvocationSnapshot | undefined;
  let previewState: PreviewState | undefined;

  const getEditorSelections = (): CodeEditorSelection[] =>
    editor.getSelections()?.map((selection) => ({ ...selection })) ?? [];

  const captureSnapshot = (): InvocationSnapshot => {
    const query = editor.getValue();
    const model = editor.getModel();
    const selections = getEditorSelections();
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
      query,
      selections,
      focusRanges: normalizeFocusRanges(query, editorSelections),
    };
  };

  const clearPreview = () => {
    if (!previewState) {
      return;
    }

    const state = previewState;
    previewState = undefined;
    editor.deltaDecorations(state.decorations, []);
    editor.updateOptions({ readOnly: state.readOnly });
  };

  const buildContext = async (snapshot: InvocationSnapshot): Promise<QueryEditorCoauthoringContext> => {
    const metricNames = extractMetricNames(interpolate(snapshot.query)).slice(0, MAX_CONTEXT_METRICS);
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
      query: snapshot.query,
      focusRanges: snapshot.focusRanges,
      metricMetadata: metricNames.map((name) => {
        const item = metadata[name];
        return {
          name,
          type: item?.type || undefined,
          help: item?.help ? item.help.slice(0, MAX_METADATA_HELP_LENGTH) : undefined,
          unit: item?.unit || undefined,
          labels: metricLabels.get(name),
        };
      }),
    };
  };

  const capability: PrometheusCoauthoringCapability<TQuery> = {
    getValue: () => {
      return editor.getValue();
    },
    getContext: () => buildContext(invocationSnapshot ?? captureSnapshot()),
    refreshContext: () => {
      const snapshot = captureSnapshot();
      invocationSnapshot = snapshot;
      return buildContext(snapshot);
    },
    createQuery,
    validateQuery: (value) => validatePromQL(value, interpolate(value)).valid,
    stagePreview: (value) => {
      clearPreview();
      const snapshot = invocationSnapshot ?? captureSnapshot();
      if (editor.getValue() !== snapshot.query) {
        return undefined;
      }

      const diff = buildStagedQueryDiff(snapshot.query, value, snapshot.focusRanges, {
        originalInterpolatedQuery: interpolate(snapshot.query),
        proposedInterpolatedQuery: interpolate(value),
      });
      if (!diff.valid || diff.changes.length === 0) {
        return undefined;
      }

      const readOnly = Boolean(editor.getRawOptions().readOnly);
      const model = editor.getModel();
      const decorations = model
        ? editor.deltaDecorations(
            [],
            diff.changes.map((change) => {
              const start = model.getPositionAt(change.originalRange.from);
              const end = model.getPositionAt(change.originalRange.to);
              const proposed = value.slice(change.proposedRange.from, change.proposedRange.to).replace(/\r?\n/g, ' ');
              const replacesText = change.originalRange.from !== change.originalRange.to;
              return {
                range: {
                  startLineNumber: start.lineNumber,
                  startColumn: start.column,
                  endLineNumber: end.lineNumber,
                  endColumn: end.column,
                },
                options: {
                  ...(replacesText ? { inlineClassName: getPreviewOriginalClassName() } : {}),
                  ...(proposed
                    ? replacesText
                      ? { before: { content: proposed, inlineClassName: getPreviewChangeClassName() } }
                      : { after: { content: proposed, inlineClassName: getPreviewChangeClassName() } }
                    : {}),
                },
              };
            })
          )
        : [];
      editor.updateOptions({ readOnly: true });
      previewState = { readOnly, decorations };

      return {
        changes: diff.changes.map((change) => ({
          id: change.id,
          original: snapshot.query.slice(change.originalRange.from, change.originalRange.to),
          proposed: value.slice(change.proposedRange.from, change.proposedRange.to),
          kind: change.proposedAnchor?.kind ?? change.originalAnchor?.kind,
          focus: change.focus,
        })),
      };
    },
    clearPreview,
    captureContext: () => {
      clearPreview();
      invocationSnapshot = captureSnapshot();
    },
    focus: () => editor.focus(),
  };

  return capability;
}
