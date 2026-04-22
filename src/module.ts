import { DataSourcePlugin } from '@grafana/data';
// @ts-ignore - @grafana/prometheus not yet available; remove once resolved
import { PrometheusDatasource, PromQueryEditorByApp, PromCheatSheet } from '@grafana/prometheus';

import { ConfigEditor } from './configuration/ConfigEditorPackage';

export const plugin = new DataSourcePlugin(PrometheusDatasource)
  .setQueryEditor(PromQueryEditorByApp)
  // @ts-ignore - ConfigEditor type mismatch until @grafana/prometheus is resolved
  .setConfigEditor(ConfigEditor)
  .setQueryEditorHelp(PromCheatSheet);
