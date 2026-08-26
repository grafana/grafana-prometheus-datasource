import { act } from '@testing-library/react';

import { type TimeRange } from '@grafana/data';
import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';

import { registerPrometheusQueryCoauthoring } from './PrometheusQueryCoauthoringAdapter';

function createRect(left: number, right: number, top: number, bottom: number): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left,
    right,
    top,
    width: right - left,
    x: left,
    y: top,
    toJSON: () => undefined,
  };
}

function createSelection(startColumn = 4, endColumn = 12): monacoTypes.Selection {
  return {
    getStartPosition: () => ({ lineNumber: 1, column: startColumn }),
    getEndPosition: () => ({ lineNumber: 1, column: endColumn }),
    isEmpty: () => false,
    selectionStartLineNumber: 1,
    selectionStartColumn: startColumn,
    positionLineNumber: 1,
    positionColumn: endColumn,
  } as monacoTypes.Selection;
}

function createEditorHarness(initialValue = 'rate(http_requests_total[5m])') {
  let contentWidget: monacoTypes.editor.IContentWidget | undefined;
  let editorAction: monacoTypes.editor.IActionDescriptor | undefined;
  let contentListener: VoidFunction | undefined;
  let layoutListener: VoidFunction | undefined;
  let mouseDownListener: ((event: monacoTypes.editor.IEditorMouseEvent) => void) | undefined;
  let mouseUpListener: ((event: monacoTypes.editor.IEditorMouseEvent) => void) | undefined;
  let blurListener: VoidFunction | undefined;
  let focusListener: VoidFunction | undefined;
  let selectionListener: VoidFunction | undefined;
  let value = initialValue;
  let externalValue = initialValue;
  let selections: monacoTypes.Selection[] = [];
  let textFocused = true;
  const actionDisposable = { dispose: jest.fn() };
  const blurDisposable = { dispose: jest.fn(() => (blurListener = undefined)) };
  const contentDisposable = { dispose: jest.fn(() => (contentListener = undefined)) };
  const layoutDisposable = { dispose: jest.fn(() => (layoutListener = undefined)) };
  const mouseDownDisposable = { dispose: jest.fn(() => (mouseDownListener = undefined)) };
  const mouseUpDisposable = { dispose: jest.fn(() => (mouseUpListener = undefined)) };
  const focusDisposable = { dispose: jest.fn(() => (focusListener = undefined)) };
  const selectionDisposable = { dispose: jest.fn(() => (selectionListener = undefined)) };
  const editorDomNode = document.createElement('div');
  const deltaDecorations = jest.fn();
  const updateOptions = jest.fn();
  const editor = {
    addAction: jest.fn((action: monacoTypes.editor.IActionDescriptor) => {
      editorAction = action;
      return actionDisposable;
    }),
    addContentWidget: jest.fn((widget: monacoTypes.editor.IContentWidget) => {
      contentWidget = widget;
      document.body.append(widget.getDomNode());
    }),
    deltaDecorations,
    getDomNode: jest.fn(() => editorDomNode),
    hasTextFocus: jest.fn(() => textFocused),
    getModel: jest.fn(() => ({
      getOffsetAt: ({ column }: monacoTypes.Position) => column - 1,
      getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
    })),
    getPosition: jest.fn(() => ({ lineNumber: 1, column: 1 })),
    getSelection: jest.fn(() => selections[0] ?? null),
    getSelections: jest.fn(() => selections),
    getValue: jest.fn(() => value),
    layoutContentWidget: jest.fn(),
    onDidChangeCursorSelection: jest.fn((listener: VoidFunction) => {
      selectionListener = listener;
      return selectionDisposable;
    }),
    onDidChangeModelContent: jest.fn((listener: VoidFunction) => {
      contentListener = listener;
      return contentDisposable;
    }),
    onDidBlurEditorText: jest.fn((listener: VoidFunction) => {
      blurListener = listener;
      return blurDisposable;
    }),
    onDidFocusEditorText: jest.fn((listener: VoidFunction) => {
      focusListener = listener;
      return focusDisposable;
    }),
    onDidLayoutChange: jest.fn((listener: VoidFunction) => {
      layoutListener = listener;
      return layoutDisposable;
    }),
    onMouseDown: jest.fn((listener: (event: monacoTypes.editor.IEditorMouseEvent) => void) => {
      mouseDownListener = listener;
      return mouseDownDisposable;
    }),
    onMouseUp: jest.fn((listener: (event: monacoTypes.editor.IEditorMouseEvent) => void) => {
      mouseUpListener = listener;
      return mouseUpDisposable;
    }),
    removeContentWidget: jest.fn((widget: monacoTypes.editor.IContentWidget) => widget.getDomNode().remove()),
    updateOptions,
  } as unknown as MonacoEditor;
  const monaco = {
    editor: { ContentWidgetPositionPreference: { BELOW: 2, ABOVE: 1 } },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { Period: 84 },
  } as unknown as Monaco;

  return {
    actionDisposable,
    blurDisposable,
    contentDisposable,
    deltaDecorations,
    editor,
    getContentWidget: () => {
      if (!contentWidget) {
        throw new Error('Expected the query coauthoring content widget to be registered.');
      }
      return contentWidget;
    },
    getEditorAction: () => {
      if (!editorAction) {
        throw new Error('Expected the query coauthoring editor action to be registered.');
      }
      return editorAction;
    },
    getExternalValue: () => externalValue,
    focusDisposable,
    layoutDisposable,
    monaco,
    mouseDownDisposable,
    mouseUpDisposable,
    notifyContentChange: () => act(() => contentListener?.()),
    notifyBlur: () => act(() => blurListener?.()),
    notifyFocus: () => act(() => focusListener?.()),
    notifyLayoutChange: () => act(() => layoutListener?.()),
    notifyMouseDown: (element?: HTMLElement) =>
      act(() => mouseDownListener?.({ target: { element } } as unknown as monacoTypes.editor.IEditorMouseEvent)),
    notifyMouseUp: (element?: HTMLElement) =>
      act(() => mouseUpListener?.({ target: { element } } as unknown as monacoTypes.editor.IEditorMouseEvent)),
    notifySelectionChange: () => act(() => selectionListener?.()),
    selectionDisposable,
    setExternalValue: (nextValue: string) => {
      externalValue = nextValue;
    },
    setSelections: (nextSelections: monacoTypes.Selection[]) => {
      selections = nextSelections;
    },
    setTextFocused: (focused: boolean) => {
      textFocused = focused;
    },
    setValue: (nextValue: string) => {
      value = nextValue;
    },
    updateOptions,
  };
}

function setup(initialValue?: string) {
  const harness = createEditorHarness(initialValue);
  const onManualQueryChange = jest.fn();
  const registration = registerPrometheusQueryCoauthoring({
    createQuery: (value) => ({ expr: value, refId: 'A' }),
    editor: harness.editor,
    getDatasource: () => ({ interpolateString: (value: string) => value }) as unknown as PrometheusDatasource,
    getExternalQuery: harness.getExternalValue,
    getLanguageProvider: () =>
      ({
        retrieveMetricsMetadata: () => ({}),
        queryMetricsMetadata: async () => ({}),
        queryLabelKeys: async () => [],
      }) as unknown as PrometheusLanguageProviderInterface,
    getTimeRange: () => ({}) as TimeRange,
    monaco: harness.monaco,
    onManualQueryChange,
    styles: { portal: 'portal-class' },
    widgetId: 'test-query-coauthoring',
  });

  return { ...harness, adapter: registration.adapter, onManualQueryChange, registration };
}

describe('registerPrometheusQueryCoauthoring', () => {
  afterEach(() => document.body.replaceChildren());

  it('registers a stable row adapter and cleans up Monaco resources', () => {
    const {
      actionDisposable,
      adapter,
      blurDisposable,
      contentDisposable,
      editor,
      getContentWidget,
      layoutDisposable,
      mouseDownDisposable,
      mouseUpDisposable,
      focusDisposable,
      registration,
      selectionDisposable,
    } = setup();

    expect(adapter.getSnapshot()).toBe(adapter.getSnapshot());
    expect(adapter.getSnapshot()).toEqual({ mode: 'hidden' });
    expect(getContentWidget().getDomNode()).toHaveClass('portal-class');

    registration.dispose();

    expect(actionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(blurDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(contentDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(layoutDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(mouseDownDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(mouseUpDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(focusDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(selectionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(editor.removeContentWidget).toHaveBeenCalledTimes(1);
  });

  it('publishes Core-owned selection UI at the midpoint of settled Monaco selections', () => {
    const {
      adapter,
      getContentWidget,
      notifyMouseDown,
      notifyMouseUp,
      notifySelectionChange,
      registration,
      setSelections,
    } = setup();
    const selection = createSelection(4, 12);
    setSelections([selection]);

    notifyMouseDown();
    notifySelectionChange();
    expect(adapter.getSnapshot()).toEqual({ mode: 'hidden' });

    notifyMouseUp();
    const snapshot = adapter.getSnapshot();
    expect(snapshot).toEqual({ mode: 'selection', portalTarget: getContentWidget().getDomNode() });
    expect(getContentWidget().getPosition()).toEqual({
      position: { lineNumber: 1, column: 8 },
      preference: [1],
    });
    registration.dispose();
  });

  it('hides the selection toolbar when Monaco loses text focus', () => {
    const {
      adapter,
      getContentWidget,
      notifyBlur,
      notifyFocus,
      notifySelectionChange,
      registration,
      setSelections,
      setTextFocused,
    } = setup();
    setSelections([createSelection()]);
    notifySelectionChange();
    expect(adapter.getSnapshot()).toEqual({ mode: 'selection', portalTarget: getContentWidget().getDomNode() });

    setTextFocused(false);
    notifyBlur();
    expect(adapter.getSnapshot()).toEqual({ mode: 'hidden' });

    notifySelectionChange();
    expect(adapter.getSnapshot()).toEqual({ mode: 'hidden' });

    setTextFocused(true);
    notifyFocus();
    expect(adapter.getSnapshot()).toEqual({ mode: 'selection', portalTarget: getContentWidget().getDomNode() });

    adapter.invoke();
    const invokedSnapshot = adapter.getSnapshot();
    setTextFocused(false);
    notifyBlur();
    expect(adapter.getSnapshot()).toBe(invokedSnapshot);
    registration.dispose();
  });

  it('resets an in-progress modifier selection when the window loses focus', () => {
    const {
      adapter,
      getContentWidget,
      notifyFocus,
      notifySelectionChange,
      registration,
      setSelections,
      setTextFocused,
    } = setup();
    setSelections([createSelection()]);
    notifySelectionChange();

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })));
    expect(adapter.getSnapshot()).toEqual({ mode: 'hidden' });

    setTextFocused(false);
    act(() => window.dispatchEvent(new Event('blur')));
    act(() => document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' })));
    expect(adapter.getSnapshot()).toEqual({ mode: 'hidden' });

    setTextFocused(true);
    notifyFocus();
    expect(adapter.getSnapshot()).toEqual({ mode: 'selection', portalTarget: getContentWidget().getDomNode() });
    registration.dispose();
  });

  it('invokes the whole query from the keyboard shortcut without a selection', async () => {
    const { adapter, editor, getContentWidget, getEditorAction, registration } = setup();
    const action = getEditorAction();
    expect(action).toMatchObject({ label: 'Coauthor PromQL query', keybindings: [2048 | 84] });

    act(() => action.run(editor));

    const snapshot = adapter.getSnapshot();
    expect(snapshot).toEqual({
      mode: 'invoked',
      invocationId: 'test-query-coauthoring:1',
      portalTarget: getContentWidget().getDomNode(),
    });
    await expect(adapter.readInvocation('test-query-coauthoring:1')).resolves.toMatchObject({
      baseline: { refId: 'A', expr: 'rate(http_requests_total[5m])' },
      context: {
        revision: 'test-query-coauthoring:1',
        query: 'rate(http_requests_total[5m])',
        focusRanges: [{ from: 0, to: 29 }],
      },
    });
    registration.dispose();
  });

  it('captures unblurred Monaco contents and the active selection atomically', async () => {
    const { adapter, registration, setSelections, setValue } = setup();
    setValue('sum(rate(http_requests_total[5m]))');
    setSelections([createSelection(5, 9)]);

    adapter.invoke();
    setValue('up');

    await expect(adapter.readInvocation('test-query-coauthoring:1')).resolves.toMatchObject({
      baseline: { expr: 'sum(rate(http_requests_total[5m]))' },
      context: {
        query: 'sum(rate(http_requests_total[5m]))',
        focusRanges: [{ from: 4, to: 8 }],
      },
    });
    registration.dispose();
  });

  it('prepares typed proposals without decorating or locking Monaco', () => {
    const { adapter, deltaDecorations, registration, updateOptions } = setup();
    adapter.invoke();

    expect(adapter.prepareProposal('test-query-coauthoring:1', 'increase(http_requests_total[5m])')).toEqual({
      status: 'ready',
      query: { refId: 'A', expr: 'increase(http_requests_total[5m])' },
      changes: [expect.objectContaining({ original: 'rate', proposed: 'increase', kind: 'function' })],
    });
    expect(deltaDecorations).not.toHaveBeenCalled();
    expect(updateOptions).not.toHaveBeenCalled();
    registration.dispose();
  });

  it('keeps the invocation active for a Core-controlled proposal update', () => {
    const { adapter, notifyContentChange, onManualQueryChange, registration, setExternalValue, setValue } = setup();
    adapter.invoke();
    const proposal = 'increase(http_requests_total[5m])';

    setExternalValue(proposal);
    setValue(proposal);
    notifyContentChange();

    expect(adapter.getSnapshot()).toMatchObject({ mode: 'invoked', invocationId: 'test-query-coauthoring:1' });
    expect(onManualQueryChange).not.toHaveBeenCalled();
    registration.dispose();
  });

  it('cancels the invocation and forwards a genuine Monaco edit through the normal query path', () => {
    const { adapter, notifyContentChange, onManualQueryChange, registration, setValue } = setup();
    adapter.invoke();

    setValue('sum(rate(http_requests_total[5m]))');
    notifyContentChange();

    expect(onManualQueryChange).toHaveBeenCalledWith('sum(rate(http_requests_total[5m]))');
    expect(adapter.getSnapshot()).toEqual({ mode: 'hidden' });
    expect(adapter.prepareProposal('test-query-coauthoring:1', 'up')).toEqual({
      status: 'rejected',
      reason: 'stale',
    });
    registration.dispose();
  });

  it('rejects context that finishes after dismissal', async () => {
    const harness = createEditorHarness();
    let resolveMetadata: ((metadata: Record<string, never>) => void) | undefined;
    const metadata = new Promise<Record<string, never>>((resolve) => {
      resolveMetadata = resolve;
    });
    const registration = registerPrometheusQueryCoauthoring({
      createQuery: (value) => ({ expr: value, refId: 'A' }),
      editor: harness.editor,
      getDatasource: () => ({ interpolateString: (value: string) => value }) as unknown as PrometheusDatasource,
      getExternalQuery: harness.getExternalValue,
      getLanguageProvider: () =>
        ({
          retrieveMetricsMetadata: () => ({}),
          queryMetricsMetadata: () => metadata,
          queryLabelKeys: async () => [],
        }) as unknown as PrometheusLanguageProviderInterface,
      getTimeRange: () => ({}) as TimeRange,
      monaco: harness.monaco,
      onManualQueryChange: jest.fn(),
      styles: { portal: 'portal-class' },
      widgetId: 'test-query-coauthoring',
    });
    registration.adapter.invoke();
    const invocation = registration.adapter.readInvocation('test-query-coauthoring:1');

    registration.adapter.dismiss();
    resolveMetadata?.({});

    await expect(invocation).rejects.toThrow('no longer active');
    registration.dispose();
  });

  it('does not perform optional metric lookups when datasource lookups are disabled', async () => {
    const harness = createEditorHarness();
    const queryMetricsMetadata = jest.fn(async () => ({}));
    const queryLabelKeys = jest.fn(async () => []);
    const registration = registerPrometheusQueryCoauthoring({
      createQuery: (value) => ({ expr: value, refId: 'A' }),
      editor: harness.editor,
      getDatasource: () =>
        ({ interpolateString: (value: string) => value, lookupsDisabled: true }) as unknown as PrometheusDatasource,
      getExternalQuery: harness.getExternalValue,
      getLanguageProvider: () =>
        ({
          retrieveMetricsMetadata: () => ({}),
          queryMetricsMetadata,
          queryLabelKeys,
        }) as unknown as PrometheusLanguageProviderInterface,
      getTimeRange: () => ({}) as TimeRange,
      monaco: harness.monaco,
      onManualQueryChange: jest.fn(),
      styles: { portal: 'portal-class' },
      widgetId: 'test-query-coauthoring',
    });

    registration.adapter.invoke();
    await expect(registration.adapter.readInvocation('test-query-coauthoring:1')).resolves.toMatchObject({
      context: { metadata: [{ kind: 'metric', name: 'http_requests_total', attributes: {} }] },
    });
    expect(queryMetricsMetadata).not.toHaveBeenCalled();
    expect(queryLabelKeys).not.toHaveBeenCalled();
    registration.dispose();
  });

  it('returns to selection-trigger mode on dismissal', () => {
    const { adapter, getContentWidget, notifySelectionChange, registration, setSelections } = setup();
    setSelections([createSelection()]);
    notifySelectionChange();
    adapter.invoke();

    adapter.dismiss();

    expect(adapter.getSnapshot()).toEqual({ mode: 'selection', portalTarget: getContentWidget().getDomNode() });
    registration.dispose();
  });

  it('measures the Core-owned surface inside the Monaco host', () => {
    const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    let resizeCallback: ResizeObserverCallback | undefined;
    const disconnect = jest.fn();
    const observe = jest.fn();
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      disconnect = disconnect;
      observe = observe;
      unobserve = jest.fn();
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: ResizeObserverMock });
    const { adapter, getContentWidget, registration } = setup();

    try {
      adapter.invoke();
      const widget = getContentWidget();
      expect(widget.beforeRender?.()).toEqual({ height: 320, width: 403 });
      expect(widget.getDomNode()).toHaveStyle({ visibility: 'hidden' });

      widget.getDomNode().append(document.createElement('div'));
      act(() =>
        resizeCallback?.([{ contentRect: createRect(0, 300, 0, 240) } as ResizeObserverEntry], {} as ResizeObserver)
      );

      expect(widget.beforeRender?.()).toEqual({ height: 240, width: 300 });
      widget.afterRender?.(2);
      expect(widget.getDomNode().style.visibility).toBe('');
    } finally {
      registration.dispose();
      expect(observe).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
      if (resizeObserverDescriptor) {
        Object.defineProperty(globalThis, 'ResizeObserver', resizeObserverDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'ResizeObserver');
      }
    }
  });

  it('keeps the selection toolbar inside the viewport', () => {
    const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const { getContentWidget, notifySelectionChange, registration, setSelections } = setup();
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
      setSelections([createSelection()]);
      notifySelectionChange();
      const widget = getContentWidget();
      jest.spyOn(widget.getDomNode(), 'getBoundingClientRect').mockReturnValue(createRect(950, 1128, 400, 434));

      widget.afterRender?.(1);

      expect(widget.getDomNode()).toHaveStyle({ transform: 'translate(-136px, -4px)' });
    } finally {
      registration.dispose();
      if (innerWidthDescriptor) {
        Object.defineProperty(window, 'innerWidth', innerWidthDescriptor);
      }
    }
  });
});
