import { screen } from '@testing-library/react';

import { type TimeRange } from '@grafana/data';
import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import enUsTranslations from '../../locales/en-US/grafana-prometheus.json';
import {
  type PrometheusCoauthoringCapability,
  QUERY_COAUTHORING_MAX_CONTEXT_LABELS,
} from '../../query_coauthoring/capability';
import { registerPrometheusQueryCoauthoring } from './QueryCoauthoringWidget';

const monacoQueryFieldTranslations = enUsTranslations['grafana-prometheus'].components['monaco-query-field'];

function createEditorHarness() {
  let contentWidget: monacoTypes.editor.IContentWidget | undefined;
  let editorAction: monacoTypes.editor.IActionDescriptor | undefined;
  let selectionListener: VoidFunction | undefined;
  const actionDisposable = { dispose: jest.fn() };
  const selectionDisposable = { dispose: jest.fn() };
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
    notifySelectionChange: () => selectionListener?.(),
    actionDisposable,
    selectionDisposable,
  };
}

function setup() {
  const {
    actionDisposable,
    editor,
    getContentWidget,
    getEditorAction,
    monaco,
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
    styles: {
      button: 'button',
      divider: 'divider',
      previewChange: 'preview-change',
      previewOriginal: 'preview-original',
      toolbar: 'toolbar',
      widget: 'widget',
    },
    widgetId: 'test-query-coauthoring',
  });
  const capability = onRegister.mock.calls[0][0] as PrometheusCoauthoringCapability;

  return {
    actionDisposable,
    capability,
    dispose: registration.dispose,
    editor,
    getContentWidget,
    getEditorAction,
    notifySelectionChange,
    onRegister,
    selectionDisposable,
    updateStyles: registration.updateStyles,
  };
}

describe('registerPrometheusQueryCoauthoring', () => {
  afterEach(() => document.body.replaceChildren());

  it('registers the capability and cleans up the editor widget', () => {
    const {
      actionDisposable,
      capability,
      dispose,
      editor,
      getContentWidget,
      onRegister,
      selectionDisposable,
      updateStyles,
    } = setup();
    const clearPreview = jest.spyOn(capability, 'clearPreview');

    expect(editor.addContentWidget).toHaveBeenCalledTimes(1);
    expect(onRegister).toHaveBeenCalledWith(capability);
    expect(monacoQueryFieldTranslations.coauthor).toBe('Coauthor');

    updateStyles({
      button: 'next-button',
      divider: 'next-divider',
      previewChange: 'next-preview-change',
      previewOriginal: 'next-preview-original',
      toolbar: 'next-toolbar',
      widget: 'next-widget',
    });

    expect(getContentWidget().getDomNode()).toHaveClass('next-widget');
    expect(screen.getByRole('button', { name: 'Coauthor', hidden: true })).toHaveClass('next-button');

    dispose();

    expect(clearPreview).toHaveBeenCalledTimes(1);
    expect(actionDisposable.dispose).toHaveBeenCalledTimes(1);
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

    action.run(editor);

    expect(onInvoke).toHaveBeenCalledWith({
      anchorElement: expect.any(HTMLElement),
      dismiss: expect.any(Function),
    });

    dispose();
  });

  it('offers coauthoring for a selection and restores the selection actions after dismissal', () => {
    const { capability, editor, notifySelectionChange } = setup();
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
    screen.getByRole('button', { name: 'Coauthor' }).click();

    expect(onInvoke).toHaveBeenCalledWith({
      anchorElement: expect.any(HTMLElement),
      dismiss: expect.any(Function),
    });
    const invocation = onInvoke.mock.calls[0][0];
    expect(invocation.anchorElement).toBeVisible();
    expect(invocation.anchorElement).not.toHaveAttribute('role');
    expect(screen.queryByRole('button', { name: 'Coauthor' })).not.toBeInTheDocument();

    invocation.dismiss();

    expect(clearPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Coauthor' })).toBeVisible();
  });

  it('reserves viewport space above the active widget and relayouts it when its fixed anchor can move', () => {
    const innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
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
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 577 });
    Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: requestAnimationFrame });
    Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: cancelAnimationFrame });
    const { capability, dispose, editor, getContentWidget, notifySelectionChange } = setup();
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

      screen.getByRole('button', { name: 'Coauthor' }).click();

      expect(widget.getPosition()?.preference).toEqual([1, 2]);
      expect(widget.beforeRender?.()).toEqual({ height: 320, width: 0 });
      expect(widget.getDomNode()).toHaveStyle({ maxHeight: '320px', overflowY: 'auto' });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 240 });
      expect(widget.beforeRender?.()).toEqual({ height: 192, width: 0 });
      expect(widget.getDomNode()).toHaveStyle({ maxHeight: '192px', overflowY: 'auto' });
      const layoutCallsAfterInvocation = jest.mocked(editor.layoutContentWidget).mock.calls.length;

      window.dispatchEvent(new Event('resize'));
      document.body.dispatchEvent(new Event('scroll'));

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(editor.layoutContentWidget).toHaveBeenCalledTimes(layoutCallsAfterInvocation);
      frameCallbacks.get(1)?.(0);
      frameCallbacks.delete(1);
      expect(editor.layoutContentWidget).toHaveBeenCalledTimes(layoutCallsAfterInvocation + 1);

      window.dispatchEvent(new Event('resize'));
      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
      onInvoke.mock.calls[0][0].dismiss();
      expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
      expect(widget.getDomNode().style.maxHeight).toBe('');

      screen.getByRole('button', { name: 'Coauthor' }).click();
      window.dispatchEvent(new Event('resize'));
      expect(requestAnimationFrame).toHaveBeenCalledTimes(3);

      dispose();
      expect(cancelAnimationFrame).toHaveBeenCalledWith(3);
      window.dispatchEvent(new Event('resize'));
      document.body.dispatchEvent(new Event('scroll'));

      expect(requestAnimationFrame).toHaveBeenCalledTimes(3);
      expect(editor.layoutContentWidget).toHaveBeenCalledTimes(layoutCallsAfterInvocation + 3);
    } finally {
      dispose();
      if (innerHeightDescriptor) {
        Object.defineProperty(window, 'innerHeight', innerHeightDescriptor);
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
    screen.getByRole('button', { name: 'Coauthor' }).click();
    const invocation = onInvoke.mock.calls[0][0];
    const layoutCallsBeforeDispose = jest.mocked(editor.layoutContentWidget).mock.calls.length;

    dispose();
    dispose();
    invocation.dismiss();
    notifySelectionChange();

    expect(editor.layoutContentWidget).toHaveBeenCalledTimes(layoutCallsBeforeDispose);
    expect(selectionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(editor.removeContentWidget).toHaveBeenCalledTimes(1);
    expect(onRegister).toHaveBeenCalledTimes(2);
    expect(onRegister).toHaveBeenLastCalledWith(undefined);
  });

  it('copies selected text without the async clipboard API', () => {
    const { editor, notifySelectionChange } = setup();
    const selection = {
      getEndPosition: () => ({ lineNumber: 1, column: 12 }),
      isEmpty: () => false,
    } as monacoTypes.Selection;
    jest.mocked(editor.getSelections).mockReturnValue([selection]);
    jest.mocked(editor.getModel).mockReturnValue({
      getValueInRange: () => 'http_requests_total',
    } as unknown as monacoTypes.editor.ITextModel);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
    const execCommand = jest.fn(() => true);

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    try {
      notifySelectionChange();
      screen.getByRole('button', { name: 'Copy' }).click();

      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(document.body.querySelector('textarea')).not.toBeInTheDocument();
    } finally {
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
      styles: {
        button: 'button',
        divider: 'divider',
        previewChange: 'preview-change',
        previewOriginal: 'preview-original',
        toolbar: 'toolbar',
        widget: 'widget',
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
      styles: {
        button: 'button',
        divider: 'divider',
        previewChange: 'preview-change',
        previewOriginal: 'preview-original',
        toolbar: 'toolbar',
        widget: 'widget',
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
