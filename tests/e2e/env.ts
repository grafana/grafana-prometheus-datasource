/// <reference types="node" />
import { type Page } from '@playwright/test';

/**
 * The Cloud workflow sets GRAFANA_URL. Local runs and pull request CI leave it
 * unset, making it a Cloud signal independent of whether Vault secrets resolve.
 */
export const isCloudRun = !!process.env.GRAFANA_URL;

function requireOnCloud(name: string, localDefault: string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (isCloudRun) {
    throw new Error(
      `${name} is not set, but GRAFANA_URL is, so this Cloud run expects it from Vault. ` +
        `Check the repo-secrets paths in .github/workflows/cron.yml; they are relative to ` +
        `ci/repo/grafana/grafana-prometheus-datasource/.`
    );
  }
  return localDefault;
}

export const DS_NAME = requireOnCloud('DS_INSTANCE_NAME', 'prometheus-gzip');

const LOCAL_DS_UID = 'prometheus-gzip';

export async function resolveDataSourceUid(page: Page): Promise<string> {
  const override = process.env.DS_E2E_UID?.trim();
  if (override) {
    return override;
  }
  if (!isCloudRun) {
    return LOCAL_DS_UID;
  }

  const response = await page.request.get('/api/datasources');
  if (!response.ok()) {
    throw new Error(`Could not list data sources on ${process.env.GRAFANA_URL}: HTTP ${response.status()}`);
  }

  const prometheusDataSources: Array<{ name: string; uid: string }> = (await response.json()).filter(
    (dataSource: { type: string }) => dataSource.type === 'prometheus'
  );

  const exactMatch = prometheusDataSources.find((dataSource) => dataSource.name === DS_NAME);
  if (exactMatch) {
    return exactMatch.uid;
  }

  if (prometheusDataSources.length === 1) {
    console.warn(
      `DS_INSTANCE_NAME does not match any data source; using the only Prometheus data source ` +
        `("${prometheusDataSources[0].name}"). Update the Vault secret.`
    );
    return prometheusDataSources[0].uid;
  }

  throw new Error(
    `Could not resolve a Prometheus data source matching DS_INSTANCE_NAME. Found ` +
      `${prometheusDataSources.length} Prometheus data source(s): ` +
      `${JSON.stringify(prometheusDataSources.map((dataSource) => dataSource.name))}.`
  );
}
