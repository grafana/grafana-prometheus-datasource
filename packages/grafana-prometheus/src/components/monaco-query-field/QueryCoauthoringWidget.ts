import { type DataQuery, type TimeRange } from '@grafana/data';
import { t } from '@grafana/i18n';
import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { escapeLabelValueInExactSelector } from '../../escaping';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import {
  createPrometheusCoauthoringCapability,
  type PrometheusCoauthoringCapability,
  QUERY_COAUTHORING_MAX_CONTEXT_LABELS,
  type QueryEditorCoauthoringRegistrar,
} from '../../query_coauthoring/capability';
import { placeHolderScopedVars } from './monaco-completion-provider/validation';

const QUERY_COAUTHORING_WIDGET_INITIAL_HEIGHT = 320;
const QUERY_COAUTHORING_WIDGET_INITIAL_WIDTH = 360;
const QUERY_COAUTHORING_WIDGET_EDITOR_MARGIN = 8;

interface QueryCoauthoringPreviewStyles {
  previewChange: string;
  previewOriginal: string;
}

export type QueryCoauthoringWidgetMode = 'hidden' | 'selection-toolbar' | 'coauthoring';

export interface QueryCoauthoringWidgetSnapshot {
  mode: QueryCoauthoringWidgetMode;
}

export interface QueryCoauthoringRegistration {
  dispose: VoidFunction;
  getSelectedText: () => string;
  getSnapshot: () => QueryCoauthoringWidgetSnapshot;
  invoke: VoidFunction;
  mountAssistant: (anchorElement: HTMLElement) => void;
  portalElement: HTMLElement;
  subscribe: (listener: VoidFunction) => VoidFunction;
  updatePreviewStyles: (styles: QueryCoauthoringPreviewStyles) => void;
  updateRenderedSize: (size: { height: number; width: number }) => void;
}

interface RegisterPrometheusQueryCoauthoringOptions<TQuery extends DataQuery> {
  createQuery: (value: string) => TQuery;
  editor: MonacoEditor;
  getDatasource: () => PrometheusDatasource;
  getLanguageProvider: () => PrometheusLanguageProviderInterface;
  getTimeRange: () => TimeRange;
  monaco: Monaco;
  onRegister: QueryEditorCoauthoringRegistrar<TQuery>;
  previewStyles: QueryCoauthoringPreviewStyles;
  widgetId: string;
}

interface RegisterQueryCoauthoringWidgetOptions<TQuery extends DataQuery> {
  capability: PrometheusCoauthoringCapability<TQuery>;
  editor: MonacoEditor;
  monaco: Monaco;
  onRegister: QueryEditorCoauthoringRegistrar<TQuery>;
  widgetId: string;
}

/**
 * Registers the internal Prometheus adapter for Grafana's experimental query coauthoring interface.
 *
 * @internal
 */
export function registerPrometheusQueryCoauthoring<TQuery extends DataQuery>({
  createQuery,
  editor,
  getDatasource,
  getLanguageProvider,
  getTimeRange,
  monaco,
  onRegister,
  previewStyles,
  widgetId,
}: RegisterPrometheusQueryCoauthoringOptions<TQuery>): QueryCoauthoringRegistration {
  const currentPreviewStyles = { ...previewStyles };
  const capability = createPrometheusCoauthoringCapability({
    editor,
    createQuery,
    interpolate: (value) => getDatasource().interpolateString(value, placeHolderScopedVars),
    retrieveMetricsMetadata: () => getLanguageProvider().retrieveMetricsMetadata(),
    queryMetricsMetadata: () => getLanguageProvider().queryMetricsMetadata(),
    queryMetricLabels: (metricName) =>
      getLanguageProvider().queryLabelKeys(
        getTimeRange(),
        `{__name__="${escapeLabelValueInExactSelector(metricName)}"}`,
        QUERY_COAUTHORING_MAX_CONTEXT_LABELS
      ),
    getPreviewChangeClassName: () => currentPreviewStyles.previewChange,
    getPreviewOriginalClassName: () => currentPreviewStyles.previewOriginal,
  });

  const registration = registerPrometheusQueryCoauthoringWidget({
    capability,
    editor,
    monaco,
    onRegister,
    widgetId,
  });

  return {
    ...registration,
    updatePreviewStyles: (nextStyles) => {
      Object.assign(currentPreviewStyles, nextStyles);
    },
  };
}

function registerPrometheusQueryCoauthoringWidget<TQuery extends DataQuery>({
  capability,
  editor,
  monaco,
  onRegister,
  widgetId,
}: RegisterQueryCoauthoringWidgetOptions<TQuery>): Omit<QueryCoauthoringRegistration, 'updatePreviewStyles'> {
  const widgetNode = document.createElement('div');
  const listeners = new Set<VoidFunction>();
  let activeInvocation = 0;
  let assistantMounted = false;
  let disposed = false;
  let pendingRelayoutFrame: number | undefined;
  let renderedHeight = QUERY_COAUTHORING_WIDGET_INITIAL_HEIGHT;
  let renderedWidth = QUERY_COAUTHORING_WIDGET_INITIAL_WIDTH;
  let snapshot: QueryCoauthoringWidgetSnapshot = { mode: 'hidden' };
  let widgetPosition = editor.getPosition() ?? { lineNumber: 1, column: 1 };

  const publish = (nextSnapshot: QueryCoauthoringWidgetSnapshot) => {
    if (snapshot.mode === nextSnapshot.mode) {
      return;
    }
    snapshot = nextSnapshot;
    listeners.forEach((listener) => listener());
  };

  const alignWidgetWithinEditor = () => {
    widgetNode.style.transform = '';
    const editorNode = editor.getDomNode();
    if (!editorNode || snapshot.mode === 'hidden') {
      return;
    }

    const editorRect = editorNode.getBoundingClientRect();
    const widgetRect = widgetNode.getBoundingClientRect();
    const leftBoundary = editorRect.left + QUERY_COAUTHORING_WIDGET_EDITOR_MARGIN;
    const rightBoundary = editorRect.right - QUERY_COAUTHORING_WIDGET_EDITOR_MARGIN;
    if (editorRect.width <= 0 || widgetRect.width <= 0 || rightBoundary <= leftBoundary) {
      return;
    }

    // Monaco anchors content widgets at the selected column but does not flip them horizontally.
    // Shift the widget after placement so its controls remain inside the editor pane.
    const maximumLeft = Math.max(leftBoundary, rightBoundary - widgetRect.width);
    const alignedLeft = Math.min(Math.max(widgetRect.left, leftBoundary), maximumLeft);
    const horizontalOffset = alignedLeft - widgetRect.left;
    if (horizontalOffset !== 0) {
      widgetNode.style.transform = `translateX(${horizontalOffset}px)`;
    }
  };

  const widget: monacoTypes.editor.IContentWidget = {
    allowEditorOverflow: true,
    beforeRender: () => {
      if (snapshot.mode !== 'coauthoring') {
        return null;
      }

      return {
        height: renderedHeight,
        width: renderedWidth,
      };
    },
    afterRender: (position) => {
      if (position === null) {
        widgetNode.style.transform = '';
        return;
      }
      alignWidgetWithinEditor();
    },
    getId: () => widgetId,
    getDomNode: () => widgetNode,
    getPosition: () => ({
      position: widgetPosition,
      preference:
        snapshot.mode === 'coauthoring'
          ? [monaco.editor.ContentWidgetPositionPreference.ABOVE, monaco.editor.ContentWidgetPositionPreference.BELOW]
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
  const updateWidgetPosition = () => {
    widgetPosition = editor.getSelection()?.getEndPosition() ?? editor.getPosition() ?? widgetPosition;
  };
  const showSelectionToolbar = () => {
    if (disposed) {
      return;
    }
    updateWidgetPosition();
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
    if (disposed || snapshot.mode === 'coauthoring' || editor.getValue().trim().length === 0) {
      return;
    }
    activeInvocation++;
    assistantMounted = false;
    updateWidgetPosition();
    renderedHeight = QUERY_COAUTHORING_WIDGET_INITIAL_HEIGHT;
    publish({ mode: 'coauthoring' });
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
  const mountAssistant = (anchorElement: HTMLElement) => {
    if (disposed || snapshot.mode !== 'coauthoring' || assistantMounted) {
      return;
    }
    assistantMounted = true;
    const invocation = activeInvocation;
    capability.invoke({
      anchorElement,
      dismiss: () => {
        if (disposed || invocation !== activeInvocation) {
          return;
        }
        capability.clearPreview();
        assistantMounted = false;
        showSelectionToolbar();
      },
    });
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
    if (changed) {
      scheduleRelayout();
    }
  };

  editor.addContentWidget(widget);
  const selectionDisposable = editor.onDidChangeCursorSelection(() => {
    if (snapshot.mode !== 'coauthoring') {
      showSelectionToolbar();
    }
  });
  const layoutDisposable = editor.onDidLayoutChange(schedulePositionRelayout);
  const actionDisposable = editor.addAction({
    id: `${widgetId}.invoke`,
    label: t('grafana-prometheus.components.monaco-query-field.coauthor-promql-query', 'Coauthor PromQL query'),
    run: startCoauthoring,
  });
  onRegister(capability);
  return {
    portalElement: widgetNode,
    getSelectedText,
    getSnapshot: () => snapshot,
    invoke: startCoauthoring,
    mountAssistant,
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
      capability.clearPreview();
      actionDisposable.dispose();
      layoutDisposable.dispose();
      selectionDisposable.dispose();
      editor.removeContentWidget(widget);
      onRegister(undefined);
      listeners.clear();
    },
  };
}
