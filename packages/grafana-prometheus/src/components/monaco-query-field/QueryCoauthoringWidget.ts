import { type DataQuery, type TimeRange } from '@grafana/data';
import { type Monaco, type MonacoEditor } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { escapeLabelValueInExactSelector } from '../../escaping';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import {
  createPrometheusCoauthoringCapability,
  type PrometheusCoauthoringCapability,
  QUERY_COAUTHORING_MAX_CONTEXT_LABELS,
} from '../../query_coauthoring/capability';
import {
  type QueryEditorCoauthoringContextV1,
  type QueryEditorCoauthoringControllerV1,
  type QueryEditorCoauthoringSnapshotV1,
} from '../../query_coauthoring/v1Compatibility';
import { createMonacoQueryCoauthoringHost, type MonacoQueryCoauthoringHost } from './MonacoQueryCoauthoringHost';
import { placeHolderScopedVars } from './monaco-completion-provider/validation';

interface QueryCoauthoringStyles {
  portal: string;
  previewChange: string;
  previewOriginal: string;
}

export interface QueryCoauthoringRegistration<TQuery extends DataQuery = DataQuery> extends MonacoQueryCoauthoringHost {
  capability: PrometheusCoauthoringCapability<TQuery>;
  updateStyles: (styles: QueryCoauthoringStyles) => void;
}

interface RegisterPrometheusQueryCoauthoringOptions<TQuery extends DataQuery> {
  createQuery: (value: string) => TQuery;
  editor: MonacoEditor;
  getDatasource: () => PrometheusDatasource;
  getLanguageProvider: () => PrometheusLanguageProviderInterface;
  getTimeRange: () => TimeRange;
  monaco: Monaco;
  styles: QueryCoauthoringStyles;
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
  styles,
  widgetId,
}: RegisterPrometheusQueryCoauthoringOptions<TQuery>): QueryCoauthoringRegistration<TQuery> {
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

  const host = createMonacoQueryCoauthoringHost({
    clearEditorDiff: () => capability.clearPreview(),
    editor,
    monaco,
    portalClassName: currentStyles.portal,
    widgetId,
  });

  return {
    ...host,
    capability,
    updateStyles: (nextStyles) => {
      host.portalElement.classList.remove(currentStyles.portal);
      Object.assign(currentStyles, nextStyles);
      host.portalElement.classList.add(currentStyles.portal);
    },
  };
}

export function createPrometheusQueryCoauthoringController<TQuery extends DataQuery>(
  registration: QueryCoauthoringRegistration<TQuery>
): QueryEditorCoauthoringControllerV1<TQuery> {
  let context: QueryEditorCoauthoringContextV1 | undefined;
  let revision = 0;
  let contextEpoch = 0;
  let sessionEpoch = 0;
  let sessionActive = false;
  let pendingContext: Promise<QueryEditorCoauthoringContextV1> | undefined;
  const listeners = new Set<VoidFunction>();
  let unsubscribeRegistration: VoidFunction | undefined;
  const nextContext = async (
    refresh: boolean,
    activeSessionEpoch: number
  ): Promise<QueryEditorCoauthoringContextV1> => {
    const captureEpoch = contextEpoch;
    const captured = await (refresh ? registration.capability.refreshContext() : registration.capability.getContext());
    if (!sessionActive || activeSessionEpoch !== sessionEpoch) {
      throw new Error('The query coauthoring session was dismissed.');
    }
    if (captureEpoch !== contextEpoch) {
      return nextContext(true, activeSessionEpoch);
    }
    revision++;
    context = {
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
    if (unsubscribeRegistration) {
      return;
    }
    currentSnapshot = snapshot();
    unsubscribeRegistration = registration.subscribe(() => {
      if (sessionActive && (context || pendingContext)) {
        context = undefined;
        contextEpoch++;
        revision++;
      }
      publish();
    });
  };

  return {
    getSnapshot: () => currentSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      ensureRegistrationSubscription();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeRegistration?.();
          unsubscribeRegistration = undefined;
        }
      };
    },
    getPortalTarget: () => registration.portalElement,
    reportSurfaceSize: registration.updateRenderedSize,
    begin: () => {
      if (context) {
        return Promise.resolve(context);
      }
      if (!pendingContext) {
        sessionActive = true;
        const activeSessionEpoch = ++sessionEpoch;
        registration.invoke();
        registration.capability.captureContext();
        const contextRequest = nextContext(false, activeSessionEpoch)
          .then((next) => {
            publish();
            return next;
          })
          .finally(() => {
            if (pendingContext === contextRequest) {
              pendingContext = undefined;
            }
          });
        pendingContext = contextRequest;
      }
      return pendingContext;
    },
    refreshContext: async () => {
      const next = await nextContext(true, sessionEpoch);
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
        query: registration.capability.createQuery(source),
        changes: preview.changes,
      };
    },
    clearEditorDiff: () => {
      registration.capability.clearPreview();
      publish();
    },
    getQueryText: registration.capability.getValue,
    focus: registration.capability.focus,
    dismiss: () => {
      sessionActive = false;
      sessionEpoch++;
      context = undefined;
      contextEpoch++;
      pendingContext = undefined;
      registration.dismiss();
      publish();
    },
  };
}
