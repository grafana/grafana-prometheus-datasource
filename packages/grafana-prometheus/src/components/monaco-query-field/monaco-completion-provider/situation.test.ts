// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/components/monaco-query-field/monaco-completion-provider/situation.test.ts
import { getSituation, type Situation } from './situation';

// we use the `^` character as the cursor-marker in the string.
function assertSituation(situation: string, expectedSituation: Situation | null) {
  // first we find the cursor-position
  const pos = situation.indexOf('^');
  if (pos === -1) {
    throw new Error('cursor missing');
  }

  // we remove the cursor-marker from the string
  const text = situation.replace('^', '');

  // sanity check, make sure no more cursor-markers remain
  if (text.indexOf('^') !== -1) {
    throw new Error('multiple cursors');
  }

  const result = getSituation(text, pos);

  if (expectedSituation === null) {
    expect(result).toStrictEqual(null);
  } else {
    expect(result).toMatchObject(expectedSituation);
  }
}

describe('situation', () => {
  it('handles things', () => {
    assertSituation('^', {
      type: 'EMPTY',
    });

    assertSituation('sum(one) / ^', {
      type: 'AT_ROOT',
    });

    assertSituation('sum(^)', {
      type: 'IN_FUNCTION',
    });

    assertSituation('sum(one) / sum(^)', {
      type: 'IN_FUNCTION',
    });

    assertSituation('something{}[^]', {
      type: 'IN_DURATION',
    });

    assertSituation('something{label~^}', null);
  });

  it('handles label names', () => {
    assertSituation('something{^}', {
      type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
      metricName: 'something',
      otherLabels: [],
      betweenQuotes: false,
    });

    assertSituation('sum(something) by (^)', {
      type: 'IN_GROUPING',
      metricName: 'something',
      otherLabels: [],
    });

    assertSituation('sum by (^) (something)', {
      type: 'IN_GROUPING',
      metricName: 'something',
      otherLabels: [],
    });

    assertSituation('something{one="val1",two!="val2",three=~"val3",four!~"val4",^}', {
      type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
      metricName: 'something',
      otherLabels: [
        { name: 'one', value: 'val1', op: '=' },
        { name: 'two', value: 'val2', op: '!=' },
        { name: 'three', value: 'val3', op: '=~' },
        { name: 'four', value: 'val4', op: '!~' },
      ],
      betweenQuotes: false,
    });

    assertSituation('{^}', {
      type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
      otherLabels: [],
      betweenQuotes: false,
    });

    assertSituation('{one="val1",^}', {
      type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
      otherLabels: [{ name: 'one', value: 'val1', op: '=' }],
      betweenQuotes: false,
    });

    // single-quoted label-values with escape
    assertSituation("{one='val\\'1',^}", {
      type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
      otherLabels: [{ name: 'one', value: "val'1", op: '=' }],
      betweenQuotes: false,
    });

    // double-quoted label-values with escape
    assertSituation('{one="val\\"1",^}', {
      type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
      otherLabels: [{ name: 'one', value: 'val"1', op: '=' }],
      betweenQuotes: false,
    });

    // backticked label-values with escape (the escape should not be interpreted)
    assertSituation('{one=`val\\"1`,^}', {
      type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
      otherLabels: [{ name: 'one', value: 'val\\"1', op: '=' }],
      betweenQuotes: false,
    });
  });

  describe('utf-8 metric name support', () => {
    it('with utf8 metric name no label and no comma', () => {
      assertSituation(`{"metric.name"^}`, null);
    });

    it('with utf8 metric name no label', () => {
      assertSituation(`{"metric.name", ^}`, {
        type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
        metricName: 'metric.name',
        otherLabels: [],
        betweenQuotes: false,
      });
    });

    it('with utf8 metric name requesting utf8 labels in quotes', () => {
      assertSituation(`{"metric.name", "^"}`, {
        type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
        metricName: 'metric.name',
        otherLabels: [],
        betweenQuotes: true,
      });
    });

    it('with utf8 metric name with a legacy label', () => {
      assertSituation(`{"metric.name", label1="val", ^}`, {
        type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
        metricName: 'metric.name',
        otherLabels: [{ name: 'label1', value: 'val', op: '=' }],
        betweenQuotes: false,
      });
    });

    it('with utf8 metric name with a legacy label and no value', () => {
      assertSituation(`{"metric.name", label1="^"}`, {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        metricName: 'metric.name',
        labelName: 'label1',
        betweenQuotes: true,
        otherLabels: [],
      });
    });

    it('with utf8 metric name with a utf8 label and no value', () => {
      assertSituation(`{"metric.name", "utf8.label"="^"}`, {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        metricName: 'metric.name',
        labelName: '"utf8.label"',
        betweenQuotes: true,
        otherLabels: [],
      });
    });

    it('with utf8 metric name with a legacy label and utf8 label', () => {
      assertSituation(`{"metric.name", label1="val", "utf8.label"="^"}`, {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        metricName: 'metric.name',
        labelName: `"utf8.label"`,
        betweenQuotes: true,
        otherLabels: [{ name: 'label1', value: 'val', op: '=' }],
      });
    });

    it('with utf8 metric name with a utf8 label and legacy label', () => {
      assertSituation(`{"metric.name", "utf8.label"="val",  label1="^"}`, {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        metricName: 'metric.name',
        labelName: `label1`,
        betweenQuotes: true,
        otherLabels: [{ name: '"utf8.label"', value: 'val', op: '=' }],
      });
    });

    it('with utf8 metric name with grouping', () => {
      assertSituation(`sum by (^)(rate({"metric.name", label1="val"}[1m]))`, {
        type: 'IN_GROUPING',
        metricName: 'metric.name',
        otherLabels: [],
      });
    });
  });

  it('utf-8 label support', () => {
    assertSituation(`metric{"label": "^"}`, null);

    assertSituation(`metric{"label with space": "^"}`, null);

    assertSituation(`metric{"label_🤖": "^"}`, null);

    assertSituation(`metric{"Spaß": "^"}`, null);

    assertSituation(`{"metric", "Spaß": "^"}`, null);

    assertSituation('something{"job"=^}', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      metricName: 'something',
      labelName: '"job"',
      betweenQuotes: false,
      otherLabels: [],
    });

    assertSituation('something{"job📈"=^}', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      metricName: 'something',
      labelName: '"job📈"',
      betweenQuotes: false,
      otherLabels: [],
    });

    assertSituation('something{"job with space"=^,host="h1"}', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      metricName: 'something',
      labelName: '"job with space"',
      betweenQuotes: false,
      otherLabels: [{ name: 'host', value: 'h1', op: '=' }],
    });
  });

  it('handles label values', () => {
    assertSituation('something{job=^}', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      metricName: 'something',
      labelName: 'job',
      betweenQuotes: false,
      otherLabels: [],
    });

    assertSituation('something{job!=^}', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      metricName: 'something',
      labelName: 'job',
      betweenQuotes: false,
      otherLabels: [],
    });

    assertSituation('something{job=~^}', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      metricName: 'something',
      labelName: 'job',
      betweenQuotes: false,
      otherLabels: [],
    });

    assertSituation('something{job!~^}', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      metricName: 'something',
      labelName: 'job',
      betweenQuotes: false,
      otherLabels: [],
    });

    assertSituation('something{job=^,host="h1"}', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      metricName: 'something',
      labelName: 'job',
      betweenQuotes: false,
      otherLabels: [{ name: 'host', value: 'h1', op: '=' }],
    });

    assertSituation('something{job="j1",host="^"}', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      metricName: 'something',
      labelName: 'host',
      betweenQuotes: true,
      otherLabels: [{ name: 'job', value: 'j1', op: '=' }],
    });

    assertSituation('something{job="j1"^}', null);
    assertSituation('something{job="j1" ^ }', null);
    assertSituation('something{job="j1" ^   ,   }', null);

    assertSituation('{job=^,host="h1"}', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      labelName: 'job',
      betweenQuotes: false,
      otherLabels: [{ name: 'host', value: 'h1', op: '=' }],
    });

    assertSituation('something{one="val1",two!="val2",three=^,four=~"val4",five!~"val5"}', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      metricName: 'something',
      labelName: 'three',
      betweenQuotes: false,
      otherLabels: [
        { name: 'one', value: 'val1', op: '=' },
        { name: 'two', value: 'val2', op: '!=' },
        { name: 'four', value: 'val4', op: '=~' },
        { name: 'five', value: 'val5', op: '!~' },
      ],
    });
  });

  it('identifies all labels from queries when cursor is in middle', () => {
    // Note the extra whitespace, if the cursor is after whitespace, the situation will fail to resolve
    assertSituation('{one="val1", ^,two!="val2",three=~"val3",four!~"val4"}', {
      type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
      otherLabels: [
        { name: 'one', value: 'val1', op: '=' },
        { name: 'two', value: 'val2', op: '!=' },
        { name: 'three', value: 'val3', op: '=~' },
        { name: 'four', value: 'val4', op: '!~' },
      ],
      betweenQuotes: false,
    });
  });
});

// Same cursor convention as assertSituation, but with the info-labels flag enabled.
function assertInfoSituation(situation: string, expectedSituation: Situation | null) {
  const pos = situation.indexOf('^');
  if (pos === -1) {
    throw new Error('cursor missing');
  }
  const text = situation.replace('^', '');
  if (text.indexOf('^') !== -1) {
    throw new Error('multiple cursors');
  }
  const result = getSituation(text, pos, true);
  if (expectedSituation === null) {
    expect(result).toStrictEqual(null);
  } else {
    expect(result).toMatchObject(expectedSituation);
  }
}

describe('situation - info() label autocomplete', () => {
  it('detects the second argument label-name context', () => {
    assertInfoSituation('info(up, {^})', {
      type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
      infoExpr: 'up',
      otherLabels: [],
      betweenQuotes: false,
    });
  });

  it('returns null for an unclosed brace, consistent with generic label behavior', () => {
    // Monaco auto-inserts the closing brace, so the realistic typed state is `info(up, {})`.
    // An unclosed `{` produces a bare error node that no resolver matches - the same fallback
    // the generic (non-info) code path exhibits for `something{`.
    assertInfoSituation('info(up, {^', null);
    assertSituation('something{^', null);
  });

  it('captures a complex first argument as infoExpr', () => {
    assertInfoSituation('info(rate(http_requests_total[5m]), {^})', {
      type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
      infoExpr: 'rate(http_requests_total[5m])',
      otherLabels: [],
      betweenQuotes: false,
    });
  });

  it('captures a first argument with a selector as infoExpr', () => {
    assertInfoSituation('info(http_requests_total{job="api"}, {^})', {
      type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
      infoExpr: 'http_requests_total{job="api"}',
      otherLabels: [],
      betweenQuotes: false,
    });
  });

  it('detects the value context for a label inside the second argument', () => {
    assertInfoSituation('info(rate(http_requests_total[5m]), {foo="^"})', {
      type: 'IN_INFO_SELECTOR_WITH_LABEL_NAME',
      infoExpr: 'rate(http_requests_total[5m])',
      labelName: 'foo',
      betweenQuotes: true,
      otherLabels: [],
    });
  });

  it('includes already-present labels as otherLabels', () => {
    assertInfoSituation('info(up, {foo="bar", ^})', {
      type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
      infoExpr: 'up',
      otherLabels: [{ name: 'foo', value: 'bar', op: '=' }],
      betweenQuotes: false,
    });
  });

  it('does NOT treat the first argument selector as an info context', () => {
    assertInfoSituation('info(up{job="^"}, {})', {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      metricName: 'up',
      labelName: 'job',
      betweenQuotes: true,
      otherLabels: [],
    });
  });

  it('falls back to generic label behavior when the flag is off', () => {
    // identical query, but using the default getSituation (flag off)
    assertSituation('info(up, {^})', {
      type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
      otherLabels: [],
      betweenQuotes: false,
    });
  });

  it('does not affect non-info function calls', () => {
    assertInfoSituation('count(up, {^})', {
      type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
      otherLabels: [],
      betweenQuotes: false,
    });
  });

  describe('metric_match extraction from a __name__ matcher', () => {
    it('encodes an = matcher as the bare value', () => {
      assertInfoSituation('info(up, {__name__="build_info", ^})', {
        type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
        infoExpr: 'up',
        infoMetricMatch: 'build_info',
        otherLabels: [{ name: '__name__', value: 'build_info', op: '=' }],
        betweenQuotes: false,
      });
    });

    it('encodes a =~ matcher with a ~ prefix', () => {
      assertInfoSituation('info(up, {__name__=~".*_info", ^})', {
        type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
        infoExpr: 'up',
        infoMetricMatch: '~.*_info',
        otherLabels: [{ name: '__name__', value: '.*_info', op: '=~' }],
        betweenQuotes: false,
      });
    });

    it('encodes a != matcher with a != prefix', () => {
      assertInfoSituation('info(up, {__name__!="target_info", ^})', {
        type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
        infoExpr: 'up',
        infoMetricMatch: '!=target_info',
        otherLabels: [{ name: '__name__', value: 'target_info', op: '!=' }],
        betweenQuotes: false,
      });
    });

    it('encodes a !~ matcher with a !~ prefix', () => {
      assertInfoSituation('info(up, {__name__!~".*_info", ^})', {
        type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
        infoExpr: 'up',
        infoMetricMatch: '!~.*_info',
        otherLabels: [{ name: '__name__', value: '.*_info', op: '!~' }],
        betweenQuotes: false,
      });
    });

    it('exposes infoMetricMatch in the value context too', () => {
      assertInfoSituation('info(up, {__name__=~".*_info", version="^"})', {
        type: 'IN_INFO_SELECTOR_WITH_LABEL_NAME',
        infoExpr: 'up',
        infoMetricMatch: '~.*_info',
        labelName: 'version',
        otherLabels: [{ name: '__name__', value: '.*_info', op: '=~' }],
        betweenQuotes: true,
      });
    });

    it('omits infoMetricMatch when there is no __name__ matcher', () => {
      const prefix = 'info(up, {version="v1", ';
      const result = getSituation(`${prefix}})`, prefix.length, true);
      expect(result).toMatchObject({
        type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
        infoExpr: 'up',
      });
      expect(result).not.toHaveProperty('infoMetricMatch');
    });
  });
});
