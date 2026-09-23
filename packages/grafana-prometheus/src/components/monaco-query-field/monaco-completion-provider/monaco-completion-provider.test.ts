import { dateTime, type TimeRange } from '@grafana/data';
import type { Monaco, monacoTypes } from '@grafana/ui';

import { type DataProvider } from './data_provider';
import { getCompletionProvider, getSuggestOptions } from './monaco-completion-provider';

// Mock the dependencies
jest.mock('./completions');
jest.mock('./situation');

const mockGetCompletions = jest.fn();
const mockGetSituation = jest.fn();

jest.mock('./completions', () => ({
  getCompletions: (...args: Parameters<typeof mockGetCompletions>) => mockGetCompletions(...args),
}));

jest.mock('./situation', () => ({
  getSituation: (...args: Parameters<typeof mockGetSituation>) => mockGetSituation(...args),
}));

// Create proper Monaco mocks without 'any'
const createMockMonaco = (): Monaco => {
  const mockRange = {
    lift: jest.fn((range: monacoTypes.IRange) => range),
    fromPositions: jest.fn((position: monacoTypes.Position) => ({
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: position.column,
      endColumn: position.column,
    })),
  };

  return {
    languages: {
      CompletionItemKind: {
        Unit: 0,
        Variable: 1,
        Snippet: 2,
        Enum: 3,
        EnumMember: 4,
        Constructor: 5,
      } as const,
    },
    Range: mockRange,
  } as unknown as Monaco;
};

const createMockModel = (
  value: string,
  mockWord: monacoTypes.editor.IWordAtPosition | null = null
): monacoTypes.editor.ITextModel => {
  return {
    getValue: () => value,
    getValueInRange: jest.fn((range: monacoTypes.IRange) => {
      // Convert to 0-based indexing
      const startIndex = Math.max(0, range.startColumn - 1);
      const endIndex = Math.min(value.length, range.endColumn - 1);
      return value.substring(startIndex, endIndex);
    }),
    getWordAtPosition: jest.fn(() => mockWord),
    getOffsetAt: jest.fn((position: monacoTypes.Position) => position.column - 1),
    id: 'test-model',
  } as unknown as monacoTypes.editor.ITextModel;
};

const createMockPosition = (column: number, lineNumber = 1): monacoTypes.Position =>
  ({
    column,
    lineNumber,
  }) as monacoTypes.Position;

const createMockDataProvider = (): DataProvider => {
  return {} as unknown as DataProvider;
};

const createMockTimeRange = (): TimeRange => ({
  from: dateTime(Date.now() - 3600000), // 1 hour ago
  to: dateTime(Date.now()),
  raw: { from: 'now-1h', to: 'now' },
});

describe('monaco-completion-provider', () => {
  let monaco: Monaco;
  let dataProvider: DataProvider;
  let timeRange: TimeRange;

  beforeEach(() => {
    monaco = createMockMonaco();
    dataProvider = createMockDataProvider();
    timeRange = createMockTimeRange();

    // Reset mocks
    jest.clearAllMocks();
    mockGetCompletions.mockResolvedValue([]);
    mockGetSituation.mockReturnValue({ type: 'EMPTY' });

    // Mock window.getSelection
    Object.defineProperty(window, 'getSelection', {
      writable: true,
      value: jest.fn(() => ({
        toString: () => '',
      })),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getSuggestOptions', () => {
    it('should return options with showWords set to false', () => {
      const options = getSuggestOptions();
      expect(options).toEqual({
        showWords: false,
      });
    });
  });

  describe('getCompletionProvider', () => {
    it('should return provider and state objects', () => {
      const result = getCompletionProvider(monaco, dataProvider, timeRange);

      expect(result).toHaveProperty('provider');
      expect(result).toHaveProperty('state');
      expect(result.state).toHaveProperty('isManualTriggerRequested', false);
      expect(result.provider).toHaveProperty('triggerCharacters');
      expect(result.provider).toHaveProperty('provideCompletionItems');
    });

    it('should have correct trigger characters', () => {
      const { provider } = getCompletionProvider(monaco, dataProvider, timeRange);

      expect(provider.triggerCharacters).toEqual(['{', ',', '[', '(', '=', '~', ' ', '"']);
    });
  });

  describe('provideCompletionItems', () => {
    it('should return empty suggestions when no situation is detected', async () => {
      mockGetSituation.mockReturnValue(null);

      const { provider } = getCompletionProvider(monaco, dataProvider, timeRange);
      const model = createMockModel('test');
      const position = createMockPosition(4);

      const result = await (provider.provideCompletionItems as Function)(model, position);

      expect(result).toEqual({
        suggestions: [],
        incomplete: false,
      });
    });

    it('should call getCompletions with correct parameters for normal word', async () => {
      const mockWord = { word: 'grafana', startColumn: 1, endColumn: 7 };
      const model = createMockModel('grafana', mockWord);
      const position = createMockPosition(7);

      const { provider } = getCompletionProvider(monaco, dataProvider, timeRange);

      await (provider.provideCompletionItems as Function)(model, position);

      expect(mockGetCompletions).toHaveBeenCalledWith(
        { type: 'EMPTY' },
        dataProvider,
        timeRange,
        'grafana',
        'full', // Should be 'full' because word length >= 3
        expect.any(Function)
      );
    });

    it('should use partial trigger type for short words', async () => {
      const mockWord = { word: 'go', startColumn: 1, endColumn: 3 };
      const model = createMockModel('go', mockWord);
      const position = createMockPosition(3);

      const { provider } = getCompletionProvider(monaco, dataProvider, timeRange);

      await (provider.provideCompletionItems as Function)(model, position);

      expect(mockGetCompletions).toHaveBeenCalledWith(
        { type: 'EMPTY' },
        dataProvider,
        timeRange,
        'go',
        'partial', // Should be 'partial' because word length < 3
        expect.any(Function)
      );
    });

    it('should format completion items correctly', async () => {
      const mockCompletions = [
        {
          label: 'test_metric',
          detail: 'A test metric',
          insertText: 'test_metric',
          documentation: 'Test documentation',
          insertTextRules: undefined,
          type: 'METRIC_NAME' as const,
          triggerOnInsert: false,
        },
      ];

      mockGetCompletions.mockResolvedValue(mockCompletions);

      const mockWord = { word: 'test', startColumn: 1, endColumn: 5 };
      const model = createMockModel('test', mockWord);
      const position = createMockPosition(5);

      const { provider } = getCompletionProvider(monaco, dataProvider, timeRange);

      const result = await (provider.provideCompletionItems as Function)(model, position);

      expect(result?.suggestions).toHaveLength(1);
      expect(result?.suggestions?.[0]).toMatchObject({
        label: 'test_metric',
        detail: 'A test metric',
        insertText: 'test_metric',
        documentation: 'Test documentation',
        kind: 5, // Constructor kind for METRIC_NAME
        sortText: '0',
        command: undefined,
      });
    });

    it('returns the first search batch and refreshes as later batches arrive', async () => {
      const metric = (label: string) => ({
        label,
        insertText: label,
        type: 'METRIC_NAME' as const,
      });
      let emit: (batch: Array<ReturnType<typeof metric>>) => void = () => undefined;
      let finish: (items: Array<ReturnType<typeof metric>>) => void = () => undefined;
      mockGetCompletions.mockImplementation((_situation, _provider, _range, _term, _trigger, onBatch) => {
        emit = onBatch;
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const onListAppended = jest.fn();
      const { provider } = getCompletionProvider(monaco, dataProvider, timeRange, onListAppended);
      const model = createMockModel('metric', { word: 'metric', startColumn: 1, endColumn: 7 });
      const position = createMockPosition(7);

      const opening = (provider.provideCompletionItems as Function)(model, position);
      emit([metric('metric_one')]);
      const first = await opening;

      expect(first.incomplete).toBe(true);
      expect(first.suggestions.map((item: { label: string }) => item.label)).toEqual(['metric_one']);
      expect(onListAppended).not.toHaveBeenCalled();
      expect(mockGetCompletions).toHaveBeenCalledTimes(1);

      emit([metric('metric_two')]);
      expect(onListAppended).toHaveBeenCalledTimes(1);

      const refreshed = await (provider.provideCompletionItems as Function)(model, position);
      expect(refreshed.incomplete).toBe(true);
      expect(refreshed.suggestions.map((item: { label: string }) => item.label)).toEqual(['metric_one', 'metric_two']);
      expect(mockGetCompletions).toHaveBeenCalledTimes(1);

      finish([metric('metric_one'), metric('metric_two')]);
      await Promise.resolve();
      expect(onListAppended).toHaveBeenCalledTimes(2);

      const done = await (provider.provideCompletionItems as Function)(model, position);
      expect(done.incomplete).toBe(false);
      expect(done.suggestions.map((item: { label: string }) => item.label)).toEqual(['metric_one', 'metric_two']);
      expect(mockGetCompletions).toHaveBeenCalledTimes(1);
    });

    it('returns a series result when the lookup resolves and does not refresh early', async () => {
      let finish: (items: Array<{ label: string; insertText: string; type: 'LABEL_NAME' }>) => void = () => undefined;
      mockGetCompletions.mockImplementation(() => {
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const onListAppended = jest.fn();
      const { provider } = getCompletionProvider(monaco, dataProvider, timeRange, onListAppended);
      const model = createMockModel('{', null);
      const position = createMockPosition(2);

      const pending = (provider.provideCompletionItems as Function)(model, position);
      finish([{ label: 'job', insertText: 'job=', type: 'LABEL_NAME' }]);
      const result = await pending;

      expect(result.incomplete).toBe(false);
      expect(result.suggestions.map((item: { label: string }) => item.label)).toEqual(['job']);
      expect(onListAppended).not.toHaveBeenCalled();
    });

    it('should add trigger command for items with triggerOnInsert', async () => {
      const mockCompletions = [
        {
          label: 'func(',
          insertText: 'func(',
          type: 'FUNCTION' as const,
          triggerOnInsert: true,
        },
      ];

      mockGetCompletions.mockResolvedValue(mockCompletions);

      const model = createMockModel('func');
      const position = createMockPosition(4);

      const { provider } = getCompletionProvider(monaco, dataProvider, timeRange);

      const result = await (provider.provideCompletionItems as Function)(model, position);

      expect(result?.suggestions?.[0]?.command).toEqual({
        id: 'editor.action.triggerSuggest',
        title: '',
      });
    });
  });

  describe('manual trigger handling', () => {
    it('should use full trigger type for manual trigger', async () => {
      const mockWord = { word: 'te', startColumn: 1, endColumn: 3 };
      const model = createMockModel('te', mockWord);
      const position = createMockPosition(3);

      const { provider, state } = getCompletionProvider(monaco, dataProvider, timeRange);

      // Set manual trigger flag
      state.isManualTriggerRequested = true;

      await (provider.provideCompletionItems as Function)(model, position);

      expect(mockGetCompletions).toHaveBeenCalledWith(
        { type: 'EMPTY' },
        dataProvider,
        timeRange,
        'te',
        'full', // Should be 'full' despite short word length
        expect.any(Function)
      );
    });
  });

  describe('trigger character handling', () => {
    const triggerCharacters = ['{', ',', '[', '(', '=', '~', ' ', '"'];

    triggerCharacters.forEach((triggerChar) => {
      it(`should use full trigger type for trigger character "${triggerChar}"`, async () => {
        const testString = `grafana${triggerChar}`;
        const model = createMockModel(testString, null);
        const position = createMockPosition(testString.length + 1); // After trigger character (1-indexed)

        const { provider } = getCompletionProvider(monaco, dataProvider, timeRange);

        await (provider.provideCompletionItems as Function)(model, position);

        expect(mockGetCompletions).toHaveBeenCalledWith(
          { type: 'EMPTY' },
          dataProvider,
          timeRange,
          undefined, // No word at position after trigger char
          'full',
          expect.any(Function)
        );
      });
    });

    it('should handle trigger character at beginning of line', async () => {
      const model = createMockModel('{', null);
      const position = createMockPosition(2); // After the { character

      const { provider } = getCompletionProvider(monaco, dataProvider, timeRange);

      await (provider.provideCompletionItems as Function)(model, position);

      // Should not fail and should still call getCompletions
      expect(mockGetCompletions).toHaveBeenCalled();
    });
  });

  describe('selection handling', () => {
    it('should adjust cursor position when text is selected', async () => {
      // Mock selected text
      Object.defineProperty(window, 'getSelection', {
        writable: true,
        value: jest.fn(() => ({
          toString: () => 'selected',
        })),
      });

      const model = createMockModel('grafana selected');
      const position = createMockPosition(16); // End of string

      const { provider } = getCompletionProvider(monaco, dataProvider, timeRange);

      await (provider.provideCompletionItems as Function)(model, position);

      // Should call getOffsetAt with adjusted position
      expect(model.getOffsetAt).toHaveBeenCalledWith({
        column: 8, // 16 - 8 (length of 'selected')
        lineNumber: 1,
      });
    });
  });
});
