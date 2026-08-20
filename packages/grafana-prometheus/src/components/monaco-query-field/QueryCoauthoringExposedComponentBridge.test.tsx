import { render, screen } from '@testing-library/react';

import { usePluginComponent } from '@grafana/runtime';

import { QueryCoauthoringExposedComponentBridge } from './QueryCoauthoringExposedComponentBridge';
import { type QueryCoauthoringRegistration } from './QueryCoauthoringWidget';

jest.mock('@grafana/runtime', () => ({
  usePluginComponent: jest.fn(),
}));

const mockedUsePluginComponent = jest.mocked(usePluginComponent);
const QUERY_EDITOR_COAUTHORING_V1_COMPONENT_ID = 'grafana/query-editor-coauthoring/v1';

function registration(): QueryCoauthoringRegistration {
  return {
    capability: {} as QueryCoauthoringRegistration['capability'],
    dismiss: jest.fn(),
    dispose: jest.fn(),
    getSelectedText: () => '',
    getSnapshot: () => ({ mode: 'hidden' }),
    invoke: jest.fn(),
    portalElement: document.createElement('div'),
    subscribe: () => jest.fn(),
    updateStyles: jest.fn(),
    updateRenderedSize: jest.fn(),
  };
}

describe('QueryCoauthoringExposedComponentBridge', () => {
  beforeEach(() => {
    mockedUsePluginComponent.mockReset();
  });

  it('uses the literal public ID and lets the controller factory survive a writable props proxy', () => {
    function ExposedComponent(props: { createController: () => { getPortalTarget(): HTMLElement } }) {
      const writableProps = new Proxy(props, { set: () => true });
      return <div>{writableProps.createController().getPortalTarget().tagName}</div>;
    }
    mockedUsePluginComponent.mockReturnValue({ component: ExposedComponent, isLoading: false });

    render(<QueryCoauthoringExposedComponentBridge enabled registration={registration()} />);

    expect(mockedUsePluginComponent).toHaveBeenCalledWith(QUERY_EDITOR_COAUTHORING_V1_COMPONENT_ID);
    expect(screen.getByText('DIV')).toBeVisible();
  });

  it('renders no coauthoring surface when the exposed component is unavailable', () => {
    mockedUsePluginComponent.mockReturnValue({ component: undefined, isLoading: false });

    const view = render(<QueryCoauthoringExposedComponentBridge enabled registration={registration()} />);

    expect(view.container).toBeEmptyDOMElement();
  });

  it('does not load the exposed component when coauthoring is disabled', () => {
    render(<QueryCoauthoringExposedComponentBridge enabled={false} registration={registration()} />);

    expect(mockedUsePluginComponent).not.toHaveBeenCalled();
  });
});
