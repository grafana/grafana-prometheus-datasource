import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import '@testing-library/jest-dom';

import { type DataSourceInstanceSettings } from '@grafana/data';
import { reportInteraction } from '@grafana/runtime';

import { DEFAULT_COMPLETION_LIMIT } from '../../constants';
import { PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import { EmptyLanguageProviderMock } from '../../language_provider.mock';
import { getMockTimeRange } from '../../test/mocks/datasource';
import { type PromOptions } from '../../types';

import { MetricCombobox, type MetricComboboxProps } from './MetricCombobox';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  reportInteraction: jest.fn(),
}));

describe('MetricCombobox', () => {
  beforeAll(() => {
    const mockGetBoundingClientRect = jest.fn(() => ({
      width: 120,
      height: 120,
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
    }));

    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      value: mockGetBoundingClientRect,
    });
  });

  const instanceSettings = {
    url: 'proxied',
    user: 'test',
    password: 'mupp',
    jsonData: { httpMethod: 'GET' },
  } as unknown as DataSourceInstanceSettings<PromOptions>;

  const mockLanguageProvider = new EmptyLanguageProviderMock() as unknown as PrometheusLanguageProviderInterface;
  const mockDatasource = new PrometheusDatasource(instanceSettings, undefined, mockLanguageProvider);

  // Options returned when user first opens the combobox - returned by onGetMetrics
  const initialMockValues = [{ label: 'top_metric_one' }, { label: 'top_metric_two' }, { label: 'top_metric_three' }];
  const mockOnGetMetrics = jest.fn(() => Promise.resolve(initialMockValues.map((v) => ({ value: v.label }))));

  const mockOnChange = jest.fn();

  const defaultProps: MetricComboboxProps = {
    metricLookupDisabled: false,
    query: {
      metric: '',
      labels: [],
      operations: [],
    },
    onChange: mockOnChange,
    onGetMetrics: mockOnGetMetrics,
    datasource: mockDatasource,
    labelsFilters: [],
    variableEditor: false,
    timeRange: getMockTimeRange(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (mockLanguageProvider.hasSearchSupport as jest.Mock).mockReturnValue(false);
    (mockLanguageProvider.getSearchApiClient as jest.Mock).mockReturnValue(undefined);
  });

  it('renders correctly', () => {
    render(<MetricCombobox {...defaultProps} />);
    expect(screen.getByPlaceholderText('Select metric')).toBeInTheDocument();
  });

  it('fetches top metrics when the combobox is opened ', async () => {
    render(<MetricCombobox {...defaultProps} />);

    const combobox = screen.getByPlaceholderText('Select metric');
    await userEvent.click(combobox);

    const item = await screen.findByRole('option', { name: 'top_metric_one' });
    expect(item).toBeInTheDocument();

    // This should be asserted by the above check, but double check anyway
    expect(mockOnGetMetrics).toHaveBeenCalledTimes(1);
  });

  it('fetches metrics for the users query', async () => {
    // Mock the queryLabelValues to return the expected metric
    mockDatasource.languageProvider.queryLabelValues = jest.fn().mockResolvedValue(['unique_metric']);

    render(<MetricCombobox {...defaultProps} />);

    const combobox = screen.getByPlaceholderText('Select metric');
    await userEvent.click(combobox);
    await userEvent.type(combobox, 'unique');

    const item = await screen.findByRole('option', { name: 'unique_metric' });
    expect(item).toBeInTheDocument();

    // This should be asserted by the above check, but double check anyway
    // This is the actual argument, created by formatKeyValueStrings()
    expect(mockDatasource.languageProvider.queryLabelValues).toHaveBeenCalledWith(
      expect.anything(),
      '__name__',
      '{__name__=~".*unique.*"}'
    );
  });

  it('uses fuzzy metric search when the search API is enabled', async () => {
    const searchMetricNames = jest.fn().mockResolvedValue({
      results: [{ name: 'http_requests_total' }],
      warnings: [],
      hasMore: false,
    });
    (mockLanguageProvider.hasSearchSupport as jest.Mock).mockReturnValue(true);
    (mockLanguageProvider.getSearchApiClient as jest.Mock).mockReturnValue({ searchMetricNames });

    render(<MetricCombobox {...defaultProps} />);

    const combobox = screen.getByPlaceholderText('Select metric');
    await userEvent.click(combobox);
    await userEvent.type(combobox, 'http req');

    expect(await screen.findByRole('option', { name: 'http_requests_total' })).toBeInTheDocument();
    expect(searchMetricNames).toHaveBeenCalledWith(
      defaultProps.timeRange,
      'http req',
      expect.objectContaining({
        limit: DEFAULT_COMPLETION_LIMIT,
        signal: expect.anything(),
      })
    );
    expect(mockDatasource.languageProvider.queryLabelValues).not.toHaveBeenCalled();
  });

  it('calls onChange with the correct value when a metric is selected', async () => {
    render(<MetricCombobox {...defaultProps} />);

    const combobox = screen.getByPlaceholderText('Select metric');
    await userEvent.click(combobox);

    const item = await screen.findByRole('option', { name: 'top_metric_two' });
    await userEvent.click(item);

    expect(mockOnChange).toHaveBeenCalledWith({ metric: 'top_metric_two', labels: [], operations: [] });
  });

  it('shows the metrics explorer button by default', () => {
    render(<MetricCombobox {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /open metrics explorer/i })).toBeInTheDocument();
  });

  it('displays the default metric value from query prop', () => {
    // Render with a query that has a default metric value
    render(
      <MetricCombobox
        {...defaultProps}
        query={{
          metric: 'default_metric_value',
          labels: [],
          operations: [],
        }}
      />
    );

    // The Combobox should display the default metric value
    const combobox = screen.getByPlaceholderText('Select metric');
    expect(combobox).toHaveValue('default_metric_value');
  });

  it('opens the metrics explorer when the button is clicked', async () => {
    render(<MetricCombobox {...defaultProps} onGetMetrics={() => Promise.resolve([])} />);

    const button = screen.getByRole('button', { name: /open metrics explorer/i });
    await userEvent.click(button);

    expect(screen.getByText('Metrics explorer')).toBeInTheDocument();
  });

  it('reports an interaction when the metrics explorer is opened', async () => {
    render(<MetricCombobox {...defaultProps} onGetMetrics={() => Promise.resolve([])} />);

    const button = screen.getByRole('button', { name: /open metrics explorer/i });
    await userEvent.click(button);

    expect(reportInteraction).toHaveBeenCalledWith('grafana_prometheus_metrics_explorer_opened', {
      hasSelectedMetric: false,
    });
  });

  it('does not open the explorer or report an interaction when metrics lookups are disabled', async () => {
    const lookupsDisabledDatasource = new PrometheusDatasource(
      {
        ...instanceSettings,
        jsonData: { ...instanceSettings.jsonData, disableMetricsLookup: true },
      } as unknown as DataSourceInstanceSettings<PromOptions>,
      undefined,
      mockLanguageProvider
    );

    render(
      <MetricCombobox
        {...defaultProps}
        datasource={lookupsDisabledDatasource}
        onGetMetrics={() => Promise.resolve([])}
      />
    );

    // the button has a tooltip, so @grafana/ui's Button renders aria-disabled (not the native
    // disabled attribute) to keep the tooltip interactive - but its onClick is still a no-op
    const button = screen.getByRole('button', { name: /open metrics explorer/i });
    expect(button).toHaveAttribute('aria-disabled', 'true');

    await userEvent.click(button);

    expect(screen.queryByText('Metrics explorer')).not.toBeInTheDocument();
    expect(reportInteraction).not.toHaveBeenCalledWith(
      'grafana_prometheus_metrics_explorer_opened',
      expect.anything()
    );
  });
});
