import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Naming rules (BLG-1033): a PR title rule beside the branch prefix in Settings › Workspaces, and a
 * project's own branch prefix and PR title rule in its Project Settings, each tagged with where it comes from.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');

async function both(page: Page, el: Locator, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await el.screenshot({ path: path.join(SHOTS, `${name}-light.png`) });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(300);
  await el.screenshot({ path: path.join(SHOTS, `${name}-dark.png`) });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
}

test('a PR title rule in Settings, and a project rule of its own over it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar).toBeVisible();

  await page.keyboard.press('Meta+,');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Workspaces', exact: true }).click();
  const title = dialog.getByRole('textbox', { name: 'Pull request titles' });
  await title.fill('Conventional commits: feat(scope): summary, under 70 characters');
  await title.blur();
  await both(page, dialog, 'naming-settings');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await sidebar.getByRole('button', { name: 'bob-api', exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Project Settings…' }).click();
  const sheet = page.getByRole('dialog', { name: 'bob-api Settings' });
  await expect(sheet.getByText('From Settings')).toBeVisible();
  await both(page, sheet, 'naming-project-inherited');

  await sheet.getByRole('textbox', { name: 'Branch prefix' }).fill('api/');
  await sheet.getByRole('textbox', { name: 'PR titles' }).fill('[API] summary in the imperative');
  await expect(sheet.getByText('Will be yours').first()).toBeVisible();
  await both(page, sheet, 'naming-project-edited');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();

  // Opened again: they're its own now.
  await sidebar.getByRole('button', { name: 'bob-api', exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Project Settings…' }).click();
  await expect(sheet.getByRole('textbox', { name: 'Branch prefix' })).toHaveValue('api/');
  await expect(sheet.getByText('Your settings').first()).toBeVisible();
  await both(page, sheet, 'naming-project-saved');

  // A prefix git won't take can't be saved.
  await sheet.getByRole('textbox', { name: 'Branch prefix' }).fill('bad prefix');
  await expect(sheet.getByText('Use letters, digits and . _ - / only.')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();
});
