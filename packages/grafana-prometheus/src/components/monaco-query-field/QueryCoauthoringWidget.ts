import { type DataQuery, type TimeRange } from '@grafana/data';
import { t } from '@grafana/i18n';
import { type Monaco, type MonacoEditor, type monacoTypes } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import {
  createPrometheusCoauthoringCapability,
  type PrometheusCoauthoringCapability,
  type QueryEditorCoauthoringRegistrar,
} from '../../query_coauthoring/capability';
import { placeHolderScopedVars } from './monaco-completion-provider/validation';

interface QueryCoauthoringWidgetStyles {
  button: string;
  divider: string;
  shortcut: string;
  toolbar: string;
  widget: string;
}

interface QueryCoauthoringStyles extends QueryCoauthoringWidgetStyles {
  previewChange: string;
  previewOriginal: string;
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
}: RegisterPrometheusQueryCoauthoringOptions<TQuery>): VoidFunction {
  const capability = createPrometheusCoauthoringCapability({
    editor,
    createQuery,
    interpolate: (value) => getDatasource().interpolateString(value, placeHolderScopedVars),
    retrieveMetricsMetadata: () => getLanguageProvider().retrieveMetricsMetadata(),
    queryMetricsMetadata: () => getLanguageProvider().queryMetricsMetadata(),
    queryMetricLabels: (metricName) => getLanguageProvider().queryLabelKeys(getTimeRange(), metricName, 30),
    previewChangeClassName: styles.previewChange,
    previewOriginalClassName: styles.previewOriginal,
  });

  return registerPrometheusQueryCoauthoringWidget({
    capability,
    editor,
    monaco,
    onRegister,
    styles,
    widgetId,
  });
}

function registerPrometheusQueryCoauthoringWidget<TQuery extends DataQuery>({
  capability,
  editor,
  monaco,
  onRegister,
  styles,
  widgetId,
}: RegisterQueryCoauthoringWidgetOptions<TQuery>): VoidFunction {
  const widgetNode = document.createElement('div');
  const toolbarNode = document.createElement('div');
  const hostNode = document.createElement('div');
  const copyButton = document.createElement('button');
  const divider = document.createElement('span');
  const coauthorButton = document.createElement('button');
  const shortcut = document.createElement('span');
  let coauthoringActive = false;
  let widgetPosition = editor.getPosition() ?? { lineNumber: 1, column: 1 };

  widgetNode.className = styles.widget;
  widgetNode.style.display = 'none';
  toolbarNode.className = styles.toolbar;
  copyButton.className = styles.button;
  copyButton.type = 'button';
  copyButton.textContent = t('grafana-prometheus.components.monaco-query-field.copy', 'Copy');
  divider.className = styles.divider;
  coauthorButton.className = styles.button;
  coauthorButton.type = 'button';
  coauthorButton.textContent = t('grafana-prometheus.components.monaco-query-field.coauthor', '✦ Coauthor');
  shortcut.className = styles.shortcut;
  shortcut.textContent = 'cmd+shift+q';
  hostNode.style.display = 'none';
  toolbarNode.append(copyButton, divider, coauthorButton, shortcut);
  widgetNode.append(toolbarNode, hostNode);

  const widget: monacoTypes.editor.IContentWidget = {
    allowEditorOverflow: true,
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

  const hasSelection = () => editor.getSelections()?.some((selection) => !selection.isEmpty()) ?? false;
  const updateWidgetPosition = () => {
    widgetPosition = editor.getSelection()?.getEndPosition() ?? editor.getPosition() ?? widgetPosition;
  };
  const showSelectionToolbar = () => {
    updateWidgetPosition();
    const visible = hasSelection() && !coauthoringActive;
    widgetNode.style.display = visible ? 'block' : 'none';
    toolbarNode.style.display = visible ? 'flex' : 'none';
    hostNode.style.display = 'none';
    editor.layoutContentWidget(widget);
  };
  const startCoauthoring = () => {
    if (coauthoringActive || editor.getValue().trim().length === 0) {
      return;
    }
    coauthoringActive = true;
    updateWidgetPosition();
    widgetNode.style.display = 'block';
    toolbarNode.style.display = 'none';
    hostNode.style.display = 'block';
    editor.layoutContentWidget(widget);
    capability.invoke({
      anchorElement: hostNode,
      dismiss: () => {
        coauthoringActive = false;
        showSelectionToolbar();
      },
    });
  };
  const preserveSelection = (event: MouseEvent) => event.preventDefault();

  copyButton.addEventListener('mousedown', preserveSelection);
  coauthorButton.addEventListener('mousedown', preserveSelection);
  copyButton.addEventListener('click', () => {
    const model = editor.getModel();
    const selectedText =
      model && editor.getSelections()
        ? editor
            .getSelections()!
            .filter((selection) => !selection.isEmpty())
            .map((selection) => model.getValueInRange(selection))
            .join('\n')
        : '';
    if (selectedText) {
      void navigator.clipboard.writeText(selectedText).catch(() => undefined);
    }
  });
  coauthorButton.addEventListener('click', startCoauthoring);
  editor.addContentWidget(widget);
  const selectionDisposable = editor.onDidChangeCursorSelection(() => {
    if (!coauthoringActive) {
      showSelectionToolbar();
    }
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyQ, startCoauthoring);

  onRegister(capability);
  return () => {
    capability.clearPreview();
    selectionDisposable.dispose();
    editor.removeContentWidget(widget);
    onRegister(undefined);
  };
}
