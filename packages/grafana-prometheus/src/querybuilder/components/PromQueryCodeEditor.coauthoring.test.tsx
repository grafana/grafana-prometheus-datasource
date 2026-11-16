import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';

import { type TemplateSrv } from '@grafana/runtime';
import { type DataSourceInstanceSettings } from '@grafana/data';
import { type Monaco, type MonacoEditor } from '@grafana/ui';

import { PrometheusDatasource } from '../../datasource';
import { EmptyLanguageProviderMock } from '../../language_provider.mock';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import {
  type QueryCoauthoringEditorHandle,
  type QueryCoauthoringEditorHost,
} from '../../query_coauthoring/queryCoauthoringContracts';
import { type QueryEditorCoauthoringAdapterV1 } from '../../query_coauthoring/internalCoauthoringContract';
import { type PromQuery } from '../../types';
import { createCoauthoringMonaco } from '../../test/monacoCoauthoring';
import { PromQueryCodeEditor } from './PromQueryCodeEditor';

let mockMonaco = createCoauthoringMonaco();
jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  ReactMonacoEditor: function Editor({
    value,
    onMount,
  }: {
    value: string;
    onMount(editor: MonacoEditor, monaco: Monaco): void;
  }) {
    const instance = mockMonaco;
    const mountRef = useRef(onMount);
    mountRef.current = onMount;
    useEffect(() => {
      mountRef.current(instance.editor, instance.monaco);
    }, [instance]); // external Monaco mount lifecycle
    useEffect(() => {
      instance.setValue(value);
    }, [instance, value]);
    return <textarea aria-label="PromQL" value={value} onChange={(event) => instance.setValue(event.target.value)} />;
  },
}));

function createHost() {
  let handle: QueryCoauthoringEditorHandle | undefined;
  const unregister = jest.fn(() => {
    handle = undefined;
  });
  const host: QueryCoauthoringEditorHost = {
    version: 1,
    register: jest.fn((candidate) => {
      handle = candidate;
      return unregister;
    }),
    invoke: jest.fn(),
  };
  return {
    host,
    unregister,
    handle: () => {
      if (!handle) {
        throw new Error('Editor not registered');
      }
      return handle;
    },
  };
}

function setup(host = createHost()) {
  const datasource = new PrometheusDatasource(
    { uid: 'prom', url: '', jsonData: { disableMetricsLookup: true } } as unknown as DataSourceInstanceSettings,
    { replace: (value: string) => value } as TemplateSrv,
    new EmptyLanguageProviderMock() as unknown as PrometheusLanguageProviderInterface
  );
  const props = {
    datasource,
    query: { refId: 'A', expr: 'up', legendFormat: 'keep' },
    onChange: jest.fn(),
    onRunQuery: jest.fn(),
    showExplain: false,
    queryCoauthoring: host.host,
  };
  const view = render(<PromQueryCodeEditor {...props} />);
  return { ...view, props, ...host };
}

beforeEach(() => {
  mockMonaco = createCoauthoringMonaco();
});

it('registers a versioned handle, reports current ranges and forwards shortcuts with or without a selection', () => {
  const { handle, host, unregister, unmount } = setup();
  expect(handle().version).toBe(1);
  expect(handle().getSelection()).toBeNull();
  const changed = jest.fn();
  const unsubscribe = handle().subscribe(changed);
  act(() => mockMonaco.select([{ from: 2, to: 0 }]));
  expect(handle().getSelection()).toEqual({ ranges: [{ from: 0, to: 2 }], anchor: expect.any(HTMLElement) });
  expect(changed).toHaveBeenCalled();
  act(() => mockMonaco.shortcut());
  expect(host.invoke).toHaveBeenCalledTimes(1);
  act(() => mockMonaco.select([{ from: 1, to: 1 }]));
  act(() => mockMonaco.shortcut());
  expect(host.invoke).toHaveBeenCalledTimes(2);
  unsubscribe();
  unmount();
  expect(unregister).toHaveBeenCalledTimes(1);
  expect(mockMonaco.actions.size).toBe(0);
  expect(mockMonaco.widgets.size).toBe(0);
});

it('sets and replaces whole-line marks, clears at preview end, and clears on typing', () => {
  const { handle, props, rerender } = setup();
  const preview = 'sum(up)\n+ 1\n+ 2';
  rerender(<PromQueryCodeEditor {...props} query={{ ...props.query, expr: preview }} />);
  expect(props.onChange).not.toHaveBeenCalled();
  act(() =>
    handle().showChanges?.([
      { original: 'up', proposed: preview, originalRanges: [{ from: 0, to: 2 }], proposedRanges: [{ from: 0, to: 8 }] },
    ])
  );
  expect(mockMonaco.marks()).toEqual([
    {
      range: expect.objectContaining({ startLineNumber: 1, endLineNumber: 1 }),
      options: expect.objectContaining({ isWholeLine: true, className: expect.any(String) }),
    },
  ]);
  act(() =>
    handle().showChanges?.([
      { original: 'up', proposed: preview, originalRanges: [], proposedRanges: [{ from: 10, to: 11 }] },
    ])
  );
  expect(mockMonaco.marks()).toHaveLength(1);
  expect(mockMonaco.marks()[0].range.startLineNumber).toBe(2);
  act(() => handle().showChanges?.(null));
  expect(mockMonaco.marks()).toEqual([]);
  act(() =>
    handle().showChanges?.([
      { original: 'up', proposed: preview, originalRanges: [], proposedRanges: [{ from: 0, to: 3 }] },
    ])
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'PromQL' }), { target: { value: 'sum(up)\n+ 10\n+ 2' } });
  expect(mockMonaco.marks()).toEqual([]);
  expect(props.onChange).toHaveBeenLastCalledWith({ ...props.query, expr: 'sum(up)\n+ 10\n+ 2' });
});

it('keeps subscriptions and current offsets across proposed-text props without reporting a manual edit on blur', () => {
  const { handle, props, rerender } = setup();
  const changed = jest.fn();
  handle().subscribe(changed);
  rerender(<PromQueryCodeEditor {...props} query={{ ...props.query, expr: 'sum(up)\n+ 1' }} />);
  act(() =>
    mockMonaco.select([
      { from: 8, to: 11 },
      { from: 0, to: 3 },
    ])
  );
  expect(handle().getSelection()?.ranges).toEqual([
    { from: 8, to: 11 },
    { from: 0, to: 3 },
  ]);
  expect(changed).toHaveBeenCalled();
  act(() => mockMonaco.focus(false));
  expect(handle().getSelection()).toBeNull();
  act(() => mockMonaco.emit('blurWidget'));
  expect(props.onChange).not.toHaveBeenCalled();
});

it('cleans registrations, marks and selection listeners on host replacement and editor replacement', () => {
  const first = setup();
  const oldHandle = first.handle();
  const listener = jest.fn();
  oldHandle.subscribe(listener);
  act(() =>
    oldHandle.showChanges?.([
      { original: 'up', proposed: 'up', originalRanges: [], proposedRanges: [{ from: 0, to: 0 }] },
    ])
  );
  const second = createHost();
  first.rerender(<PromQueryCodeEditor {...first.props} queryCoauthoring={second.host} />);
  expect(first.unregister).toHaveBeenCalledTimes(1);
  expect(mockMonaco.marks()).toEqual([]);
  expect(oldHandle.getSelection()).toBeNull();
  listener.mockClear();
  act(() => mockMonaco.select([{ from: 0, to: 2 }]));
  expect(listener).not.toHaveBeenCalled();
  expect(second.handle().getSelection()?.ranges).toEqual([{ from: 0, to: 2 }]);
  const previousEditor = mockMonaco;
  mockMonaco = createCoauthoringMonaco();
  first.rerender(<PromQueryCodeEditor {...first.props} queryCoauthoring={second.host} />);
  expect(second.unregister).toHaveBeenCalledTimes(1);
  expect(previousEditor.actions.size).toBe(0);
  expect(previousEditor.widgets.size).toBe(0);
  act(() => previousEditor.shortcut());
  expect(second.host.invoke).not.toHaveBeenCalled();
  act(() => mockMonaco.shortcut());
  expect(second.host.invoke).toHaveBeenCalledTimes(1);
  first.unmount();
  expect(second.unregister).toHaveBeenCalledTimes(2);
  expect(mockMonaco.marks()).toEqual([]);
});

it.each([
  undefined,
  null,
  {},
  { version: 2, register: jest.fn(), invoke: jest.fn() },
  { version: 1, register: jest.fn() },
  { version: 1, invoke: jest.fn() },
  [],
])('ignores absent or malformed hosts: %p', (candidate) => {
  const { props, rerender } = setup();
  rerender(<PromQueryCodeEditor {...props} queryCoauthoring={candidate as QueryCoauthoringEditorHost} />);
  expect(mockMonaco.actions.size).toBe(0);
  act(() => mockMonaco.setValue('up + 1'));
  expect(props.onChange).not.toHaveBeenCalled(); // ordinary editor still commits on blur
  act(() => mockMonaco.emit('blurWidget'));
  expect(props.onChange).toHaveBeenCalledWith({ ...props.query, expr: 'up + 1' });
});

it('switches repeatedly between inline v1 and v2 with only one shortcut handler', async () => {
  const { props, host, rerender, unmount } = setup();
  let adapter: QueryEditorCoauthoringAdapterV1<PromQuery> | undefined;
  const unregisterV1 = jest.fn(() => {
    adapter = undefined;
  });
  const v1 = {
    register: jest.fn((candidate: QueryEditorCoauthoringAdapterV1<PromQuery>) => {
      adapter = candidate;
      return unregisterV1;
    }),
  };
  for (let iteration = 0; iteration < 2; iteration++) {
    rerender(<PromQueryCodeEditor {...props} queryCoauthoring={undefined} unstable_queryEditorCoauthoringV1={v1} />);
    expect(adapter).toBeDefined();
    expect(mockMonaco.actions.size).toBe(1);
    act(() => mockMonaco.select([{ from: 0, to: 2 }]));
    expect(adapter?.getSnapshot().mode).toBe('selection');
    const beforeV2 = jest.mocked(host.invoke).mock.calls.length;
    act(() => mockMonaco.shortcut());
    const snapshot = adapter!.getSnapshot();
    expect(snapshot.mode).toBe('invoked');
    if (snapshot.mode !== 'invoked') {
      throw new Error('Expected inline invocation');
    }
    await expect(adapter!.readInvocation(snapshot.invocationId)).resolves.toMatchObject({
      baseline: props.query,
      context: { query: 'up', focusRanges: [{ from: 0, to: 2 }] },
    });
    expect(adapter!.prepareProposal(snapshot.invocationId, 'sum(up)')).toMatchObject({
      status: 'ready',
      query: { ...props.query, expr: 'sum(up)' },
    });
    expect(jest.mocked(host.invoke).mock.calls.length).toBe(beforeV2);
    rerender(<PromQueryCodeEditor {...props} unstable_queryEditorCoauthoringV1={v1} />);
    expect(adapter).toBeUndefined();
    expect(mockMonaco.actions.size).toBe(1);
    act(() => mockMonaco.shortcut());
    expect(jest.mocked(host.invoke).mock.calls.length).toBe(beforeV2 + 1);
  }
  unmount();
  expect(mockMonaco.actions.size).toBe(0);
  expect(unregisterV1).toHaveBeenCalledTimes(2);
});
