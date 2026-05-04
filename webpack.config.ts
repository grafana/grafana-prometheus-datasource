import path from 'node:path';

import type { Configuration } from 'webpack';
import webpack from 'webpack';
import { merge } from 'webpack-merge';

import grafanaConfig, { Env } from './.config/webpack/webpack.config';

const config = async (env: Env): Promise<Configuration> => {
  const baseConfig = await grafanaConfig(env);

  return merge(baseConfig, {
    resolve: {
      // Use the workspace library's TypeScript source directly so no prebuilt
      // dist is needed during development. swc-loader picks it up because
      // symlinks resolve outside node_modules.
      //
      // Force @grafana/i18n and react-i18next to a single canonical path.
      // Yarn workspaces install both packages twice (root + inner workspace),
      // giving each copy its own module-scoped tFunc. Only one copy gets
      // initialized by initPluginTranslations(), causing "t() was called
      // before i18n was initialized" in components that import the other copy.
      alias: {
        '@grafana/prometheus$': path.resolve(__dirname, 'packages/grafana-prometheus/src/index.ts'),
        '@grafana/i18n$': path.resolve(__dirname, 'node_modules/@grafana/i18n'),
        'react-i18next$': path.resolve(__dirname, 'node_modules/react-i18next'),
      },
    },
    plugins: [
      // SWC loader uses the classic JSX transform (React.createElement), so React
      // must be in scope in every JSX file. ProvidePlugin injects it automatically.
      //
      // TODO: remove once grafana/plugin-tools@951defa ships and this plugin runs
      //  `npx @grafana/create-plugin@latest update` (switches to react/jsx-runtime).
      new webpack.ProvidePlugin({ React: 'react' }),
    ],
  });
};

export default config;
