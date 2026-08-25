import { t } from '@grafana/i18n';
import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

const INITIAL_HEIGHT = 320;
const INITIAL_WIDTH = 403;
const SELECTION_TOOLBAR_GAP = 4;
const VIEWPORT_MARGIN = 8;

export type MonacoQueryCoauthoringHostMode = 'hidden' | 'selection' | 'invoked';

export interface MonacoQueryCoauthoringHostSnapshot {
  mode: MonacoQueryCoauthoringHostMode;
}

export interface MonacoQueryCoauthoringHost {
  dismiss(): void;
  dispose(): void;
  getSnapshot(): MonacoQueryCoauthoringHostSnapshot;
  hide(): void;
  portalTarget: HTMLElement;
  showInvocation(): void;
  subscribe(listener: VoidFunction): VoidFunction;
  updatePortalClass(className: string): void;
}

interface Options {
  editor: MonacoEditor;
  monaco: Monaco;
  onContentChange(value: string): void;
  onInvoke(): void;
  portalClassName: string;
  widgetId: string;
}

export function createMonacoQueryCoauthoringHost({
  editor,
  monaco,
  onContentChange,
  onInvoke,
  portalClassName,
  widgetId,
}: Options): MonacoQueryCoauthoringHost {
  const portalTarget = document.createElement('div');
  portalTarget.classList.add(portalClassName);
  const listeners = new Set<VoidFunction>();
  let hasMeasuredSurface = false;
  let disposed = false;
  // Selection settling: while a drag or a modifier-key gesture is still in progress the toolbar stays hidden,
  // so it appears once at the final selection instead of flickering along with every intermediate one.
  let keyboardSelecting = false;
  let mouseSelecting = false;
  let pendingRelayoutFrame: number | undefined;
  let renderedHeight = INITIAL_HEIGHT;
  let renderedWidth = INITIAL_WIDTH;
  let sessionPlacement: monacoTypes.editor.ContentWidgetPositionPreference | undefined;
  let snapshot: MonacoQueryCoauthoringHostSnapshot = { mode: 'hidden' };
  let widgetPosition = editor.getPosition() ?? { lineNumber: 1, column: 1 };

  const publish = (mode: MonacoQueryCoauthoringHostMode) => {
    if (snapshot.mode === mode) {
      return;
    }
    snapshot = { mode };
    listeners.forEach((listener) => listener());
  };

  const alignWithinViewport = () => {
    portalTarget.style.transform = '';
    if (snapshot.mode === 'hidden') {
      return;
    }

    const widgetRect = portalTarget.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftBoundary = (viewport?.offsetLeft ?? 0) + VIEWPORT_MARGIN;
    const rightBoundary = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - VIEWPORT_MARGIN;
    if (widgetRect.width <= 0 || rightBoundary <= leftBoundary) {
      return;
    }

    // Monaco anchors content widgets at the selected column but does not keep overflowing widgets in view.
    const targetLeft = snapshot.mode === 'selection' ? widgetRect.left - widgetRect.width / 2 : widgetRect.left;
    const maximumLeft = Math.max(leftBoundary, rightBoundary - widgetRect.width);
    const alignedLeft = Math.min(Math.max(targetLeft, leftBoundary), maximumLeft);
    const horizontalOffset = alignedLeft - widgetRect.left;
    const verticalOffset = snapshot.mode === 'selection' ? -SELECTION_TOOLBAR_GAP : 0;
    if (horizontalOffset !== 0 && verticalOffset !== 0) {
      portalTarget.style.transform = `translate(${horizontalOffset}px, ${verticalOffset}px)`;
    } else if (horizontalOffset !== 0) {
      portalTarget.style.transform = `translateX(${horizontalOffset}px)`;
    } else if (verticalOffset !== 0) {
      portalTarget.style.transform = `translateY(${verticalOffset}px)`;
    }
  };

  const widget: monacoTypes.editor.IContentWidget = {
    allowEditorOverflow: true,
    beforeRender: () =>
      snapshot.mode === 'invoked'
        ? {
            height: renderedHeight,
            width: renderedWidth,
          }
        : null,
    afterRender: (position) => {
      if (position === null) {
        portalTarget.style.transform = '';
        return;
      }
      // Latch the first above/below choice for the rest of the invocation; otherwise the surface hops sides as
      // Core's prompt grows. It is cleared only when something moves the editor (scroll, resize, relayout).
      if (snapshot.mode === 'invoked' && sessionPlacement === undefined) {
        sessionPlacement = position;
      }
      alignWithinViewport();
      if (snapshot.mode !== 'invoked' || hasMeasuredSurface) {
        portalTarget.style.visibility = '';
      }
    },
    getId: () => widgetId,
    getDomNode: () => portalTarget,
    getPosition: () => ({
      position: widgetPosition,
      preference:
        snapshot.mode === 'selection'
          ? [monaco.editor.ContentWidgetPositionPreference.ABOVE]
          : sessionPlacement === undefined
            ? [monaco.editor.ContentWidgetPositionPreference.BELOW, monaco.editor.ContentWidgetPositionPreference.ABOVE]
            : [sessionPlacement],
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
  const schedulePositionRelayout = (shouldReevaluateSessionPlacement = true) => {
    if (snapshot.mode === 'invoked' && shouldReevaluateSessionPlacement) {
      sessionPlacement = undefined;
    }
    if (snapshot.mode !== 'hidden') {
      scheduleRelayout();
    }
  };
  const scheduleExternalPositionRelayout = () => schedulePositionRelayout();
  const scheduleScrollRelayout = (event: Event) => {
    if (snapshot.mode !== 'invoked') {
      schedulePositionRelayout(false);
      return;
    }
    if (event.target instanceof Node && portalTarget.contains(event.target)) {
      return;
    }
    if (event.target === window || event.target === document) {
      schedulePositionRelayout();
      return;
    }
    if (!(event.target instanceof Node)) {
      return;
    }
    const editorNode = editor.getDomNode();
    if (editorNode && (event.target.contains(editorNode) || editorNode.contains(event.target))) {
      schedulePositionRelayout();
    }
  };
  const startPositionTracking = () => {
    if (trackingPositionChanges) {
      return;
    }
    trackingPositionChanges = true;
    window.addEventListener('resize', scheduleExternalPositionRelayout);
    window.addEventListener('scroll', scheduleScrollRelayout, true);
    visualViewport?.addEventListener('resize', scheduleExternalPositionRelayout);
    visualViewport?.addEventListener('scroll', scheduleExternalPositionRelayout);
  };
  const stopPositionTracking = () => {
    if (!trackingPositionChanges) {
      return;
    }
    trackingPositionChanges = false;
    window.removeEventListener('resize', scheduleExternalPositionRelayout);
    window.removeEventListener('scroll', scheduleScrollRelayout, true);
    visualViewport?.removeEventListener('resize', scheduleExternalPositionRelayout);
    visualViewport?.removeEventListener('scroll', scheduleExternalPositionRelayout);
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
  const hide = () => {
    if (snapshot.mode === 'hidden') {
      return;
    }
    publish('hidden');
    stopPositionTracking();
    cancelPendingRelayout();
    editor.layoutContentWidget(widget);
  };
  const showSelectionToolbar = () => {
    if (disposed || snapshot.mode === 'invoked') {
      return;
    }
    updateWidgetPosition('center');
    hasMeasuredSurface = false;
    portalTarget.style.visibility = '';
    const mode = hasSelection() ? 'selection' : 'hidden';
    publish(mode);
    if (mode === 'hidden') {
      stopPositionTracking();
      cancelPendingRelayout();
    } else {
      startPositionTracking();
    }
    editor.layoutContentWidget(widget);
  };
  const showInvocation = () => {
    if (disposed || snapshot.mode === 'invoked') {
      return;
    }
    keyboardSelecting = false;
    mouseSelecting = false;
    hasMeasuredSurface = false;
    sessionPlacement = undefined;
    // Monaco positions with the conservative fallback size first. Hide that speculative placement until the
    // ResizeObserver has measured the surface Core rendered into the portal.
    portalTarget.style.visibility = 'hidden';
    updateWidgetPosition('start');
    renderedHeight = INITIAL_HEIGHT;
    renderedWidth = INITIAL_WIDTH;
    publish('invoked');
    startPositionTracking();
    editor.layoutContentWidget(widget);
  };
  const updateRenderedSize = ({ height, width }: { height: number; width: number }) => {
    if (disposed || snapshot.mode !== 'invoked') {
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
    const measuredSurface = Boolean(portalTarget.childElementCount) && height > 0;
    const firstSurfaceMeasurement = measuredSurface && !hasMeasuredSurface;
    if (firstSurfaceMeasurement) {
      hasMeasuredSurface = true;
    }
    if (changed || firstSurfaceMeasurement) {
      scheduleRelayout();
    }
  };

  editor.addContentWidget(widget);
  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(([entry]) => {
          if (entry) {
            updateRenderedSize(entry.contentRect);
          }
        });
  resizeObserver?.observe(portalTarget);
  const selectionDisposable = editor.onDidChangeCursorSelection(() => {
    if (snapshot.mode === 'invoked') {
      return;
    }
    if (mouseSelecting || keyboardSelecting) {
      hide();
    } else {
      showSelectionToolbar();
    }
  });
  const mouseDownDisposable = editor.onMouseDown((event) => {
    if (event.target.element && portalTarget.contains(event.target.element)) {
      return;
    }
    if (snapshot.mode !== 'invoked') {
      mouseSelecting = true;
      hide();
    }
  });
  const mouseUpDisposable = editor.onMouseUp((event) => {
    if (event.target.element && portalTarget.contains(event.target.element)) {
      return;
    }
    if (snapshot.mode !== 'invoked') {
      mouseSelecting = false;
      if (!keyboardSelecting) {
        showSelectionToolbar();
      }
    }
  });
  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (snapshot.mode !== 'invoked' && (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)) {
      keyboardSelecting = true;
      hide();
    }
  };
  const onDocumentKeyUp = (event: KeyboardEvent) => {
    if (
      snapshot.mode !== 'invoked' &&
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
  const contentDisposable = editor.onDidChangeModelContent(() => onContentChange(editor.getValue()));
  const layoutDisposable = editor.onDidLayoutChange(scheduleExternalPositionRelayout);
  const actionDisposable = editor.addAction({
    id: `${widgetId}.invoke`,
    label: t('grafana-prometheus.components.monaco-query-field.coauthor-promql-query', 'Coauthor PromQL query'),
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period],
    run: onInvoke,
  });

  return {
    dismiss: () => {
      keyboardSelecting = false;
      mouseSelecting = false;
      sessionPlacement = undefined;
      publish('hidden');
      showSelectionToolbar();
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      stopPositionTracking();
      cancelPendingRelayout();
      sessionPlacement = undefined;
      resizeObserver?.disconnect();
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
    getSnapshot: () => snapshot,
    hide,
    portalTarget,
    showInvocation,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updatePortalClass: (className) => {
      portalTarget.className = className;
    },
  };
}
