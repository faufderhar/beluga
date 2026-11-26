import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/**
 * A plan's Agents menu (header) says each part's agent with its model, as Plan Settings does, and
 * changes it agent ▸ model: planned by Opus, built by Haiku and checked by Sonnet reads as three
 * agents, not "Claude" three times, and a pick in either place shows in the other.
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

test('the Agents menu names each part’s model and picks agent ▸ model; Plan Settings shows the same', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPlan(page);

  // Plan Settings: planned by Opus, built by Haiku, checked by Sonnet.
  let sheet = await openSettings(page);
  const agents = sheet.getByRole('group', { name: 'Agents' });
  await agents.getByRole('button', { name: 'Mix Agents' }).click();
  for (const [part, model] of [
    ['Builder', 'Haiku'],
    ['Planner', 'Opus'],
    ['Checker', 'Sonnet'],
  ] as const) {
    await agents.getByRole('combobox', { name: part }).click();
    await page.getByRole('option', { name: new RegExp(`^Claude · ${model}`) }).first().click();
    await expect(agents.getByRole('combobox', { name: part })).toContainText(`Claude · ${model}`);
  }
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);

  // The header: three agents, each part with its model.
  const button = page.getByRole('button', { name: /^Agents: / });
  await expect(button).toHaveText('3 Agents');
  await button.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /^Planner: Claude · Opus/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Builder: Claude · Haiku/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Checker: Claude · Sonnet/ })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'plan-agents-menu.png') });

  // Planner ▸ Claude ▸ its models, Opus checked.
  // By the keys, as on a Mac (a click on a submenu's row toggles it): → opens Planner's, on its
  // first row; ↓ to Claude; → opens its models.
  await menu.getByRole('menuitem', { name: /^Planner: / }).hover();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: /^Same as the Builder/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: /^Claude$/ })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const opus = page.getByRole('menuitem', { name: /^Opus/ });
  await expect(opus).toHaveAttribute('data-checked', 'true');
  await expect(page.getByRole('menuitem', { name: /^Default Model/ })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'plan-agents-menu-models.png') });

  // Planned by Sonnet from the menu: the agent and its model, as Plan Settings then shows.
  const sonnet = page.getByRole('menuitem', { name: /^Sonnet/ });
  await expect(page.getByRole('menuitem', { name: /^Default Model/ })).toBeFocused();
  for (let i = 0; i < 4 && !(await sonnet.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown');
  await expect(sonnet).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(button).toHaveText('2 Agents');
  sheet = await openSettings(page);
  await expect(sheet.getByRole('group', { name: 'Agents' }).getByRole('combobox', { name: 'Planner' })).toContainText('Claude · Sonnet');
  await sheet.screenshot({ path: path.join(SHOTS, 'plan-agents-menu-settings.png') });
  await sheet.getByRole('button', { name: 'Cancel' }).click();
});
