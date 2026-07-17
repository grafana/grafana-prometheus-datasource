import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { type TimeRange } from '@grafana/data';
import { reportInteraction } from '@grafana/runtime';

import { DEFAULT_SERIES_LIMIT, METRIC_LABEL } from '../../constants';
import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import { getMockTimeRange } from '../../test/mocks/datasource';

import { MetricSelector } from './MetricSelector';
import { MetricsBrowserProvider } from './MetricsBrowserContext';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  reportInteraction: jest.fn(),
}));

function createLanguageProvider(): PrometheusLanguageProviderInterface {
  const mockLanguageProvider = {
    retrieveMetricsMetadata: () => ({}),
    queryLabelKeys: jest.fn().mockResolvedValue([]),
    queryLabelValues: jest.fn().mockImplementation((_timeRange: TimeRange, label: string) => {
      if (label === METRIC_LABEL) {
        return Promise.resolve(['metric_one', 'metric_two', 'metric_three']);
      }
      return Promise.resolve([]);
    }),
  } as unknown as PrometheusLanguageProviderInterface;
  mockLanguageProvider.datasource = { seriesLimit: DEFAULT_SERIES_LIMIT } as unknown as PrometheusDatasource;
  return mockLanguageProvider;
}

function setup() {
  render(
    <MetricsBrowserProvider timeRange={getMockTimeRange()} languageProvider={createLanguageProvider()} onChange={jest.fn()}>
      <MetricSelector />
    </MetricsBrowserProvider>
  );
}

describe('MetricSelector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports an interaction when a metric search is performed', async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByText('metric_one')).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText('Filter expression for metric');
    await userEvent.type(searchInput, 'metric_o');

    await waitFor(
      () => {
        expect(reportInteraction).toHaveBeenCalledWith('grafana_prometheus_metrics_browser_metric_search_performed', {
          searchQuery: 'metric_o',
          resultsCount: 1,
        });
      },
      { timeout: 2000 }
    );
  });

  it('does not report an interaction for an empty search', async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByText('metric_one')).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText('Filter expression for metric');
    await userEvent.type(searchInput, 'x');
    await userEvent.clear(searchInput);

    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(reportInteraction).not.toHaveBeenCalledWith(
      'grafana_prometheus_metrics_browser_metric_search_performed',
      expect.objectContaining({ searchQuery: '' })
    );
  });
});
