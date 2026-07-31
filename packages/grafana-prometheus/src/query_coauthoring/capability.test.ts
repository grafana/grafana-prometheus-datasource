import { createPrometheusCoauthoringCapability } from './capability';
import { type PromMetricsMetadata } from '../types';

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
    getValue: () => value,
    setValue,
    getSelections: () => selections,
    setSelections,
    getModel: () => ({
      getOffsetAt: ({ column }: { column: number }) => column - 1,
      getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
      deltaDecorations,
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
    previewChangeClassName: 'coauthoring-preview-change',
    previewOriginalClassName: 'coauthoring-preview-original',
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
    const anchorElement = document.createElement('div');
    const listener = jest.fn();
    capability.subscribeToInvocation(listener);

    capability.invoke({ anchorElement, dismiss: jest.fn() });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ anchorElement }));
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

  it('stages a reversible read-only preview and highlights proposed changes', () => {
    const { capability, editor, setValue, setSelections, deltaDecorations, updateOptions } = setup();
    capability.invoke({ anchorElement: document.createElement('div'), dismiss: jest.fn() });

    expect(capability.stagePreview('increase(http_requests_total[5m])')).toEqual({
      changes: [
        expect.objectContaining({
          id: 'change-1',
          focus: 'outside',
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
});
