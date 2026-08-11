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
  type?: string;
  help?: string;
  unit?: string;
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
}

/** @internal */
export interface QueryEditorCoauthoringPreview {
  changes: QueryEditorCoauthoringPreviewChange[];
}

/** @internal */
export interface QueryEditorCoauthoringInvocation {
  anchorElement: HTMLElement;
  dismiss: () => void;
}

/**
 * Experimental contract between Grafana and the Prometheus query editor's coauthoring adapter.
 *
 * @remarks
 * This interface is internal to Grafana and can change without notice. It is not a plugin API.
 *
 * @internal
 */
export interface QueryEditorCoauthoringCapability<TQuery extends DataQuery = DataQuery> {
  getValue: () => string;
  getContext: () => Promise<QueryEditorCoauthoringContext>;
  createQuery: (value: string) => TQuery;
  validateQuery: (value: string) => boolean;
  stagePreview: (value: string) => QueryEditorCoauthoringPreview | undefined;
  clearPreview: () => void;
  subscribeToInvocation: (listener: (invocation: QueryEditorCoauthoringInvocation) => void) => () => void;
  focus: () => void;
}

/** @internal */
export interface PrometheusCoauthoringCapability<
  TQuery extends DataQuery = DataQuery,
> extends QueryEditorCoauthoringCapability<TQuery> {
  invoke: (invocation: QueryEditorCoauthoringInvocation) => void;
}

/** @internal */
export type QueryEditorCoauthoringRegistrar<TQuery extends DataQuery = DataQuery> = (
  capability: QueryEditorCoauthoringCapability<TQuery> | undefined
) => void;

interface CodeEditor {
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
}

interface CreateCapabilityOptions<TQuery extends DataQuery> {
  editor: CodeEditor;
  createQuery: (value: string) => TQuery;
  interpolate: (value: string) => string;
  retrieveMetricsMetadata: () => PromMetricsMetadata;
  queryMetricsMetadata: () => Promise<PromMetricsMetadata>;
  queryMetricLabels: (metricName: string) => Promise<string[]>;
  previewChangeClassName: string;
  previewOriginalClassName: string;
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
const MAX_CONTEXT_LABELS = 30;
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
  previewChangeClassName,
  previewOriginalClassName,
}: CreateCapabilityOptions<TQuery>): PrometheusCoauthoringCapability<TQuery> {
  const listeners = new Set<(invocation: QueryEditorCoauthoringInvocation) => void>();
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
    const model = editor.getModel();
    model?.deltaDecorations(state.decorations, []);
    editor.updateOptions({ readOnly: state.readOnly });
  };

  const capability: PrometheusCoauthoringCapability<TQuery> = {
    getValue: () => {
      return editor.getValue();
    },
    getContext: async () => {
      const snapshot = invocationSnapshot ?? captureSnapshot();
      const metricNames = extractMetricNames(snapshot.query).slice(0, MAX_CONTEXT_METRICS);
      let metadata = retrieveMetricsMetadata();
      const metadataPromise = metricNames.some((name) => !metadata[name])
        ? queryMetricsMetadata()
        : Promise.resolve(metadata);
      const metricLabels = new Map(
        await Promise.all(
          metricNames.slice(0, MAX_LABEL_METRICS).map(async (name) => {
            const labels = await queryMetricLabels(name).catch(() => []);
            return [
              name,
              labels
                .filter((label) => label !== '__name__')
                .sort()
                .slice(0, MAX_CONTEXT_LABELS),
            ] as const;
          })
        )
      );
      metadata = await metadataPromise;

      return {
        query: snapshot.query,
        focusRanges: snapshot.focusRanges,
        metricMetadata: metricNames.flatMap((name) => {
          const item = metadata[name];
          return item
            ? [
                {
                  name,
                  type: item.type || undefined,
                  help: item.help ? item.help.slice(0, MAX_METADATA_HELP_LENGTH) : undefined,
                  unit: item.unit || undefined,
                  labels: metricLabels.get(name),
                },
              ]
            : [];
        }),
      };
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
      const decorations =
        model?.deltaDecorations(
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
                ...(replacesText ? { inlineClassName: previewOriginalClassName } : {}),
                ...(proposed
                  ? replacesText
                    ? { before: { content: proposed, inlineClassName: previewChangeClassName } }
                    : { after: { content: proposed, inlineClassName: previewChangeClassName } }
                  : {}),
              },
            };
          })
        ) ?? [];
      editor.updateOptions({ readOnly: true });
      previewState = { readOnly, decorations };

      return {
        changes: diff.changes.map((change) => ({
          id: change.id,
          original: snapshot.query.slice(change.originalRange.from, change.originalRange.to),
          proposed: value.slice(change.proposedRange.from, change.proposedRange.to),
          kind: change.proposedAnchor?.kind ?? change.originalAnchor?.kind,
        })),
      };
    },
    clearPreview,
    subscribeToInvocation: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invoke: (invocation) => {
      clearPreview();
      invocationSnapshot = captureSnapshot();
      listeners.forEach((listener) => listener(invocation));
    },
    focus: () => editor.focus(),
  };

  return capability;
}
