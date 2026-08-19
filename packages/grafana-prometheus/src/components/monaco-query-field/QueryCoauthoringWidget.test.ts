import { createElement } from 'react';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { createTheme, ThemeContext, type TimeRange } from '@grafana/data';
import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import enUsTranslations from '../../locales/en-US/grafana-prometheus.json';
import {
  type PrometheusCoauthoringCapability,
  QUERY_COAUTHORING_MAX_CONTEXT_LABELS,
} from '../../query_coauthoring/capability';
import { QueryCoauthoringChrome } from './QueryCoauthoringChrome';
import { registerPrometheusQueryCoauthoring } from './QueryCoauthoringWidget';

const monacoQueryFieldTranslations = enUsTranslations['grafana-prometheus'].components['monaco-query-field'];

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
  let selectionListener: VoidFunction | undefined;
  const editorNode = document.createElement('div');
  const actionDisposable = { dispose: jest.fn() };
  const layoutDisposable = { dispose: jest.fn(() => (layoutListener = undefined)) };
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
    getDomNode: jest.fn(() => editorNode),
    getPosition: jest.fn(() => ({ lineNumber: 1, column: 1 })),
    getSelection: jest.fn(),
    getSelections: jest.fn(() => []),
    getValue: jest.fn(() => 'rate(http_requests_total[5m])'),
    layoutContentWidget: jest.fn(),
    onDidLayoutChange: jest.fn((listener: VoidFunction) => {
      layoutListener = listener;
      return layoutDisposable;
    }),
    onDidChangeCursorSelection: jest.fn((listener: VoidFunction) => {
      selectionListener = listener;
      return selectionDisposable;
    }),
    removeContentWidget: jest.fn((widget: monacoTypes.editor.IContentWidget) => widget.getDomNode().remove()),
  } as unknown as MonacoEditor;
  const monaco = {
    editor: {
      ContentWidgetPositionPreference: {
        BELOW: 2,
        ABOVE: 1,
      },
    },
  } as unknown as Monaco;

  return {
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
    monaco,
    notifyLayoutChange: () => act(() => layoutListener?.()),
    notifySelectionChange: () => act(() => selectionListener?.()),
    actionDisposable,
    layoutDisposable,
    selectionDisposable,
  };
}

function setup() {
  const {
    actionDisposable,
    editor,
    getContentWidget,
    getEditorAction,
    layoutDisposable,
    monaco,
    notifyLayoutChange,
    notifySelectionChange,
    selectionDisposable,
  } = createEditorHarness();
  const onRegister = jest.fn();

  const registration = registerPrometheusQueryCoauthoring({
    createQuery: (value) => ({ expr: value, refId: 'A' }),
    editor,
    getDatasource: () => ({ interpolateString: (value: string) => value }) as unknown as PrometheusDatasource,
    getLanguageProvider: () =>
      ({
        retrieveMetricsMetadata: () => ({}),
        queryMetricsMetadata: async () => ({}),
        queryLabelKeys: async () => [],
      }) as unknown as PrometheusLanguageProviderInterface,
    getTimeRange: () => ({}) as TimeRange,
    monaco,
    onRegister,
    previewStyles: {
      previewChange: 'preview-change',
      previewOriginal: 'preview-original',
    },
    widgetId: 'test-query-coauthoring',
  });
  const renderChrome = (theme = createTheme()) =>
    createElement(ThemeContext.Provider, { value: theme }, createElement(QueryCoauthoringChrome, { registration }));
  const chrome = render(renderChrome());
  const capability = onRegister.mock.calls[0][0] as PrometheusCoauthoringCapability;

  return {
    actionDisposable,
    capability,
    dispose: registration.dispose,
    editor,
    getContentWidget,
    getEditorAction,
    layoutDisposable,
    notifyLayoutChange,
    notifySelectionChange,
    onRegister,
    registration,
    selectionDisposable,
    rerenderChrome: (theme: ReturnType<typeof createTheme>) => chrome.rerender(renderChrome(theme)),
    unmountChrome: chrome.unmount,
    updatePreviewStyles: registration.updatePreviewStyles,
  };
}

describe('registerPrometheusQueryCoauthoring', () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  it('registers the capability, renders accessible React chrome, and cleans up the editor widget', () => {
    const {
      actionDisposable,
      capability,
      dispose,
      editor,
      getContentWidget,
      layoutDisposable,
      notifySelectionChange,
      onRegister,
      selectionDisposable,
    } = setup();
    const clearPreview = jest.spyOn(capability, 'clearPreview');
    const selection = {
      getEndPosition: () => ({ lineNumber: 1, column: 12 }),
      isEmpty: () => false,
    } as monacoTypes.Selection;
    jest.mocked(editor.getSelection).mockReturnValue(selection);
    jest.mocked(editor.getSelections).mockReturnValue([selection]);

    expect(editor.addContentWidget).toHaveBeenCalledTimes(1);
    expect(onRegister).toHaveBeenCalledWith(capability);
    expect(getComputedStyle(getContentWidget().getDomNode()).zIndex).toBe(String(createTheme().zIndex.portal));
    expect(monacoQueryFieldTranslations.coauthor).toBe('Coauthor');
    expect(monacoQueryFieldTranslations.copy).toBe('Copy');

    notifySelectionChange();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeVisible();
    const coauthorButton = screen.getByRole('button', { name: 'Coauthor' });
    expect(coauthorButton).toBeVisible();
    expect(coauthorButton).toHaveAccessibleName('Coauthor');

    jest.mocked(editor.getSelections).mockReturnValue([]);
    notifySelectionChange();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Coauthor' })).not.toBeInTheDocument();

    dispose();

    expect(clearPreview).toHaveBeenCalledTimes(1);
    expect(actionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(layoutDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(selectionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(editor.removeContentWidget).toHaveBeenCalledTimes(1);
    expect(onRegister).toHaveBeenLastCalledWith(undefined);
  });

  it('offers a command-palette action without a direct shortcut', () => {
    const { capability, dispose, editor, getEditorAction } = setup();
    const onInvoke = jest.fn();
    capability.subscribeToInvocation(onInvoke);

    const action = getEditorAction();
    expect(monacoQueryFieldTranslations['coauthor-promql-query']).toBe('Coauthor PromQL query');
    expect(action).toMatchObject({
      label: 'Coauthor PromQL query',
      run: expect.any(Function),
    });
    expect(action).not.toHaveProperty('keybindings');

    act(() => action.run(editor));

    expect(onInvoke).toHaveBeenCalledWith({
      anchorElement: expect.any(HTMLElement),
      dismiss: expect.any(Function),
    });

    dispose();
  });

  it('preserves selection, keeps one Assistant host across React rerenders, and restores the toolbar after dismissal', () => {
    const { capability, dispose, editor, notifySelectionChange, rerenderChrome } = setup();
    const clearPreview = jest.spyOn(capability, 'clearPreview');
    const onInvoke = jest.fn();
    capability.subscribeToInvocation(onInvoke);
    const selection = {
      getEndPosition: () => ({ lineNumber: 1, column: 12 }),
      isEmpty: () => false,
    } as monacoTypes.Selection;
    jest.mocked(editor.getSelection).mockReturnValue(selection);
    jest.mocked(editor.getSelections).mockReturnValue([selection]);

    notifySelectionChange();
    const coauthorButton = screen.getByRole('button', { name: 'Coauthor' });
    expect(fireEvent.mouseDown(coauthorButton)).toBe(false);
    fireEvent.click(coauthorButton);

    expect(onInvoke).toHaveBeenCalledWith({
      anchorElement: expect.any(HTMLElement),
      dismiss: expect.any(Function),
    });
    const invocation = onInvoke.mock.calls[0][0];
    expect(invocation.anchorElement).toBeVisible();
    expect(invocation.anchorElement).not.toHaveAttribute('role');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Coauthor' })).not.toBeInTheDocument();

    const anchorElement = invocation.anchorElement;
    const widgetElement = screen.getByTestId('prometheus-query-coauthoring-widget');
    const darkThemeClassName = widgetElement.className;
    rerenderChrome(createTheme({ colors: { mode: 'light' } }));
    expect(onInvoke).toHaveBeenCalledTimes(1);
    expect(onInvoke.mock.calls[0][0].anchorElement).toBe(anchorElement);
    expect(screen.getByTestId('prometheus-query-coauthoring-widget')).toBe(widgetElement);
    expect(widgetElement.className).not.toBe(darkThemeClassName);

    act(() => invocation.dismiss());

    expect(clearPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Coauthor' })).toBeVisible();

    dispose();
  });

  it('uses the committed React size for deterministic placement without owning a second height budget', () => {
    const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    const requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
    const cancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(window, 'cancelAnimationFrame');
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let notifyResize: VoidFunction | undefined;
    let nextFrame = 1;
    const requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      const frame = nextFrame++;
      frameCallbacks.set(frame, callback);
      return frame;
    });
    const cancelAnimationFrame = jest.fn((frame: number) => frameCallbacks.delete(frame));
    const resizeObserver = {
      disconnect: jest.fn(),
      observe: jest.fn(),
      unobserve: jest.fn(),
    } as unknown as ResizeObserver;
    const ResizeObserverMock = jest.fn((callback: ResizeObserverCallback) => {
      notifyResize = () => callback([], resizeObserver);
      return resizeObserver;
    });
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: ResizeObserverMock });
    Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: requestAnimationFrame });
    Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: cancelAnimationFrame });
    const { capability, dispose, editor, getContentWidget, notifySelectionChange, unmountChrome } = setup();
    const onInvoke = jest.fn();
    capability.subscribeToInvocation(onInvoke);
    const selection = {
      getEndPosition: () => ({ lineNumber: 1, column: 12 }),
      isEmpty: () => false,
    } as monacoTypes.Selection;
    jest.mocked(editor.getSelection).mockReturnValue(selection);
    jest.mocked(editor.getSelections).mockReturnValue([selection]);

    try {
      notifySelectionChange();
      const widget = getContentWidget();
      expect(widget.getPosition()?.preference).toEqual([2, 1]);

      fireEvent.click(screen.getByRole('button', { name: 'Coauthor' }));

      expect(widget.getPosition()?.preference).toEqual([1, 2]);
      expect(widget.beforeRender?.()).toEqual({ height: 320, width: 360 });
      expect(widget.beforeRender?.()).toEqual({ height: 320, width: 360 });
      expect(screen.getByTestId('prometheus-query-coauthoring-widget').style.maxHeight).toBe('');
      expect(widget.getDomNode().style.maxHeight).toBe('');
      const layoutCallsAfterInvocation = jest.mocked(editor.layoutContentWidget).mock.calls.length;

      jest.spyOn(widget.getDomNode(), 'getBoundingClientRect').mockReturnValue({
        bottom: 240,
        height: 240,
        left: 0,
        right: 300,
        top: 0,
        width: 300,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      });
      act(() => notifyResize?.());

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(widget.beforeRender?.()).toEqual({ height: 240, width: 300 });
      expect(editor.layoutContentWidget).toHaveBeenCalledTimes(layoutCallsAfterInvocation);

      jest.mocked(widget.getDomNode().getBoundingClientRect).mockReturnValue({
        bottom: 32,
        height: 32,
        left: 0,
        right: 288,
        top: 0,
        width: 288,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      });
      act(() => notifyResize?.());
      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(widget.beforeRender?.()).toEqual({ height: 32, width: 288 });

      frameCallbacks.get(1)?.(0);
      frameCallbacks.delete(1);
      expect(editor.layoutContentWidget).toHaveBeenCalledTimes(layoutCallsAfterInvocation + 1);

      jest.mocked(widget.getDomNode().getBoundingClientRect).mockReturnValue({
        bottom: 40,
        height: 40,
        left: 0,
        right: 288,
        top: 0,
        width: 288,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      });
      act(() => notifyResize?.());
      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

      unmountChrome();
      expect(resizeObserver.disconnect).toHaveBeenCalledTimes(1);
      dispose();
      expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
      act(() => notifyResize?.());
      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      if (resizeObserverDescriptor) {
        Object.defineProperty(globalThis, 'ResizeObserver', resizeObserverDescriptor);
      } else {
        delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
      }
      if (requestAnimationFrameDescriptor) {
        Object.defineProperty(window, 'requestAnimationFrame', requestAnimationFrameDescriptor);
      } else {
        delete (window as { requestAnimationFrame?: typeof window.requestAnimationFrame }).requestAnimationFrame;
      }
      if (cancelAnimationFrameDescriptor) {
        Object.defineProperty(window, 'cancelAnimationFrame', cancelAnimationFrameDescriptor);
      } else {
        delete (window as { cancelAnimationFrame?: typeof window.cancelAnimationFrame }).cancelAnimationFrame;
      }
    }
  });

  it('keeps the coauthoring widget within the editor horizontal bounds', () => {
    const { dispose, editor, getContentWidget, notifySelectionChange } = setup();
    const selection = {
      getEndPosition: () => ({ lineNumber: 1, column: 12 }),
      isEmpty: () => false,
    } as monacoTypes.Selection;
    jest.mocked(editor.getSelection).mockReturnValue(selection);
    jest.mocked(editor.getSelections).mockReturnValue([selection]);
    const editorNode = editor.getDomNode();
    if (!editorNode) {
      throw new Error('Expected an editor DOM node.');
    }

    jest.spyOn(editorNode, 'getBoundingClientRect').mockReturnValue(createRect(600, 1000, 200, 300));

    try {
      notifySelectionChange();
      fireEvent.click(screen.getByRole('button', { name: 'Coauthor' }));
      const widget = getContentWidget();
      jest.spyOn(widget.getDomNode(), 'getBoundingClientRect').mockReturnValue(createRect(850, 1138, 200, 520));

      widget.afterRender?.(widget.getPosition()?.preference?.[0] ?? null);

      expect(widget.getDomNode()).toHaveStyle({ transform: 'translateX(-146px)' });

      jest.mocked(editorNode.getBoundingClientRect).mockReturnValue(createRect(600, 800, 200, 300));
      widget.afterRender?.(widget.getPosition()?.preference?.[0] ?? null);

      expect(widget.getDomNode()).toHaveStyle({ transform: 'translateX(-242px)' });

      jest.mocked(editorNode.getBoundingClientRect).mockReturnValue(createRect(600, 1300, 200, 300));
      widget.afterRender?.(widget.getPosition()?.preference?.[0] ?? null);

      expect(widget.getDomNode().style.transform).toBe('');
    } finally {
      dispose();
    }
  });

  it('coalesces viewport, ancestor scroll, and editor layout changes into position relayouts', () => {
    const requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
    const cancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(window, 'cancelAnimationFrame');
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      const frame = nextFrame++;
      frameCallbacks.set(frame, callback);
      return frame;
    });
    const cancelAnimationFrame = jest.fn((frame: number) => frameCallbacks.delete(frame));
    Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: requestAnimationFrame });
    Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: cancelAnimationFrame });
    const { dispose, editor, notifyLayoutChange, notifySelectionChange } = setup();
    const selection = {
      getEndPosition: () => ({ lineNumber: 1, column: 12 }),
      isEmpty: () => false,
    } as monacoTypes.Selection;
    jest.mocked(editor.getSelection).mockReturnValue(selection);

    try {
      window.dispatchEvent(new Event('resize'));
      notifyLayoutChange();
      expect(requestAnimationFrame).not.toHaveBeenCalled();

      jest.mocked(editor.getSelections).mockReturnValue([selection]);
      notifySelectionChange();
      const layoutCallsAfterSelection = jest.mocked(editor.layoutContentWidget).mock.calls.length;

      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
      notifyLayoutChange();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(editor.layoutContentWidget).toHaveBeenCalledTimes(layoutCallsAfterSelection);

      act(() => frameCallbacks.get(1)?.(0));
      frameCallbacks.delete(1);
      expect(editor.layoutContentWidget).toHaveBeenCalledTimes(layoutCallsAfterSelection + 1);

      jest.mocked(editor.getSelections).mockReturnValue([]);
      notifySelectionChange();
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
      notifyLayoutChange();
      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

      jest.mocked(editor.getSelections).mockReturnValue([selection]);
      notifySelectionChange();
      window.dispatchEvent(new Event('scroll'));
      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

      dispose();
      expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
      notifyLayoutChange();
      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      if (requestAnimationFrameDescriptor) {
        Object.defineProperty(window, 'requestAnimationFrame', requestAnimationFrameDescriptor);
      } else {
        delete (window as { requestAnimationFrame?: typeof window.requestAnimationFrame }).requestAnimationFrame;
      }
      if (cancelAnimationFrameDescriptor) {
        Object.defineProperty(window, 'cancelAnimationFrame', cancelAnimationFrameDescriptor);
      } else {
        delete (window as { cancelAnimationFrame?: typeof window.cancelAnimationFrame }).cancelAnimationFrame;
      }
    }
  });

  it('does not relayout or dispose the widget again after it has been disposed', () => {
    const { capability, dispose, editor, notifySelectionChange, onRegister, selectionDisposable } = setup();
    const onInvoke = jest.fn();
    capability.subscribeToInvocation(onInvoke);
    const selection = {
      getEndPosition: () => ({ lineNumber: 1, column: 12 }),
      isEmpty: () => false,
    } as monacoTypes.Selection;
    jest.mocked(editor.getSelection).mockReturnValue(selection);
    jest.mocked(editor.getSelections).mockReturnValue([selection]);

    notifySelectionChange();
    fireEvent.click(screen.getByRole('button', { name: 'Coauthor' }));
    const invocation = onInvoke.mock.calls[0][0];
    const layoutCallsBeforeDispose = jest.mocked(editor.layoutContentWidget).mock.calls.length;

    dispose();
    dispose();
    act(() => invocation.dismiss());
    notifySelectionChange();

    expect(editor.layoutContentWidget).toHaveBeenCalledTimes(layoutCallsBeforeDispose);
    expect(selectionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(editor.removeContentWidget).toHaveBeenCalledTimes(1);
    expect(onRegister).toHaveBeenCalledTimes(2);
    expect(onRegister).toHaveBeenLastCalledWith(undefined);
  });

  it('preserves multiple selections and copies each selected fragment without the async clipboard API', async () => {
    const { dispose, editor, notifySelectionChange } = setup();
    const firstSelection = {
      getEndPosition: () => ({ lineNumber: 1, column: 12 }),
      isEmpty: () => false,
    } as monacoTypes.Selection;
    const secondSelection = {
      getEndPosition: () => ({ lineNumber: 1, column: 24 }),
      isEmpty: () => false,
    } as monacoTypes.Selection;
    jest.mocked(editor.getSelection).mockReturnValue(secondSelection);
    jest.mocked(editor.getSelections).mockReturnValue([firstSelection, secondSelection]);
    const getValueInRange = jest.fn().mockReturnValueOnce('http_requests_total').mockReturnValueOnce('handler="api"');
    jest.mocked(editor.getModel).mockReturnValue({
      getValueInRange,
    } as unknown as monacoTypes.editor.ITextModel);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
    const execCommand = jest.fn(() => true);

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    try {
      notifySelectionChange();
      const copyButton = screen.getByRole('button', { name: 'Copy' });
      expect(fireEvent.mouseDown(copyButton)).toBe(false);
      fireEvent.click(copyButton);

      await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
      expect(getValueInRange).toHaveBeenNthCalledWith(1, firstSelection);
      expect(getValueInRange).toHaveBeenNthCalledWith(2, secondSelection);
      expect(document.body.querySelector('textarea')).not.toBeInTheDocument();
    } finally {
      dispose();
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        delete (navigator as { clipboard?: Clipboard }).clipboard;
      }
      if (execCommandDescriptor) {
        Object.defineProperty(document, 'execCommand', execCommandDescriptor);
      } else {
        delete (document as { execCommand?: typeof document.execCommand }).execCommand;
      }
    }
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
    const initialRange = { from: { valueOf: () => 1 }, to: { valueOf: () => 2 } } as TimeRange;
    const currentRange = { from: { valueOf: () => 3 }, to: { valueOf: () => 4 } } as TimeRange;
    let languageProvider = initialProvider;
    let timeRange = initialRange;
    const onRegister = jest.fn();

    registerPrometheusQueryCoauthoring({
      createQuery: (value) => ({ expr: value, refId: 'A' }),
      editor,
      getDatasource: () => ({ interpolateString: (value: string) => value }) as unknown as PrometheusDatasource,
      getLanguageProvider: () => languageProvider,
      getTimeRange: () => timeRange,
      monaco,
      onRegister,
      previewStyles: {
        previewChange: 'preview-change',
        previewOriginal: 'preview-original',
      },
      widgetId: 'test-current-context',
    });
    languageProvider = currentProvider;
    timeRange = currentRange;

    const capability = onRegister.mock.calls[0][0] as PrometheusCoauthoringCapability;
    await expect(capability.getContext()).resolves.toMatchObject({
      metricMetadata: [{ name: 'http_requests_total', type: 'counter', labels: ['handler'] }],
    });
    expect(currentProvider.queryLabelKeys).toHaveBeenCalledWith(
      currentRange,
      '{__name__="http_requests_total"}',
      QUERY_COAUTHORING_MAX_CONTEXT_LABELS
    );
    expect(initialProvider.queryLabelKeys).not.toHaveBeenCalled();
  });

  it('builds a valid selector when fetching labels for a UTF-8 metric name', async () => {
    const { editor, monaco } = createEditorHarness();
    jest.mocked(editor.getValue).mockReturnValue('{"mé\\"tric\\\\total"}');
    const queryLabelKeys = jest.fn(async () => []);
    const onRegister = jest.fn();

    registerPrometheusQueryCoauthoring({
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
      onRegister,
      previewStyles: {
        previewChange: 'preview-change',
        previewOriginal: 'preview-original',
      },
      widgetId: 'test-utf8-context',
    });

    const capability = onRegister.mock.calls[0][0] as PrometheusCoauthoringCapability;
    await capability.getContext();

    expect(queryLabelKeys).toHaveBeenCalledWith(
      expect.anything(),
      '{__name__="mé\\"tric\\\\total"}',
      QUERY_COAUTHORING_MAX_CONTEXT_LABELS
    );
  });
});
