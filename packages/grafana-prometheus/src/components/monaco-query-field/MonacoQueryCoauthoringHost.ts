import { t } from '@grafana/i18n';
import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

const INITIAL_HEIGHT = 320;
const INITIAL_WIDTH = 403;
const SELECTION_TOOLBAR_GAP = 4;
const VIEWPORT_MARGIN = 8;

export type QueryCoauthoringWidgetMode = 'hidden' | 'selection-toolbar' | 'session';

export interface QueryCoauthoringWidgetSnapshot {
  mode: QueryCoauthoringWidgetMode;
}

export interface MonacoQueryCoauthoringHost {
  dismiss: VoidFunction;
  dispose: VoidFunction;
  getSelectedText: () => string;
  getSnapshot: () => QueryCoauthoringWidgetSnapshot;
  invoke: VoidFunction;
  portalElement: HTMLElement;
  subscribe: (listener: VoidFunction) => VoidFunction;
  updateRenderedSize: (size: { height: number; width: number }) => void;
}

interface Options {
  clearEditorDiff: VoidFunction;
  editor: MonacoEditor;
  monaco: Monaco;
  portalClassName: string;
  widgetId: string;
}

export function createMonacoQueryCoauthoringHost({
  clearEditorDiff,
  editor,
  monaco,
  portalClassName,
  widgetId,
}: Options): MonacoQueryCoauthoringHost {
  const widgetNode = document.createElement('div');
  widgetNode.classList.add(portalClassName);
  const listeners = new Set<VoidFunction>();
  let hasMeasuredSurface = false;
  let disposed = false;
  let keyboardSelecting = false;
  let mouseSelecting = false;
  let pendingRelayoutFrame: number | undefined;
  let renderedHeight = INITIAL_HEIGHT;
  let renderedWidth = INITIAL_WIDTH;
  let snapshot: QueryCoauthoringWidgetSnapshot = { mode: 'hidden' };
  let widgetPosition = editor.getPosition() ?? { lineNumber: 1, column: 1 };

  const publish = (nextSnapshot: QueryCoauthoringWidgetSnapshot) => {
    snapshot = nextSnapshot;
    listeners.forEach((listener) => listener());
  };

  const alignWithinViewport = () => {
    widgetNode.style.transform = '';
    if (snapshot.mode === 'hidden') {
      return;
    }

    const widgetRect = widgetNode.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftBoundary = (viewport?.offsetLeft ?? 0) + VIEWPORT_MARGIN;
    const rightBoundary = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - VIEWPORT_MARGIN;
    if (widgetRect.width <= 0 || rightBoundary <= leftBoundary) {
      return;
    }

    // Monaco anchors content widgets at the selected column but does not keep overflowing widgets inside the viewport.
    const targetLeft = snapshot.mode === 'selection-toolbar' ? widgetRect.left - widgetRect.width / 2 : widgetRect.left;
    const maximumLeft = Math.max(leftBoundary, rightBoundary - widgetRect.width);
    const alignedLeft = Math.min(Math.max(targetLeft, leftBoundary), maximumLeft);
    const horizontalOffset = alignedLeft - widgetRect.left;
    const verticalOffset = snapshot.mode === 'selection-toolbar' ? -SELECTION_TOOLBAR_GAP : 0;
    if (horizontalOffset !== 0 && verticalOffset !== 0) {
      widgetNode.style.transform = `translate(${horizontalOffset}px, ${verticalOffset}px)`;
    } else if (horizontalOffset !== 0) {
      widgetNode.style.transform = `translateX(${horizontalOffset}px)`;
    } else if (verticalOffset !== 0) {
      widgetNode.style.transform = `translateY(${verticalOffset}px)`;
    }
  };

  const widget: monacoTypes.editor.IContentWidget = {
    allowEditorOverflow: true,
    beforeRender: () =>
      snapshot.mode === 'session'
        ? {
            height: renderedHeight,
            width: renderedWidth,
          }
        : null,
    afterRender: (position) => {
      if (position === null) {
        widgetNode.style.transform = '';
        return;
      }
      alignWithinViewport();
      if (snapshot.mode !== 'session' || hasMeasuredSurface) {
        widgetNode.style.visibility = '';
      }
    },
    getId: () => widgetId,
    getDomNode: () => widgetNode,
    getPosition: () => ({
      position: widgetPosition,
      preference:
        snapshot.mode === 'selection-toolbar'
          ? [monaco.editor.ContentWidgetPositionPreference.ABOVE]
          : [monaco.editor.ContentWidgetPositionPreference.BELOW, monaco.editor.ContentWidgetPositionPreference.ABOVE],
    }),
  };

  const cancelPendingRelayout = () => {
    if (pendingRelayoutFrame !== undefined) {
      window.cancelAnimationFrame(pendingRelayoutFrame);
      pendingRelayoutFrame = undefined;
    }
  };
  const scheduleRelayout = () => {
    if (disposed || pendingRelayoutFrame !== undefined) {
      return;
    }
    pendingRelayoutFrame = window.requestAnimationFrame(() => {
      pendingRelayoutFrame = undefined;
      if (!disposed) {
        editor.layoutContentWidget(widget);
      }
    });
  };
  const visualViewport = window.visualViewport;
  let trackingPositionChanges = false;
  const schedulePositionRelayout = () => {
    if (snapshot.mode !== 'hidden') {
      scheduleRelayout();
    }
  };
  const startPositionTracking = () => {
    if (trackingPositionChanges) {
      return;
    }
    trackingPositionChanges = true;
    window.addEventListener('resize', schedulePositionRelayout);
    window.addEventListener('scroll', schedulePositionRelayout, true);
    visualViewport?.addEventListener('resize', schedulePositionRelayout);
    visualViewport?.addEventListener('scroll', schedulePositionRelayout);
  };
  const stopPositionTracking = () => {
    if (!trackingPositionChanges) {
      return;
    }
    trackingPositionChanges = false;
    window.removeEventListener('resize', schedulePositionRelayout);
    window.removeEventListener('scroll', schedulePositionRelayout, true);
    visualViewport?.removeEventListener('resize', schedulePositionRelayout);
    visualViewport?.removeEventListener('scroll', schedulePositionRelayout);
  };

  const hasSelection = () => editor.getSelections()?.some((selection) => !selection.isEmpty()) ?? false;
  const updateWidgetPosition = (edge: 'start' | 'center') => {
    const selection = editor.getSelection();
    if (edge === 'center') {
      const model = editor.getModel();
      const selections = editor.getSelections()?.filter((candidate) => !candidate.isEmpty());
      if (model && selections?.length) {
        const offsets = selections.flatMap((candidate) => [
          model.getOffsetAt(candidate.getStartPosition()),
          model.getOffsetAt(candidate.getEndPosition()),
        ]);
        widgetPosition = model.getPositionAt(Math.floor((Math.min(...offsets) + Math.max(...offsets)) / 2));
        return;
      }
    }
    widgetPosition = selection?.getStartPosition() ?? editor.getPosition() ?? widgetPosition;
  };
  const hideSelectionToolbar = () => {
    if (snapshot.mode === 'session') {
      return;
    }
    publish({ mode: 'hidden' });
    editor.layoutContentWidget(widget);
  };
  const showSelectionToolbar = () => {
    if (disposed) {
      return;
    }
    updateWidgetPosition('center');
    hasMeasuredSurface = false;
    widgetNode.style.visibility = '';
    const mode = hasSelection() ? 'selection-toolbar' : 'hidden';
    publish({ mode });
    if (mode === 'hidden') {
      stopPositionTracking();
      cancelPendingRelayout();
    } else {
      startPositionTracking();
    }
    editor.layoutContentWidget(widget);
  };
  const startCoauthoring = () => {
    if (disposed || snapshot.mode === 'session' || editor.getValue().trim().length === 0) {
      return;
    }
    keyboardSelecting = false;
    mouseSelecting = false;
    hasMeasuredSurface = false;
    // Monaco first positions with a conservative fallback size. Hide that speculative placement until Core measures it.
    widgetNode.style.visibility = 'hidden';
    updateWidgetPosition('start');
    renderedHeight = INITIAL_HEIGHT;
    renderedWidth = INITIAL_WIDTH;
    publish({ mode: 'session' });
    startPositionTracking();
    editor.layoutContentWidget(widget);
  };
  const getSelectedText = () => {
    const model = editor.getModel();
    const selections = editor.getSelections();
    return model && selections
      ? selections
          .filter((selection) => !selection.isEmpty())
          .map((selection) => model.getValueInRange(selection))
          .join('\n')
      : '';
  };
  const updateRenderedSize = ({ height, width }: { height: number; width: number }) => {
    if (disposed) {
      return;
    }

    let changed = false;
    if (height > 0 && height !== renderedHeight) {
      renderedHeight = height;
      changed = true;
    }
    if (width > 0 && width !== renderedWidth) {
      renderedWidth = width;
      changed = true;
    }
    const measuredSurface = snapshot.mode === 'session' && Boolean(widgetNode.childElementCount) && height > 0;
    const firstSurfaceMeasurement = measuredSurface && !hasMeasuredSurface;
    if (firstSurfaceMeasurement) {
      hasMeasuredSurface = true;
    }
    if (changed || firstSurfaceMeasurement) {
      scheduleRelayout();
    }
  };

  editor.addContentWidget(widget);
  const selectionDisposable = editor.onDidChangeCursorSelection(() => {
    if (snapshot.mode === 'session') {
      publish(snapshot);
    } else if (mouseSelecting || keyboardSelecting) {
      hideSelectionToolbar();
    } else {
      showSelectionToolbar();
    }
  });
  const mouseDownDisposable = editor.onMouseDown(() => {
    if (snapshot.mode !== 'session') {
      mouseSelecting = true;
      hideSelectionToolbar();
    }
  });
  const mouseUpDisposable = editor.onMouseUp(() => {
    if (snapshot.mode !== 'session') {
      mouseSelecting = false;
      if (!keyboardSelecting) {
        showSelectionToolbar();
      }
    }
  });
  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (snapshot.mode !== 'session' && (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)) {
      keyboardSelecting = true;
      hideSelectionToolbar();
    }
  };
  const onDocumentKeyUp = (event: KeyboardEvent) => {
    if (
      snapshot.mode !== 'session' &&
      keyboardSelecting &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      keyboardSelecting = false;
      if (!mouseSelecting) {
        showSelectionToolbar();
      }
    }
  };
  document.addEventListener('keydown', onDocumentKeyDown, true);
  document.addEventListener('keyup', onDocumentKeyUp, true);
  const contentDisposable = editor.onDidChangeModelContent(() => publish(snapshot));
  const layoutDisposable = editor.onDidLayoutChange(schedulePositionRelayout);
  const actionDisposable = editor.addAction({
    id: `${widgetId}.invoke`,
    label: t('grafana-prometheus.components.monaco-query-field.coauthor-promql-query', 'Coauthor PromQL query'),
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period],
    run: startCoauthoring,
  });

  return {
    dismiss: () => {
      keyboardSelecting = false;
      mouseSelecting = false;
      clearEditorDiff();
      showSelectionToolbar();
    },
    portalElement: widgetNode,
    getSelectedText,
    getSnapshot: () => snapshot,
    invoke: startCoauthoring,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateRenderedSize,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      stopPositionTracking();
      cancelPendingRelayout();
      clearEditorDiff();
      actionDisposable.dispose();
      contentDisposable.dispose();
      layoutDisposable.dispose();
      mouseDownDisposable.dispose();
      mouseUpDisposable.dispose();
      selectionDisposable.dispose();
      document.removeEventListener('keydown', onDocumentKeyDown, true);
      document.removeEventListener('keyup', onDocumentKeyUp, true);
      editor.removeContentWidget(widget);
      listeners.clear();
    },
  };
}
