import { screen } from '@testing-library/react';

import { type TimeRange } from '@grafana/data';
import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import { type PrometheusCoauthoringCapability } from '../../query_coauthoring/capability';
import { registerPrometheusQueryCoauthoring } from './QueryCoauthoringWidget';

function createEditorHarness() {
  let selectionListener: VoidFunction | undefined;
  const selectionDisposable = { dispose: jest.fn() };
  const editor = {
    addContentWidget: jest.fn((widget: monacoTypes.editor.IContentWidget) => {
      document.body.append(widget.getDomNode());
    }),
    addCommand: jest.fn(),
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
    KeyCode: { KeyQ: 47 },
    KeyMod: { CtrlCmd: 2048, Shift: 1024 },
  } as unknown as Monaco;

  return {
    editor,
    monaco,
    notifySelectionChange: () => selectionListener?.(),
    selectionDisposable,
  };
}

function setup() {
  const { editor, monaco, notifySelectionChange, selectionDisposable } = createEditorHarness();
  const onRegister = jest.fn();

  const dispose = registerPrometheusQueryCoauthoring({
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
      shortcut: 'shortcut',
      toolbar: 'toolbar',
      widget: 'widget',
    },
    widgetId: 'test-query-coauthoring',
  });
  const capability = onRegister.mock.calls[0][0] as PrometheusCoauthoringCapability;

  return { capability, dispose, editor, notifySelectionChange, onRegister, selectionDisposable };
}

describe('registerPrometheusQueryCoauthoring', () => {
  afterEach(() => document.body.replaceChildren());

  it('registers the capability and cleans up the editor widget', () => {
    const { capability, dispose, editor, onRegister, selectionDisposable } = setup();
    const clearPreview = jest.spyOn(capability, 'clearPreview');

    expect(editor.addContentWidget).toHaveBeenCalledTimes(1);
    expect(onRegister).toHaveBeenCalledWith(capability);

    dispose();

    expect(clearPreview).toHaveBeenCalledTimes(1);
    expect(selectionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(editor.removeContentWidget).toHaveBeenCalledTimes(1);
    expect(onRegister).toHaveBeenLastCalledWith(undefined);
  });

  it('offers coauthoring for a selection and restores the selection actions after dismissal', () => {
    const { capability, editor, notifySelectionChange } = setup();
    const onInvoke = jest.fn();
    capability.subscribeToInvocation(onInvoke);
    const selection = {
      getEndPosition: () => ({ lineNumber: 1, column: 12 }),
      isEmpty: () => false,
    } as monacoTypes.Selection;
    jest.mocked(editor.getSelection).mockReturnValue(selection);
    jest.mocked(editor.getSelections).mockReturnValue([selection]);

    notifySelectionChange();
    screen.getByRole('button', { name: '✦ Coauthor' }).click();

    expect(onInvoke).toHaveBeenCalledWith({
      anchorElement: expect.any(HTMLElement),
      dismiss: expect.any(Function),
    });
    const invocation = onInvoke.mock.calls[0][0];
    expect(invocation.anchorElement).toBeVisible();
    expect(screen.queryByRole('button', { name: '✦ Coauthor' })).not.toBeInTheDocument();

    invocation.dismiss();

    expect(screen.getByRole('button', { name: '✦ Coauthor' })).toBeVisible();
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
        shortcut: 'shortcut',
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
    expect(currentProvider.queryLabelKeys).toHaveBeenCalledWith(currentRange, 'http_requests_total', 30);
    expect(initialProvider.queryLabelKeys).not.toHaveBeenCalled();
  });
});
