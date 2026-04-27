// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const path = require('path');
const { grafanaESModules, nodeModulesToTransform } = require('./.config/jest/utils');
const baseConfig = require('./.config/jest.config');

const swcTransform = [
  '@swc/jest',
  {
    sourceMaps: 'inline',
    jsc: {
      parser: {
        syntax: 'typescript',
        tsx: true,
        decorators: false,
        dynamicImport: true,
      },
      transform: {
        react: {
          runtime: 'automatic',
        },
      },
    },
    module: {
      type: 'commonjs',
    },
  },
];

// Project 1: the Grafana plugin source (jsdom + DOM-aware setup).
const pluginProject = {
  ...baseConfig,
  displayName: 'plugin',
  rootDir: __dirname,
  // Resolve @grafana/prometheus to its TypeScript source so tests don't require
  // a pre-built dist (which may not exist in CI before the package is compiled).
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    '^@grafana/prometheus$': '<rootDir>/packages/grafana-prometheus/src/index.ts',
    // Force all code (including packages/grafana-prometheus) to share the root React instance.
    // Without this, the nested node_modules/react in that package causes "Invalid hook call" errors.
    '^react$': '<rootDir>/node_modules/react',
    '^react-dom$': '<rootDir>/node_modules/react-dom',
    '^react/jsx-runtime$': '<rootDir>/node_modules/react/jsx-runtime',
    '^react/jsx-dev-runtime$': '<rootDir>/node_modules/react/jsx-dev-runtime',
  },
  transform: { '^.+\\.(t|j)sx?$': swcTransform },
  // monaco-promql ships ESM only; add it to the transform allowlist
  transformIgnorePatterns: [nodeModulesToTransform([...grafanaESModules, 'monaco-promql'])],
};

// Project 2: the repo-management scripts (node env, no DOM setup).
const scriptsProject = {
  displayName: 'scripts',
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/scripts/**/__tests__/*.{test,spec}.{js,ts}'],
  transform: { '^.+\\.(t|j)sx?$': swcTransform },
};

module.exports = {
  projects: [pluginProject, scriptsProject],
};
