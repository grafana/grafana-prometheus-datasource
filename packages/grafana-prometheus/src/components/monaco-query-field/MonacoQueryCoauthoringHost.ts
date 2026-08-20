import { t } from '@grafana/i18n';
import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

const INITIAL_HEIGHT = 320;
const INITIAL_WIDTH = 403;
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
    const maximumLeft = Math.max(leftBoundary, rightBoundary - widgetRect.width);
    const alignedLeft = Math.min(Math.max(widgetRect.left, leftBoundary), maximumLeft);
    const horizontalOffset = alignedLeft - widgetRect.left;
    if (horizontalOffset !== 0) {
      widgetNode.style.transform = `translateX(${horizontalOffset}px)`;
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
      preference: [
        monaco.editor.ContentWidgetPositionPreference.BELOW,
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
      ],
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
  const updateWidgetPosition = (edge: 'start' | 'end') => {
    const selection = editor.getSelection();
    widgetPosition =
      (edge === 'start' ? selection?.getStartPosition() : selection?.getEndPosition()) ??
      editor.getPosition() ??
      widgetPosition;
  };
  const showSelectionToolbar = () => {
    if (disposed) {
      return;
    }
    updateWidgetPosition('end');
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
    if (snapshot.mode !== 'session') {
      showSelectionToolbar();
    } else {
      publish(snapshot);
    }
  });
  const contentDisposable = editor.onDidChangeModelContent(() => publish(snapshot));
  const layoutDisposable = editor.onDidLayoutChange(schedulePositionRelayout);
  const actionDisposable = editor.addAction({
    id: `${widgetId}.invoke`,
    label: t('grafana-prometheus.components.monaco-query-field.coauthor-promql-query', 'Coauthor PromQL query'),
    run: startCoauthoring,
  });

  return {
    dismiss: () => {
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
      selectionDisposable.dispose();
      editor.removeContentWidget(widget);
      listeners.clear();
    },
  };
}
