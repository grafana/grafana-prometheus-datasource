import { DataSourcePlugin } from '@grafana/data';
import { initPluginTranslations } from '@grafana/i18n';
import { loadResources, PromCheatSheet, PrometheusDatasource, PromQueryEditorByApp } from '@grafana/prometheus';

import { ConfigEditor } from './configuration/ConfigEditor';
import pluginJson from './plugin.json';

// process.env.NODE_ENV is replaced by webpack's DefinePlugin at build time;
// declared locally to avoid pulling @types/node into the plugin tsconfig.
declare const process: { env: { NODE_ENV?: string } };

// Fire-and-forget: top-level `await` turns module.ts into a webpack async
// module whose exports become a Promise. AMD + SystemJS doesn't propagate
// that Promise reliably, so the host would render components before tFunc
// is set. The synchronous part of initPluginTranslations sets tFunc on the
// next microtask — before any plugin-rendered component mounts.
if (process.env.NODE_ENV !== 'test') {
  void initPluginTranslations(pluginJson.id, [loadResources]);
}

export const plugin = new DataSourcePlugin(PrometheusDatasource)
  .setQueryEditor(PromQueryEditorByApp)
  .setConfigEditor(ConfigEditor)
  .setQueryEditorHelp(PromCheatSheet);
