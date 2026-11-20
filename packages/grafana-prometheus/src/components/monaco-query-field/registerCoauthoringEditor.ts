import { t } from '@grafana/i18n';
import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

import {
  type QueryCoauthoringEditorHandle,
  type QueryCoauthoringEditorHost,
} from '../../query_coauthoring/queryCoauthoringContracts';

interface Options {
  editor: MonacoEditor;
  monaco: Monaco;
  host: QueryCoauthoringEditorHost;
  getExternalQuery(): string;
  onManualQueryChange(value: string): void;
  widgetId: string;
  changeClassName?: string;
}

/** @internal The host owns UI and invocation; this registration only reports editor facts. */
export function registerCoauthoringEditor({
  editor,
  monaco,
  host,
  getExternalQuery,
  onManualQueryChange,
  widgetId,
  changeClassName,
}: Options) {
  const listeners = new Set<() => void>();
  const anchor = document.createElement('div');
  let disposed = false;
  const marks = editor.createDecorationsCollection();
  const clearMarks = () => {
    marks.clear();
  };
  const widget: monacoTypes.editor.IContentWidget = {
    getId: () => `${widgetId}.v2`,
    getDomNode: () => anchor,
    getPosition: () => ({
      position: editor.getSelection()?.getEndPosition() ?? editor.getPosition(),
      preference: [monaco.editor.ContentWidgetPositionPreference.BELOW],
    }),
    afterRender: () => publish(),
  };
  const publish = () => {
    if (!disposed) {
      listeners.forEach((listener) => listener());
    }
  };
  const update = () => {
    editor.layoutContentWidget(widget);
    publish();
  };
  editor.addContentWidget(widget);
  const handle: QueryCoauthoringEditorHandle = {
    version: 1,
    getSelection() {
      const model = editor.getModel();
      if (disposed || !model || !editor.hasTextFocus()) {
        return null;
      }
      const ranges =
        editor
          .getSelections()
          ?.filter((selection) => !selection.isEmpty())
          .map((selection) => ({
            from: model.getOffsetAt(selection.getStartPosition()),
            to: model.getOffsetAt(selection.getEndPosition()),
          })) ?? [];
      return ranges.length ? { ranges, anchor } : null;
    },
    showChanges(changes) {
      if (disposed) {
        return;
      }
      const model = editor.getModel();
      const decorations = model
        ? (changes ?? []).flatMap((change) =>
            change.proposedRanges.map(({ from, to }) => {
              const start = model.getPositionAt(from);
              // End offsets are exclusive. A deletion marks the surviving line at its insertion point.
              const end = model.getPositionAt(Math.max(from, to - 1));
              return {
                range: new monaco.Range(start.lineNumber, 1, end.lineNumber, 1),
                options: { isWholeLine: true, className: changeClassName },
              };
            })
          )
        : [];
      marks.set(decorations);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const subscriptions = [
    editor.onDidChangeCursorSelection(update),
    editor.onDidFocusEditorText(update),
    editor.onDidBlurEditorText(update),
    editor.onDidChangeModel(() => {
      clearMarks();
      update();
    }),
    editor.onDidScrollChange(update),
    editor.onDidChangeModelContent(() => {
      const value = editor.getValue();
      if (value !== getExternalQuery()) {
        clearMarks();
        onManualQueryChange(value);
      }
      update();
    }),
    editor.onDidLayoutChange(update),
    editor.addAction({
      id: `${widgetId}.v2.invoke`,
      label: t('grafana-prometheus.components.monaco-query-field.coauthor-promql-query', 'Coauthor PromQL query'),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period],
      run: () => host.invoke(),
    }),
  ];
  let unsubscribe: (() => void) | undefined;
  try {
    const result = host.register(handle);
    unsubscribe = typeof result === 'function' ? result : undefined;
  } catch {
    // A drifted private host must not break ordinary editing.
  }
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribe?.();
    clearMarks();
    subscriptions.forEach((subscription) => subscription.dispose());
    editor.removeContentWidget(widget);
    listeners.clear();
  };
}
