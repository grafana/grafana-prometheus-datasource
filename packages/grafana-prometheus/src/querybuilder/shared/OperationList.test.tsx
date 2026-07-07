// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/querybuilder/shared/OperationList.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { type DataSourceApi, type DataSourceInstanceSettings } from '@grafana/data';

import { PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import { EmptyLanguageProviderMock } from '../../language_provider.mock';
import { getMockTimeRange } from '../../test/mocks/datasource';
import { type PromOptions } from '../../types';
import { addOperationInQueryBuilder } from '../testUtils';
import { type PromVisualQuery } from '../types';

import { OperationList } from './OperationList';
import { promQueryModeller } from './modeller_instance';

const defaultQuery: PromVisualQuery = {
  metric: 'random_metric',
  labels: [{ label: 'instance', op: '=', value: 'localhost:9090' }],
  operations: [
    {
      id: 'rate',
      params: ['auto'],
    },
    {
      id: '__sum_by',
      params: ['instance', 'job'],
    },
  ],
};

describe('OperationList', () => {
  it('renders operations', async () => {
    setup();
    expect(screen.getByText('Rate')).toBeInTheDocument();
    expect(screen.getByText('Sum by')).toBeInTheDocument();
  });

  it('removes an operation', async () => {
    const { onChange } = setup();
    const removeOperationButtons = screen.getAllByLabelText('Remove operation');
    expect(removeOperationButtons).toHaveLength(2);
    await userEvent.click(removeOperationButtons[1]);
    expect(onChange).toHaveBeenCalledWith({
      labels: [{ label: 'instance', op: '=', value: 'localhost:9090' }],
      metric: 'random_metric',
      operations: [{ id: 'rate', params: ['auto'] }],
    });
  });

  it('associates each param label with its input so screen readers announce it', () => {
    // Regression for https://github.com/grafana/grafana/issues/66347 — the <label>
    // used a useId-derived id while the editors used operation.id, so every param
    // label was an orphan and Prometheus query builder fields had no accessible name.
    setup();
    // Rate has a Range param — the label "Range" must be linked to its combo box input.
    expect(screen.getByLabelText('Range').tagName).toBe('INPUT');
  });

  it('gives each instance of a duplicated operation a distinct input id', () => {
    // Each OperationEditor uses its own useId() value as the param-id prefix,
    // so two `rate` operations don't produce duplicate ids (which would
    // confuse screen readers and collide in the DOM).
    setup({
      metric: 'random_metric',
      labels: [{ label: 'instance', op: '=', value: 'localhost:9090' }],
      operations: [
        { id: 'rate', params: ['auto'] },
        { id: 'rate', params: ['$__rate_interval'] },
      ],
    });
    const rangeInputs = screen.getAllByLabelText('Range');
    expect(rangeInputs).toHaveLength(2);
    expect(rangeInputs[0].id).not.toBe(rangeInputs[1].id);
  });

  it('keeps ids unique across multiple OperationLists rendered on the same page', () => {
    // Multiple Prometheus queries on a single Grafana panel each render their
    // own OperationList; if both contain `rate` at index 0 the param ids must
    // still be distinct, otherwise the second list's <label htmlFor> binds to
    // the first list's input and screen readers announce the wrong field.
    const props = makeProps();
    const query: PromVisualQuery = {
      metric: 'random_metric',
      labels: [{ label: 'instance', op: '=', value: 'localhost:9090' }],
      operations: [{ id: 'rate', params: ['auto'] }],
    };
    render(
      <>
        <OperationList {...props} query={query} />
        <OperationList {...props} query={query} />
      </>
    );
    const rangeInputs = screen.getAllByLabelText('Range');
    expect(rangeInputs).toHaveLength(2);
    expect(new Set(rangeInputs.map((input) => input.id)).size).toBe(2);
  });

  it('adds an operation', async () => {
    const { onChange } = setup();
    await addOperationInQueryBuilder('Aggregations', 'Min');
    expect(onChange).toHaveBeenCalledWith({
      labels: [{ label: 'instance', op: '=', value: 'localhost:9090' }],
      metric: 'random_metric',
      operations: [
        { id: 'rate', params: ['auto'] },
        { id: '__sum_by', params: ['instance', 'job'] },
        { id: 'min', params: [] },
      ],
    });
  });
});

function makeProps() {
  const languageProvider = new EmptyLanguageProviderMock() as unknown as PrometheusLanguageProviderInterface;
  return {
    datasource: new PrometheusDatasource(
      {
        url: '',
        jsonData: {},
        meta: {},
      } as DataSourceInstanceSettings<PromOptions>,
      undefined,
      languageProvider
    ) as DataSourceApi,
    onRunQuery: () => {},
    onChange: jest.fn(),
    queryModeller: promQueryModeller,
    timeRange: getMockTimeRange(),
  };
}

function setup(query: PromVisualQuery = defaultQuery) {
  const props = makeProps();
  render(<OperationList {...props} query={query} />);
  return props;
}
