import { expect, test } from '@grafana/plugin-e2e';
import { type Locator, type Page } from '@playwright/test';

const PLUGIN_TYPE = 'prometheus';

// Grafana 13 migrated multiple UI surfaces from aria-label to data-testid
// (https://github.com/grafana/grafana/pull/121784). Helpers below match both shapes
// where applicable so tests work across Grafana versions, mirroring
// tests/e2e/queryEditor.spec.ts.
function getDataSourceConnectionUrlInput(page: Page): Locator {
  return page.locator(
    '[data-testid="data-testid Data source connection URL"], [aria-label="Data source connection URL"]'
  );
}

test.describe('Config editor', () => {
  test(
    'smoke: should render config editor',
    { tag: '@plugins' },
    async ({ createDataSourceConfigPage, page, selectors }) => {
      const configPage = await createDataSourceConfigPage({ type: PLUGIN_TYPE });

      await expect(page.getByText(/Before you can use the Prometheus data source/)).toBeVisible();
      await expect(configPage.getByGrafanaSelector(selectors.pages.DataSource.name)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Connection', exact: true })).toBeVisible();
      await expect(getDataSourceConnectionUrlInput(page)).toBeVisible();
    }
  );

  test(
    'should show max samples processed threshold fields in advanced settings',
    { tag: '@plugins' },
    async ({ createDataSourceConfigPage, page }) => {
      await createDataSourceConfigPage({ type: PLUGIN_TYPE });

      await expect(
        page.getByTestId('prom-settings-max-samples-processed-warning-threshold')
      ).toBeVisible();
      await expect(
        page.getByTestId('prom-settings-max-samples-processed-error-threshold')
      ).toBeVisible();
    }
  );
});
