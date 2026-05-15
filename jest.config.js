// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const { grafanaESModules, nodeModulesToTransform } = require('./.config/jest/utils');

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...require('./.config/jest.config'),

  // Resolve @grafana/prometheus to its TypeScript source so tests don't require
  // a pre-built dist (which may not exist in CI before the package is compiled).
  moduleNameMapper: {
    ...require('./.config/jest.config').moduleNameMapper,
    '^@grafana/prometheus$': '<rootDir>/packages/grafana-prometheus/src/index.ts',
    // Force all code (including packages/grafana-prometheus) to share the root React instance.
    // Without this, the nested node_modules/react in that package causes "Invalid hook call" errors.
    '^react$': '<rootDir>/node_modules/react',
    '^react-dom$': '<rootDir>/node_modules/react-dom',
    '^react/jsx-runtime$': '<rootDir>/node_modules/react/jsx-runtime',
    '^react/jsx-dev-runtime$': '<rootDir>/node_modules/react/jsx-dev-runtime',
  },

  // Use automatic JSX runtime so tests don't need `import React from 'react'`
  transform: {
    '^.+\\.(t|j)sx?$': [
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
    ],
  },

  // monaco-promql ships ESM only; add it to the transform allowlist
  transformIgnorePatterns: [nodeModulesToTransform([...grafanaESModules, 'monaco-promql'])],
};
