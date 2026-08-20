import { useCallback, useEffect, useLayoutEffect } from 'react';

import { usePluginComponent } from '@grafana/runtime';

import {
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

const QUERY_EDITOR_COAUTHORING_V1_COMPONENT_ID = 'grafana/query-editor-coauthoring/v1';

export function QueryCoauthoringExposedComponentBridge({ host, registration }: Props) {
  if (!host || !registration) {
    return null;
  }

  return <LoadedQueryCoauthoringExposedComponentBridge host={host} registration={registration} />;
}

function LoadedQueryCoauthoringExposedComponentBridge({ host, registration }: Required<Props>) {
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

  useLayoutEffect(() => {
    if (!host || !registration || !CoauthoringComponent) {
      return;
    }

    const updateRenderedSize = () => {
      const { height, width } = registration.portalElement.getBoundingClientRect();
      registration.updateRenderedSize({ height, width });
    };
    updateRenderedSize();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const resizeObserver = new ResizeObserver(updateRenderedSize);
    resizeObserver.observe(registration.portalElement);
    return () => resizeObserver.disconnect();
  }, [CoauthoringComponent, host, registration]);

  if (!CoauthoringComponent) {
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
