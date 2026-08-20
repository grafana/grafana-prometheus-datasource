import { useCallback, useEffect } from 'react';

import { usePluginComponent } from '@grafana/runtime';

import {
  QUERY_EDITOR_COAUTHORING_V1_COMPONENT_ID,
  type QueryEditorCoauthoringHostDescriptorV1,
  type QueryEditorCoauthoringV1Props,
} from '../../query_coauthoring/v1Compatibility';

import {
  createPrometheusQueryCoauthoringController,
  type QueryCoauthoringRegistration,
} from './QueryCoauthoringWidget';

interface Props {
  host: QueryEditorCoauthoringHostDescriptorV1 | undefined;
  registration: QueryCoauthoringRegistration | undefined;
}

export function QueryCoauthoringExposedComponentBridge({ host, registration }: Props) {
  const { component: CoauthoringComponent, isLoading } = usePluginComponent<QueryEditorCoauthoringV1Props>(
    QUERY_EDITOR_COAUTHORING_V1_COMPONENT_ID
  );
  const createController = useCallback(() => {
    if (!registration || !host) {
      throw new Error('The query coauthoring controller is not ready.');
    }
    return createPrometheusQueryCoauthoringController(registration, host.queryKey);
  }, [host?.queryKey, registration]);

  useEffect(() => {
    if (host && !isLoading && !CoauthoringComponent) {
      host.onSurfaceStateChange({ generation: host.generation, state: 'unavailable' });
    }
  }, [CoauthoringComponent, host, isLoading]);

  if (!host || !registration || !CoauthoringComponent) {
    return null;
  }

  return (
    <CoauthoringComponent
      surfaceGeneration={host.generation}
      createController={createController}
      onSurfaceStateChange={host.onSurfaceStateChange}
    />
  );
}
