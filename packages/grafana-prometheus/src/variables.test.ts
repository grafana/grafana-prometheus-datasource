import { BehaviorSubject, firstValueFrom } from 'rxjs';

import {
  dateTime,
  LiveChannelConnectionState,
  LiveChannelEventType,
  type LiveChannelEvent,
  type TimeRange,
} from '@grafana/data';
import { getGrafanaLiveSrv, type TemplateSrv } from '@grafana/runtime';

import { DEFAULT_SERIES_LIMIT } from './constants';
import { type PrometheusDatasource } from './datasource';
import { PrometheusLanguageProvider } from './language_provider';
import { PrometheusCacheLevel } from './types';
import { PrometheusVariableSupport } from './variables';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getGrafanaLiveSrv: jest.fn(),
}));

describe('PrometheusVariableSupport search integration', () => {
  it('executes label-value variables through the configured SearchApiClient', async () => {
    const stream = new BehaviorSubject<LiveChannelEvent<unknown>>({
      type: LiveChannelEventType.Status,
      id: 'ds/uid/search/test',
      timestamp: Date.now(),
      state: LiveChannelConnectionState.Connected,
    });
    const publish = jest.fn().mockResolvedValue(undefined);
    jest.mocked(getGrafanaLiveSrv).mockReturnValue({
      getStream: jest.fn().mockReturnValue(stream),
      publish,
    } as never);
    const range: TimeRange = {
      from: dateTime(1681300292392),
      to: dateTime(1681300293392),
      raw: { from: 'now-1s', to: 'now' },
    };
    const datasource = {
      uid: 'uid',
      interval: '15s',
      cacheLevel: PrometheusCacheLevel.None,
      seriesLimit: DEFAULT_SERIES_LIMIT,
      hasSearchApiSupport: () => true,
      hasLabelsMatchAPISupport: () => true,
      getAdjustedInterval: () => ({ start: '1', end: '2' }),
      getTimeRangeParams: () => ({ start: '1', end: '2' }),
      getRangeScopedVars: () => ({}),
      interpolateString: (value: string) => value,
      interpolateQueryExpr: (value: string | string[]) => value,
      metadataRequest: jest.fn(),
    } as unknown as PrometheusDatasource;
    datasource.languageProvider = new PrometheusLanguageProvider(datasource);
    const templateSrv = { replace: (value: string) => value } as unknown as TemplateSrv;
    const variables = new PrometheusVariableSupport(datasource, templateSrv);

    const resultPromise = firstValueFrom(
      variables.query({
        targets: [{ refId: 'A', query: 'label_values(job)' }],
        range,
        scopedVars: {},
      } as never)
    );
    const requestId = publish.mock.calls[0][1].requestId;
    stream.next({
      type: LiveChannelEventType.Message,
      message: { requestId, type: 'batch', results: [{ value: 'grafana' }] },
    });
    stream.next({ type: LiveChannelEventType.Message, message: { requestId, type: 'terminal' } });

    await expect(resultPromise).resolves.toEqual({ data: [{ text: 'grafana' }] });
    expect(publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ endpoint: 'label_values' }), {
      useSocket: true,
    });
  });
});
