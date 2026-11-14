import path from 'node:path';
import { expect, test } from './fixtures.js';
import { pick } from './helpers.js';

/**
 * Settings › Workspaces › Fetch in the background (#479): every 15 minutes by default, slower, or
 * never (git keys in a vault that asks each time stay quiet). Saves through session.setPrefs.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');

test('Fetch in the background: every 15 minutes by default, and it can be turned off', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Workspaces', exact: true }).click();

  const select = dialog.getByRole('combobox', { name: 'Fetch in the background' });
  await expect(select).toContainText('Every 15 minutes (default)');
  await select.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'background-fetch-default.png') });

  await pick(page, 'Fetch in the background', 'Never');
  await expect(select).toContainText('Never');
  await expect(dialog.getByText(/Off: projects fetch only when you click Fetch or Update main/)).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'background-fetch-never.png') });

  await pick(page, 'Fetch in the background', 'Every hour');
  await expect(select).toContainText('Every hour');

  // The search finds it by what someone would type.
  await dialog.getByRole('combobox', { name: 'Search settings' }).fill('git fetch');
  await expect(dialog.getByRole('option', { name: /Fetch in the background/ })).toBeVisible();
});
