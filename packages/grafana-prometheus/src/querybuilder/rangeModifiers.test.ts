import { parser } from '@prometheus-io/lezer-promql';

import { validateQuery } from '../components/monaco-query-field/monaco-completion-provider/validation';

import { buildVisualQueryFromString } from './parsing';
import { PromQueryModeller } from './PromQueryModeller';

const modeller = new PromQueryModeller();

describe('extended range selectors', () => {
  it.each([
    ['rate', 'anchored'],
    ['increase', 'anchored'],
    ['delta', 'anchored'],
    ['changes', 'anchored'],
    ['resets', 'anchored'],
    ['rate', 'smoothed'],
    ['increase', 'smoothed'],
    ['delta', 'smoothed'],
  ])('round trips %s with %s through Builder', (name, modifier) => {
    const expression = `${name}(requests_total{job="api"}[$__rate_interval] ${modifier})`;
    const { query, errors } = buildVisualQueryFromString(expression);
    expect(errors).toEqual([]);
    expect(query.operations).toEqual([{ id: `__${name}_${modifier}`, params: ['$__rate_interval'] }]);
    expect(modeller.renderQuery(query)).toBe(expression);

    const interpolated = expression.replace('$__rate_interval', '5m');
    expect(validateQuery(expression, interpolated, [expression], parser).errors).toEqual([]);
  });

  it('preserves modifiers within aggregations and binary queries', () => {
    const expression = 'sum(rate(requests_total[5m] smoothed)) / sum(increase(requests_total[5m] anchored))';
    const { query, errors } = buildVisualQueryFromString(expression);
    expect(errors).toEqual([]);
    expect(modeller.renderQuery(query)).toBe(
      'sum(rate(requests_total[5m] smoothed)) / (sum(increase(requests_total[5m] anchored)))'
    );
  });

  it('reads the range from the selector when label values contain brackets', () => {
    const expression = 'rate(requests_total{job="api[blue]"}[5m] smoothed)';
    const { query, errors } = buildVisualQueryFromString(expression);
    expect(errors).toEqual([]);
    expect(modeller.renderQuery(query)).toBe(expression);
  });

  describe.each(['anchored', 'smoothed'])('%s custom intervals', (modifier) => {
    it.each(['$window', '${window}', '${window:raw}', '${seconds}s'])('preserves %s through Builder', (interval) => {
      const expression = `rate(requests_total{job="api[blue]"}[${interval}] ${modifier})`;
      const { query, errors } = buildVisualQueryFromString(expression);
      expect(errors).toEqual([]);
      expect(query.operations).toEqual([{ id: `__rate_${modifier}`, params: [interval] }]);
      expect(modeller.renderQuery(query)).toBe(expression);
    });
  });

  it('adds an extended rate before aggregations and replaces an existing range function', () => {
    const query = buildVisualQueryFromString('sum(rate(requests_total[5m]))').query;
    const def = modeller.getOperationDef('__rate_smoothed')!;
    const updated = def.addOperationHandler(def, query, modeller);
    expect(modeller.renderQuery(updated)).toBe('sum(rate(requests_total[$__rate_interval] smoothed))');
    expect(def.documentation).toContain('--enable-feature=promql-extended-range-selectors');
  });

  it.each([
    'irate(requests_total[5m] smoothed)',
    'changes(requests_total[5m] smoothed)',
    'resets(requests_total[5m] smoothed)',
    'rate(requests_total[5m:] anchored)',
    'rate(requests_total[5m] anchored smoothed)',
    'rate(requests_total[5m] offset 1m anchored)',
    'rate(requests_total[5m] anchored offset 1m)',
    'rate(requests_total[5m] @ 1234 smoothed)',
    'rate(requests_total[5m] smoothed, 1)',
    'requests_total smoothed',
  ])('reports Builder conversion errors for %s', (expression) => {
    expect(buildVisualQueryFromString(expression).errors.length).toBeGreaterThan(0);
  });

  it('continues to support ordinary resets', () => {
    const { query, errors } = buildVisualQueryFromString('resets(requests_total[5m])');
    expect(errors).toEqual([]);
    expect(modeller.renderQuery(query)).toBe('resets(requests_total[5m])');
  });

  it('retains an extended operation before a metric has been selected', () => {
    const { query, errors } = buildVisualQueryFromString('rate([$__rate_interval] smoothed)');
    expect(errors).toEqual([]);
    expect(modeller.renderQuery(query)).toBe('rate([$__rate_interval] smoothed)');
  });
});
