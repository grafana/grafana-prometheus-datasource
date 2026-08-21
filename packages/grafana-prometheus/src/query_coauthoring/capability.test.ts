import { createPrometheusCoauthoringCapability, QUERY_COAUTHORING_MAX_CONTEXT_LABELS } from './capability';
import { type PromMetricsMetadata } from '../types';

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function setup(initialValue = 'rate(http_requests_total[5m])') {
  let value = initialValue;
  let selections = [selection(5, 12)];
  let readOnly = false;
  const focus = jest.fn();
  const setValue = jest.fn((nextValue: string) => {
    value = nextValue;
  });
  const setSelections = jest.fn((nextSelections: typeof selections) => {
    selections = nextSelections;
  });
  const deltaDecorations = jest.fn((_oldDecorations, newDecorations) =>
    newDecorations.map((_: unknown, index: number) => `decoration-${index}`)
  );
  const updateOptions = jest.fn((options: { readOnly: boolean }) => {
    readOnly = options.readOnly;
  });
  const editor = {
    deltaDecorations,
    getValue: () => value,
    setValue,
    getSelections: () => selections,
    setSelections,
    getModel: () => ({
      getOffsetAt: ({ column }: { column: number }) => column - 1,
      getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
    }),
    getRawOptions: () => ({ readOnly }),
    updateOptions,
    focus,
  };
  const retrieveMetricsMetadata = jest.fn(
    (): PromMetricsMetadata => ({
      http_requests_total: { type: 'counter', help: 'Total HTTP requests.' },
      unrelated_metric: { type: 'gauge', help: 'Not relevant.' },
    })
  );
  const queryMetricsMetadata = jest.fn<Promise<PromMetricsMetadata>, []>().mockResolvedValue({});
  const queryMetricLabels = jest.fn<Promise<string[]>, [string]>().mockResolvedValue(['__name__', 'job', 'handler']);
  const capability = createPrometheusCoauthoringCapability({
    editor,
    createQuery: (nextValue) => ({ refId: 'A', expr: nextValue }),
    interpolate: (nextValue) => nextValue.replace('$metric', 'http_requests_total'),
    retrieveMetricsMetadata,
    queryMetricsMetadata,
    queryMetricLabels,
    getPreviewChangeClassName: () => 'coauthoring-preview-change',
    getPreviewOriginalClassName: () => 'coauthoring-preview-original',
  });

  return {
    capability,
    deltaDecorations,
    editor,
    focus,
    queryMetricsMetadata,
    queryMetricLabels,
    retrieveMetricsMetadata,
    setSelections,
    setValue,
    updateOptions,
    setEditorSelections: (nextSelections: typeof selections) => {
      selections = nextSelections;
    },
  };
}

function selection(from: number, to: number) {
  return {
    selectionStartLineNumber: 1,
    selectionStartColumn: from + 1,
    positionLineNumber: 1,
    positionColumn: to + 1,
  };
}

describe('createPrometheusCoauthoringCapability', () => {
  it('captures lexical selection boundaries and only relevant cached metric metadata', async () => {
    const { capability, queryMetricLabels } = setup();
    capability.captureContext();

    await expect(capability.getContext()).resolves.toEqual({
      query: 'rate(http_requests_total[5m])',
      focusRanges: [{ from: 5, to: 24 }],
      metricMetadata: [
        {
          name: 'http_requests_total',
          type: 'counter',
          help: 'Total HTTP requests.',
          unit: undefined,
          labels: ['handler', 'job'],
        },
      ],
    });
    expect(queryMetricLabels).toHaveBeenCalledWith('http_requests_total');
  });

  it('refreshes the invocation snapshot from the current editor selection', async () => {
    const query = 'rate(http_requests_total[5m])';
    const { capability, setEditorSelections } = setup(query);
    capability.captureContext();

    setEditorSelections([selection(0, query.length)]);

    await expect(capability.getContext()).resolves.toMatchObject({
      focusRanges: [{ from: 5, to: 24 }],
    });
    await expect(capability.refreshContext()).resolves.toMatchObject({
      query,
      focusRanges: [{ from: 0, to: query.length }],
    });
    await expect(capability.getContext()).resolves.toMatchObject({
      focusRanges: [{ from: 0, to: query.length }],
    });
  });

  it('loads metadata when the language-provider cache is empty', async () => {
    const { capability, retrieveMetricsMetadata, queryMetricsMetadata } = setup();
    retrieveMetricsMetadata.mockReturnValue({});
    queryMetricsMetadata.mockResolvedValue({
      http_requests_total: { type: 'counter', help: 'Fetched metadata.' },
    });

    await expect(capability.getContext()).resolves.toMatchObject({
      metricMetadata: [{ name: 'http_requests_total', type: 'counter', help: 'Fetched metadata.' }],
    });
    expect(queryMetricsMetadata).toHaveBeenCalledTimes(1);
  });

  it('keeps labels and metric identity when metadata enrichment fails', async () => {
    const { capability, retrieveMetricsMetadata, queryMetricsMetadata } = setup();
    retrieveMetricsMetadata.mockReturnValue({});
    queryMetricsMetadata.mockRejectedValue(new Error('metadata unavailable'));

    await expect(capability.getContext()).resolves.toEqual({
      query: 'rate(http_requests_total[5m])',
      focusRanges: [{ from: 5, to: 24 }],
      metricMetadata: [
        {
          name: 'http_requests_total',
          type: undefined,
          help: undefined,
          unit: undefined,
          labels: ['handler', 'job'],
        },
      ],
    });
  });

  it('loads metadata and labels concurrently', async () => {
    const { capability, queryMetricLabels, queryMetricsMetadata, retrieveMetricsMetadata } = setup();
    const metadata = deferred<PromMetricsMetadata>();
    const labels = deferred<string[]>();
    retrieveMetricsMetadata.mockReturnValue({});
    queryMetricsMetadata.mockReturnValue(metadata.promise);
    queryMetricLabels.mockReturnValue(labels.promise);

    const contextPromise = capability.getContext();
    await Promise.resolve();

    expect(queryMetricsMetadata).toHaveBeenCalledTimes(1);
    expect(queryMetricLabels).toHaveBeenCalledTimes(1);

    metadata.resolve({ http_requests_total: { type: 'counter', help: 'Fetched metadata.' } });
    labels.resolve(['__name__', 'job']);

    await expect(contextPromise).resolves.toMatchObject({
      metricMetadata: [{ name: 'http_requests_total', type: 'counter', labels: ['job'] }],
    });
  });

  it('retains cached metadata when a refresh resolves without the missing metric', async () => {
    const { capability, queryMetricsMetadata } = setup('http_requests_total + missing_metric');
    queryMetricsMetadata.mockResolvedValue({});

    await expect(capability.getContext()).resolves.toMatchObject({
      metricMetadata: [
        { name: 'http_requests_total', type: 'counter', labels: ['handler', 'job'] },
        { name: 'missing_metric', type: undefined, labels: ['handler', 'job'] },
      ],
    });
  });

  it('treats synchronous metadata provider failures as optional enrichment', async () => {
    const { capability, queryMetricsMetadata, retrieveMetricsMetadata } = setup();
    retrieveMetricsMetadata.mockImplementation(() => {
      throw new Error('cache unavailable');
    });
    queryMetricsMetadata.mockImplementation(() => {
      throw new Error('metadata unavailable');
    });

    await expect(capability.getContext()).resolves.toMatchObject({
      metricMetadata: [{ name: 'http_requests_total', type: undefined, labels: ['handler', 'job'] }],
    });
  });

  it('applies the shared label context budget after filtering and sorting', async () => {
    const { capability, queryMetricLabels } = setup();
    const labels = Array.from({ length: QUERY_COAUTHORING_MAX_CONTEXT_LABELS + 5 }, (_, index) => `label_${index}`);
    queryMetricLabels.mockResolvedValue(['__name__', ...labels]);

    const context = await capability.getContext();

    expect(context.metricMetadata[0].labels).toEqual(labels.sort().slice(0, QUERY_COAUTHORING_MAX_CONTEXT_LABELS));
  });

  it('uses the interpolated query for metric metadata while preserving the original query', async () => {
    const { capability, queryMetricLabels } = setup('rate($metric[5m])');

    await expect(capability.getContext()).resolves.toMatchObject({
      query: 'rate($metric[5m])',
      metricMetadata: [{ name: 'http_requests_total', type: 'counter' }],
    });
    expect(queryMetricLabels).toHaveBeenCalledWith('http_requests_total');
  });

  it('stages a reversible read-only preview and highlights proposed changes', () => {
    const { capability, editor, setValue, setSelections, deltaDecorations, updateOptions } = setup();
    capability.captureContext();

    expect(capability.stagePreview('increase(http_requests_total[5m])')).toEqual({
      changes: [
        expect.objectContaining({
          id: 'change-1',
          original: 'rate',
          proposed: 'increase',
          kind: 'function',
        }),
      ],
    });
    expect(setValue).not.toHaveBeenCalled();
    expect(deltaDecorations).toHaveBeenCalledWith(
      [],
      [
        expect.objectContaining({
          options: {
            inlineClassName: 'coauthoring-preview-original',
            before: { content: 'increase', inlineClassName: 'coauthoring-preview-change' },
          },
        }),
      ]
    );
    expect(updateOptions).toHaveBeenCalledWith({ readOnly: true });
    expect(editor.getValue()).toBe('rate(http_requests_total[5m])');
    expect(capability.getValue()).toBe('rate(http_requests_total[5m])');

    capability.clearPreview();

    expect(setValue).not.toHaveBeenCalled();
    expect(setSelections).not.toHaveBeenCalled();
    expect(deltaDecorations).toHaveBeenLastCalledWith(['decoration-0'], []);
    expect(updateOptions).toHaveBeenLastCalledWith({ readOnly: false });
  });

  it('does not lock the editor for a no-op proposal', () => {
    const { capability, deltaDecorations, updateOptions } = setup();
    capability.captureContext();

    expect(capability.stagePreview('rate(http_requests_total[5m])')).toBeUndefined();
    expect(deltaDecorations).not.toHaveBeenCalled();
    expect(updateOptions).not.toHaveBeenCalled();
  });

  it('validates interpolated PromQL and exposes no query-run command', () => {
    const { capability, focus } = setup('rate($metric[5m])');

    expect(capability.createQuery('increase($metric[5m])')).toEqual({
      refId: 'A',
      expr: 'increase($metric[5m])',
    });
    expect(capability.validateQuery('sum(rate($metric[5m]))')).toBe(true);
    expect(capability.validateQuery('sum(rate($metric[5m])')).toBe(false);

    capability.focus();
    expect(focus).toHaveBeenCalled();
    expect(capability).not.toHaveProperty('runQuery');
  });

  it('replaces the captured context when a new session begins', async () => {
    const { capability, setValue } = setup();
    capability.captureContext();

    setValue('up');
    capability.captureContext();
    setValue('down');

    await expect(capability.getContext()).resolves.toMatchObject({ query: 'up' });
  });
});
