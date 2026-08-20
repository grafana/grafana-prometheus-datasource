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
import {
  type QueryEditorCoauthoringContextV1,
  type QueryEditorCoauthoringControllerV1,
  type QueryEditorCoauthoringSnapshotV1,
} from '../../query_coauthoring/v1Compatibility';
import { placeHolderScopedVars } from './monaco-completion-provider/validation';

const QUERY_COAUTHORING_WIDGET_INITIAL_HEIGHT = 320;
const QUERY_COAUTHORING_WIDGET_INITIAL_WIDTH = 403;
const QUERY_COAUTHORING_WIDGET_VIEWPORT_MARGIN = 8;

interface QueryCoauthoringPreviewStyles {
  previewChange: string;
  previewOriginal: string;
}

export type QueryCoauthoringWidgetMode = 'hidden' | 'selection-toolbar' | 'coauthoring';

export interface QueryCoauthoringWidgetSnapshot {
  mode: QueryCoauthoringWidgetMode;
}

export interface QueryCoauthoringRegistration {
  capability: PrometheusCoauthoringCapability;
  dismiss: VoidFunction;
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
    capability,
    updatePreviewStyles: (nextStyles) => {
      Object.assign(currentPreviewStyles, nextStyles);
    },
  };
}

export function createPrometheusQueryCoauthoringController<TQuery extends DataQuery>(
  registration: QueryCoauthoringRegistration,
  queryKey: string
): QueryEditorCoauthoringControllerV1<TQuery> {
  let context: QueryEditorCoauthoringContextV1 | undefined;
  let revision = 0;
  let disposed = false;
  const listeners = new Set<VoidFunction>();
  let unsubscribeRegistration: VoidFunction | undefined;
  const nextContext = async (refresh: boolean) => {
    const captured = await (refresh ? registration.capability.refreshContext() : registration.capability.getContext());
    revision++;
    context = {
      queryKey,
      revision: String(revision),
      query: captured.query,
      focusRanges: captured.focusRanges,
      language: { id: 'promql', displayName: 'PromQL' },
      metricMetadata: captured.metricMetadata,
    };
    return context;
  };
  const snapshot = (): QueryEditorCoauthoringSnapshotV1 => {
    const widgetSnapshot = registration.getSnapshot();
    if (widgetSnapshot.mode === 'hidden') {
      return { mode: 'hidden' };
    }
    if (widgetSnapshot.mode === 'selection-toolbar') {
      return {
        mode: 'selection',
        selectedText: registration.getSelectedText(),
        revision: context?.revision ?? String(revision),
      };
    }
    return { mode: 'session', revision: context?.revision ?? String(revision) };
  };
  let currentSnapshot = snapshot();
  const publish = () => {
    currentSnapshot = snapshot();
    listeners.forEach((listener) => listener());
  };
  const ensureRegistrationSubscription = () => {
    unsubscribeRegistration ??= registration.subscribe(publish);
  };

  ensureRegistrationSubscription();

  return {
    getSnapshot: () => currentSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPortalTarget: () => registration.portalElement,
    begin: async () => {
      if (context) {
        return context;
      }
      registration.invoke();
      registration.capability.invoke({ anchorElement: registration.portalElement, dismiss: registration.dismiss });
      const next = await nextContext(false);
      publish();
      return next;
    },
    refreshContext: async () => {
      const next = await nextContext(true);
      publish();
      return next;
    },
    stageEditorDiff: (source) => {
      if (!context || registration.capability.getValue() !== context.query) {
        return { status: 'rejected', reason: 'stale' };
      }
      if (!registration.capability.validateQuery(source)) {
        return { status: 'rejected', reason: 'invalid' };
      }
      const preview = registration.capability.stagePreview(source);
      if (!preview) {
        return { status: 'rejected', reason: source === context.query ? 'unchanged' : 'stale' };
      }
      return {
        status: 'staged',
        query: registration.capability.createQuery(source) as TQuery,
        queryKey,
        baselineRevision: context.revision,
        changes: preview.changes,
      };
    },
    clearEditorDiff: () => {
      registration.capability.clearPreview();
      publish();
    },
    focus: registration.capability.focus,
    dismiss: () => {
      registration.dismiss();
      publish();
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeRegistration?.();
      unsubscribeRegistration = undefined;
      listeners.clear();
      registration.dispose();
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
  let assistantAnchorElement: HTMLElement | undefined;
  let hasMeasuredAssistant = false;
  let assistantMounted = false;
  let disposed = false;
  let pendingRelayoutFrame: number | undefined;
  let renderedHeight = QUERY_COAUTHORING_WIDGET_INITIAL_HEIGHT;
  let renderedWidth = QUERY_COAUTHORING_WIDGET_INITIAL_WIDTH;
  let snapshot: QueryCoauthoringWidgetSnapshot = { mode: 'hidden' };
  let widgetPosition = editor.getPosition() ?? { lineNumber: 1, column: 1 };

  const publish = (nextSnapshot: QueryCoauthoringWidgetSnapshot) => {
    snapshot = nextSnapshot;
    listeners.forEach((listener) => listener());
  };

  const alignWidgetWithinViewport = () => {
    widgetNode.style.transform = '';
    if (snapshot.mode === 'hidden') {
      return;
    }

    const widgetRect = widgetNode.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftBoundary = (viewport?.offsetLeft ?? 0) + QUERY_COAUTHORING_WIDGET_VIEWPORT_MARGIN;
    const rightBoundary =
      (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - QUERY_COAUTHORING_WIDGET_VIEWPORT_MARGIN;
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
      alignWidgetWithinViewport();
      if (snapshot.mode !== 'coauthoring' || hasMeasuredAssistant) {
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
    assistantAnchorElement = undefined;
    hasMeasuredAssistant = false;
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
    if (disposed || snapshot.mode === 'coauthoring' || editor.getValue().trim().length === 0) {
      return;
    }
    activeInvocation++;
    assistantAnchorElement = undefined;
    hasMeasuredAssistant = false;
    assistantMounted = false;
    // Monaco first positions with the conservative fallback height. Keep that speculative placement from painting
    // until React has mounted and measured the Assistant, then reveal it after the measured relayout.
    widgetNode.style.visibility = 'hidden';
    updateWidgetPosition('start');
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
    assistantAnchorElement = anchorElement;
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
    const measuredAssistant =
      snapshot.mode === 'coauthoring' &&
      assistantMounted &&
      Boolean(assistantAnchorElement?.childElementCount) &&
      height > 0;
    const firstAssistantMeasurement = measuredAssistant && !hasMeasuredAssistant;
    if (firstAssistantMeasurement) {
      hasMeasuredAssistant = true;
    }
    if (changed || firstAssistantMeasurement) {
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
    capability,
    dismiss: () => {
      capability.clearPreview();
      assistantMounted = false;
      showSelectionToolbar();
    },
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
