import { useCallback, useMemo } from 'react';

import { usePluginComponent } from '@grafana/runtime';

import { type QueryEditorCoauthoringV1Props } from '../../query_coauthoring/v1Compatibility';

import {
  createPrometheusQueryCoauthoringController,
  type QueryCoauthoringRegistration,
} from './QueryCoauthoringWidget';

interface Props {
  enabled: boolean;
  registration: QueryCoauthoringRegistration | undefined;
}

const QUERY_EDITOR_COAUTHORING_V1_COMPONENT_ID = 'grafana/query-editor-coauthoring/v1';

export function QueryCoauthoringExposedComponentBridge({ enabled, registration }: Props) {
  if (!enabled || !registration) {
    return null;
  }

  return <LoadedQueryCoauthoringExposedComponentBridge registration={registration} />;
}

function LoadedQueryCoauthoringExposedComponentBridge({
  registration,
}: {
  registration: QueryCoauthoringRegistration;
}) {
  const { component: CoauthoringComponent } = usePluginComponent<QueryEditorCoauthoringV1Props>(
    QUERY_EDITOR_COAUTHORING_V1_COMPONENT_ID
  );
  const controller = useMemo(() => createPrometheusQueryCoauthoringController(registration), [registration]);
  const createController = useCallback(() => controller, [controller]);

  if (!CoauthoringComponent) {
    return null;
  }

  return <CoauthoringComponent createController={createController} />;
}
