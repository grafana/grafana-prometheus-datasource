import { config } from '@grafana/runtime';

import { DEFAULT_COMPLETION_LIMIT } from '../../../constants';
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
    queryMetricsMetadata: jest.fn().mockResolvedValue({}),
    retrieveLabelKeys: jest.fn(),
    retrieveMetricsMetadata: jest.fn().mockReturnValue({}),
    getSearchApiClient: jest.fn().mockReturnValue(undefined),
    datasource: {
      interpolateString: (value: string) => value,
    },
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

it('completes selector modifiers as keywords with their feature requirements', async () => {
  const completions = await getCompletions(
    { type: 'RANGE_MODIFIER', modifiers: ['anchored', 'smoothed'] },
    dataProvider,
    getMockTimeRange()
  );
  expect(completions.map(({ type, insertText }) => ({ type, insertText }))).toEqual([
    { type: 'KEYWORD', insertText: 'anchored' },
    { type: 'KEYWORD', insertText: 'smoothed' },
  ]);
  for (const completion of completions) {
    expect(completion.documentation).toContain('--enable-feature=promql-extended-range-selectors');
  }
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

describe('search batches', () => {
  const timeRange = getMockTimeRange();

  it('publishes metric batches and still resolves history, functions, and metrics', async () => {
    jest.spyOn(dataProvider, 'queryMetricNames').mockImplementation(async (_timeRange, _term, onBatch) => {
      onBatch?.(['metric_a']);
      onBatch?.(['metric_b']);
      return ['metric_a', 'metric_b'];
    });
    const onBatch = jest.fn();

    const completions = await getCompletions({ type: 'AT_ROOT' }, dataProvider, timeRange, 'metric', 'full', onBatch);

    const functionLabels = getFunctions().map((fn) => fn.label);
    expect(onBatch.mock.calls.map((call) => call[0].map((item: { label: string }) => item.label))).toEqual([
      functionLabels,
      ['metric_a'],
      ['metric_b'],
    ]);
    expect(onBatch.mock.calls[0][0].every((item: { type: string }) => item.type === 'FUNCTION')).toBe(true);
    expect(
      onBatch.mock.calls.slice(1).every((call) => call[0].every((item: { type: string }) => item.type === 'METRIC_NAME'))
    ).toBe(true);
    const functionsCount = getFunctions().length;
    expect(completions).toHaveLength(functionsCount + 2);
    expect(completions.slice(0, functionsCount).every((item) => item.type === 'FUNCTION')).toBe(true);
    expect(completions.filter((item) => item.type === 'METRIC_NAME').map((item) => item.label)).toEqual([
      'metric_a',
      'metric_b',
    ]);
  });

  it('publishes history and functions before metric batches when the editor is empty', async () => {
    jest.spyOn(dataProvider, 'queryMetricNames').mockImplementation(async (_timeRange, _term, onBatch) => {
      onBatch?.(['metric_a']);
      return ['metric_a'];
    });
    const onBatch = jest.fn();

    const completions = await getCompletions({ type: 'EMPTY' }, dataProvider, timeRange, undefined, 'full', onBatch);

    const firstBatch = onBatch.mock.calls[0][0] as Array<{ type: string; label: string }>;
    expect(firstBatch.slice(0, history.length).map((item) => item.label)).toEqual(history);
    expect(firstBatch.slice(0, history.length).every((item) => item.type === 'HISTORY')).toBe(true);
    expect(firstBatch.slice(history.length).every((item) => item.type === 'FUNCTION')).toBe(true);
    expect(onBatch.mock.calls[1][0].map((item: { label: string }) => item.label)).toEqual(['metric_a']);
    expect(completions.map((item) => item.type).slice(0, history.length + 1)).toEqual([
      'HISTORY',
      'HISTORY',
      'HISTORY',
      'FUNCTION',
    ]);
    expect(completions[completions.length - 1]).toMatchObject({ type: 'METRIC_NAME', label: 'metric_a' });
  });

  it('publishes label name batches without names already used in the selector', async () => {
    jest.spyOn(dataProvider, 'queryLabelKeys').mockImplementation(async (...args) => {
      const onBatch = args[4] as ((names: string[]) => void) | undefined;
      onBatch?.(['job', '__name__']);
      onBatch?.(['instance']);
      return ['job', '__name__', 'instance'];
    });
    const onBatch = jest.fn();

    const completions = await getCompletions(
      { type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME', otherLabels: [], betweenQuotes: false },
      dataProvider,
      timeRange,
      'j',
      'full',
      onBatch
    );

    expect(onBatch.mock.calls.map((call) => call[0].map((item: { label: string }) => item.label))).toEqual([
      ['job'],
      ['instance'],
    ]);
    expect(completions.map((item) => item.label)).toEqual(['job', 'instance']);
  });

  it('publishes label value batches', async () => {
    jest.spyOn(dataProvider, 'queryLabelValues').mockImplementation(async (...args) => {
      const onBatch = args[5] as ((values: string[]) => void) | undefined;
      onBatch?.(['api']);
      onBatch?.(['db']);
      return ['api', 'db'];
    });
    const onBatch = jest.fn();

    const completions = await getCompletions(
      {
        type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
        labelName: 'job',
        betweenQuotes: false,
        otherLabels: [],
      },
      dataProvider,
      timeRange,
      'a',
      'full',
      onBatch
    );

    expect(onBatch.mock.calls.map((call) => call[0].map((item: { label: string }) => item.label))).toEqual([
      ['api'],
      ['db'],
    ]);
    expect(completions.map((item) => item.insertText)).toEqual(['"api"', '"db"']);
  });

  it('does not publish batches for duration or function-only completions', async () => {
    const onBatch = jest.fn();
    const queryMetricNames = jest.spyOn(dataProvider, 'queryMetricNames').mockResolvedValue(['metric_a']);

    const durations = await getCompletions({ type: 'IN_DURATION' }, dataProvider, timeRange, undefined, 'full', onBatch);
    const functions = await getCompletions({ type: 'AT_ROOT' }, dataProvider, timeRange, 'me', 'partial', onBatch);

    expect(durations.length).toBeGreaterThan(0);
    expect(functions.every((item) => item.type === 'FUNCTION')).toBe(true);
    expect(queryMetricNames).not.toHaveBeenCalled();
    expect(onBatch).not.toHaveBeenCalled();
  });
});

describe('Label name completions', () => {
  it('passes the typed term to label name search', async () => {
    const queryLabelKeys = jest.spyOn(dataProvider, 'queryLabelKeys').mockResolvedValue(['environment']);
    const timeRange = getMockTimeRange();

    await getCompletions(
      { type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME', otherLabels: [], betweenQuotes: false },
      dataProvider,
      timeRange,
      'env'
    );

    expect(queryLabelKeys).toHaveBeenCalledWith(timeRange, undefined, DEFAULT_COMPLETION_LIMIT, 'env');
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

  it('passes the typed term to label value search', async () => {
    const queryLabelValues = jest.spyOn(dataProvider, 'queryLabelValues').mockResolvedValue(['production']);
    const situation: Situation = {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
      labelName: 'environment',
      betweenQuotes: true,
      otherLabels: [],
    };
    const timeRange = getMockTimeRange();

    await getCompletions(situation, dataProvider, timeRange, 'prod');

    expect(queryLabelValues).toHaveBeenCalledWith(
      timeRange,
      'environment',
      undefined,
      DEFAULT_COMPLETION_LIMIT,
      'prod'
    );
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
