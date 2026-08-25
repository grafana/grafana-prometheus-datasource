import { type TimeRange } from '@grafana/data';
import { type DataQuery } from '@grafana/schema';
import { type Monaco, type MonacoEditor } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { escapeLabelValueInExactSelector } from '../../escaping';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import {
  createPrometheusCoauthoringIntelligence,
  type PrometheusCoauthoringCapturedInvocation,
  QUERY_COAUTHORING_MAX_CONTEXT_LABELS,
} from '../../query_coauthoring/intelligence';
import {
  type QueryEditorCoauthoringAdapterV1,
  type QueryEditorCoauthoringInvocationV1,
  type QueryEditorCoauthoringSnapshotV1,
} from '../../query_coauthoring/internalCoauthoringContract';
import { createMonacoQueryCoauthoringHost } from './MonacoQueryCoauthoringHost';
import { placeHolderScopedVars } from './monaco-completion-provider/validation';

interface QueryCoauthoringStyles {
  portal: string;
}

interface ActiveInvocation<TQuery extends DataQuery> {
  captured: PrometheusCoauthoringCapturedInvocation<TQuery>;
  id: string;
  result?: Promise<QueryEditorCoauthoringInvocationV1<TQuery>>;
}

export interface QueryCoauthoringRegistration<TQuery extends DataQuery = DataQuery> {
  adapter: QueryEditorCoauthoringAdapterV1<TQuery>;
  dispose(): void;
  updateStyles(styles: QueryCoauthoringStyles): void;
}

interface RegisterPrometheusQueryCoauthoringOptions<TQuery extends DataQuery> {
  createQuery(value: string): TQuery;
  editor: MonacoEditor;
  getDatasource(): PrometheusDatasource;
  getExternalQuery(): string;
  getLanguageProvider(): PrometheusLanguageProviderInterface;
  getTimeRange(): TimeRange;
  monaco: Monaco;
  onManualQueryChange(value: string): void;
  styles: QueryCoauthoringStyles;
  widgetId: string;
}

export function registerPrometheusQueryCoauthoring<TQuery extends DataQuery>({
  createQuery,
  editor,
  getDatasource,
  getExternalQuery,
  getLanguageProvider,
  getTimeRange,
  monaco,
  onManualQueryChange,
  styles,
  widgetId,
}: RegisterPrometheusQueryCoauthoringOptions<TQuery>): QueryCoauthoringRegistration<TQuery> {
  const intelligence = createPrometheusCoauthoringIntelligence({
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
  });
  const listeners = new Set<VoidFunction>();
  let activeInvocation: ActiveInvocation<TQuery> | undefined;
  let invocationSequence = 0;
  let currentSnapshot: QueryEditorCoauthoringSnapshotV1 = { mode: 'hidden' };
  let host: ReturnType<typeof createMonacoQueryCoauthoringHost> | undefined;

  const snapshotFromHost = (): QueryEditorCoauthoringSnapshotV1 => {
    const currentHost = host;
    const hostSnapshot = currentHost?.getSnapshot();
    if (!currentHost || !hostSnapshot || hostSnapshot.mode === 'hidden') {
      return { mode: 'hidden' };
    }
    if (hostSnapshot.mode === 'selection') {
      return { mode: 'selection', portalTarget: currentHost.portalTarget };
    }
    return activeInvocation
      ? { mode: 'invoked', invocationId: activeInvocation.id, portalTarget: currentHost.portalTarget }
      : { mode: 'hidden' };
  };
  const snapshotsEqual = (
    first: QueryEditorCoauthoringSnapshotV1,
    second: QueryEditorCoauthoringSnapshotV1
  ): boolean => {
    if (first.mode !== second.mode) {
      return false;
    }
    if (first.mode === 'hidden' || second.mode === 'hidden') {
      return true;
    }
    if (first.portalTarget !== second.portalTarget) {
      return false;
    }
    return first.mode !== 'invoked' || second.mode !== 'invoked' || first.invocationId === second.invocationId;
  };
  const publish = () => {
    const nextSnapshot = snapshotFromHost();
    if (snapshotsEqual(currentSnapshot, nextSnapshot)) {
      return;
    }
    currentSnapshot = nextSnapshot;
    listeners.forEach((listener) => listener());
  };
  const invoke = () => {
    if (activeInvocation || !host || editor.getValue().trim().length === 0) {
      return;
    }
    const id = `${widgetId}:${++invocationSequence}`;
    activeInvocation = {
      captured: intelligence.captureInvocation(id),
      id,
    };
    host.showInvocation();
    publish();
  };
  const handleContentChange = (value: string) => {
    // Core renders a proposal by pushing it through the ordinary query props, so Monaco content changes arrive
    // for both proposals and manual typing. Matching the current query prop is what tells the two apart:
    // anything else is the user editing by hand, which ends the invocation and takes the normal onChange path.
    if (!activeInvocation || value === getExternalQuery()) {
      return;
    }
    activeInvocation = undefined;
    onManualQueryChange(value);
    host?.hide();
    publish();
  };

  host = createMonacoQueryCoauthoringHost({
    editor,
    monaco,
    onContentChange: handleContentChange,
    onInvoke: invoke,
    portalClassName: styles.portal,
    widgetId,
  });
  currentSnapshot = snapshotFromHost();
  const unsubscribeHost = host.subscribe(publish);

  const adapter: QueryEditorCoauthoringAdapterV1<TQuery> = {
    dismiss: () => {
      activeInvocation = undefined;
      host?.dismiss();
      publish();
    },
    getSnapshot: () => currentSnapshot,
    invoke,
    prepareProposal: (invocationId, source) => {
      if (!activeInvocation || activeInvocation.id !== invocationId) {
        return { status: 'rejected', reason: 'stale' };
      }
      return intelligence.prepareProposal(activeInvocation.captured, source);
    },
    readInvocation: (invocationId) => {
      const invocation = activeInvocation;
      if (!invocation || invocation.id !== invocationId) {
        return Promise.reject(new Error('The query coauthoring invocation is no longer active.'));
      }
      if (!invocation.result) {
        invocation.result = intelligence.readInvocation(invocation.captured).then((result) => {
          if (activeInvocation !== invocation) {
            throw new Error('The query coauthoring invocation is no longer active.');
          }
          return result;
        });
      }
      return invocation.result;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    adapter,
    dispose: () => {
      activeInvocation = undefined;
      unsubscribeHost();
      host?.dispose();
      host = undefined;
      listeners.clear();
    },
    updateStyles: (nextStyles) => host?.updatePortalClass(nextStyles.portal),
  };
}
