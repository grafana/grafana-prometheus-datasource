import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { type TimeRange } from '@grafana/data';
import { reportInteraction } from '@grafana/runtime';

import { DEFAULT_SERIES_LIMIT, LAST_USED_LABELS_KEY, METRIC_LABEL } from '../../constants';
import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import { getMockTimeRange } from '../../test/mocks/datasource';

import { MetricsBrowserProvider } from './MetricsBrowserContext';
import { ValueSelector } from './ValueSelector';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  reportInteraction: jest.fn(),
}));

function createLanguageProvider(): PrometheusLanguageProviderInterface {
  const mockLanguageProvider = {
    retrieveMetricsMetadata: () => ({}),
    queryLabelKeys: jest.fn().mockResolvedValue(['job']),
    queryLabelValues: jest.fn().mockImplementation((_timeRange: TimeRange, label: string) => {
      if (label === METRIC_LABEL) {
        return Promise.resolve(['metric_one']);
      }
      if (label === 'job') {
        return Promise.resolve(['grafana', 'prometheus']);
      }
      return Promise.resolve([]);
    }),
  } as unknown as PrometheusLanguageProviderInterface;
  mockLanguageProvider.datasource = { seriesLimit: DEFAULT_SERIES_LIMIT } as unknown as PrometheusDatasource;
  return mockLanguageProvider;
}

function setup() {
  // pre-select the "job" label key so its values are loaded on init, without needing to drive LabelSelector
  localStorage.setItem(LAST_USED_LABELS_KEY, JSON.stringify(['job']));

  render(
    <MetricsBrowserProvider timeRange={getMockTimeRange()} languageProvider={createLanguageProvider()} onChange={jest.fn()}>
      <ValueSelector />
    </MetricsBrowserProvider>
  );
}

describe('ValueSelector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('reports an interaction with result counts but not the raw search text when a value search is performed', async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByText('grafana')).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText('Filter expression for label values');
    await userEvent.type(searchInput, 'grafana');

    await waitFor(
      () => {
        expect(reportInteraction).toHaveBeenCalledWith('grafana_prometheus_metrics_browser_value_search_performed', {
          resultsCount: 1,
        });
      },
      { timeout: 2000 }
    );

    // the search text itself must never be sent, since label values can carry sensitive/high-cardinality data
    for (const [, payload] of jest.mocked(reportInteraction).mock.calls) {
      expect(JSON.stringify(payload ?? {})).not.toContain('grafana');
    }
  });
});
