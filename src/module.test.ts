import { plugin as PrometheusDatasourcePlugin } from './module';

declare const process: { env: { NODE_ENV?: string } };
declare const require: (id: string) => { plugin: unknown };

describe('module', () => {
  it('should have metrics query field in panels and Explore', () => {
    expect(PrometheusDatasourcePlugin.components.QueryEditor).toBeDefined();
  });
});

describe('module i18n bootstrap', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    jest.dontMock('@grafana/i18n');
    jest.resetModules();
  });

  function loadModuleWith({
    nodeEnv,
    initPluginTranslations,
  }: {
    nodeEnv: string;
    initPluginTranslations: jest.Mock;
  }): { plugin: unknown } {
    process.env.NODE_ENV = nodeEnv;

    let exports: { plugin: unknown } = { plugin: undefined };
    jest.isolateModules(() => {
      jest.doMock('@grafana/i18n', () => {
        const actual = jest.requireActual('@grafana/i18n');
        return { ...actual, initPluginTranslations };
      });

      exports = require('./module');
    });
    return exports;
  }

  it('skips initPluginTranslations under jest (NODE_ENV=test) to keep test output clean', () => {
    const initPluginTranslations = jest.fn();
    loadModuleWith({ nodeEnv: 'test', initPluginTranslations });
    expect(initPluginTranslations).not.toHaveBeenCalled();
  });

  it('calls initPluginTranslations(pluginJson.id, [loadResources]) when running outside jest', () => {
    const initPluginTranslations = jest.fn();
    loadModuleWith({ nodeEnv: 'production', initPluginTranslations });

    expect(initPluginTranslations).toHaveBeenCalledTimes(1);
    const [pluginId, resources] = initPluginTranslations.mock.calls[0];
    expect(pluginId).toBe('prometheus');
    expect(Array.isArray(resources)).toBe(true);
    expect(resources).toHaveLength(1);
    expect(typeof resources[0]).toBe('function');
  });

  it('does not await initPluginTranslations: module evaluates synchronously even when the bootstrap promise never resolves', () => {
    // If module.ts regresses to `await initPluginTranslations(...)`, require()
    // resolves to a Promise instead of the plugin exports.
    const initPluginTranslations = jest.fn(() => new Promise<void>(() => {}));

    const exports = loadModuleWith({ nodeEnv: 'production', initPluginTranslations });

    expect(exports.plugin).toBeDefined();
    expect(exports.plugin).not.toBeInstanceOf(Promise);
    expect(initPluginTranslations).toHaveBeenCalledTimes(1);
  });
});
