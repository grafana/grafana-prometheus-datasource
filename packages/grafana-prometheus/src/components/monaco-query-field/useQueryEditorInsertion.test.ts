import { act, renderHook } from '@testing-library/react';

import { type MonacoEditor } from '@grafana/ui';

import {
  type QueryEditorInsertionRegistrationV1,
  type QueryEditorInsertionTargetV1,
} from '../../query_insertion/internalInsertionContract';
import { useQueryEditorInsertion } from './useQueryEditorInsertion';

interface Position {
  lineNumber: number;
  column: number;
}

interface Range {
  startColumn: number;
  endColumn: number;
}

// Monaco does not run under jsdom, so this stands in for a single-line editor.
function createEditor(initialValue: string, selection = { from: 0, to: 0 }) {
  let value = initialValue;
  let cursor = selection;
  let focusListener: VoidFunction | undefined;
  const history: string[] = [];
  const toPosition = (offset: number): Position => ({ lineNumber: 1, column: offset + 1 });
  const model = {
    getValue: () => value,
    getOffsetAt: (position: Position) => position.column - 1,
    getPositionAt: toPosition,
  };
  const editor = {
    getModel: () => model,
    getValue: () => value,
    getSelection: () => ({
      getStartPosition: () => toPosition(cursor.from),
      getEndPosition: () => toPosition(cursor.to),
    }),
    hasTextFocus: () => false,
    onDidFocusEditorText: (listener: VoidFunction) => {
      focusListener = listener;
      return { dispose: jest.fn() };
    },
    executeEdits: (_source: string, edits: Array<{ range: Range; text: string }>) => {
      const [{ range, text }] = edits;
      value = value.slice(0, range.startColumn - 1) + text + value.slice(range.endColumn - 1);
      history.push(`edit:${text}`);
    },
    pushUndoStop: () => {
      history.push('undo-stop');
      return true;
    },
    setPosition: (position: Position) => {
      cursor = { from: position.column - 1, to: position.column - 1 };
    },
    focus: jest.fn(),
  };

  return {
    editor: editor as unknown as MonacoEditor,
    focus: () => focusListener?.(),
    getCursor: () => cursor,
    getHistory: () => history,
    focusSpy: editor.focus,
  };
}

function createRegistrar() {
  const targets: QueryEditorInsertionTargetV1[] = [];
  const unregister = jest.fn();
  const registrar: QueryEditorInsertionRegistrationV1 = {
    register: jest.fn((target) => {
      targets.push(target);
      return unregister;
    }),
  };
  return { registrar, targets, unregister };
}

describe('useQueryEditorInsertion', () => {
  it('reports no selection until the editor has had text focus', () => {
    const { registrar, targets } = createRegistrar();
    const fake = createEditor('rate(up[5m])', { from: 5, to: 7 });
    const { result } = renderHook(() => useQueryEditorInsertion({ registrar, onCommit: jest.fn() }));

    act(() => result.current(fake.editor));
    expect(targets[0].getSelection()).toBeUndefined();

    act(() => fake.focus());
    expect(targets[0].getSelection()).toEqual({ value: 'rate(up[5m])', from: 5, to: 7 });
  });

  it('replaces the range, moves the cursor after the text and commits the new value', () => {
    const { registrar, targets } = createRegistrar();
    const onCommit = jest.fn();
    const fake = createEditor('rate(up[5m])');
    const { result } = renderHook(() => useQueryEditorInsertion({ registrar, onCommit }));

    act(() => result.current(fake.editor));
    act(() => targets[0].replaceRange(5, 7, 'http_requests_total'));

    expect(onCommit).toHaveBeenCalledWith('rate(http_requests_total[5m])');
    expect(fake.getCursor()).toEqual({ from: 24, to: 24 });
    expect(fake.focusSpy).toHaveBeenCalledTimes(1);
  });

  it('makes the insertion its own undo step', () => {
    const { registrar, targets } = createRegistrar();
    const fake = createEditor('rate([5m])');
    const { result } = renderHook(() => useQueryEditorInsertion({ registrar, onCommit: jest.fn() }));

    act(() => result.current(fake.editor));
    act(() => targets[0].replaceRange(5, 5, 'up'));

    expect(fake.getHistory()).toEqual(['undo-stop', 'edit:up', 'undo-stop']);
  });

  it('unregisters when the registrar goes away and on unmount', () => {
    const first = createRegistrar();
    const second = createRegistrar();
    let registrar: QueryEditorInsertionRegistrationV1 | undefined = first.registrar;
    const fake = createEditor('up');
    const { result, rerender, unmount } = renderHook(() => useQueryEditorInsertion({ registrar, onCommit: jest.fn() }));

    act(() => result.current(fake.editor));
    expect(first.registrar.register).toHaveBeenCalledTimes(1);

    registrar = undefined;
    rerender();
    expect(first.unregister).toHaveBeenCalledTimes(1);

    registrar = second.registrar;
    rerender();
    expect(second.registrar.register).toHaveBeenCalledTimes(1);

    unmount();
    expect(second.unregister).toHaveBeenCalledTimes(1);
  });

  it('ignores a drifted registrar that throws or has no register function', () => {
    const fake = createEditor('up');
    const throwing = {
      register: jest.fn(() => {
        throw new Error('Drifted registrar');
      }),
    };
    // @ts-expect-error Simulate mismatched Core and datasource contract copies at runtime.
    let registrar: QueryEditorInsertionRegistrationV1 = {};
    const { result, rerender } = renderHook(() => useQueryEditorInsertion({ registrar, onCommit: jest.fn() }));

    act(() => result.current(fake.editor));
    registrar = throwing;
    expect(() => rerender()).not.toThrow();
    expect(throwing.register).toHaveBeenCalledTimes(1);
  });
});
