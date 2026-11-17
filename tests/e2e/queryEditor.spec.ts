import { expect, test } from '@grafana/plugin-e2e';
import { type Locator, type Page } from '@playwright/test';

// Grafana 13 migrated query editor row selectors from aria-label to data-testid
// (https://github.com/grafana/grafana/pull/121784). This helper matches both so tests work across versions
// until @grafana/plugin-e2e ships a fix and this repo upgrades.
function getQueryEditorRow(page: Page, refId: string): Locator {
  return page.locator('[data-testid="data-testid Query editor row"], [aria-label="Query editor row"]').filter({
    has: page.locator(
      `[data-testid="data-testid Query editor row title ${refId}"], [aria-label="Query editor row title ${refId}"]`
    ),
  });
}

test.describe('Query editor', () => {
  test('smoke: renders query editor controls', { tag: '@plugins' }, async ({ explorePage, page }) => {
    await explorePage.datasource.set('prometheus-gzip');

    const queryRow = getQueryEditorRow(page, 'A');
    await expect(queryRow.getByRole('button', { name: 'Kick start your query' })).toBeVisible();
    await expect(queryRow.getByText('Explain', { exact: true })).toBeVisible();
    await expect(queryRow.getByRole('radio', { name: 'Builder' })).toBeVisible();
    await expect(queryRow.getByRole('radio', { name: 'Code' })).toBeVisible();
  });

  test('selects the exact metric match on Enter in Builder mode', async ({ explorePage, page, selectors }) => {
    await explorePage.datasource.set('prometheus-direct');

    const queryRow = getQueryEditorRow(page, 'A');
    await queryRow.getByRole('radio', { name: 'Builder' }).click();

    // Prometheus scrapes itself and Grafana, so many metric names contain `up` and sort
    // ahead of the exact `up` match (for example `analytics_summaries_rollup_duration_seconds`).
    const metricSelect = queryRow.getByTestId(
      selectors.components.DataSource.Prometheus.queryEditor.builder.metricSelect
    );
    await metricSelect.click();
    await page.keyboard.type('up');
    await expect(page.getByRole('option', { name: 'up', exact: true })).toBeVisible();
    await expect(page.getByRole('option').first()).toHaveText('up');

    await page.keyboard.press('Enter');
    await expect(metricSelect).toHaveText('up');
  });
});
