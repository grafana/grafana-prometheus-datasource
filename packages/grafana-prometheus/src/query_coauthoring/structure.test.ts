import {
  buildStagedQueryDiff,
  extractMetricNames,
  normalizeFocusRanges,
  validatePromQL,
  type EditorSelection,
  type TextRange,
} from './structure';

function selection(query: string, text: string, fromOffset = 0, toOffset = text.length): EditorSelection {
  const start = query.indexOf(text);
  if (start < 0) {
    throw new Error(`Could not find ${text}`);
  }

  return { anchor: start + fromOffset, head: start + toOffset };
}

function range(query: string, text: string): TextRange {
  const from = query.indexOf(text);
  if (from < 0) {
    throw new Error(`Could not find ${text}`);
  }

  return { from, to: from + text.length };
}

describe('normalizeFocusRanges', () => {
  it('expands partial selections to PromQL lexical boundaries', () => {
    const query = 'sum(rate(http_requests_total{job="api"}[5m]))';

    expect(normalizeFocusRanges(query, [selection(query, 'http_requests_total', 5, 13)])).toEqual([
      range(query, 'http_requests_total'),
    ]);
  });

  it('normalizes partial and complete selections of a Grafana variable', () => {
    const query = 'rate(http_requests_total[$__rate_interval])';

    expect(normalizeFocusRanges(query, [selection(query, '__rate_interval')])).toEqual([
      range(query, '$__rate_interval'),
    ]);
    expect(normalizeFocusRanges(query, [selection(query, '$__rate_interval')])).toEqual([
      range(query, '$__rate_interval'),
    ]);
  });

  it('expands a selection across query parts to their enclosing syntax boundary', () => {
    const query = 'rate(fakedata_highcard_http_requests_total[$__rate_interval])';

    expect(normalizeFocusRanges(query, [selection(query, 'total[$__rat')])).toEqual([
      range(query, 'fakedata_highcard_http_requests_total[$__rate_interval]'),
    ]);
  });

  it('normalizes reversed disjoint selections independently', () => {
    const query = 'rate(http_requests_total{job="api"}[5m])';
    const metric = selection(query, 'http_requests_total', 4, 12);
    const duration = selection(query, '5m');

    expect(
      normalizeFocusRanges(query, [
        { anchor: metric.head, head: metric.anchor },
        { anchor: duration.head, head: duration.anchor },
      ])
    ).toEqual([range(query, 'http_requests_total'), range(query, '5m')]);
  });

  it('merges overlapping and touching normalized ranges', () => {
    const query = 'foo + bar';

    expect(
      normalizeFocusRanges(query, [
        selection(query, 'foo'),
        { anchor: query.indexOf('foo') + 2, head: query.indexOf('bar') + 1 },
      ])
    ).toEqual([{ from: 0, to: query.length }]);
  });

  it('uses the whole existing query when every selection is empty', () => {
    const query = 'rate(foo_total[5m])';

    expect(normalizeFocusRanges(query, [{ anchor: 4, head: 4 }])).toEqual([{ from: 0, to: query.length }]);
  });

  it('never shrinks a full selection around a Grafana template variable', () => {
    const query = 'rate(prometheus_http_requests_total{job="prometheus"}[$__rate_interval])';

    expect(normalizeFocusRanges(query, [{ anchor: 0, head: query.length }])).toEqual([{ from: 0, to: query.length }]);
  });

  it('keeps Monaco UTF-16 offsets intact for UTF-8 metric names', () => {
    const query = '{"mé🔥tric", job="api"}';
    const metric = '"mé🔥tric"';
    const metricStart = query.indexOf(metric);

    expect(normalizeFocusRanges(query, [{ anchor: metricStart + 3, head: metricStart + metric.length - 1 }])).toEqual([
      { from: metricStart, to: metricStart + metric.length },
    ]);
  });

  it('clamps editor offsets before normalizing them', () => {
    const query = 'foo_total';

    expect(normalizeFocusRanges(query, [{ anchor: -20, head: 200 }])).toEqual([{ from: 0, to: query.length }]);
  });
});

describe('extractMetricNames', () => {
  it('returns unique metrics referenced by vector selectors', () => {
    expect(
      extractMetricNames(
        'sum(rate(http_requests_total[5m])) / ignoring(instance) count(node_cpu_seconds_total) + http_requests_total'
      )
    ).toEqual(['http_requests_total', 'node_cpu_seconds_total']);
  });

  it('extracts an exact __name__ matcher without treating label values as metrics', () => {
    expect(extractMetricNames('{__name__="http_requests_total",job="api"}')).toEqual(['http_requests_total']);
  });

  it('does not infer a concrete metric from a __name__ regex matcher', () => {
    expect(extractMetricNames('{__name__=~"http_.*"}')).toEqual([]);
  });

  it('does not treat labels whose names contain __name__ as metric names', () => {
    expect(extractMetricNames('{service__name__="api"}')).toEqual([]);
  });

  it('decodes PromQL escapes in an exact __name__ matcher', () => {
    expect(extractMetricNames('{__name__="http\\x2erequests"}')).toEqual(['http.requests']);
  });

  it('extracts and decodes quoted UTF-8 metric names', () => {
    expect(extractMetricNames('{"http.requests",job="api"} + {"http\\\"responses",job="api"}')).toEqual([
      'http.requests',
      'http"responses',
    ]);
  });

  it('does not treat quoted label matchers as quoted metric names', () => {
    expect(extractMetricNames('{"job"="api"} + {"__name__"="http_requests_total"}')).toEqual([]);
  });
});

describe('validatePromQL', () => {
  it('rejects a proposal with parser errors', () => {
    expect(validatePromQL('sum(rate(foo_total[5m])')).toEqual({ valid: false });
  });

  it('validates Grafana template variables through a separately interpolated query', () => {
    expect(validatePromQL('rate($metric[$__rate_interval])', 'rate(foo_total[5m])')).toEqual({ valid: true });
  });
});

describe('buildStagedQueryDiff', () => {
  it('returns no changes for identical queries before applying the large-diff fallback', () => {
    const query = Array.from({ length: 300 }, (_, index) => `metric_${index}`).join(' + ');

    expect(buildStagedQueryDiff(query, query, [{ from: 0, to: query.length }])).toEqual({
      valid: true,
      changes: [],
    });
  });

  it('creates stable syntax anchors for multiple changes', () => {
    const original = 'sum(rate(http_requests_total{job="api"}[5m]))';
    const proposed = 'sum(increase(http_requests_total{job="api"}[10m]))';

    expect(
      buildStagedQueryDiff(original, proposed, [range(original, 'rate(http_requests_total{job="api"}[5m])')])
    ).toMatchObject({
      valid: true,
      changes: [
        {
          id: 'change-1',
          originalRange: range(original, 'rate'),
          proposedRange: range(proposed, 'increase'),
          focus: 'inside',
          originalAnchor: { kind: 'function', range: range(original, 'rate(http_requests_total{job="api"}[5m])') },
          proposedAnchor: {
            kind: 'function',
            range: range(proposed, 'increase(http_requests_total{job="api"}[10m])'),
          },
        },
        {
          id: 'change-2',
          originalRange: range(original, '5m'),
          proposedRange: range(proposed, '10m'),
          focus: 'inside',
          originalAnchor: { kind: 'range', range: range(original, '5m') },
          proposedAnchor: { kind: 'range', range: range(proposed, '10m') },
        },
      ],
    });
  });

  it('classifies edits outside the selected focus without claiming semantic correctness', () => {
    const original = 'rate(foo_total{job="api"}[5m])';
    const proposed = 'rate(foo_total{job="api", cluster="prod"}[5m])';

    expect(buildStagedQueryDiff(original, proposed, [range(original, '5m')])).toMatchObject({
      valid: true,
      changes: [{ focus: 'outside', originalRange: { from: original.indexOf('}'), to: original.indexOf('}') } }],
    });
  });

  it('treats an insertion at a focus boundary as in focus', () => {
    const original = 'foo_total';
    const proposed = 'sum(foo_total)';

    expect(buildStagedQueryDiff(original, proposed, [{ from: 0, to: original.length }])).toMatchObject({
      valid: true,
      changes: [
        { id: 'change-1', focus: 'inside', originalRange: { from: 0, to: 0 } },
        {
          id: 'change-2',
          focus: 'inside',
          originalRange: { from: original.length, to: original.length },
        },
      ],
    });
  });

  it('classifies a replacement spanning selected and unselected text as mixed', () => {
    const original = 'foo_total + bar_total';
    const proposed = 'baz_total';

    expect(buildStagedQueryDiff(original, proposed, [range(original, 'foo_total')])).toMatchObject({
      valid: true,
      changes: [
        {
          id: 'change-1',
          focus: 'mixed',
          originalRange: { from: 0, to: original.length },
          proposedRange: { from: 0, to: proposed.length },
        },
      ],
    });
  });

  it('stages queries containing variables when interpolated validation input is provided', () => {
    const original = 'rate($metric[5m])';
    const proposed = 'sum(rate($metric[5m]))';
    const result = buildStagedQueryDiff(original, proposed, [{ from: 0, to: original.length }], {
      originalInterpolatedQuery: 'rate(foo_total[5m])',
      proposedInterpolatedQuery: 'sum(rate(foo_total[5m]))',
    });

    expect(result).toMatchObject({
      valid: true,
      changes: [
        {
          id: 'change-1',
          focus: 'inside',
          originalRange: { from: 0, to: 0 },
        },
        {
          id: 'change-2',
          focus: 'inside',
          originalRange: { from: original.length, to: original.length },
        },
      ],
    });
    for (const change of result.changes) {
      expect(change).not.toHaveProperty('originalAnchor');
      expect(change).not.toHaveProperty('proposedAnchor');
    }
  });

  it('does not stage malformed proposals', () => {
    expect(buildStagedQueryDiff('foo_total', 'sum(foo_total', [{ from: 0, to: 9 }])).toEqual({
      valid: false,
      changes: [],
    });
  });
});
