import { useCallback, useEffect, useRef, useState } from 'react';
import { useLatest } from 'react-use';

import { type MonacoEditor } from '@grafana/ui';

import {
  type QueryEditorInsertionRegistrationV1,
  type QueryEditorInsertionTargetV1,
} from '../../query_insertion/internalInsertionContract';

interface UseQueryEditorInsertionOptions {
  registrar?: QueryEditorInsertionRegistrationV1;
  onCommit(value: string): void;
}

export function useQueryEditorInsertion({ registrar, onCommit }: UseQueryEditorInsertionOptions) {
  const onCommitRef = useLatest(onCommit);
  const [editor, setEditor] = useState<MonacoEditor>();
  // Monaco puts the cursor at the start of a never-focused editor, which the user did not choose.
  const hasFocusedRef = useRef(false);

  useEffect(() => {
    if (!editor || typeof registrar?.register !== 'function') {
      return;
    }

    const target: QueryEditorInsertionTargetV1 = {
      getSelection() {
        const model = editor.getModel();
        const selection = editor.getSelection();
        if (!hasFocusedRef.current || !model || !selection) {
          return undefined;
        }
        return {
          value: model.getValue(),
          from: model.getOffsetAt(selection.getStartPosition()),
          to: model.getOffsetAt(selection.getEndPosition()),
        };
      },
      replaceRange(from, to, text) {
        const model = editor.getModel();
        if (!model) {
          return;
        }
        const start = model.getPositionAt(from);
        const end = model.getPositionAt(to);
        // Undo stops on both sides keep one undo from also taking back what the user typed just before.
        editor.pushUndoStop();
        editor.executeEdits('add-to-query', [
          {
            range: {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
            },
            text,
            forceMoveMarkers: true,
          },
        ]);
        editor.pushUndoStop();
        editor.setPosition(model.getPositionAt(from + text.length));
        editor.focus();
        // The field reports its value only on blur or run, so the edit is committed here.
        onCommitRef.current(editor.getValue());
      },
    };

    try {
      const unregister = registrar.register(target);
      return typeof unregister === 'function' ? unregister : undefined;
    } catch {
      return;
    }
  }, [editor, onCommitRef, registrar]);

  return useCallback((nextEditor: MonacoEditor) => {
    hasFocusedRef.current = nextEditor.hasTextFocus();
    // Lives as long as the editor, like the field's other editor listeners.
    nextEditor.onDidFocusEditorText(() => {
      hasFocusedRef.current = true;
    });
    setEditor(nextEditor);
  }, []);
}
