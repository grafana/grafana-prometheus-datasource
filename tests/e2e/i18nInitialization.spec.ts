import { expect, test } from '@grafana/plugin-e2e';
import { type ConsoleMessage, type Page } from '@playwright/test';

const PLUGIN_TYPE = 'prometheus';

const FORBIDDEN_PATTERNS: RegExp[] = [
  /t\(\) was called before i18n was initialized/i,
  /react-i18next.*NO_I18NEXT_INSTANCE/i,
  /You need to pass in an i18next instance using i18nextReactModule/i,
];

type Captured = { source: 'pageerror' | 'console'; type?: string; text: string };

function attachCapture(page: Page): Captured[] {
  const captured: Captured[] = [];
  page.on('pageerror', (err) => {
    captured.push({ source: 'pageerror', text: `${err.name}: ${err.message}\n${err.stack ?? ''}` });
  });
  page.on('console', (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      captured.push({ source: 'console', type, text: msg.text() });
    }
  });
  return captured;
}

function findForbidden(captured: Captured[]): Captured[] {
  return captured.filter((entry) => FORBIDDEN_PATTERNS.some((rx) => rx.test(entry.text)));
}

test.describe('i18n initialization', () => {
  test(
    'config editor mounts AlertingSettingsOverhaul and PromSettings without i18n-not-initialized errors',
    { tag: '@plugins' },
    async ({ createDataSourceConfigPage, page }) => {
      const captured = attachCapture(page);

      await createDataSourceConfigPage({ type: PLUGIN_TYPE });

      await expect(page.getByRole('heading', { name: 'Alerting', exact: true })).toBeVisible();
      await expect(page.getByText('Manage alerts via Alerting UI', { exact: true })).toBeVisible();
      await expect(page.getByText('Scrape interval', { exact: true })).toBeVisible();
      await expect(page.getByText('Query timeout', { exact: true })).toBeVisible();
      // i18n key must never leak into the DOM
      await expect(page.getByText('grafana-prometheus.configuration.', { exact: false })).toHaveCount(0);

      const violations = findForbidden(captured);
      expect(
        violations,
        `Captured i18n-initialization errors:\n${violations.map((v) => `[${v.source}${v.type ? '/' + v.type : ''}] ${v.text}`).join('\n---\n')}`
      ).toEqual([]);
    }
  );

  test(
    'explore with prometheus datasource imports promql.ts grammar without top-level t() throwing',
    { tag: '@plugins' },
    async ({ explorePage, page }) => {
      const captured = attachCapture(page);

      await explorePage.datasource.set('prometheus');

      await expect(
        page.locator('[data-testid="data-testid Query editor row"], [aria-label="Query editor row"]')
      ).toBeVisible();

      // Open QueryPatternsModal — the last hop on the import chain that triggered the eager t() call
      const kickStart = page.getByRole('button', { name: 'Kick start your query' });
      await expect(kickStart).toBeVisible();
      await kickStart.click();
      await expect(page.getByRole('dialog')).toBeVisible();

      const violations = findForbidden(captured);
      expect(
        violations,
        `Captured i18n-initialization errors during Explore + QueryPatternsModal:\n${violations.map((v) => `[${v.source}${v.type ? '/' + v.type : ''}] ${v.text}`).join('\n---\n')}`
      ).toEqual([]);
    }
  );
});
