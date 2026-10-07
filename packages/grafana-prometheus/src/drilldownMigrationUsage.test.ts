import { classifyDrilldownMigrationUsage, type InterpolateWithVariable } from './drilldownMigrationUsage';
import { type PromQuery } from './types';

// Stand-in for `datasource.interpolateString` with `placeHolderScopedVars`: the classified variable
// gets the given value, other variables and macros get fixed values, unknown ones stay as written.
const OTHER_VALUES: Record<string, string> = {
  window: '5m',
  offset: '1d',
  ts: '1700000000',
  range: '1h',
  step: '1m',
  env: 'prod',
  __interval: '1s',
  __interval_ms: '1000',
  __rate_interval: '1s',
  __rate_interval_ms: '1000',
  __range: '1s',
  __range_s: '1',
  __range_ms: '1000',
  __to: '1700000000',
};

function interpolatorFor(variableName: string): InterpolateWithVariable {
  return (text, value) =>
    text.replace(
      /\$(\w+)|\[\[(\w+)(?::\w+)?\]\]|\$\{(\w+)(\.[^:}]+)?(?::([^}]+))?\}/g,
      (match, plain, bracket, braced, fieldPath, format) => {
        const name = plain ?? bracket ?? braced;
        const resolved = name === variableName ? value : OTHER_VALUES[name];
        if (resolved === undefined) {
          return match;
        }
        if (fieldPath) {
          // A field path on a plain string value resolves to nothing.
          return '';
        }
        return format === 'queryparam' ? `var-${name}=${resolved}` : resolved;
      }
    );
}

function classify(variableName: string, expr: string, extra: Partial<PromQuery> = {}) {
  return classifyDrilldownMigrationUsage({ refId: 'A', expr, ...extra }, interpolatorFor(variableName));
}

const unsafe = { kind: 'unsafe', reason: expect.any(String) };

describe('classifyDrilldownMigrationUsage', () => {
  describe('not referenced', () => {
    it('returns undefined when the variable is not used in the query', () => {
      expect(classify('job', 'up{instance="localhost"}')).toBeUndefined();
    });

    it('only classifies the requested variable', () => {
      expect(classify('job', 'up{env="$env", job="$job"}')).toEqual({ kind: 'filter', key: 'job', operator: '=' });
      expect(classify('instance', 'up{env="$env", job="$job"}')).toBeUndefined();
    });

    it('returns undefined for a query with no expr', () => {
      expect(classify('job', '')).toBeUndefined();
    });
  });

  describe('filter positions', () => {
    it.each([
      ['=~', 'up{job=~"$job"}'],
      ['=', 'up{job="$job"}'],
      ['!=', 'up{job!="$job"}'],
      ['!~', 'up{job!~"$job"}'],
    ])('classifies a whole %s matcher value as a filter', (operator, expr) => {
      expect(classify('job', expr)).toEqual({ kind: 'filter', key: 'job', operator });
    });

    it.each([['up{job="${job}"}'], ['up{job="[[job]]"}'], ['up{job=~"${job:regex}"}']])(
      'handles the %s syntax',
      (expr) => {
        expect(classify('job', expr)).toEqual(expect.objectContaining({ kind: 'filter', key: 'job' }));
      }
    );

    it('rejects the only matcher of a selector without a metric name', () => {
      expect(classify('job', '{job="$job"}')).toEqual(unsafe);
    });

    it.each([['{job="$job", env="prod"}'], ['{__name__="up", job="$job"}'], ['{"my.metric", job="$job"}']])(
      'accepts a matcher in %s, which keeps other content once removed',
      (expr) => {
        expect(classify('job', expr)).toEqual({ kind: 'filter', key: 'job', operator: '=' });
      }
    );

    it('classifies a quoted (utf8) label matcher', () => {
      expect(classify('val', 'up{"my label"=~"$val"}')).toEqual({ kind: 'filter', key: 'my label', operator: '=~' });
    });

    it('rejects a matcher value that combines the variable with other text', () => {
      expect(classify('job', 'up{job=~"prefix-$job"}')).toEqual(unsafe);
    });

    it('rejects a variable in label key position', () => {
      expect(classify('label', 'up{$label="foo"}')).toEqual(unsafe);
    });
  });

  describe('groupBy positions', () => {
    it.each([['sum by ($groupby) (up)'], ['sum by (job, $groupby) (up)'], ['sum(up) by ($groupby)']])(
      'classifies %s as groupBy',
      (expr) => {
        expect(classify('groupby', expr)).toEqual({ kind: 'groupBy' });
      }
    );

    it.each([['sum without ($groupby) (up)'], ['up / on ($groupby) up']])('rejects %s', (expr) => {
      expect(classify('groupby', expr)).toEqual(unsafe);
    });
  });

  describe('other positions', () => {
    it.each([['rate($metric[5m])'], ['label_replace(up, "dst", "$1", "src", "$metric")']])('rejects %s', (expr) => {
      expect(classify('metric', expr)).toEqual(unsafe);
    });
  });

  describe('multiple occurrences within one query', () => {
    it('agrees when every occurrence is the same filter key', () => {
      expect(classify('job', 'up{job="$job"} / down{job="$job"}')).toEqual({
        kind: 'filter',
        key: 'job',
        operator: '=',
      });
    });

    it('tolerates differing operators as long as the key agrees', () => {
      expect(classify('job', 'up{job="$job"} / down{job=~"$job"}')).toEqual({
        kind: 'filter',
        key: 'job',
        operator: '=',
      });
    });

    it.each([
      ['two label keys', 'up{job="$job"} / down{instance="$job"}'],
      ['a filter and a groupBy label', 'sum by ($job) (up{job="$job"})'],
      ['a safe and an unsafe position', 'up{job="$job"} / $job'],
    ])('is unsafe for %s', (_, expr) => {
      expect(classify('job', expr)).toEqual(unsafe);
    });
  });

  describe('interpolation of everything else', () => {
    it.each([
      ['rate(up{job="$job"}[$window])'],
      ['up{job="$job"} offset $offset'],
      ['up{job="$job"} @ $ts'],
      ['max_over_time(rate(up{job="$job"}[5m])[$range:$step])'],
      ['up{job="$job"} @ ${__to:date:seconds}'],
    ])('parses %s with the other variables and macros resolved', (expr) => {
      expect(classify('job', expr)).toEqual({ kind: 'filter', key: 'job', operator: '=' });
    });

    it.each([
      ['$__interval'],
      ['$__interval_ms'],
      ['$__rate_interval'],
      ['$__rate_interval_ms'],
      ['$__range'],
      ['$__range_s'],
      ['$__range_ms'],
    ])('accepts the backend-interpolated %s in a range', (macro) => {
      expect(classify('job', `rate(up{job="$job"}[${macro}])`)).toEqual({ kind: 'filter', key: 'job', operator: '=' });
    });

    it('rejects the classified variable in a range position', () => {
      expect(classify('window', 'rate(up[$window])')).toEqual(unsafe);
    });

    it('rejects a format that changes the value', () => {
      expect(classify('job', 'up{job="${job:queryparam}"}')).toEqual(unsafe);
    });

    it('treats a field path, which renders nothing either way, as not referencing the variable', () => {
      expect(classify('job', 'up{job="${job.field}"}')).toBeUndefined();
    });

    it('reports an unparsable expression as unsafe', () => {
      expect(classify('job', 'sum(up{job="$job"}')).toEqual(unsafe);
    });
  });

  describe('fields other than expr', () => {
    it.each([['legendFormat'], ['interval']])('is unsafe when the variable is also used in %s', (field) => {
      expect(classify('job', 'up{job="$job"}', { [field]: '{{instance}} $job' })).toEqual(unsafe);
    });

    it('ignores other variables used in other fields', () => {
      expect(classify('job', 'up{job="$job"}', { interval: '$window' })).toEqual({
        kind: 'filter',
        key: 'job',
        operator: '=',
      });
    });
  });
});
