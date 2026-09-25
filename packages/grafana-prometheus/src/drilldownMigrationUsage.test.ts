import { classifyDrilldownMigrationUsage, classifyDrilldownMigrationUsageForQuery } from './drilldownMigrationUsage';

describe('classifyDrilldownMigrationUsage', () => {
  describe('not referenced', () => {
    it('returns undefined when the variable is not used in the expression', () => {
      expect(classifyDrilldownMigrationUsage('instance', 'up{job="grafana"}')).toBeUndefined();
    });

    it('only classifies the requested variable', () => {
      const expr = 'sum by($groupby) (up{instance=~"$instance"})';

      expect(classifyDrilldownMigrationUsage('groupby', expr)).toEqual({ kind: 'groupBy' });
      expect(classifyDrilldownMigrationUsage('instance', expr)).toEqual({
        kind: 'filter',
        key: 'instance',
        operator: '=~',
      });
      expect(classifyDrilldownMigrationUsage('other', expr)).toBeUndefined();
    });
  });

  describe('filter positions', () => {
    it('classifies a variable as full regex matcher value', () => {
      expect(
        classifyDrilldownMigrationUsage('instance', 'sum(rate(up{instance=~"$instance", job="grafana"}[5m]))')
      ).toEqual({ kind: 'filter', key: 'instance', operator: '=~' });
    });

    it('classifies a variable as full equality matcher value', () => {
      expect(classifyDrilldownMigrationUsage('job', 'up{job="$job"}')).toEqual({
        kind: 'filter',
        key: 'job',
        operator: '=',
      });
    });

    it.each([['up{job="${job}"}'], ['up{job="[[job]]"}']])('handles the %s interpolation syntax', (expr) => {
      expect(classifyDrilldownMigrationUsage('job', expr)).toEqual({ kind: 'filter', key: 'job', operator: '=' });
    });

    it('rejects a matcher on a selector without a metric name', () => {
      expect(classifyDrilldownMigrationUsage('job', '{job="$job"}')).toEqual({
        kind: 'unsafe',
        reason: expect.any(String),
      });
    });

    it('accepts a matcher on a selector with a quoted utf8 metric name', () => {
      expect(classifyDrilldownMigrationUsage('job', '{"my.metric", job="$job"}')).toEqual({
        kind: 'filter',
        key: 'job',
        operator: '=',
      });
    });

    it('classifies a quoted (utf8) label matcher', () => {
      expect(classifyDrilldownMigrationUsage('val', 'up{"my label"=~"$val"}')).toEqual({
        kind: 'filter',
        key: 'my label',
        operator: '=~',
      });
    });

    it.each([
      ['up{job!="$job"}', '!='],
      ['up{job!~"$job"}', '!~'],
    ])('classifies negative matcher %s as a filter with operator %s', (expr, operator) => {
      expect(classifyDrilldownMigrationUsage('job', expr)).toEqual({ kind: 'filter', key: 'job', operator });
    });

    it('rejects a matcher value that combines the variable with other text', () => {
      expect(classifyDrilldownMigrationUsage('job', 'up{job=~"prefix-$job"}')).toEqual({
        kind: 'unsafe',
        reason: expect.any(String),
      });
    });

    it('rejects a variable in label key position', () => {
      expect(classifyDrilldownMigrationUsage('label', 'up{$label="foo"}')).toEqual({
        kind: 'unsafe',
        reason: expect.any(String),
      });
    });
  });

  describe('groupBy positions', () => {
    it('classifies a variable as by() grouping label', () => {
      expect(classifyDrilldownMigrationUsage('groupby', 'sum by($groupby) (up)')).toEqual({ kind: 'groupBy' });
    });

    it('classifies a variable among other by() grouping labels', () => {
      expect(classifyDrilldownMigrationUsage('groupby', 'sum by (job, $groupby, instance) (rate(up[5m]))')).toEqual({
        kind: 'groupBy',
      });
    });

    it('supports the trailing aggregation modifier form', () => {
      expect(classifyDrilldownMigrationUsage('groupby', 'sum(up) by ($groupby)')).toEqual({ kind: 'groupBy' });
    });

    it('rejects without() grouping', () => {
      expect(classifyDrilldownMigrationUsage('groupby', 'sum without($groupby) (up)')).toEqual({
        kind: 'unsafe',
        reason: expect.any(String),
      });
    });

    it('rejects on() grouping of binary expressions', () => {
      expect(classifyDrilldownMigrationUsage('label', 'up / on($label) group_left() up')).toEqual({
        kind: 'unsafe',
        reason: expect.any(String),
      });
    });
  });

  describe('other positions', () => {
    it('rejects a variable in metric name position', () => {
      expect(classifyDrilldownMigrationUsage('metric', 'rate($metric[5m])')).toEqual({
        kind: 'unsafe',
        reason: expect.any(String),
      });
    });

    it('rejects a variable in a function string argument', () => {
      expect(classifyDrilldownMigrationUsage('var', 'label_replace(up, "dst", "$1", "src", "$var")')).toEqual({
        kind: 'unsafe',
        reason: expect.any(String),
      });
    });
  });

  describe('multiple occurrences within one query', () => {
    it('agrees when every occurrence is the same filter key', () => {
      expect(
        classifyDrilldownMigrationUsage('instance', 'up{instance=~"$instance"} / up{instance=~"$instance"}')
      ).toEqual({ kind: 'filter', key: 'instance', operator: '=~' });
    });

    it('tolerates differing operators as long as the key agrees', () => {
      expect(classifyDrilldownMigrationUsage('v', 'up{a="$v"} / up{a=~"$v"}')).toEqual({
        kind: 'filter',
        key: 'a',
        operator: '=',
      });
    });

    it('is unsafe when the same variable filters on two different label keys', () => {
      const result = classifyDrilldownMigrationUsage('v', 'up{a="$v"} / up{b="$v"}');
      expect(result?.kind).toBe('unsafe');
    });

    it('is unsafe when the same variable is used as both a filter and a groupBy label', () => {
      const result = classifyDrilldownMigrationUsage('v', 'sum by($v) (up{instance=~"$v"})');
      expect(result?.kind).toBe('unsafe');
    });

    it('is unsafe when one occurrence is safe and another is not', () => {
      const result = classifyDrilldownMigrationUsage('v', 'up{a="$v"} + rate($v[5m])');
      expect(result?.kind).toBe('unsafe');
    });
  });

  describe('built-in variables', () => {
    it.each([['$__rate_interval'], ['$__interval'], ['$__range'], ['$__auto']])(
      'does not error on %s in range position',
      (builtIn) => {
        expect(classifyDrilldownMigrationUsage('job', `rate(up{job="$job"}[${builtIn}])`)).toEqual({
          kind: 'filter',
          key: 'job',
          operator: '=',
        });
      }
    );
  });

  describe('parse errors', () => {
    it('reports unparsable expressions as unsafe', () => {
      expect(classifyDrilldownMigrationUsage('job', 'sum(up{job="$job"}')).toEqual({
        kind: 'unsafe',
        reason: expect.any(String),
      });
    });
  });

  describe('unsupported variable syntax', () => {
    it('flags a field-path reference anywhere in the expression as unsafe', () => {
      expect(classifyDrilldownMigrationUsage('job', 'up{job="$job", other="${obj.field}"}')).toEqual({
        kind: 'unsafe',
        reason: expect.any(String),
      });
    });

    it('flags a format specifier with non-word characters as unsafe', () => {
      expect(classifyDrilldownMigrationUsage('job', 'up{job="${job:date:iso}"}')).toEqual({
        kind: 'unsafe',
        reason: expect.any(String),
      });
    });

    it('does not flag a plain word-shaped format specifier', () => {
      expect(classifyDrilldownMigrationUsage('job', 'up{job=~"${job:regex}"}')).toEqual({
        kind: 'filter',
        key: 'job',
        operator: '=~',
      });
    });
  });
});

describe('classifyDrilldownMigrationUsageForQuery', () => {
  it('classifies the query expr', () => {
    expect(
      classifyDrilldownMigrationUsageForQuery({ variableName: 'job', query: { refId: 'A', expr: 'up{job="$job"}' } })
    ).toEqual({ kind: 'filter', key: 'job', operator: '=' });
  });

  it('returns undefined for a query with no expr', () => {
    expect(classifyDrilldownMigrationUsageForQuery({ variableName: 'job', query: { refId: 'A', expr: '' } })).toBe(
      undefined
    );
  });
});
