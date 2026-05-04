describe('promql lazy function regex', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock('@grafana/i18n');
  });

  function loadPromqlWithSpiedT(): {
    promqlGrammar: { function: RegExp; [key: string]: unknown };
    tSpy: jest.Mock;
  } {
    const tSpy = jest.fn((_key: string, fallback: string) => fallback);

    jest.doMock('@grafana/i18n', () => {
      const actual = jest.requireActual('@grafana/i18n');
      return { ...actual, t: tSpy };
    });

    let mod: { promqlGrammar: { function: RegExp; [key: string]: unknown } } = {
      promqlGrammar: { function: /never/ },
    };
    jest.isolateModules(() => {
      mod = require('./promql');
    });
    return { promqlGrammar: mod.promqlGrammar, tSpy };
  }

  it('does not call t() when promql.ts is first imported', () => {
    const { tSpy } = loadPromqlWithSpiedT();
    expect(tSpy).not.toHaveBeenCalled();
  });

  it('does not call t() when other grammar fields are read (only `function` is lazy)', () => {
    const { promqlGrammar, tSpy } = loadPromqlWithSpiedT();

    void promqlGrammar.comment;
    void promqlGrammar['context-aggregation'];
    void promqlGrammar['context-labels'];
    void promqlGrammar['context-range'];
    void promqlGrammar.idList;
    void promqlGrammar.number;
    void promqlGrammar.operator;
    void promqlGrammar.punctuation;

    expect(tSpy).not.toHaveBeenCalled();
  });

  it('builds the function regex lazily on first read of promqlGrammar.function', () => {
    const { promqlGrammar, tSpy } = loadPromqlWithSpiedT();
    expect(tSpy).not.toHaveBeenCalled();

    const regex = promqlGrammar.function;

    expect(regex).toBeInstanceOf(RegExp);
    expect(regex.test('rate(')).toBe(true);
    expect(regex.test('histogram_quantile(')).toBe(true);
    expect(regex.test('sum(')).toBe(true);
    // lookahead requires an opening paren; bare identifiers must not match
    expect(regex.test('rate')).toBe(false);

    expect(tSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('memoizes the regex: subsequent reads return the same instance and do not re-call t()', () => {
    const { promqlGrammar, tSpy } = loadPromqlWithSpiedT();

    const first = promqlGrammar.function;
    const callsAfterFirstRead = tSpy.mock.calls.length;
    expect(callsAfterFirstRead).toBeGreaterThan(0);

    const second = promqlGrammar.function;
    const third = promqlGrammar.function;

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(tSpy.mock.calls.length).toBe(callsAfterFirstRead);
  });
});
