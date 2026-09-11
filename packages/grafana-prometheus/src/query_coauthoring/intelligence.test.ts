import { type PromMetricsMetadata } from '../types';

import { createPrometheusCoauthoringIntelligence, QUERY_COAUTHORING_MAX_CONTEXT_LABELS } from './intelligence';

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function selection(from: number, to: number) {
  return {
    selectionStartLineNumber: 1,
    selectionStartColumn: from + 1,
    positionLineNumber: 1,
    positionColumn: to + 1,
  };
}

function setup(initialValue = 'rate(http_requests_total[5m])') {
  let value = initialValue;
  let selections = [selection(5, 12)];
  const editor = {
    getValue: () => value,
    getSelections: () => selections,
    getModel: () => ({
      getOffsetAt: ({ column }: { column: number }) => column - 1,
    }),
  };
  const retrieveMetricsMetadata = jest.fn(
    (): PromMetricsMetadata => ({
      http_requests_total: { type: 'counter', help: 'Total HTTP requests.' },
      unrelated_metric: { type: 'gauge', help: 'Not relevant.' },
    })
  );
  const queryMetricsMetadata = jest.fn<Promise<PromMetricsMetadata>, []>().mockResolvedValue({});
  const queryMetricLabels = jest.fn<Promise<string[]>, [string]>().mockResolvedValue(['__name__', 'job', 'handler']);
  const intelligence = createPrometheusCoauthoringIntelligence({
    editor,
    createQuery: (nextValue: string) => ({ refId: 'A', expr: nextValue }),
    interpolate: (nextValue: string) => nextValue.replace('$metric', 'http_requests_total'),
    retrieveMetricsMetadata,
    queryMetricsMetadata,
    queryMetricLabels,
  });

  return {
    intelligence,
    queryMetricLabels,
    queryMetricsMetadata,
    retrieveMetricsMetadata,
    setSelections: (nextSelections: typeof selections) => {
      selections = nextSelections;
    },
    setValue: (nextValue: string) => {
      value = nextValue;
    },
  };
}

describe('createPrometheusCoauthoringIntelligence', () => {
  it('captures the full typed baseline and lexical selection before loading context', async () => {
    const { intelligence, queryMetricLabels } = setup();
    const captured = intelligence.captureInvocation('invocation-1');

    await expect(intelligence.readInvocation(captured)).resolves.toEqual({
      baseline: { refId: 'A', expr: 'rate(http_requests_total[5m])' },
      context: {
        revision: 'invocation-1',
        query: 'rate(http_requests_total[5m])',
        focusRanges: [{ from: 5, to: 24 }],
        language: expect.objectContaining({ id: 'promql', displayName: 'PromQL' }),
        metadata: [
          {
            kind: 'metric',
            name: 'http_requests_total',
            attributes: {
              type: 'counter',
              help: 'Total HTTP requests.',
              labels: ['handler', 'job'],
            },
          },
        ],
      },
    });
    expect(queryMetricLabels).toHaveBeenCalledWith('http_requests_total');
  });

  it('keeps the invocation atomic when Monaco changes after capture', async () => {
    const { intelligence, setSelections, setValue } = setup();
    const captured = intelligence.captureInvocation('invocation-1');

    setValue('up');
    setSelections([selection(0, 2)]);

    await expect(intelligence.readInvocation(captured)).resolves.toMatchObject({
      baseline: { expr: 'rate(http_requests_total[5m])' },
      context: { query: 'rate(http_requests_total[5m])', focusRanges: [{ from: 5, to: 24 }] },
    });
    await expect(intelligence.readInvocation(intelligence.captureInvocation('invocation-2'))).resolves.toMatchObject({
      baseline: { expr: 'up' },
      context: { query: 'up', focusRanges: [{ from: 0, to: 2 }] },
    });
  });

  it('loads metadata when the language-provider cache is empty', async () => {
    const { intelligence, queryMetricsMetadata, retrieveMetricsMetadata } = setup();
    retrieveMetricsMetadata.mockReturnValue({});
    queryMetricsMetadata.mockResolvedValue({
      http_requests_total: { type: 'counter', help: 'Fetched metadata.' },
    });

    await expect(intelligence.readInvocation(intelligence.captureInvocation('invocation-1'))).resolves.toMatchObject({
      context: {
        metadata: [
          {
            name: 'http_requests_total',
            attributes: { type: 'counter', help: 'Fetched metadata.', labels: ['handler', 'job'] },
          },
        ],
      },
    });
    expect(queryMetricsMetadata).toHaveBeenCalledTimes(1);
  });

  it('keeps labels and metric identity when metadata enrichment fails', async () => {
    const { intelligence, queryMetricsMetadata, retrieveMetricsMetadata } = setup();
    retrieveMetricsMetadata.mockReturnValue({});
    queryMetricsMetadata.mockRejectedValue(new Error('metadata unavailable'));

    await expect(intelligence.readInvocation(intelligence.captureInvocation('invocation-1'))).resolves.toMatchObject({
      context: {
        metadata: [{ kind: 'metric', name: 'http_requests_total', attributes: { labels: ['handler', 'job'] } }],
      },
    });
  });

  it('loads metadata and labels concurrently', async () => {
    const { intelligence, queryMetricLabels, queryMetricsMetadata, retrieveMetricsMetadata } = setup();
    const metadata = deferred<PromMetricsMetadata>();
    const labels = deferred<string[]>();
    retrieveMetricsMetadata.mockReturnValue({});
    queryMetricsMetadata.mockReturnValue(metadata.promise);
    queryMetricLabels.mockReturnValue(labels.promise);

    const invocationPromise = intelligence.readInvocation(intelligence.captureInvocation('invocation-1'));
    await Promise.resolve();

    expect(queryMetricsMetadata).toHaveBeenCalledTimes(1);
    expect(queryMetricLabels).toHaveBeenCalledTimes(1);

    metadata.resolve({ http_requests_total: { type: 'counter', help: 'Fetched metadata.' } });
    labels.resolve(['__name__', 'job']);

    await expect(invocationPromise).resolves.toMatchObject({
      context: { metadata: [{ name: 'http_requests_total', attributes: { type: 'counter', labels: ['job'] } }] },
    });
  });

  it('applies the label context budget after filtering and sorting', async () => {
    const { intelligence, queryMetricLabels } = setup();
    const labels = Array.from({ length: QUERY_COAUTHORING_MAX_CONTEXT_LABELS + 5 }, (_, index) => `label_${index}`);
    queryMetricLabels.mockResolvedValue(['__name__', ...labels]);

    const invocation = await intelligence.readInvocation(intelligence.captureInvocation('invocation-1'));

    expect(invocation.context.metadata[0].attributes?.labels).toEqual(
      labels.sort().slice(0, QUERY_COAUTHORING_MAX_CONTEXT_LABELS)
    );
  });

  it('uses interpolated PromQL for metadata while preserving the authored query', async () => {
    const { intelligence, queryMetricLabels } = setup('rate($metric[5m])');

    await expect(intelligence.readInvocation(intelligence.captureInvocation('invocation-1'))).resolves.toMatchObject({
      baseline: { expr: 'rate($metric[5m])' },
      context: { query: 'rate($metric[5m])', metadata: [{ name: 'http_requests_total' }] },
    });
    expect(queryMetricLabels).toHaveBeenCalledWith('http_requests_total');
  });

  it('prepares a typed proposal and semantic change list without mutating Monaco', () => {
    const { intelligence } = setup();
    const captured = intelligence.captureInvocation('invocation-1');

    expect(intelligence.prepareProposal(captured, 'increase(http_requests_total[5m])')).toEqual({
      status: 'ready',
      query: { refId: 'A', expr: 'increase(http_requests_total[5m])' },
      changes: [
        expect.objectContaining({
          id: 'change-1',
          original: 'rate',
          proposed: 'increase',
          kind: 'function',
        }),
      ],
    });
  });

  it('rejects invalid and unchanged proposals', () => {
    const { intelligence } = setup();
    const captured = intelligence.captureInvocation('invocation-1');

    expect(intelligence.prepareProposal(captured, 'sum(rate(http_requests_total[5m])')).toEqual({
      status: 'rejected',
      reason: 'invalid',
    });
    expect(intelligence.prepareProposal(captured, 'rate(http_requests_total[5m])')).toEqual({
      status: 'rejected',
      reason: 'unchanged',
    });
  });
});
