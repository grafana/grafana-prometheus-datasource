import { act, renderHook } from '@testing-library/react';

import { type TimeRange } from '@grafana/data';
import { type Monaco, type MonacoEditor } from '@grafana/ui';

import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import {
  type QueryEditorCoauthoringAdapterV1,
  type QueryEditorCoauthoringRegistrationV1,
} from '../../query_coauthoring/internalCoauthoringContract';
import { type PromQuery } from '../../types';
import { registerPrometheusQueryCoauthoring } from './PrometheusQueryCoauthoringAdapter';
import { usePrometheusQueryCoauthoring } from './usePrometheusQueryCoauthoring';

jest.mock('./PrometheusQueryCoauthoringAdapter', () => ({
  registerPrometheusQueryCoauthoring: jest.fn(),
}));

function createOptions(
  registrar: QueryEditorCoauthoringRegistrationV1<PromQuery> | undefined,
  createQuery: ((value: string) => PromQuery) | undefined,
  portalClassName = 'portal'
) {
  return {
    createQuery,
    datasource: { interpolateString: (value: string) => value } as unknown as PrometheusDatasource,
    externalQuery: 'up',
    languageProvider: {
      queryLabelKeys: jest.fn(async () => []),
      queryLabelValues: jest.fn(async () => []),
      queryMetricsMetadata: jest.fn(async () => ({})),
      retrieveMetricsMetadata: jest.fn(() => ({ existing_metric: { type: 'gauge' } })),
    } as unknown as PrometheusLanguageProviderInterface,
    onManualQueryChange: jest.fn(),
    portalClassName,
    registrar,
    timeRange: {} as TimeRange,
    widgetId: 'prometheus-query-coauthoring-A',
  };
}

function createRegistration() {
  return {
    adapter: {
      dismiss: jest.fn(),
      getSnapshot: jest.fn(() => ({ mode: 'hidden' as const })),
      invoke: jest.fn(),
      prepareProposal: jest.fn(),
      readInvocation: jest.fn(),
      subscribe: jest.fn(() => jest.fn()),
    } satisfies QueryEditorCoauthoringAdapterV1<PromQuery>,
    dispose: jest.fn(),
    updateStyles: jest.fn(),
  };
}

describe('usePrometheusQueryCoauthoring', () => {
  beforeEach(() => {
    jest.mocked(registerPrometheusQueryCoauthoring).mockReset();
  });

  it('ignores a drifted private registrar without a register function', () => {
    // @ts-expect-error Simulate mismatched Core and datasource contract copies at runtime.
    const driftedRegistrar: QueryEditorCoauthoringRegistrationV1<PromQuery> = {};
    const options = createOptions(driftedRegistrar, (value) => ({ expr: value, refId: 'A' }));
    const { result } = renderHook(() => usePrometheusQueryCoauthoring(options));

    act(() => result.current({} as MonacoEditor, {} as Monaco));

    expect(registerPrometheusQueryCoauthoring).not.toHaveBeenCalled();
  });

  it('fails closed when a drifted registrar throws or returns an invalid cleanup', () => {
    const registrations = [createRegistration(), createRegistration()];
    jest.mocked(registerPrometheusQueryCoauthoring).mockImplementation(() => {
      const registration = registrations.shift();
      if (!registration) {
        throw new Error('Unexpected coauthoring registration');
      }
      return registration;
    });
    const createQuery = (value: string): PromQuery => ({ expr: value, refId: 'A' });
    const throwingRegistrar = {
      register: jest.fn(() => {
        throw new Error('Drifted registrar');
      }),
    };
    let options = createOptions(throwingRegistrar, createQuery);
    const { result, rerender, unmount } = renderHook(() => usePrometheusQueryCoauthoring(options));

    expect(() => act(() => result.current({} as MonacoEditor, {} as Monaco))).not.toThrow();
    expect(throwingRegistrar.register).toHaveBeenCalledTimes(1);

    const invalidRegister = jest.fn(() => 'not-a-cleanup');
    const invalidCleanupRegistrar = {
      register: invalidRegister,
    } as unknown as QueryEditorCoauthoringRegistrationV1<PromQuery>;
    options = createOptions(invalidCleanupRegistrar, createQuery);
    expect(() => rerender()).not.toThrow();
    expect(invalidRegister).toHaveBeenCalledTimes(1);
    expect(() => unmount()).not.toThrow();
  });

  it('owns adapter registration, current inputs, style updates, and cleanup', () => {
    const registrations = [createRegistration(), createRegistration()];
    jest.mocked(registerPrometheusQueryCoauthoring).mockImplementation(() => {
      const registration = registrations.shift();
      if (!registration) {
        throw new Error('Unexpected coauthoring registration');
      }
      return registration;
    });
    const unregister = jest.fn();
    const registrar = { register: jest.fn(() => unregister) };
    const firstCreateQuery = (value: string): PromQuery => ({ expr: value, refId: 'A' });
    const secondCreateQuery = (value: string): PromQuery => ({ expr: value, refId: 'B' });
    let options = createOptions(undefined, firstCreateQuery);
    const { result, rerender, unmount } = renderHook(() => usePrometheusQueryCoauthoring(options));
    const editor = {} as MonacoEditor;
    const monaco = {} as Monaco;

    act(() => result.current(editor, monaco));
    expect(registerPrometheusQueryCoauthoring).not.toHaveBeenCalled();

    options = createOptions(registrar, firstCreateQuery);
    rerender();
    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(1);
    const firstRegistration = jest.mocked(registerPrometheusQueryCoauthoring).mock.results[0].value;
    expect(registrar.register).toHaveBeenCalledWith(firstRegistration.adapter);
    const initialAdapterOptions = jest.mocked(registerPrometheusQueryCoauthoring).mock.calls[0][0];

    const nextOptions = createOptions(registrar, secondCreateQuery);
    nextOptions.externalQuery = 'rate(up[5m])';
    options = nextOptions;
    rerender();
    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(1);
    expect(initialAdapterOptions.createQuery('next')).toEqual({ expr: 'next', refId: 'B' });
    expect(initialAdapterOptions.getDatasource()).toBe(nextOptions.datasource);
    expect(initialAdapterOptions.getExternalQuery()).toBe('rate(up[5m])');
    expect(initialAdapterOptions.getLanguageProvider()).toBe(nextOptions.languageProvider);
    expect(initialAdapterOptions.getTimeRange()).toBe(nextOptions.timeRange);
    initialAdapterOptions.onManualQueryChange('manual change');
    expect(nextOptions.onManualQueryChange).toHaveBeenCalledWith('manual change');

    options = createOptions(registrar, secondCreateQuery, 'next-portal');
    rerender();
    expect(firstRegistration.updateStyles).toHaveBeenLastCalledWith({ portal: 'next-portal' });
    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(1);

    options = createOptions(undefined, secondCreateQuery, 'next-portal');
    rerender();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(firstRegistration.dispose).toHaveBeenCalledTimes(1);

    options = createOptions(registrar, secondCreateQuery, 'next-portal');
    rerender();
    expect(registerPrometheusQueryCoauthoring).toHaveBeenCalledTimes(2);
    const secondRegistration = jest.mocked(registerPrometheusQueryCoauthoring).mock.results[1].value;

    unmount();
    expect(secondRegistration.dispose).toHaveBeenCalledTimes(1);
  });
});
