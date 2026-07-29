import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { type TimeRange } from '@grafana/data';
import { reportInteraction } from '@grafana/runtime';

import { DEFAULT_SERIES_LIMIT, LAST_USED_LABELS_KEY, METRIC_LABEL } from '../../constants';
import { type PrometheusDatasource } from '../../datasource';
import { type PrometheusLanguageProviderInterface } from '../../language_provider';
import { getMockTimeRange } from '../../test/mocks/datasource';

import { MetricsBrowserProvider } from './MetricsBrowserContext';
import { SelectorActions } from './SelectorActions';
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
        return Promise.resolve(['grafana']);
      }
      return Promise.resolve([]);
    }),
  } as unknown as PrometheusLanguageProviderInterface;
  mockLanguageProvider.datasource = { seriesLimit: DEFAULT_SERIES_LIMIT } as unknown as PrometheusDatasource;
  return mockLanguageProvider;
}

async function setup(onChange = jest.fn()) {
  // pre-select the "job" label key so its values are loaded, then select a value below
  // to give the selector something non-empty for the action buttons to operate on
  localStorage.setItem(LAST_USED_LABELS_KEY, JSON.stringify(['job']));

  render(
    <MetricsBrowserProvider timeRange={getMockTimeRange()} languageProvider={createLanguageProvider()} onChange={onChange}>
      <ValueSelector />
      <SelectorActions />
    </MetricsBrowserProvider>
  );

  await waitFor(() => {
    expect(screen.getByText('grafana')).toBeInTheDocument();
  });
  await userEvent.click(screen.getByText('grafana'));

  return { onChange };
}

describe('SelectorActions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('reports an interaction when the selector is used as a query', async () => {
    await setup();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /use selector for query button/i })).toBeEnabled();
    });

    await userEvent.click(screen.getByRole('button', { name: /use selector for query button/i }));

    expect(reportInteraction).toHaveBeenCalledWith('grafana_prometheus_metrics_browser_query_applied', {
      asRateQuery: false,
    });
  });

  it('reports an interaction when the selector is used as a rate query', async () => {
    await setup();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /use selector as metrics button/i })).toBeEnabled();
    });

    await userEvent.click(screen.getByRole('button', { name: /use selector as metrics button/i }));

    expect(reportInteraction).toHaveBeenCalledWith('grafana_prometheus_metrics_browser_query_applied', {
      asRateQuery: true,
    });
  });
});
