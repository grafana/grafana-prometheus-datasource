import { act, render } from '@testing-library/react';

import { type GrafanaTheme2, type TimeRange } from '@grafana/data';
import { type Monaco, type MonacoEditor } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import { type QueryEditorCoauthoringRegistrar } from '../../query_coauthoring/capability';
import { type PromQuery } from '../../types';
import MonacoQueryField from './MonacoQueryField';
import { registerPrometheusQueryCoauthoring } from './QueryCoauthoringWidget';

let mockMonacoOnMount: ((editor: MonacoEditor, monaco: Monaco) => void) | undefined;
let mockTheme: GrafanaTheme2;

jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  ReactMonacoEditor: (props: { onMount: (editor: MonacoEditor, monaco: Monaco) => void }) => {
    mockMonacoOnMount = props.onMount;
    return null;
  },
  useTheme2: () => mockTheme,
}));

jest.mock('./QueryCoauthoringWidget', () => ({
  registerPrometheusQueryCoauthoring: jest.fn(),
}));

jest.mock('./QueryCoauthoringChrome', () => ({
  QueryCoauthoringChrome: () => null,
}));

const lightTheme = {
  colors: {
    action: { hover: '#eee', selected: '#ddd' },
    background: { secondary: '#fff' },
    border: { weak: '#ccc' },
    primary: { border: '#00f', text: '#00f' },
    text: { primary: '#111', secondary: '#555' },
  },
  components: { input: { borderColor: '#aaa' } },
  shape: { radius: { default: '2px' } },
  shadows: { z3: '0 1px 3px #000' },
  spacing: (...values: number[]) => values.map((value) => `${value * 8}px`).join(' '),
  typography: {
    bodySmall: { fontSize: '12px', lineHeight: 1.4 },
    fontFamilyMonospace: 'monospace',
  },
  zIndex: { portal: 1000 },
} as unknown as GrafanaTheme2;

function createEditorHarness() {
  const completionDispose = jest.fn();
  const editor = {
    addCommand: jest.fn(),
    createContextKey: jest.fn(() => ({ set: jest.fn() })),
    getContentHeight: jest.fn(() => 20),
    getModel: jest.fn(() => null),
    getValue: jest.fn(() => 'up'),
    hasTextFocus: jest.fn(() => false),
    layout: jest.fn(),
    onDidBlurEditorWidget: jest.fn(),
    onDidContentSizeChange: jest.fn(),
    onDidFocusEditorText: jest.fn(),
    trigger: jest.fn(),
  } as unknown as MonacoEditor;
  const monaco = {
    editor: {
      addKeybindingRule: jest.fn(),
    },
    KeyCode: { Enter: 3, KeyF: 4, KeyK: 5 },
    KeyMod: { CtrlCmd: 1, Shift: 2 },
    languages: {
      registerCompletionItemProvider: jest.fn(() => ({ dispose: completionDispose })),
    },
  } as unknown as Monaco;

  return { completionDispose, editor, monaco };
}

function createProps(
  onRegisterQueryEditorCoauthoring: QueryEditorCoauthoringRegistrar<PromQuery> | undefined,
  createQueryForCoauthoring: ((value: string) => PromQuery) | undefined
) {
  const languageProvider = {
    queryLabelKeys: jest.fn(async () => []),
    queryLabelValues: jest.fn(async () => []),
    queryMetricsMetadata: jest.fn(async () => ({})),
    retrieveMetricsMetadata: jest.fn(() => ({ existing_metric: { type: 'gauge' } })),
  } as unknown as PrometheusLanguageProviderInterface;

  return {
    createQueryForCoauthoring,
    datasource: { interpolateString: (value: string) => value } as unknown as PrometheusDatasource,
    history: [],
    initialValue: 'up',
    languageProvider,
    onBlur: jest.fn(),
    onRegisterQueryEditorCoauthoring,
    onRunQuery: jest.fn(),
    placeholder: '',
    timeRange: {} as TimeRange,
  };
}

describe('MonacoQueryField query coauthoring lifecycle', () => {
  beforeEach(() => {
    mockMonacoOnMount = undefined;
    mockTheme = lightTheme;
    jest.mocked(registerPrometheusQueryCoauthoring).mockReset();
  });

  it('registers on late availability without restarting for registrar, query factory, or style changes', () => {
    const registrations: Array<{ dispose: jest.Mock; updatePreviewStyles: jest.Mock }> = [];
    jest.mocked(registerPrometheusQueryCoauthoring).mockImplementation((options) => {
      const capability = { getValue: jest.fn() } as never;
      const registration = {
        dispose: jest.fn(() => options.onRegister(undefined)),
        getSelectedText: jest.fn(() => ''),
        getSnapshot: jest.fn(() => ({ mode: 'hidden' as const })),
        invoke: jest.fn(),
        mountAssistant: jest.fn(),
        portalElement: document.createElement('div'),
        subscribe: jest.fn(() => jest.fn()),
        updatePreviewStyles: jest.fn(),
        updateRenderedSize: jest.fn(),
      };
      registrations.push(registration);
      options.onRegister(capability);
      return registration;
    });
    const firstRegistrar = jest.fn();
    const secondRegistrar = jest.fn();
    const firstCreateQuery = (value: string): PromQuery => ({ expr: value, refId: 'A' });
    const secondCreateQuery = (value: string): PromQuery => ({ expr: value, refId: 'B' });
    const props = createProps(undefined, firstCreateQuery);
    const { rerender, unmount } = render(<MonacoQueryField {...props} />);
    const { completionDispose, editor, monaco } = createEditorHarness();

    if (!mockMonacoOnMount) {
      throw new Error('Expected ReactMonacoEditor to provide onMount');
    }
    act(() => mockMonacoOnMount?.(editor, monaco));

    expect(registerPrometheusQueryCoauthoring).not.toHaveBeenCalled();

    rerender(<MonacoQueryField {...props} onRegisterQueryEditorCoauthoring={firstRegistrar} />);

    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(1);
    const initialRegistration = jest.mocked(registerPrometheusQueryCoauthoring).mock.calls[0][0];
    const capability = firstRegistrar.mock.calls[0][0];

    rerender(
      <MonacoQueryField
        {...props}
        createQueryForCoauthoring={secondCreateQuery}
        onRegisterQueryEditorCoauthoring={firstRegistrar}
      />
    );

    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(1);
    expect(initialRegistration.createQuery('next')).toEqual({ expr: 'next', refId: 'B' });

    rerender(
      <MonacoQueryField
        {...props}
        createQueryForCoauthoring={secondCreateQuery}
        onRegisterQueryEditorCoauthoring={secondRegistrar}
      />
    );

    expect(registrations[0].dispose).not.toHaveBeenCalled();
    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(1);
    expect(firstRegistrar).toHaveBeenLastCalledWith(undefined);
    expect(secondRegistrar).toHaveBeenCalledWith(capability);

    const styleUpdatesBeforeThemeChange = registrations[0].updatePreviewStyles.mock.calls.length;
    mockTheme = { ...lightTheme };
    rerender(
      <MonacoQueryField
        {...props}
        createQueryForCoauthoring={secondCreateQuery}
        onRegisterQueryEditorCoauthoring={secondRegistrar}
      />
    );

    expect(registrations[0].dispose).not.toHaveBeenCalled();
    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(1);
    expect(registrations[0].updatePreviewStyles).toHaveBeenCalledTimes(styleUpdatesBeforeThemeChange + 1);

    rerender(
      <MonacoQueryField
        {...props}
        createQueryForCoauthoring={undefined}
        onRegisterQueryEditorCoauthoring={secondRegistrar}
      />
    );

    expect(registrations[0].dispose).toHaveBeenCalledTimes(1);
    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(1);
    expect(secondRegistrar).toHaveBeenLastCalledWith(undefined);

    rerender(
      <MonacoQueryField
        {...props}
        createQueryForCoauthoring={secondCreateQuery}
        onRegisterQueryEditorCoauthoring={secondRegistrar}
      />
    );

    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(2);
    expect(registrations[1].dispose).not.toHaveBeenCalled();

    unmount();
    expect(registrations[1].dispose).toHaveBeenCalledTimes(1);
    expect(completionDispose).toHaveBeenCalledTimes(1);
  });
});
