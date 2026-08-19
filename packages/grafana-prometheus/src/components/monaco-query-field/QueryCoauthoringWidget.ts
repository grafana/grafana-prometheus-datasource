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

const QUERY_COAUTHORING_WIDGET_PREFERRED_HEIGHT = 320;
const QUERY_COAUTHORING_WIDGET_VIEWPORT_PADDING = 24;

interface QueryCoauthoringWidgetStyles {
  button: string;
  divider: string;
  toolbar: string;
  widget: string;
}

interface QueryCoauthoringStyles extends QueryCoauthoringWidgetStyles {
  previewChange: string;
  previewOriginal: string;
}

interface QueryCoauthoringRegistration {
  dispose: VoidFunction;
  updateStyles: (styles: QueryCoauthoringStyles) => void;
}

interface QueryCoauthoringWidgetRegistration {
  dispose: VoidFunction;
  updateStyles: (styles: QueryCoauthoringWidgetStyles) => void;
}

interface RegisterPrometheusQueryCoauthoringOptions<TQuery extends DataQuery> {
  createQuery: (value: string) => TQuery;
  editor: MonacoEditor;
  getDatasource: () => PrometheusDatasource;
  getLanguageProvider: () => PrometheusLanguageProviderInterface;
  getTimeRange: () => TimeRange;
  monaco: Monaco;
  onRegister: QueryEditorCoauthoringRegistrar<TQuery>;
  styles: QueryCoauthoringStyles;
  widgetId: string;
}

interface RegisterQueryCoauthoringWidgetOptions<TQuery extends DataQuery> {
  capability: PrometheusCoauthoringCapability<TQuery>;
  editor: MonacoEditor;
  monaco: Monaco;
  onRegister: QueryEditorCoauthoringRegistrar<TQuery>;
  styles: QueryCoauthoringWidgetStyles;
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
  styles,
  widgetId,
}: RegisterPrometheusQueryCoauthoringOptions<TQuery>): QueryCoauthoringRegistration {
  const currentStyles = { ...styles };
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
    getPreviewChangeClassName: () => currentStyles.previewChange,
    getPreviewOriginalClassName: () => currentStyles.previewOriginal,
  });

  const widgetRegistration = registerPrometheusQueryCoauthoringWidget({
    capability,
    editor,
    monaco,
    onRegister,
    styles: currentStyles,
    widgetId,
  });

  return {
    dispose: widgetRegistration.dispose,
    updateStyles: (nextStyles) => {
      Object.assign(currentStyles, nextStyles);
      widgetRegistration.updateStyles(currentStyles);
    },
  };
}

function registerPrometheusQueryCoauthoringWidget<TQuery extends DataQuery>({
  capability,
  editor,
  monaco,
  onRegister,
  styles,
  widgetId,
}: RegisterQueryCoauthoringWidgetOptions<TQuery>): QueryCoauthoringWidgetRegistration {
  const widgetNode = document.createElement('div');
  const toolbarNode = document.createElement('div');
  const hostNode = document.createElement('div');
  const copyButton = document.createElement('button');
  const divider = document.createElement('span');
  const coauthorButton = document.createElement('button');
  const coauthorIcon = document.createElement('span');
  let coauthoringActive = false;
  let disposed = false;
  let pendingRelayoutFrame: number | undefined;
  let widgetPosition = editor.getPosition() ?? { lineNumber: 1, column: 1 };

  widgetNode.style.display = 'none';
  copyButton.type = 'button';
  copyButton.textContent = t('grafana-prometheus.components.monaco-query-field.copy', 'Copy');
  coauthorButton.type = 'button';
  coauthorIcon.setAttribute('aria-hidden', 'true');
  coauthorIcon.textContent = '✦';
  coauthorButton.append(
    coauthorIcon,
    document.createTextNode(` ${t('grafana-prometheus.components.monaco-query-field.coauthor', 'Coauthor')}`)
  );
  hostNode.style.display = 'none';
  toolbarNode.append(copyButton, divider, coauthorButton);
  widgetNode.append(toolbarNode, hostNode);

  const applyStyles = (nextStyles: QueryCoauthoringWidgetStyles) => {
    widgetNode.className = nextStyles.widget;
    toolbarNode.className = nextStyles.toolbar;
    copyButton.className = nextStyles.button;
    divider.className = nextStyles.divider;
    coauthorButton.className = nextStyles.button;
  };
  applyStyles(styles);

  const getViewportBoundedHeight = () => {
    const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
    return Math.min(
      QUERY_COAUTHORING_WIDGET_PREFERRED_HEIGHT,
      Math.max(1, viewportHeight - QUERY_COAUTHORING_WIDGET_VIEWPORT_PADDING * 2)
    );
  };
  const applyViewportBounds = () => {
    const height = getViewportBoundedHeight();
    widgetNode.style.maxHeight = `${height}px`;
    widgetNode.style.overflowX = 'hidden';
    widgetNode.style.overflowY = 'auto';
    return height;
  };
  const clearViewportBounds = () => {
    widgetNode.style.maxHeight = '';
    widgetNode.style.overflowX = '';
    widgetNode.style.overflowY = '';
  };

  const widget: monacoTypes.editor.IContentWidget = {
    allowEditorOverflow: true,
    beforeRender: () => {
      if (!coauthoringActive) {
        return null;
      }

      return {
        // Assistant mounts after Monaco's first layout pass, so reserve the same viewport-bounded height as the host.
        height: applyViewportBounds(),
        width: widgetNode.getBoundingClientRect().width,
      };
    },
    getId: () => widgetId,
    getDomNode: () => widgetNode,
    getPosition: () => ({
      position: widgetPosition,
      preference: coauthoringActive
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
  const scheduleRelayoutForViewportChange = () => {
    if (disposed || !coauthoringActive || pendingRelayoutFrame !== undefined) {
      return;
    }

    pendingRelayoutFrame = window.requestAnimationFrame(() => {
      pendingRelayoutFrame = undefined;
      if (!disposed && coauthoringActive) {
        editor.layoutContentWidget(widget);
      }
    });
  };
  const addViewportListeners = () => {
    window.addEventListener('resize', scheduleRelayoutForViewportChange);
    window.addEventListener('scroll', scheduleRelayoutForViewportChange, true);
    window.visualViewport?.addEventListener('resize', scheduleRelayoutForViewportChange);
    window.visualViewport?.addEventListener('scroll', scheduleRelayoutForViewportChange);
  };
  const removeViewportListeners = () => {
    window.removeEventListener('resize', scheduleRelayoutForViewportChange);
    window.removeEventListener('scroll', scheduleRelayoutForViewportChange, true);
    window.visualViewport?.removeEventListener('resize', scheduleRelayoutForViewportChange);
    window.visualViewport?.removeEventListener('scroll', scheduleRelayoutForViewportChange);
    cancelPendingRelayout();
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
    const visible = hasSelection() && !coauthoringActive;
    widgetNode.style.display = visible ? 'block' : 'none';
    toolbarNode.style.display = visible ? 'flex' : 'none';
    hostNode.style.display = 'none';
    clearViewportBounds();
    editor.layoutContentWidget(widget);
  };
  const startCoauthoring = () => {
    if (disposed || coauthoringActive || editor.getValue().trim().length === 0) {
      return;
    }
    coauthoringActive = true;
    addViewportListeners();
    updateWidgetPosition();
    widgetNode.style.display = 'block';
    toolbarNode.style.display = 'none';
    hostNode.style.display = 'block';
    applyViewportBounds();
    editor.layoutContentWidget(widget);
    capability.invoke({
      anchorElement: hostNode,
      dismiss: () => {
        capability.clearPreview();
        coauthoringActive = false;
        removeViewportListeners();
        showSelectionToolbar();
      },
    });
  };
  const preserveSelection = (event: MouseEvent) => event.preventDefault();

  copyButton.addEventListener('mousedown', preserveSelection);
  coauthorButton.addEventListener('mousedown', preserveSelection);
  copyButton.addEventListener('click', () => {
    const model = editor.getModel();
    const selections = editor.getSelections();
    const selectedText =
      model && selections
        ? selections
            .filter((selection) => !selection.isEmpty())
            .map((selection) => model.getValueInRange(selection))
            .join('\n')
        : '';
    if (selectedText) {
      copyText(selectedText);
    }
  });
  coauthorButton.addEventListener('click', startCoauthoring);
  editor.addContentWidget(widget);
  const selectionDisposable = editor.onDidChangeCursorSelection(() => {
    if (!coauthoringActive) {
      showSelectionToolbar();
    }
  });
  const actionDisposable = editor.addAction({
    id: `${widgetId}.invoke`,
    label: t('grafana-prometheus.components.monaco-query-field.coauthor-promql-query', 'Coauthor PromQL query'),
    run: startCoauthoring,
  });
  onRegister(capability);
  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      removeViewportListeners();
      capability.clearPreview();
      actionDisposable.dispose();
      selectionDisposable.dispose();
      editor.removeContentWidget(widget);
      onRegister(undefined);
    },
    updateStyles: (nextStyles) => {
      if (disposed) {
        return;
      }
      applyStyles(nextStyles);
      editor.layoutContentWidget(widget);
    },
  };
}

function copyText(value: string) {
  const writeText = navigator.clipboard?.writeText;
  if (writeText) {
    void writeText.call(navigator.clipboard, value).catch(() => copyTextFallback(value));
    return;
  }

  copyTextFallback(value);
}

function copyTextFallback(value: string) {
  if (typeof document.execCommand !== 'function') {
    return;
  }

  const activeElement = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  try {
    textarea.select();
    document.execCommand('copy');
  } catch {
    // Copying is best-effort in browsers without the async clipboard API.
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) {
      activeElement.focus();
    }
  }
}
