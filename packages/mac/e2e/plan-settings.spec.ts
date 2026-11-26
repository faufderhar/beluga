import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/**
 * Plan Settings: a plan's ••• › Plan Settings… changes what New Plan asked once the plan
 * exists, with New Plan's own Agents row: Mix Agents gives the checker another agent and model,
 * Save keeps it (and when its tests run), and it's there when the sheet opens again.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');
const main = (page: Page) => page.locator('main');

async function openPlan(page: Page): Promise<void> {
  await page.goto('/');
  await openWork(page, 'Plans');
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Plan Options' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Plan Settings…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Plan Settings' });
  await expect(sheet).toBeVisible();
  return sheet;
}

test('Plan Settings: mix the agents of a plan already made, and when its tests run; kept when it opens again', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPlan(page);

  let sheet = await openSettings(page);
  // What New Plan asked: the project shown, how it runs, its agents as one sentence, its tests.
  await expect(sheet).toContainText('bob-api');
  await expect(sheet.getByRole('radiogroup')).toBeVisible();
  const agents = sheet.getByRole('group', { name: 'Agents' });
  await expect(agents).toContainText('Planned, built and checked by');
  const tests = sheet.getByRole('combobox', { name: 'When to run tests' });
  await expect(tests).toContainText('Each Milestone');
  // Nothing moved yet: nothing to save. Save is in view without scrolling the sheet.
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeInViewport({ ratio: 1 });

  // Mix Agents: a picker per part; the checker gets a model of its own.
  await agents.getByRole('button', { name: 'Mix Agents' }).click();
  await expect(agents.getByRole('combobox')).toHaveCount(3);
  await agents.getByRole('combobox', { name: 'Checker' }).click();
  await page.getByRole('option', { name: /^Claude · Opus/ }).first().click();
  await expect(agents.getByRole('combobox', { name: 'Checker' })).toContainText('Claude · Opus');
  await tests.click();
  await page.getByRole('option', { name: /Only at the End/ }).click();
  await sheet.screenshot({ path: path.join(SHOTS, 'plan-settings-en.png') });
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Plan settings saved' })).toBeVisible();

  // Open again, after the window loads again (what the daemon keeps, not the page): mixed, both kept.
  await openPlan(page);
  sheet = await openSettings(page);
  await expect(sheet.getByRole('group', { name: 'Agents' }).getByRole('combobox', { name: 'Checker' })).toContainText('Claude · Opus');
  await expect(sheet.getByRole('combobox', { name: 'When to run tests' })).toContainText('Only at the End');
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();

  // One Agent gives the checker back to the builder.
  await sheet.getByRole('group', { name: 'Agents' }).getByRole('button', { name: 'One Agent' }).click();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  sheet = await openSettings(page);
  await expect(sheet.getByRole('group', { name: 'Agents' })).toContainText('Planned, built and checked by');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
});

test('Plan Settings: Never wait for me under Autopilot, saved with the rest, ticked when it opens again', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPlan(page);

  let sheet = await openSettings(page);
  // Not on Autopilot: no box. On it: Never wait for me, as How It Runs and New Plan have it.
  await expect(sheet.getByRole('checkbox', { name: /Never wait for me/ })).toHaveCount(0);
  await sheet.getByRole('radio', { name: /^Autopilot/ }).click();
  const box = sheet.getByRole('checkbox', { name: /Never wait for me/ });
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();
  await sheet.screenshot({ path: path.join(SHOTS, 'plan-settings-never-wait.png') });
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Runs on Full Autopilot/ })).toBeVisible();

  // Open again: Autopilot, the box ticked, nothing to save. Unticked, it says questions come back to you.
  sheet = await openSettings(page);
  await expect(sheet.getByRole('radio', { name: /^Autopilot/ })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.getByRole('checkbox', { name: /Never wait for me/ })).toBeChecked();
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();
  await sheet.getByRole('checkbox', { name: /Never wait for me/ }).click();
  await expect(sheet.getByRole('status', { name: 'What changes' })).toContainText('waits for you again');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: /Runs on Autopilot/ })).toBeVisible();
});
