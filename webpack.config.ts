import path from 'node:path';

import type { Configuration } from 'webpack';
import webpack from 'webpack';
import { merge } from 'webpack-merge';

import grafanaConfig, { Env } from './.config/webpack/webpack.config';

// Resolve packages via Node's own resolution algorithm instead of assuming a
// fixed root `node_modules/<pkg>` path. Hoisting layout differs across
// package managers (and across npm installs depending on version splits
// elsewhere in the tree), so a package that's a *transitive* dependency
// (like react-i18next, pulled in by @grafana/i18n) isn't guaranteed to be
// hoisted to the root — it may only exist nested inside @grafana/i18n's own
// node_modules. Resolving relative to @grafana/i18n's directory finds
// whichever copy @grafana/i18n itself would use, regardless of hoisting.
const grafanaI18nDir = path.dirname(require.resolve('@grafana/i18n/package.json'));
const reactI18nextEntry = require.resolve('react-i18next', { paths: [grafanaI18nDir] });

const config = async (env: Env): Promise<Configuration> => {
  const baseConfig = await grafanaConfig(env);

  return merge(baseConfig, {
    resolve: {
      // Use the workspace library's TypeScript source directly so no prebuilt
      // dist is needed during development. swc-loader picks it up because
      // symlinks resolve outside node_modules.
      //
      // Force @grafana/i18n and react-i18next to a single canonical path.
      // Workspaces can install both packages twice (root + inner workspace),
      // giving each copy its own module-scoped tFunc. Only one copy gets
      // initialized by initPluginTranslations(), causing "t() was called
      // before i18n was initialized" in components that import the other copy.
      alias: {
        '@grafana/prometheus$': path.resolve(__dirname, 'packages/grafana-prometheus/src/index.ts'),
        '@grafana/i18n$': grafanaI18nDir,
        'react-i18next$': reactI18nextEntry,
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
