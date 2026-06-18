import { QueryFixAction } from '@grafana/data';

import { applyModifyQuery } from './modify_query';
import { PromQuery } from './types';

const baseQuery: PromQuery = { refId: 'A', expr: 'my_metric' };

describe('applyModifyQuery()', () => {
  it('returns the query unchanged for unknown action types', () => {
    const action = { type: 'UNKNOWN_ACTION' } as unknown as QueryFixAction;
    expect(applyModifyQuery(baseQuery, action)).toEqual(baseQuery);
  });

  it('adds an equality label filter for ADD_FILTER', () => {
    const action: QueryFixAction = { type: 'ADD_FILTER', options: { key: 'env', value: 'prod' } };
    expect(applyModifyQuery(baseQuery, action).expr).toBe('my_metric{env="prod"}');
  });

  it('adds a not-equal label filter for ADD_FILTER_OUT', () => {
    const action: QueryFixAction = { type: 'ADD_FILTER_OUT', options: { key: 'env', value: 'prod' } };
    expect(applyModifyQuery(baseQuery, action).expr).toBe('my_metric{env!="prod"}');
  });

  it('leaves expr untouched when ADD_FILTER is missing key or value', () => {
    const missingKey: QueryFixAction = { type: 'ADD_FILTER', options: { key: '', value: 'prod' } };
    const missingValue: QueryFixAction = { type: 'ADD_FILTER', options: { key: 'env', value: '' } };
    expect(applyModifyQuery(baseQuery, missingKey).expr).toBe('my_metric');
    expect(applyModifyQuery(baseQuery, missingValue).expr).toBe('my_metric');
  });

  it('wraps expr in rate() for ADD_RATE', () => {
    expect(applyModifyQuery(baseQuery, { type: 'ADD_RATE' } as QueryFixAction).expr).toBe(
      'rate(my_metric[$__rate_interval])'
    );
  });

  it('wraps expr in sum() with placeholder for ADD_SUM', () => {
    expect(applyModifyQuery({ refId: 'A', expr: '  my_metric  ' }, { type: 'ADD_SUM' } as QueryFixAction).expr).toBe(
      'sum(my_metric) by ($1)'
    );
  });

  it.each([
    ['ADD_HISTOGRAM_QUANTILE', 'histogram_quantile(0.95, sum(rate(my_metric[$__rate_interval])) by (le))'],
    ['ADD_HISTOGRAM_AVG', 'histogram_avg(rate(my_metric[$__rate_interval]))'],
    ['ADD_HISTOGRAM_FRACTION', 'histogram_fraction(0,0.2,rate(my_metric[$__rate_interval]))'],
    ['ADD_HISTOGRAM_COUNT', 'histogram_count(rate(my_metric[$__rate_interval]))'],
    ['ADD_HISTOGRAM_SUM', 'histogram_sum(rate(my_metric[$__rate_interval]))'],
    ['ADD_HISTOGRAM_STDDEV', 'histogram_stddev(rate(my_metric[$__rate_interval]))'],
    ['ADD_HISTOGRAM_STDVAR', 'histogram_stdvar(rate(my_metric[$__rate_interval]))'],
  ])('wraps expr for histogram action %s', (actionType, expected) => {
    expect(applyModifyQuery(baseQuery, { type: actionType } as QueryFixAction).expr).toBe(expected);
  });

  it('preserves non-expr fields on the query', () => {
    const query: PromQuery = { refId: 'A', expr: 'my_metric', legendFormat: '{{job}}', instant: true };
    const result = applyModifyQuery(query, { type: 'ADD_RATE' } as QueryFixAction);
    expect(result.legendFormat).toBe('{{job}}');
    expect(result.instant).toBe(true);
  });

  it('treats a missing expr as empty string', () => {
    const query = { refId: 'A' } as PromQuery;
    expect(applyModifyQuery(query, { type: 'ADD_RATE' } as QueryFixAction).expr).toBe('rate([$__rate_interval])');
  });
});
