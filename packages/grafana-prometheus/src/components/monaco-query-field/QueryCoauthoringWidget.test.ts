import { act } from '@testing-library/react';

import { type TimeRange } from '@grafana/data';
import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import { QUERY_COAUTHORING_MAX_CONTEXT_LABELS } from '../../query_coauthoring/capability';
import {
  createPrometheusQueryCoauthoringController,
  registerPrometheusQueryCoauthoring,
} from './QueryCoauthoringWidget';

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

function createEditorHarness() {
  let contentWidget: monacoTypes.editor.IContentWidget | undefined;
  let editorAction: monacoTypes.editor.IActionDescriptor | undefined;
  let layoutListener: VoidFunction | undefined;
  let contentListener: VoidFunction | undefined;
  let selectionListener: VoidFunction | undefined;
  const actionDisposable = { dispose: jest.fn() };
  const layoutDisposable = { dispose: jest.fn(() => (layoutListener = undefined)) };
  const contentDisposable = { dispose: jest.fn(() => (contentListener = undefined)) };
  const selectionDisposable = { dispose: jest.fn(() => (selectionListener = undefined)) };
  const editor = {
    addAction: jest.fn((action: monacoTypes.editor.IActionDescriptor) => {
      editorAction = action;
      return actionDisposable;
    }),
    addContentWidget: jest.fn((widget: monacoTypes.editor.IContentWidget) => {
      contentWidget = widget;
      document.body.append(widget.getDomNode());
    }),
    getModel: jest.fn(),
    getPosition: jest.fn(() => ({ lineNumber: 1, column: 1 })),
    getSelection: jest.fn(),
    getSelections: jest.fn(() => []),
    getValue: jest.fn(() => 'rate(http_requests_total[5m])'),
    layoutContentWidget: jest.fn(),
    onDidLayoutChange: jest.fn((listener: VoidFunction) => {
      layoutListener = listener;
      return layoutDisposable;
    }),
    onDidChangeModelContent: jest.fn((listener: VoidFunction) => {
      contentListener = listener;
      return contentDisposable;
    }),
    onDidChangeCursorSelection: jest.fn((listener: VoidFunction) => {
      selectionListener = listener;
      return selectionDisposable;
    }),
    removeContentWidget: jest.fn((widget: monacoTypes.editor.IContentWidget) => widget.getDomNode().remove()),
  } as unknown as MonacoEditor;
  const monaco = {
    editor: { ContentWidgetPositionPreference: { BELOW: 2, ABOVE: 1 } },
  } as unknown as Monaco;

  return {
    actionDisposable,
    contentDisposable,
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
    layoutDisposable,
    monaco,
    notifyContentChange: () => act(() => contentListener?.()),
    notifyLayoutChange: () => act(() => layoutListener?.()),
    notifySelectionChange: () => act(() => selectionListener?.()),
    selectionDisposable,
  };
}

function setup() {
  const harness = createEditorHarness();
  const registration = registerPrometheusQueryCoauthoring({
    createQuery: (value) => ({ expr: value, refId: 'A' }),
    editor: harness.editor,
    getDatasource: () => ({ interpolateString: (value: string) => value }) as unknown as PrometheusDatasource,
    getLanguageProvider: () =>
      ({
        retrieveMetricsMetadata: () => ({}),
        queryMetricsMetadata: async () => ({}),
        queryLabelKeys: async () => [],
      }) as unknown as PrometheusLanguageProviderInterface,
    getTimeRange: () => ({}) as TimeRange,
    monaco: harness.monaco,
    styles: { portal: 'portal-class', previewChange: 'preview-change', previewOriginal: 'preview-original' },
    widgetId: 'test-query-coauthoring',
  });

  return { ...harness, registration, capability: registration.capability, dispose: registration.dispose };
}

function createSelection(startColumn = 4, endColumn = 12): monacoTypes.Selection {
  return {
    getStartPosition: () => ({ lineNumber: 1, column: startColumn }),
    getEndPosition: () => ({ lineNumber: 1, column: endColumn }),
    isEmpty: () => false,
  } as monacoTypes.Selection;
}

describe('registerPrometheusQueryCoauthoring', () => {
  afterEach(() => document.body.replaceChildren());

  it('registers only the Monaco host and cleans up its editor resources', () => {
    const {
      actionDisposable,
      capability,
      contentDisposable,
      dispose,
      editor,
      getContentWidget,
      layoutDisposable,
      notifySelectionChange,
      registration,
      selectionDisposable,
    } = setup();
    const clearPreview = jest.spyOn(capability, 'clearPreview');
    const selection = createSelection();
    jest.mocked(editor.getSelection).mockReturnValue(selection);
    jest.mocked(editor.getSelections).mockReturnValue([selection]);

    expect(editor.addContentWidget).toHaveBeenCalledTimes(1);
    expect(getContentWidget().getDomNode()).toHaveClass('portal-class');
    expect(registration.getSnapshot()).toEqual({ mode: 'hidden' });

    notifySelectionChange();
    expect(registration.getSnapshot()).toEqual({ mode: 'selection-toolbar' });
    expect(registration.getSelectedText()).toBe('');

    dispose();
    expect(clearPreview).toHaveBeenCalledTimes(1);
    expect(actionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(contentDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(layoutDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(selectionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(editor.removeContentWidget).toHaveBeenCalledTimes(1);
  });

  it('offers a command-palette action without a direct shortcut', async () => {
    const { dispose, editor, getEditorAction, registration } = setup();
    const action = getEditorAction();
    expect(action).toMatchObject({ label: 'Coauthor PromQL query', run: expect.any(Function) });
    expect(action).not.toHaveProperty('keybindings');

    act(() => action.run(editor));
    expect(registration.getSnapshot()).toEqual({ mode: 'session' });
    dispose();
  });

  it('keeps a stable controller snapshot and rejects proposals from an obsolete query revision', async () => {
    const { capability, notifyContentChange, registration } = setup();
    jest.spyOn(capability, 'getContext').mockResolvedValue({
      query: 'rate(http_requests_total[$__rate_interval])',
      focusRanges: [],
      metricMetadata: [],
    });
    jest.spyOn(capability, 'refreshContext').mockResolvedValue({
      query: 'rate(http_requests_total[$__rate_interval])',
      focusRanges: [],
      metricMetadata: [],
    });
    const getValue = jest.spyOn(capability, 'getValue').mockReturnValue('rate(http_requests_total[$__rate_interval])');
    jest.spyOn(capability, 'stagePreview').mockReturnValue({ changes: [] });
    jest.spyOn(capability, 'createQuery').mockReturnValue({ expr: 'sum(rate(http_requests_total[5m]))', refId: 'A' });
    const controller = createPrometheusQueryCoauthoringController(registration);
    const listener = jest.fn();
    const unsubscribe = controller.subscribe(listener);

    expect(controller.getSnapshot()).toBe(controller.getSnapshot());
    const firstContext = controller.begin();
    const secondContext = controller.begin();
    expect(capability.getContext).toHaveBeenCalledTimes(1);
    const context = await firstContext;
    await expect(secondContext).resolves.toBe(context);
    await expect(controller.begin()).resolves.toBe(context);
    expect(context).toMatchObject({ revision: '1', query: 'rate(http_requests_total[$__rate_interval])' });
    expect(listener).toHaveBeenCalled();

    notifyContentChange();
    expect(controller.getSnapshot()).toMatchObject({ revision: '2' });
    expect(controller.stageEditorDiff('sum(rate(http_requests_total[5m]))')).toEqual({
      status: 'rejected',
      reason: 'stale',
    });

    await controller.refreshContext();
    jest.spyOn(capability, 'validateQuery').mockReturnValue(false);
    expect(controller.stageEditorDiff('not valid')).toEqual({ status: 'rejected', reason: 'invalid' });

    jest.mocked(capability.validateQuery).mockReturnValue(true);
    getValue.mockReturnValue('rate(http_requests_total[5m])');
    expect(controller.stageEditorDiff('sum(rate(http_requests_total[5m]))')).toEqual({
      status: 'rejected',
      reason: 'stale',
    });

    unsubscribe();
    registration.dispose();
  });

  it('subscribes to the Monaco host only while the controller has listeners', () => {
    const { registration } = setup();
    const hostUnsubscribe = jest.fn();
    const hostSubscribe = jest.spyOn(registration, 'subscribe').mockReturnValue(hostUnsubscribe);
    const controller = createPrometheusQueryCoauthoringController(registration);

    expect(hostSubscribe).not.toHaveBeenCalled();
    const unsubscribe = controller.subscribe(jest.fn());
    expect(hostSubscribe).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(hostUnsubscribe).toHaveBeenCalledTimes(1);
    registration.dispose();
  });

  it('reads the current Monaco state when its first listener subscribes', () => {
    const { registration } = setup();
    const controller = createPrometheusQueryCoauthoringController(registration);

    registration.invoke();
    expect(controller.getSnapshot()).toEqual({ mode: 'hidden' });
    const unsubscribe = controller.subscribe(jest.fn());
    expect(controller.getSnapshot()).toMatchObject({ mode: 'session' });

    unsubscribe();
    registration.dispose();
  });

  it('discards context that finishes loading after dismissal', async () => {
    const { capability, registration } = setup();
    let resolveFirstContext: ((context: Awaited<ReturnType<typeof capability.getContext>>) => void) | undefined;
    const firstContext = new Promise<Awaited<ReturnType<typeof capability.getContext>>>((resolve) => {
      resolveFirstContext = resolve;
    });
    jest.spyOn(capability, 'getContext').mockReturnValueOnce(firstContext).mockResolvedValueOnce({
      query: 'rate(new_query[5m])',
      focusRanges: [],
      metricMetadata: [],
    });
    const controller = createPrometheusQueryCoauthoringController(registration);

    const dismissedContext = controller.begin();
    controller.dismiss();
    resolveFirstContext?.({
      query: 'rate(stale_query[5m])',
      focusRanges: [],
      metricMetadata: [],
    });

    await expect(dismissedContext).rejects.toThrow('dismissed');
    await expect(controller.begin()).resolves.toMatchObject({ query: 'rate(new_query[5m])' });
    expect(capability.getContext).toHaveBeenCalledTimes(2);
    registration.dispose();
  });

  it('uses the measured Core surface size for deterministic placement', async () => {
    const requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
    const cancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(window, 'cancelAnimationFrame');
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: jest.fn((callback: FrameRequestCallback) => {
        const frame = nextFrame++;
        frameCallbacks.set(frame, callback);
        return frame;
      }),
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: jest.fn((frame: number) => frameCallbacks.delete(frame)),
    });
    const { dispose, editor, getContentWidget, registration } = setup();
    const controller = createPrometheusQueryCoauthoringController(registration);

    try {
      await controller.begin();
      const widget = getContentWidget();
      expect(widget.getPosition()).toMatchObject({ position: { lineNumber: 1, column: 1 }, preference: [2, 1] });
      expect(widget.beforeRender?.()).toEqual({ height: 320, width: 403 });
      expect(widget.getDomNode()).toHaveStyle({ visibility: 'hidden' });

      widget.getDomNode().append(document.createElement('div'));
      controller.reportSurfaceSize({ height: 240, width: 300 });
      expect(widget.beforeRender?.()).toEqual({ height: 240, width: 300 });
      expect(editor.layoutContentWidget).toHaveBeenCalledTimes(1);

      act(() => frameCallbacks.get(1)?.(0));
      widget.afterRender?.(widget.getPosition()?.preference?.[0] ?? null);
      expect(widget.getDomNode().style.visibility).toBe('');
    } finally {
      dispose();
      if (requestAnimationFrameDescriptor) {
        Object.defineProperty(window, 'requestAnimationFrame', requestAnimationFrameDescriptor);
      }
      if (cancelAnimationFrameDescriptor) {
        Object.defineProperty(window, 'cancelAnimationFrame', cancelAnimationFrameDescriptor);
      }
    }
  });

  it('keeps the widget within the viewport without constraining it to the editor width', async () => {
    const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const { dispose, getContentWidget, registration } = setup();
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
      await createPrometheusQueryCoauthoringController(registration).begin();
      const widget = getContentWidget();
      jest.spyOn(widget.getDomNode(), 'getBoundingClientRect').mockReturnValue(createRect(850, 1138, 200, 520));

      widget.afterRender?.(widget.getPosition()?.preference?.[0] ?? null);
      expect(widget.getDomNode()).toHaveStyle({ transform: 'translateX(-146px)' });
    } finally {
      dispose();
      if (innerWidthDescriptor) {
        Object.defineProperty(window, 'innerWidth', innerWidthDescriptor);
      }
    }
  });

  it('coalesces viewport and editor layout changes', () => {
    const requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
    const callbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: jest.fn((callback: FrameRequestCallback) => {
        callbacks.set(1, callback);
        return 1;
      }),
    });
    const { dispose, editor, notifyLayoutChange, notifySelectionChange } = setup();
    const selection = createSelection();
    jest.mocked(editor.getSelection).mockReturnValue(selection);
    jest.mocked(editor.getSelections).mockReturnValue([selection]);

    try {
      notifySelectionChange();
      const calls = jest.mocked(editor.layoutContentWidget).mock.calls.length;
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
      notifyLayoutChange();
      expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(editor.layoutContentWidget).toHaveBeenCalledTimes(calls);
      act(() => callbacks.get(1)?.(0));
      expect(editor.layoutContentWidget).toHaveBeenCalledTimes(calls + 1);
    } finally {
      dispose();
      if (requestAnimationFrameDescriptor) {
        Object.defineProperty(window, 'requestAnimationFrame', requestAnimationFrameDescriptor);
      }
    }
  });

  it('preserves multiple selected fragments for the Core Copy control', () => {
    const { dispose, editor, notifySelectionChange, registration } = setup();
    const firstSelection = createSelection(4, 12);
    const secondSelection = createSelection(16, 24);
    jest.mocked(editor.getSelection).mockReturnValue(secondSelection);
    jest.mocked(editor.getSelections).mockReturnValue([firstSelection, secondSelection]);
    const getValueInRange = jest.fn().mockReturnValueOnce('http_requests_total').mockReturnValueOnce('handler="api"');
    jest.mocked(editor.getModel).mockReturnValue({ getValueInRange } as unknown as monacoTypes.editor.ITextModel);

    notifySelectionChange();
    expect(registration.getSelectedText()).toBe('http_requests_total\nhandler="api"');
    expect(getValueInRange).toHaveBeenNthCalledWith(1, firstSelection);
    expect(getValueInRange).toHaveBeenNthCalledWith(2, secondSelection);
    dispose();
  });

  it('uses the current language provider and time range when context is requested', async () => {
    const { editor, monaco } = createEditorHarness();
    const initialProvider = {
      retrieveMetricsMetadata: jest.fn(() => ({})),
      queryMetricsMetadata: jest.fn(async () => ({})),
      queryLabelKeys: jest.fn(async () => []),
    } as unknown as PrometheusLanguageProviderInterface;
    const currentProvider = {
      retrieveMetricsMetadata: jest.fn(() => ({
        http_requests_total: { type: 'counter', help: 'Current metadata.' },
      })),
      queryMetricsMetadata: jest.fn(async () => ({})),
      queryLabelKeys: jest.fn(async () => ['__name__', 'handler']),
    } as unknown as PrometheusLanguageProviderInterface;
    const currentRange = { from: { valueOf: () => 3 }, to: { valueOf: () => 4 } } as TimeRange;
    let languageProvider = initialProvider;
    let timeRange = {} as TimeRange;
    const registration = registerPrometheusQueryCoauthoring({
      createQuery: (value) => ({ expr: value, refId: 'A' }),
      editor,
      getDatasource: () => ({ interpolateString: (value: string) => value }) as unknown as PrometheusDatasource,
      getLanguageProvider: () => languageProvider,
      getTimeRange: () => timeRange,
      monaco,
      styles: { portal: 'portal', previewChange: 'change', previewOriginal: 'original' },
      widgetId: 'test-current-context',
    });
    languageProvider = currentProvider;
    timeRange = currentRange;

    await expect(createPrometheusQueryCoauthoringController(registration).begin()).resolves.toMatchObject({
      language: {
        id: 'promql',
        displayName: 'PromQL',
        guidance: expect.arrayContaining([expect.stringContaining('rate expression inside an aggregation')]),
      },
      metadata: [
        {
          kind: 'metric',
          name: 'http_requests_total',
          attributes: { type: 'counter', labels: ['handler'] },
        },
      ],
    });
    expect(currentProvider.queryLabelKeys).toHaveBeenCalledWith(
      currentRange,
      '{__name__="http_requests_total"}',
      QUERY_COAUTHORING_MAX_CONTEXT_LABELS
    );
    registration.dispose();
  });

  it('builds a valid selector when fetching labels for a UTF-8 metric name', async () => {
    const { editor, monaco } = createEditorHarness();
    jest.mocked(editor.getValue).mockReturnValue('{"mé\\"tric\\\\total"}');
    const queryLabelKeys = jest.fn(async () => []);
    const registration = registerPrometheusQueryCoauthoring({
      createQuery: (value) => ({ expr: value, refId: 'A' }),
      editor,
      getDatasource: () => ({ interpolateString: (value: string) => value }) as unknown as PrometheusDatasource,
      getLanguageProvider: () =>
        ({
          retrieveMetricsMetadata: () => ({}),
          queryMetricsMetadata: async () => ({}),
          queryLabelKeys,
        }) as unknown as PrometheusLanguageProviderInterface,
      getTimeRange: () => ({}) as TimeRange,
      monaco,
      styles: { portal: 'portal', previewChange: 'change', previewOriginal: 'original' },
      widgetId: 'test-utf8-context',
    });

    await createPrometheusQueryCoauthoringController(registration).begin();
    expect(queryLabelKeys).toHaveBeenCalledWith(
      expect.anything(),
      '{__name__="mé\\"tric\\\\total"}',
      QUERY_COAUTHORING_MAX_CONTEXT_LABELS
    );
    registration.dispose();
  });
});
