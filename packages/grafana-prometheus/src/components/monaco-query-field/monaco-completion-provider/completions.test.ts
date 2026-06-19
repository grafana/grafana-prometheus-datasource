import { config } from '@grafana/runtime';

import { getFunctions } from '../../../promql';
import { getMockTimeRange } from '../../../test/mocks/datasource';

import { getCompletions } from './completions';
import { DataProvider, type DataProviderParams } from './data_provider';
import type { Situation } from './situation';

const history: string[] = ['previous_metric_name_1', 'previous_metric_name_2', 'previous_metric_name_3'];
const dataProviderSettings = {
  languageProvider: {
    queryLabelKeys: jest.fn(),
    queryLabelValues: jest.fn(),
    queryInfoLabels: jest.fn(),
    queryMetricsMetadata: jest.fn().mockResolvedValue({}),
    retrieveLabelKeys: jest.fn(),
    retrieveMetricsMetadata: jest.fn().mockReturnValue({}),
  },
  historyProvider: history.map((expr, idx) => ({ query: { expr, refId: 'some-ref' }, ts: idx })),
} as unknown as DataProviderParams;
let dataProvider = new DataProvider(dataProviderSettings);

beforeEach(() => {
  dataProvider = new DataProvider(dataProviderSettings);
});

afterEach(() => {
  jest.restoreAllMocks();
});

type MetricNameSituation = Extract<Situation['type'], 'AT_ROOT' | 'EMPTY' | 'IN_FUNCTION'>;
const metricNameCompletionSituations = ['AT_ROOT', 'IN_FUNCTION', 'EMPTY'] as MetricNameSituation[];

describe.each(metricNameCompletionSituations)('metric name completions in situation %s', (situationType) => {
  const timeRange = getMockTimeRange();
  const sampleMetricNames = ['metric_a', 'metric_b', 'metric_c'];
  const situation: Situation = { type: situationType };

  // Metric-name filtering is performed server-side via DataProvider.queryMetricNames, so these
  // tests assert the completion list that getCompletions assembles around the returned names
  // (ordering, counts, search-term forwarding) rather than any client-side fuzzy matching.

  it('returns history (EMPTY only), functions and metric names in order on a full trigger', async () => {
    jest.spyOn(dataProvider, 'queryMetricNames').mockResolvedValue(sampleMetricNames);

    const completions = await getCompletions(situation, dataProvider, timeRange, undefined, 'full');

    const functionsCount = getFunctions().length;
    const historyCount = situationType === 'EMPTY' ? history.length : 0;
    expect(completions).toHaveLength(historyCount + functionsCount + sampleMetricNames.length);

    // Metric names are appended last and preserve the order returned by the data provider.
    const metricCompletions = completions.filter((c) => c.type === 'METRIC_NAME');
    expect(metricCompletions.map((c) => c.label)).toEqual(sampleMetricNames);

    if (situationType === 'EMPTY') {
      expect(completions.slice(0, history.length).every((c) => c.type === 'HISTORY')).toBe(true);
    }
  });

  it('forwards the search term to the data provider', async () => {
    const spy = jest.spyOn(dataProvider, 'queryMetricNames').mockResolvedValue([]);

    await getCompletions(situation, dataProvider, timeRange, 'node_cpu', 'full');

    expect(spy).toHaveBeenCalledWith(timeRange, 'node_cpu');
  });

  it('returns only functions and never queries metric names on a partial trigger', async () => {
    const spy = jest.spyOn(dataProvider, 'queryMetricNames').mockResolvedValue(sampleMetricNames);

    const completions = await getCompletions(situation, dataProvider, timeRange, 'metric', 'partial');

    expect(completions.every((c) => c.type === 'FUNCTION')).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('metric name completions (utf8)', () => {
  const timeRange = getMockTimeRange();

  it('wraps utf8 metric names as quoted snippets', async () => {
    jest.spyOn(dataProvider, 'queryMetricNames').mockResolvedValue(['metric.with.dots']);

    const completions = await getCompletions({ type: 'AT_ROOT' }, dataProvider, timeRange, undefined, 'full');

    const utf8 = completions.find((c) => c.label === 'metric.with.dots');
    expect(utf8?.insertText).toBe('{"metric.with.dots"${1:}}');
    // 4 === languages.CompletionItemInsertTextRule.InsertAsSnippet
    expect(utf8?.insertTextRules).toBe(4);
  });
});

describe('Label value completions', () => {
  let dataProvider: DataProvider;

  beforeEach(() => {
    dataProvider = {
      queryLabelValues: jest.fn().mockResolvedValue(['value1', 'value"2', 'value\\3', "value'4"]),
    } as unknown as DataProvider;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('with prometheusSpecialCharsInLabelValues disabled', () => {
    beforeEach(() => {
      jest.replaceProperty(config, 'featureToggles', {
        prometheusSpecialCharsInLabelValues: false,
      });
    });

    const timeRange = getMockTimeRange();

    it('should not escape special characters when between quotes', async () => {
      const situation: Situation = {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        labelName: 'testLabel',
        betweenQuotes: true,
        otherLabels: [],
      };

      const completions = await getCompletions(situation, dataProvider, timeRange);

      expect(completions).toHaveLength(4);
      expect(completions[0].insertText).toBe('value1');
      expect(completions[1].insertText).toBe('value"2');
      expect(completions[2].insertText).toBe('value\\3');
      expect(completions[3].insertText).toBe("value'4");
    });

    it('should wrap in quotes but not escape special characters when not between quotes', async () => {
      const situation: Situation = {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        labelName: 'testLabel',
        betweenQuotes: false,
        otherLabels: [],
      };

      const completions = await getCompletions(situation, dataProvider, timeRange);

      expect(completions).toHaveLength(4);
      expect(completions[0].insertText).toBe('"value1"');
      expect(completions[1].insertText).toBe('"value"2"');
      expect(completions[2].insertText).toBe('"value\\3"');
      expect(completions[3].insertText).toBe('"value\'4"');
    });
  });

  describe('with prometheusSpecialCharsInLabelValues enabled', () => {
    beforeEach(() => {
      jest.replaceProperty(config, 'featureToggles', {
        prometheusSpecialCharsInLabelValues: true,
      });
    });

    const timeRange = getMockTimeRange();

    it('should escape special characters when between quotes', async () => {
      const situation: Situation = {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        labelName: 'testLabel',
        betweenQuotes: true,
        otherLabels: [],
      };

      const completions = await getCompletions(situation, dataProvider, timeRange);

      expect(completions).toHaveLength(4);
      expect(completions[0].insertText).toBe('value1');
      expect(completions[1].insertText).toBe('value\\"2');
      expect(completions[2].insertText).toBe('value\\\\3');
      expect(completions[3].insertText).toBe("value'4");
    });

    it('should wrap in quotes and escape special characters when not between quotes', async () => {
      const situation: Situation = {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        labelName: 'testLabel',
        betweenQuotes: false,
        otherLabels: [],
      };

      const completions = await getCompletions(situation, dataProvider, timeRange);

      expect(completions).toHaveLength(4);
      expect(completions[0].insertText).toBe('"value1"');
      expect(completions[1].insertText).toBe('"value\\"2"');
      expect(completions[2].insertText).toBe('"value\\\\3"');
      expect(completions[3].insertText).toBe('"value\'4"');
    });
  });

  describe('label value escaping edge cases', () => {
    beforeEach(() => {
      jest.replaceProperty(config, 'featureToggles', {
        prometheusSpecialCharsInLabelValues: true,
      });
    });

    const timeRange = getMockTimeRange();

    it('should handle empty values', async () => {
      jest.spyOn(dataProvider, 'queryLabelValues').mockResolvedValue(['']);

      const situation: Situation = {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        labelName: 'testLabel',
        betweenQuotes: false,
        otherLabels: [],
      };

      const completions = await getCompletions(situation, dataProvider, timeRange);
      expect(completions).toHaveLength(1);
      expect(completions[0].insertText).toBe('""');
    });

    it('should handle values with multiple special characters', async () => {
      jest.spyOn(dataProvider, 'queryLabelValues').mockResolvedValue(['test"\\value']);

      const situation: Situation = {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        labelName: 'testLabel',
        betweenQuotes: true,
        otherLabels: [],
      };

      const completions = await getCompletions(situation, dataProvider, timeRange);
      expect(completions).toHaveLength(1);
      expect(completions[0].insertText).toBe('test\\"\\\\value');
    });

    it('should handle non-string values', async () => {
      jest.spyOn(dataProvider, 'queryLabelValues').mockResolvedValue([123 as unknown as string]);

      const situation: Situation = {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        labelName: 'testLabel',
        betweenQuotes: false,
        otherLabels: [],
      };

      const completions = await getCompletions(situation, dataProvider, timeRange);
      expect(completions).toHaveLength(1);
      expect(completions[0].insertText).toBe('"123"');
    });
  });
});

describe('info() label completions', () => {
  const timeRange = getMockTimeRange();
  let infoDataProvider: DataProvider;

  beforeEach(() => {
    infoDataProvider = {
      getInfoLabels: jest.fn(),
    } as unknown as DataProvider;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('IN_INFO_SELECTOR_NO_LABEL_NAME (label names)', () => {
    it('emits label-name completions with the "=" suffix and triggerOnInsert', async () => {
      jest.spyOn(infoDataProvider, 'getInfoLabels').mockResolvedValue([
        { name: 'version', values: ['v1.0', 'v2.0'] },
        { name: 'env', values: ['prod'] },
      ]);

      const situation: Situation = {
        type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
        infoExpr: 'up',
        otherLabels: [],
        betweenQuotes: false,
      };

      const completions = await getCompletions(situation, infoDataProvider, timeRange);

      expect(infoDataProvider.getInfoLabels).toHaveBeenCalledWith(timeRange, 'up');
      expect(completions).toEqual([
        { type: 'LABEL_NAME', label: 'version', insertText: 'version=', triggerOnInsert: true },
        { type: 'LABEL_NAME', label: 'env', insertText: 'env=', triggerOnInsert: true },
      ]);
    });

    it('excludes labels already present in the selector', async () => {
      jest.spyOn(infoDataProvider, 'getInfoLabels').mockResolvedValue([
        { name: 'version', values: ['v1.0'] },
        { name: 'env', values: ['prod'] },
      ]);

      const situation: Situation = {
        type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
        infoExpr: 'up',
        otherLabels: [{ name: 'env', value: 'prod', op: '=' }],
        betweenQuotes: false,
      };

      const completions = await getCompletions(situation, infoDataProvider, timeRange);

      expect(completions.map((c) => c.label)).toEqual(['version']);
    });

    it('quotes UTF-8 label names as snippets', async () => {
      jest
        .spyOn(infoDataProvider, 'getInfoLabels')
        .mockResolvedValue([{ name: 'k8s.cluster', values: ['c1'] }]);

      const situation: Situation = {
        type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
        infoExpr: 'up',
        otherLabels: [],
        betweenQuotes: false,
      };

      const completions = await getCompletions(situation, infoDataProvider, timeRange);

      expect(completions[0].insertText).toBe('"k8s.cluster"=');
      expect(completions[0].insertTextRules).toBe(4);
    });

    it('returns an empty list when there are no records', async () => {
      jest.spyOn(infoDataProvider, 'getInfoLabels').mockResolvedValue([]);

      const situation: Situation = {
        type: 'IN_INFO_SELECTOR_NO_LABEL_NAME',
        infoExpr: 'up',
        otherLabels: [],
        betweenQuotes: false,
      };

      const completions = await getCompletions(situation, infoDataProvider, timeRange);
      expect(completions).toEqual([]);
    });
  });

  describe('IN_INFO_SELECTOR_WITH_LABEL_NAME (label values)', () => {
    beforeEach(() => {
      jest.replaceProperty(config, 'featureToggles', { prometheusSpecialCharsInLabelValues: false });
    });

    it('emits the values of the chosen label', async () => {
      jest.spyOn(infoDataProvider, 'getInfoLabels').mockResolvedValue([
        { name: 'version', values: ['v1.0', 'v2.0'] },
        { name: 'env', values: ['prod'] },
      ]);

      const situation: Situation = {
        type: 'IN_INFO_SELECTOR_WITH_LABEL_NAME',
        infoExpr: 'up',
        labelName: 'version',
        otherLabels: [],
        betweenQuotes: true,
      };

      const completions = await getCompletions(situation, infoDataProvider, timeRange);

      expect(completions).toEqual([
        { type: 'LABEL_VALUE', label: 'v1.0', insertText: 'v1.0' },
        { type: 'LABEL_VALUE', label: 'v2.0', insertText: 'v2.0' },
      ]);
    });

    it('wraps values in quotes when not between quotes', async () => {
      jest.spyOn(infoDataProvider, 'getInfoLabels').mockResolvedValue([{ name: 'version', values: ['v1.0'] }]);

      const situation: Situation = {
        type: 'IN_INFO_SELECTOR_WITH_LABEL_NAME',
        infoExpr: 'up',
        labelName: 'version',
        otherLabels: [],
        betweenQuotes: false,
      };

      const completions = await getCompletions(situation, infoDataProvider, timeRange);
      expect(completions[0].insertText).toBe('"v1.0"');
    });

    it('matches a quoted (UTF-8) label name against the unquoted record name', async () => {
      jest.spyOn(infoDataProvider, 'getInfoLabels').mockResolvedValue([{ name: 'k8s.cluster', values: ['c1'] }]);

      const situation: Situation = {
        type: 'IN_INFO_SELECTOR_WITH_LABEL_NAME',
        infoExpr: 'up',
        labelName: '"k8s.cluster"',
        otherLabels: [],
        betweenQuotes: true,
      };

      const completions = await getCompletions(situation, infoDataProvider, timeRange);
      expect(completions.map((c) => c.label)).toEqual(['c1']);
    });

    it('returns an empty list when the label is unknown', async () => {
      jest.spyOn(infoDataProvider, 'getInfoLabels').mockResolvedValue([{ name: 'version', values: ['v1.0'] }]);

      const situation: Situation = {
        type: 'IN_INFO_SELECTOR_WITH_LABEL_NAME',
        infoExpr: 'up',
        labelName: 'missing',
        otherLabels: [],
        betweenQuotes: true,
      };

      const completions = await getCompletions(situation, infoDataProvider, timeRange);
      expect(completions).toEqual([]);
    });
  });
});
