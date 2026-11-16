import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

// Monaco is the external browser boundary. Keep the real field, hooks and adapters mounted.
export function createCoauthoringMonaco(initialValue = 'up') {
  let value = initialValue;
  let ranges = [{ from: 0, to: 0 }];
  let focused = true;
  const callbacks = new Map<string, Set<() => void>>();
  const on = (event: string) => (callback: () => void) => {
    const listeners = callbacks.get(event) ?? new Set();
    callbacks.set(event, listeners);
    listeners.add(callback);
    return { dispose: () => listeners.delete(callback) };
  };
  const emit = (event: string) => callbacks.get(event)?.forEach((callback) => callback());
  const actions = new Map<string, monacoTypes.editor.IActionDescriptor>();
  const widgets = new Set<monacoTypes.editor.IContentWidget>();
  let decorations: monacoTypes.editor.IModelDeltaDecoration[] = [];
  const positionAt = (offset: number) => {
    const lines = value.slice(0, offset).split('\n');
    return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
  };
  const offsetAt = ({ lineNumber, column }: { lineNumber: number; column: number }) =>
    value
      .split('\n')
      .slice(0, lineNumber - 1)
      .reduce((total, line) => total + line.length + 1, 0) +
    column -
    1;
  const selections = () =>
    ranges.map(({ from, to }) => ({
      ...positionAt(from),
      selectionStartLineNumber: positionAt(from).lineNumber,
      selectionStartColumn: positionAt(from).column,
      positionLineNumber: positionAt(to).lineNumber,
      positionColumn: positionAt(to).column,
      getStartPosition: () => positionAt(Math.min(from, to)),
      getEndPosition: () => positionAt(Math.max(from, to)),
      isEmpty: () => from === to,
    }));
  const model = {
    deltaDecorations: () => [],
    getOffsetAt: offsetAt,
    getPositionAt: positionAt,
    getValue: () => value,
    getValueLength: () => value.length,
    getLinesContent: () => value.split('\n'),
  };
  const editor = {
    getValue: () => value,
    getModel: () => model,
    getSelection: () => selections()[0] ?? null,
    getSelections: selections,
    getPosition: () => positionAt(ranges[0]?.to ?? 0),
    hasTextFocus: () => focused,
    getDomNode: () => document.body,
    addAction: (action: monacoTypes.editor.IActionDescriptor) => {
      actions.set(action.id, action);
      return { dispose: () => actions.delete(action.id) };
    },
    addContentWidget: (widget: monacoTypes.editor.IContentWidget) => {
      widgets.add(widget);
      document.body.append(widget.getDomNode());
    },
    removeContentWidget: (widget: monacoTypes.editor.IContentWidget) => {
      widgets.delete(widget);
      widget.getDomNode().remove();
    },
    layoutContentWidget: () => {},
    createDecorationsCollection: () => ({
      clear: () => {
        decorations = [];
      },
      set: (next: monacoTypes.editor.IModelDeltaDecoration[]) => {
        decorations = next;
      },
    }),
    deltaDecorations: (_old: string[], next: monacoTypes.editor.IModelDeltaDecoration[]) => {
      decorations = next;
      return next.map((_, i) => `mark-${i}`);
    },
    onDidChangeCursorSelection: on('selection'),
    onDidChangeModelContent: on('content'),
    onDidChangeModel: on('model'),
    onDidBlurEditorText: on('blur'),
    onDidBlurEditorWidget: on('blurWidget'),
    onDidFocusEditorText: on('focus'),
    onDidLayoutChange: on('layout'),
    onDidScrollChange: on('scroll'),
    onMouseDown: on('mouseDown'),
    onMouseUp: on('mouseUp'),
    onDidContentSizeChange: on('size'),
    createContextKey: () => ({ set: () => {} }),
    getContentHeight: () => 20,
    layout: () => {},
    addCommand: () => {},
    trigger: () => {},
  } as unknown as MonacoEditor;
  const monaco = {
    KeyMod: { CtrlCmd: 2048, Shift: 1024 },
    KeyCode: { Period: 84, Enter: 3, KeyF: 4, KeyK: 5 },
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number
      ) {}
    },
    editor: {
      ContentWidgetPositionPreference: { ABOVE: 1, BELOW: 2 },
      addKeybindingRule: () => {},
      setModelMarkers: () => {},
    },
    languages: { registerCompletionItemProvider: () => ({ dispose: () => {} }) },
    MarkerSeverity: { Error: 8, Warning: 4 },
  } as unknown as Monaco;
  return {
    editor,
    monaco,
    actions,
    widgets,
    emit,
    marks: () => decorations,
    setValue: (next: string) => {
      value = next;
      emit('content');
    },
    select: (next: typeof ranges) => {
      ranges = next;
      emit('selection');
    },
    focus: (next: boolean) => {
      focused = next;
      emit(next ? 'focus' : 'blur');
    },
    shortcut: () => actions.forEach((action) => action.run(editor)),
  };
}
