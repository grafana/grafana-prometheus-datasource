import { act, render } from '@testing-library/react';

import { type GrafanaTheme2, type TimeRange } from '@grafana/data';
import { type Monaco, type MonacoEditor } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import { type QueryEditorCoauthoringRegistrationV1 } from '../../query_coauthoring/internalCoauthoringContract';
import { type PromQuery } from '../../types';
import MonacoQueryField from './MonacoQueryField';
import { usePrometheusQueryCoauthoring } from './usePrometheusQueryCoauthoring';

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

jest.mock('./usePrometheusQueryCoauthoring', () => ({
  usePrometheusQueryCoauthoring: jest.fn(),
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

describe('MonacoQueryField query coauthoring wiring', () => {
  beforeEach(() => {
    mockMonacoOnMount = undefined;
    mockTheme = lightTheme;
    jest.mocked(usePrometheusQueryCoauthoring).mockReset();
  });

  it('attaches coauthoring when Monaco mounts and preserves editor cleanup', () => {
    const attachCoauthoring = jest.fn();
    jest.mocked(usePrometheusQueryCoauthoring).mockReturnValue(attachCoauthoring);
    const createQueryForCoauthoring = (value: string): PromQuery => ({ expr: value, refId: 'A' });
    const registrar = { register: jest.fn(() => jest.fn()) };
    const props = createProps(registrar, createQueryForCoauthoring);
    const { unmount } = render(<MonacoQueryField {...props} />);
    const { completionDispose, editor, monaco } = createEditorHarness();

    if (!mockMonacoOnMount) {
      throw new Error('Expected ReactMonacoEditor to provide onMount');
    }
    act(() => mockMonacoOnMount?.(editor, monaco));
    expect(attachCoauthoring).toHaveBeenCalledWith(editor, monaco);
    expect(usePrometheusQueryCoauthoring).toHaveBeenCalledWith(
      expect.objectContaining({
        createQuery: createQueryForCoauthoring,
        externalQuery: 'up',
        registrar,
      })
    );

    unmount();
    expect(completionDispose).toHaveBeenCalledTimes(1);
  });
});
