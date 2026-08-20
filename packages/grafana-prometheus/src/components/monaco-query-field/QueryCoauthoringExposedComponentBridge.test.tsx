import { render, screen } from '@testing-library/react';

import { usePluginComponent } from '@grafana/runtime';

import { QUERY_EDITOR_COAUTHORING_V1_COMPONENT_ID } from '../../query_coauthoring/v1Compatibility';
import { QueryCoauthoringExposedComponentBridge } from './QueryCoauthoringExposedComponentBridge';
import { type QueryCoauthoringRegistration } from './QueryCoauthoringWidget';

jest.mock('@grafana/runtime', () => ({
  usePluginComponent: jest.fn(),
}));

const mockedUsePluginComponent = jest.mocked(usePluginComponent);

function registration(): QueryCoauthoringRegistration {
  return {
    capability: {} as QueryCoauthoringRegistration['capability'],
    dismiss: jest.fn(),
    dispose: jest.fn(),
    getSelectedText: () => '',
    getSnapshot: () => ({ mode: 'hidden' }),
    invoke: jest.fn(),
    mountAssistant: jest.fn(),
    portalElement: document.createElement('div'),
    subscribe: () => jest.fn(),
    updatePreviewStyles: jest.fn(),
    updateRenderedSize: jest.fn(),
  };
}

describe('QueryCoauthoringExposedComponentBridge', () => {
  const host = {
    componentId: QUERY_EDITOR_COAUTHORING_V1_COMPONENT_ID,
    generation: 'generation-1',
    queryKey: 'prometheus:A',
    surfaceState: 'pending' as const,
    onSurfaceStateChange: jest.fn(),
  };

  beforeEach(() => {
    host.onSurfaceStateChange.mockClear();
  });

  it('uses the literal public ID and lets the controller factory survive a writable props proxy', () => {
    function ExposedComponent(props: {
      createController: () => { getPortalTarget(): HTMLElement };
      surfaceGeneration: string;
    }) {
      const writableProps = new Proxy(props, { set: () => true });
      const controller = writableProps.createController();
      return <div>{`${props.surfaceGeneration}:${controller.getPortalTarget().tagName}`}</div>;
    }
    mockedUsePluginComponent.mockReturnValue({ component: ExposedComponent, isLoading: false });

    render(<QueryCoauthoringExposedComponentBridge host={host} registration={registration()} />);

    expect(mockedUsePluginComponent).toHaveBeenCalledWith(QUERY_EDITOR_COAUTHORING_V1_COMPONENT_ID);
    expect(screen.getByText('generation-1:DIV')).toBeVisible();
  });

  it('keeps the legacy surface eligible when the exposed component is unavailable', () => {
    mockedUsePluginComponent.mockReturnValue({ component: undefined, isLoading: false });

    render(<QueryCoauthoringExposedComponentBridge host={host} registration={registration()} />);

    expect(host.onSurfaceStateChange).toHaveBeenCalledWith({ generation: 'generation-1', state: 'unavailable' });
  });
});
