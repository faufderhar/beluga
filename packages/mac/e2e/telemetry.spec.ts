import { expect, test } from './fixtures.js';

/**
 * Usage statistics (BLG-922): Off, Limited, On in Settings › General, and the ask
 * after an update. The demo shows them as a release would and never sends anything.
 */

const shots = process.env.BELUGA_SHOTS;

async function both(page: import('@playwright/test').Page, el: import('@playwright/test').Locator, name: string): Promise<void> {
  if (!shots) return;
  await page.waitForTimeout(500);
  await el.screenshot({ path: `${shots}/${name}-light.png` });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(300);
  await el.screenshot({ path: `${shots}/${name}-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
}

test('Settings › General has the level', async ({ page }) => {
  test.skip(process.env.BELUGA_DEMO_ASKS === 'telemetry', 'the ask is forced on');
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const search = dialog.getByRole('combobox', { name: 'Search settings' });
  await search.fill('usage statistics');
  await page.keyboard.press('Enter');
  const level = dialog.getByRole('combobox', { name: 'Share usage statistics' });
  await expect(level).toBeVisible();
  await expect(level).toContainText('Limited');
  await both(page, dialog, 'telemetry-settings');
  await expect(dialog.getByRole('button', { name: /See What/ })).toHaveCount(0);
});

// With BELUGA_DEMO_ASKS=telemetry the demo has updated and not answered: the ask comes by itself.
test('the ask after an update: Limited picked, Later closes it', async ({ page }) => {
  test.skip(process.env.BELUGA_DEMO_ASKS !== 'telemetry', 'needs BELUGA_DEMO_ASKS=telemetry');
  await page.goto('/');
  const sheet = page.getByRole('dialog', { name: 'Help make Beluga better' });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByRole('radio', { name: /Limited/ })).toBeChecked();
  await expect(sheet.getByRole('button', { name: 'Share (Limited)' })).toBeVisible();
  await both(page, sheet, 'telemetry-ask');
  await sheet.getByRole('radio', { name: /^Off/ }).check();
  await expect(sheet.getByRole('button', { name: 'Keep It Off' })).toBeVisible();
  await sheet.getByRole('radio', { name: /Limited/ }).check();
  await sheet.getByRole('button', { name: 'Later' }).last().click();
  await expect(sheet).toBeHidden();
  await page.waitForTimeout(3000);
  await expect(page.getByRole('dialog', { name: 'Help make Beluga better' })).toHaveCount(0);
});

test('a project can be left out of usage statistics in its Settings', async ({ page }) => {
  test.skip(process.env.BELUGA_DEMO_ASKS === 'telemetry', 'the ask is forced on');
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  await sidebar.getByRole('button', { name: 'bob-api', exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Project Settings…' }).click();
  const sheet = page.getByRole('dialog', { name: 'bob-api Settings' });
  const share = sheet.getByRole('checkbox', { name: /Send usage statistics from this project/ });
  await expect(share).toBeChecked();
  await share.uncheck();
  await both(page, sheet, 'telemetry-project');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  // Opened again, it remembers.
  await sidebar.getByRole('button', { name: 'bob-api', exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Project Settings…' }).click();
  await expect(sheet.getByRole('checkbox', { name: /Send usage statistics from this project/ })).not.toBeChecked();
});
