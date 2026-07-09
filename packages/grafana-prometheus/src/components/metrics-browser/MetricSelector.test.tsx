import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { selectors } from '@grafana/e2e-selectors';

import { MetricSelector } from './MetricSelector';
import { useMetricsBrowser } from './MetricsBrowserContext';

jest.mock('./MetricsBrowserContext', () => ({
  useMetricsBrowser: jest.fn(),
}));

jest.mock('@grafana/ui', () => {
  const actual = jest.requireActual('@grafana/ui');
  return {
    ...actual,
    useStyles2: () => ({
      section: 'section',
      valueListWrapper: 'valueListWrapper',
      valueList: 'valueList',
    }),
    BrowserLabel: ({ name }: { name: string }) => <div>{name}</div>,
  };
});

const seriesLimitTestId = selectors.components.DataSource.Prometheus.queryEditor.code.metricsBrowser.seriesLimit;

describe('MetricSelector series limit input', () => {
  const setSeriesLimit = jest.fn();
  const onMetricClick = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useMetricsBrowser as jest.Mock).mockReturnValue({
      metrics: [{ name: 'up' }],
      selectedMetric: '',
      seriesLimit: 40000,
      setSeriesLimit,
      onMetricClick,
    });
  });

  it('does not call setSeriesLimit while typing (only updates local draft)', async () => {
    const user = userEvent.setup();
    render(<MetricSelector />);

    const input = screen.getByTestId(seriesLimitTestId);
    await user.clear(input);
    await user.type(input, '5000');

    expect(setSeriesLimit).not.toHaveBeenCalled();
    expect(input).toHaveValue('5000');
  });

  it('calls setSeriesLimit on blur with the parsed limit', async () => {
    const user = userEvent.setup();
    render(<MetricSelector />);

    const input = screen.getByTestId(seriesLimitTestId);
    await user.clear(input);
    await user.type(input, '5000');
    await user.tab();

    expect(setSeriesLimit).toHaveBeenCalledTimes(1);
    expect(setSeriesLimit).toHaveBeenCalledWith(5000);
  });

  it('calls setSeriesLimit when Enter is pressed', async () => {
    const user = userEvent.setup();
    render(<MetricSelector />);

    const input = screen.getByTestId(seriesLimitTestId);
    await user.clear(input);
    await user.type(input, '1000{Enter}');

    expect(setSeriesLimit).toHaveBeenCalledWith(1000);
  });
});
