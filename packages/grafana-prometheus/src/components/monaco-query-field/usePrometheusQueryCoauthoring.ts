import { useCallback, useEffect, useState } from 'react';
import { useLatest } from 'react-use';

import { type TimeRange } from '@grafana/data';
import { type Monaco, type MonacoEditor } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import { type QueryEditorCoauthoringRegistrationV1 } from '../../query_coauthoring/internalCoauthoringContract';
import { type PromQuery } from '../../types';
import {
  registerPrometheusQueryCoauthoring,
  type QueryCoauthoringRegistration,
} from './PrometheusQueryCoauthoringAdapter';

interface UsePrometheusQueryCoauthoringOptions {
  createQuery?: (value: string) => PromQuery;
  datasource: PrometheusDatasource;
  externalQuery: string;
  languageProvider: PrometheusLanguageProviderInterface;
  onManualQueryChange(value: string): void;
  portalClassName: string;
  registrar?: QueryEditorCoauthoringRegistrationV1<PromQuery>;
  timeRange: TimeRange;
  widgetId: string;
}

interface MonacoMount {
  editor: MonacoEditor;
  monaco: Monaco;
}

export function usePrometheusQueryCoauthoring({
  createQuery,
  datasource,
  externalQuery,
  languageProvider,
  onManualQueryChange,
  portalClassName,
  registrar,
  timeRange,
  widgetId,
}: UsePrometheusQueryCoauthoringOptions) {
  // Everything the adapter reads goes through a ref: the adapter outlives renders and is torn down only when
  // the Monaco instance changes, so re-creating it on each new callback identity would drop a live invocation.
  const createQueryRef = useLatest(createQuery);
  const datasourceRef = useLatest(datasource);
  const externalQueryRef = useLatest(externalQuery);
  const languageProviderRef = useLatest(languageProvider);
  const onManualQueryChangeRef = useLatest(onManualQueryChange);
  const portalClassNameRef = useLatest(portalClassName);
  const timeRangeRef = useLatest(timeRange);
  const [mount, setMount] = useState<MonacoMount>();
  const [registration, setRegistration] = useState<QueryCoauthoringRegistration<PromQuery>>();
  const available = Boolean(typeof registrar?.register === 'function' && createQuery);

  useEffect(() => {
    const createQueryAtRegistration = createQueryRef.current;
    if (!mount || !available || !createQueryAtRegistration) {
      return;
    }

    const nextRegistration = registerPrometheusQueryCoauthoring({
      editor: mount.editor,
      createQuery: (value) => (createQueryRef.current ?? createQueryAtRegistration)(value),
      getDatasource: () => datasourceRef.current,
      getExternalQuery: () => externalQueryRef.current,
      getLanguageProvider: () => languageProviderRef.current,
      getTimeRange: () => timeRangeRef.current,
      monaco: mount.monaco,
      onManualQueryChange: (value) => onManualQueryChangeRef.current(value),
      styles: { portal: portalClassNameRef.current },
      widgetId,
    });
    setRegistration(nextRegistration);

    return () => {
      setRegistration((current) => (current === nextRegistration ? undefined : current));
      nextRegistration.dispose();
    };
  }, [
    available,
    createQueryRef,
    datasourceRef,
    externalQueryRef,
    languageProviderRef,
    mount,
    onManualQueryChangeRef,
    portalClassNameRef,
    timeRangeRef,
    widgetId,
  ]);

  useEffect(() => {
    registration?.updateStyles({ portal: portalClassName });
  }, [portalClassName, registration]);

  useEffect(() => {
    if (!registration || typeof registrar?.register !== 'function') {
      return;
    }
    return registrar.register(registration.adapter);
  }, [registrar, registration]);

  return useCallback((editor: MonacoEditor, monaco: Monaco) => {
    setMount({ editor, monaco });
  }, []);
}
