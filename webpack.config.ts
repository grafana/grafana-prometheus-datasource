import path from 'node:path';

import type { Configuration } from 'webpack';
import webpack from 'webpack';
import { merge } from 'webpack-merge';

import grafanaConfig, { Env } from './.config/webpack/webpack.config';

const config = async (env: Env): Promise<Configuration> => {
  const baseConfig = await grafanaConfig(env);

  return merge(baseConfig, {
    resolve: {
      // Point at the workspace library's TypeScript source instead of ./dist,
      // so the plugin doesn't require the library to be prebuilt during
      // development. The library is transpiled together with the plugin by
      // the existing swc-loader rule (workspace paths are not under any
      // node_modules once symlinks are resolved).
      alias: {
        '@grafana/prometheus$': path.resolve(__dirname, 'packages/grafana-prometheus/src/index.ts'),
      },
    },
    plugins: [
      // The scaffolded SWC loader uses the classic JSX transform (React.createElement),
      // which requires React to be in scope in every JSX file. ProvidePlugin injects
      // `var React = require('react')` automatically into any module that references
      // the React global, using Grafana's externalized react instance.
      new webpack.ProvidePlugin({ React: 'react' }),
    ],
  });
};

export default config;
