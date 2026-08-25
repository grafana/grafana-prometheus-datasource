import { act, render } from '@testing-library/react';

import { type GrafanaTheme2, type TimeRange } from '@grafana/data';
import { type Monaco, type MonacoEditor } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import {
  type QueryEditorCoauthoringAdapterV1,
  type QueryEditorCoauthoringRegistrationV1,
} from '../../query_coauthoring/internalCoauthoringContract';
import { type PromQuery } from '../../types';
import MonacoQueryField from './MonacoQueryField';
import { registerPrometheusQueryCoauthoring } from './PrometheusQueryCoauthoringAdapter';

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

jest.mock('./PrometheusQueryCoauthoringAdapter', () => ({
  registerPrometheusQueryCoauthoring: jest.fn(),
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
    editor: { addKeybindingRule: jest.fn() },
    KeyCode: { Enter: 3, KeyF: 4, KeyK: 5 },
    KeyMod: { CtrlCmd: 1, Shift: 2 },
    languages: { registerCompletionItemProvider: jest.fn(() => ({ dispose: completionDispose })) },
  } as unknown as Monaco;

  return { completionDispose, editor, monaco };
}

function createProps(
  unstable_queryEditorCoauthoringV1: QueryEditorCoauthoringRegistrationV1<PromQuery> | undefined,
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
    onRunQuery: jest.fn(),
    placeholder: '',
    unstable_queryEditorCoauthoringV1,
    timeRange: {} as TimeRange,
  };
}

describe('MonacoQueryField query coauthoring lifecycle', () => {
  beforeEach(() => {
    mockMonacoOnMount = undefined;
    mockTheme = lightTheme;
    jest.mocked(registerPrometheusQueryCoauthoring).mockReset();
  });

  it('ignores a drifted private registrar without a register function', () => {
    // @ts-expect-error Simulate mismatched Core and datasource contract copies at runtime.
    const driftedRegistration: QueryEditorCoauthoringRegistrationV1<PromQuery> = {};
    const props = createProps(driftedRegistration, (value) => ({ expr: value, refId: 'A' }));
    render(<MonacoQueryField {...props} />);
    const { editor, monaco } = createEditorHarness();

    if (!mockMonacoOnMount) {
      throw new Error('Expected ReactMonacoEditor to provide onMount');
    }
    act(() => mockMonacoOnMount?.(editor, monaco));

    expect(registerPrometheusQueryCoauthoring).not.toHaveBeenCalled();
  });

  it('creates one datasource adapter while registered and updates styles without restarting it', () => {
    const registrations: Array<{
      adapter: QueryEditorCoauthoringAdapterV1<PromQuery>;
      dispose: jest.Mock;
      updateStyles: jest.Mock;
    }> = [];
    jest.mocked(registerPrometheusQueryCoauthoring).mockImplementation(() => {
      const registration = {
        adapter: {
          dismiss: jest.fn(),
          getSnapshot: jest.fn(() => ({ mode: 'hidden' as const })),
          invoke: jest.fn(),
          prepareProposal: jest.fn(),
          readInvocation: jest.fn(),
          subscribe: jest.fn(() => jest.fn()),
        },
        dispose: jest.fn(),
        updateStyles: jest.fn(),
      };
      registrations.push(registration);
      return registration;
    });
    const unregister = jest.fn();
    const unstable_queryEditorCoauthoringV1 = { register: jest.fn(() => unregister) };
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

    rerender(<MonacoQueryField {...props} unstable_queryEditorCoauthoringV1={unstable_queryEditorCoauthoringV1} />);
    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(1);
    expect(unstable_queryEditorCoauthoringV1.register).toHaveBeenCalledWith(registrations[0].adapter);
    const initialOptions = jest.mocked(registerPrometheusQueryCoauthoring).mock.calls[0][0];

    rerender(
      <MonacoQueryField
        {...props}
        unstable_queryEditorCoauthoringV1={unstable_queryEditorCoauthoringV1}
        createQueryForCoauthoring={secondCreateQuery}
      />
    );
    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(1);
    expect(initialOptions.createQuery('next')).toEqual({ expr: 'next', refId: 'B' });

    const styleUpdatesBeforeThemeChange = registrations[0].updateStyles.mock.calls.length;
    mockTheme = { ...lightTheme };
    rerender(
      <MonacoQueryField
        {...props}
        unstable_queryEditorCoauthoringV1={unstable_queryEditorCoauthoringV1}
        createQueryForCoauthoring={secondCreateQuery}
      />
    );
    expect(registrations[0].updateStyles).toHaveBeenCalledTimes(styleUpdatesBeforeThemeChange + 1);

    rerender(<MonacoQueryField {...props} unstable_queryEditorCoauthoringV1={undefined} />);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(registrations[0].dispose).toHaveBeenCalledTimes(1);

    rerender(<MonacoQueryField {...props} unstable_queryEditorCoauthoringV1={unstable_queryEditorCoauthoringV1} />);
    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(2);

    unmount();
    expect(registrations[1].dispose).toHaveBeenCalledTimes(1);
    expect(completionDispose).toHaveBeenCalledTimes(1);
  });
});
