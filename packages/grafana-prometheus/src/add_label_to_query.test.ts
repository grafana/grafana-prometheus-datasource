// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/add_label_to_query.test.ts
import { addLabelToQuery } from './add_label_to_query';

describe('addLabelToQuery()', () => {
  it('should add label to simple query', () => {
    expect(() => {
      addLabelToQuery('foo', '', '');
    }).toThrow();
    expect(addLabelToQuery('foo', 'bar', 'baz')).toBe('foo{bar="baz"}');
    expect(addLabelToQuery('foo{}', 'bar', 'baz')).toBe('foo{bar="baz"}');
    expect(addLabelToQuery('foo{x="yy"}', 'bar', 'baz')).toBe('foo{x="yy", bar="baz"}');
    expect(addLabelToQuery('metric > 0.001', 'foo', 'bar')).toBe('metric{foo="bar"} > 0.001');
  });

  it('should add custom operator', () => {
    expect(addLabelToQuery('foo{}', 'bar', 'baz', '!=')).toBe('foo{bar!="baz"}');
    expect(addLabelToQuery('foo{x="yy"}', 'bar', 'baz', '!=')).toBe('foo{x="yy", bar!="baz"}');
  });

  it('should not modify ranges', () => {
    expect(addLabelToQuery('rate(metric[1m])', 'foo', 'bar')).toBe('rate(metric{foo="bar"}[1m])');
  });

  it('should detect in-order function use', () => {
    expect(addLabelToQuery('sum by (xx) (foo)', 'bar', 'baz')).toBe('sum by (xx) (foo{bar="baz"})');
  });

  it('should convert number Infinity to +Inf', () => {
    expect(
      addLabelToQuery('sum(rate(prometheus_tsdb_compaction_chunk_size_bytes_bucket[5m])) by (le)', 'le', Infinity)
    ).toBe('sum(rate(prometheus_tsdb_compaction_chunk_size_bytes_bucket{le="+Inf"}[5m])) by (le)');
  });

  it('should handle selectors with punctuation', () => {
    expect(addLabelToQuery('foo{instance="my-host.com:9100"}', 'bar', 'baz')).toBe(
      'foo{instance="my-host.com:9100", bar="baz"}'
    );
    expect(addLabelToQuery('foo:metric:rate1m', 'bar', 'baz')).toBe('foo:metric:rate1m{bar="baz"}');
    expect(addLabelToQuery('avg(foo:metric:rate1m{a="b"})', 'bar', 'baz')).toBe(
      'avg(foo:metric:rate1m{a="b", bar="baz"})'
    );
    expect(addLabelToQuery('foo{list="a,b,c"}', 'bar', 'baz')).toBe('foo{list="a,b,c", bar="baz"}');
  });

  it('should work on arithmetical expressions', () => {
    expect(addLabelToQuery('foo + foo', 'bar', 'baz')).toBe('foo{bar="baz"} + foo{bar="baz"}');
    expect(addLabelToQuery('foo{x="yy"} + metric', 'bar', 'baz')).toBe('foo{x="yy", bar="baz"} + metric{bar="baz"}');
    expect(addLabelToQuery('avg(foo) + sum(xx_yy)', 'bar', 'baz')).toBe('avg(foo{bar="baz"}) + sum(xx_yy{bar="baz"})');
    expect(addLabelToQuery('foo{x="yy"} * metric{y="zz",a="bb"} * metric2', 'bar', 'baz')).toBe(
      'foo{x="yy", bar="baz"} * metric{y="zz", a="bb", bar="baz"} * metric2{bar="baz"}'
    );
  });

  it('should not add duplicate labels to a query', () => {
    expect(addLabelToQuery(addLabelToQuery('foo{x="yy"}', 'bar', 'baz', '!='), 'bar', 'baz', '!=')).toBe(
      'foo{x="yy", bar!="baz"}'
    );
    expect(addLabelToQuery(addLabelToQuery('rate(metric[1m])', 'foo', 'bar'), 'foo', 'bar')).toBe(
      'rate(metric{foo="bar"}[1m])'
    );
    expect(addLabelToQuery(addLabelToQuery('foo{list="a,b,c"}', 'bar', 'baz'), 'bar', 'baz')).toBe(
      'foo{list="a,b,c", bar="baz"}'
    );
    expect(addLabelToQuery(addLabelToQuery('avg(foo) + sum(xx_yy)', 'bar', 'baz'), 'bar', 'baz')).toBe(
      'avg(foo{bar="baz"}) + sum(xx_yy{bar="baz"})'
    );
  });

  it('should modify existing labels if the operator is different', () => {
    expect(addLabelToQuery(addLabelToQuery('foo{x="yy"}', 'bar', 'baz', '!='), 'bar', 'baz', '=')).toBe(
      'foo{x="yy", bar="baz"}'
    );
    expect(addLabelToQuery(addLabelToQuery('foo{x="yy"}', 'bar', 'baz', '='), 'bar', 'baz', '!=')).toBe(
      'foo{x="yy", bar!="baz"}'
    );
  });

  it('should not remove filters', () => {
    expect(addLabelToQuery('{x="y"} |="yy"', 'bar', 'baz')).toBe('{x="y", bar="baz"} |="yy"');
    expect(addLabelToQuery('{x="y"} |="yy" !~"xx"', 'bar', 'baz')).toBe('{x="y", bar="baz"} |="yy" !~"xx"');
  });

  it('should add labels to metrics with logical operators', () => {
    expect(addLabelToQuery('foo_info or bar_info', 'bar', 'baz')).toBe('foo_info{bar="baz"} or bar_info{bar="baz"}');
    expect(addLabelToQuery('foo_info and bar_info', 'bar', 'baz')).toBe('foo_info{bar="baz"} and bar_info{bar="baz"}');
  });

  it('should not add ad-hoc filter to template variables', () => {
    expect(addLabelToQuery('sum(rate({job="foo"}[2m])) by (value $variable)', 'bar', 'baz')).toBe(
      'sum(rate({job="foo", bar="baz"}[2m])) by (value $variable)'
    );
  });

  it('should not add ad-hoc filter to range', () => {
    expect(addLabelToQuery('avg(rate((my_metric{job="foo"} > 0)[3h:])) by (label)', 'bar', 'baz')).toBe(
      'avg(rate((my_metric{job="foo", bar="baz"} > 0)[3h:])) by (label)'
    );
  });
  it('should not add ad-hoc filter to labels in label list provided with the group modifier', () => {
    expect(
      addLabelToQuery(
        'max by (id, name, type) (my_metric{type=~"foo|bar|baz-test"}) * on(id) group_right(id, type, name) sum by (id) (my_metric) * 1000',
        'bar',
        'baz'
      )
    ).toBe(
      'max by (id, name, type) (my_metric{type=~"foo|bar|baz-test", bar="baz"}) * on(id) group_right(id, type, name) sum by (id) (my_metric{bar="baz"}) * 1000'
    );
  });
  it('should not add ad-hoc filter to labels in label list provided with the group modifier', () => {
    expect(addLabelToQuery('rate(my_metric[${__range_s}s])', 'bar', 'baz')).toBe(
      'rate(my_metric{bar="baz"}[${__range_s}s])'
    );
  });
  it('should not add ad-hoc filter to labels to math operations', () => {
    expect(addLabelToQuery('count(my_metric{job!="foo"} < (5*1024*1024*1024) or vector(0)) - 1', 'bar', 'baz')).toBe(
      'count(my_metric{job!="foo", bar="baz"} < (5*1024*1024*1024) or vector(0)) - 1'
    );
  });

  it('should not add ad-hoc filter bool operator', () => {
    expect(addLabelToQuery('ALERTS < bool 1', 'bar', 'baz')).toBe('ALERTS{bar="baz"} < bool 1');
  });

  it('should add a utf8 label', () => {
    expect(addLabelToQuery('{"metric.name"}', 'cenk.erdem', 'muhabbet')).toBe(
      '{"metric.name", "cenk.erdem"="muhabbet"}'
    );

    expect(addLabelToQuery('metric{label="val"}', 'cenk.erdem', 'muhabbet')).toBe(
      'metric{label="val", "cenk.erdem"="muhabbet"}'
    );
  });

  it('should not add a utf8 label when it is already applied', () => {
    expect(addLabelToQuery('{"metric.name", "cenk.erdem"="muhabbet"}', 'cenk.erdem', 'muhabbet')).toBe(
      '{"metric.name", "cenk.erdem"="muhabbet"}'
    );

    expect(addLabelToQuery('metric{label="val", "cenk.erdem"="muhabbet"}', 'cenk.erdem', 'muhabbet')).toBe(
      'metric{label="val", "cenk.erdem"="muhabbet"}'
    );
  });

  // Regression tests for https://github.com/grafana/grafana/issues/126518:
  // Prometheus rejects queries where the metric name is set both as the
  // selector prefix and as an exact-match `__name__` label
  // ("metric name must not be set twice"). The metric prefix must be folded
  // into the `__name__` matcher in that case so the name is specified once.
  describe('with a __name__ filter', () => {
    it('should fold the metric prefix into a __name__ matcher (no labels)', () => {
      expect(addLabelToQuery('metric_name', '__name__', 'metric_name')).toBe('{__name__="metric_name"}');
    });

    it('should fold the metric prefix into a __name__ matcher while preserving other labels', () => {
      expect(addLabelToQuery('metric_name{job="x"}', '__name__', 'metric_name')).toBe(
        '{job="x", __name__="metric_name"}'
      );
    });

    it('should let an adhoc __name__ filter override a differing metric prefix', () => {
      expect(addLabelToQuery('metric_name{job="x"}', '__name__', 'other_metric')).toBe(
        '{job="x", __name__="other_metric"}'
      );
    });

    it('should leave the metric prefix alone for non-equality __name__ operators', () => {
      expect(addLabelToQuery('metric_name', '__name__', 'metric_name', '=~')).toBe(
        'metric_name{__name__=~"metric_name"}'
      );
      expect(addLabelToQuery('metric_name', '__name__', 'other', '!=')).toBe('metric_name{__name__!="other"}');
      expect(addLabelToQuery('metric_name', '__name__', 'other', '!~')).toBe('metric_name{__name__!~"other"}');
    });

    it('should fold the metric prefix in every vector selector of a binary expression', () => {
      expect(addLabelToQuery('sum(a) / sum(b)', '__name__', 'a')).toBe(
        'sum({__name__="a"}) / sum({__name__="a"})'
      );
    });

    it('should be idempotent when the same __name__ filter is applied twice', () => {
      expect(addLabelToQuery(addLabelToQuery('metric_name', '__name__', 'metric_name'), '__name__', 'metric_name')).toBe(
        '{__name__="metric_name"}'
      );
    });

    it('should not affect adding non-__name__ adhoc filters to a metric prefix', () => {
      expect(addLabelToQuery('metric_name', 'job', 'x')).toBe('metric_name{job="x"}');
    });
  });
});
