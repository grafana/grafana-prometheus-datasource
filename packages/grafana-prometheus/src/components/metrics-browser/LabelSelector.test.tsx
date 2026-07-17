import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { type TimeRange } from '@grafana/data';
import { reportInteraction } from '@grafana/runtime';

import { DEFAULT_SERIES_LIMIT, METRIC_LABEL } from '../../constants';
import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import { getMockTimeRange } from '../../test/mocks/datasource';

import { LabelSelector } from './LabelSelector';
import { MetricsBrowserProvider } from './MetricsBrowserContext';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  reportInteraction: jest.fn(),
}));

function createLanguageProvider(): PrometheusLanguageProviderInterface {
  const mockLanguageProvider = {
    retrieveMetricsMetadata: () => ({}),
    queryLabelKeys: jest.fn().mockResolvedValue(['job', 'instance', 'service']),
    queryLabelValues: jest.fn().mockImplementation((_timeRange: TimeRange, label: string) => {
      if (label === METRIC_LABEL) {
        return Promise.resolve(['metric_one']);
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
      <LabelSelector />
    </MetricsBrowserProvider>
  );
}

describe('LabelSelector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports an interaction when a label search is performed', async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByText('job')).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText('Filter expression for label');
    await userEvent.type(searchInput, 'job');

    await waitFor(
      () => {
        expect(reportInteraction).toHaveBeenCalledWith('grafana_prometheus_metrics_browser_label_search_performed', {
          searchQuery: 'job',
          resultsCount: 1,
        });
      },
      { timeout: 2000 }
    );
  });
});
