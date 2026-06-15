// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/components/monaco-query-field/monaco-completion-provider/validation.test.ts
import { parser } from '@prometheus-io/lezer-promql';

import { validateQuery, warningTypes } from './validation';

describe('Monaco Query Validation', () => {
  test('Identifies empty queries as valid', () => {
    expect(validateQuery('', '', [], parser)).toEqual({ errors: [], warnings: [] });
  });

  test.each([
    'access_evaluation_duration_sum{job="grafana"}',
    'http_requests_total{job="apiserver", handler="/api/comments"}[5m]',
    'http_requests_total{job=~".*server"}',
    'rate(http_requests_total[5m])[30m:1m]',
    'max_over_time(deriv(rate(distance_covered_total[5s])[30s:5s])[10m:])',
    'rate(http_requests_total[5m])',
    'topk(3, sum by (app, proc) (rate(instance_cpu_time_ns[5m])))',
  ])('Identifies valid queries', (query: string) => {
    expect(validateQuery(query, query, [], parser).errors).toEqual([]);
  });

  test('Identifies invalid queries', () => {
    // Missing } at the end
    let query = 'access_evaluation_duration_sum{job="grafana"';
    expect(validateQuery(query, query, [query], parser)).toEqual({
      errors: [{ endColumn: 45, endLineNumber: 1, issue: '{job="grafana"', startColumn: 31, startLineNumber: 1 }],
      warnings: [],
    });

    // Missing handler="value"
    query = 'http_requests_total{job="apiserver", handler}[5m]';
    expect(validateQuery(query, query, [query], parser)).toEqual({
      errors: [{ endColumn: 45, endLineNumber: 1, issue: 'handler', startColumn: 38, startLineNumber: 1 }],
      warnings: [],
    });

    // Missing : in [30s:5s]
    query = 'max_over_time(deriv(rate(distance_covered_total[5s])[30s5s])[10m:])';
    expect(validateQuery(query, query, [query], parser)).toEqual({
      errors: [{ endColumn: 59, endLineNumber: 1, issue: '5s', startColumn: 57, startLineNumber: 1 }],
      warnings: [],
    });
  });

  test('Identifies valid multi-line queries', () => {
    const query = `
sum by (job) (
    rate(http_requests_total[5m])
)`;
    const queryLines = query.split('\n');
    expect(validateQuery(query, query, queryLines, parser)).toEqual({ errors: [], warnings: [] });
  });

  test('Identifies invalid multi-line queries', () => {
    const query = `
sum by (job) (
    rate(http_requests_total[])
)`;
    const queryLines = query.split('\n');
    expect(validateQuery(query, query, queryLines, parser)).toEqual({
      errors: [{ endColumn: 30, endLineNumber: 3, issue: '', startColumn: 30, startLineNumber: 3 }],
      warnings: [],
    });
  });

  test('Warns agains subqueries with same duration and step', () => {
    const query = 'rate(http_requests_total[5m:5m])';
    const queryLines = query.split('\n');
    expect(validateQuery(query, query, queryLines, parser)).toEqual({
      errors: [],
      warnings: [
        { endColumn: 32, endLineNumber: 1, issue: warningTypes.SubqueryExpr, startColumn: 6, startLineNumber: 1 },
      ],
    });
  });

  test('Warns agains queries with multiple subqueries', () => {
    const query = 'quantile_over_time(0.5, rate(http_requests_total[1m:1m]) [1m:1m])';
    const queryLines = query.split('\n');
    expect(validateQuery(query, query, queryLines, parser)).toEqual({
      errors: [],
      warnings: [
        { issue: warningTypes.SubqueryExpr, startColumn: 25, endColumn: 65, startLineNumber: 1, endLineNumber: 1 },
        { issue: warningTypes.SubqueryExpr, startColumn: 30, endColumn: 56, startLineNumber: 1, endLineNumber: 1 },
      ],
    });
  });

  describe('interpolated queries (query !== interpolatedQuery)', () => {
    test('traces interpolated errors back to the original query positions', () => {
      // The original query holds a $variable; the interpolated version substitutes a
      // real metric of a different length. Both are missing the closing brace, so the
      // error text matches and the boundary must be reported against the ORIGINAL query
      // (column 8, after "$metric") rather than the interpolated one (column 3, after "up").
      const query = '$metric{job="grafana"';
      const interpolatedQuery = 'up{job="grafana"';

      expect(validateQuery(query, interpolatedQuery, [query], parser)).toEqual({
        errors: [{ startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 22, issue: '{job="grafana"' }],
        warnings: [],
      });
    });

    test('returns no errors when no interpolated error text matches the original query', () => {
      // The interpolated error text ("{job=") has no counterpart in the original query,
      // so the trace-back filter yields nothing and the error is dropped.
      const query = 'rate($interval)';
      const interpolatedQuery = 'rate(1m){job=';

      expect(validateQuery(query, interpolatedQuery, [query], parser).errors).toEqual([]);
    });

    test('traces interpolated subquery warnings back to the original query', () => {
      // The subquery sits before the $variable, so its node.from is identical in both
      // strings and the warning trace-back (matched by node.from) resolves to it.
      const query = 'rate(http_requests_total[5m:5m]) + $value';
      const interpolatedQuery = 'rate(http_requests_total[5m:5m]) + 1';

      expect(validateQuery(query, interpolatedQuery, [query], parser)).toEqual({
        errors: [],
        warnings: [
          { issue: warningTypes.SubqueryExpr, startColumn: 6, endColumn: 32, startLineNumber: 1, endLineNumber: 1 },
        ],
      });
    });
  });

  test('drops boundaries whose node falls outside the provided multi-line query lines', () => {
    // A genuinely invalid single-line query, but the caller supplies queryLines that do not
    // cover the error node's offset. findIssueBoundary walks the (multi-line) lines, never
    // finds one containing the node, and returns null, which is then filtered out.
    const query = 'metric_name_with_open_brace{';
    const mismatchedLines = ['a', 'b'];

    expect(validateQuery(query, query, mismatchedLines, parser).errors).toEqual([]);
  });
});
