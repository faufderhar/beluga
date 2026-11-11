import { expect, test, type Page } from './fixtures.js';

/**
 * Any agent, shown by its mark (BLG-497): Settings' "Your agent" lists every runtime with its
 * models, and the box's agent chip opens the picker with each runtime's mark beside its name.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const chip = (page: Page) => page.getByRole('button', { name: 'Agent, model and effort' });
const shots = process.env.BELUGA_SHOTS_DIR;

test('your agent can be any runtime, and pickers show each one by its mark', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();

  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  const yours = settings.getByRole('combobox', { name: 'Your agent' });
  await expect(yours).toBeVisible();
  if (shots) await settings.screenshot({ path: `${shots}/01-settings-your-agent.png` });
  await yours.click();
  await expect(page.getByRole('option', { name: /Codex/ }).first()).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/02-your-agent-open.png` });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await chip(page).click();
  await page.getByRole('tab', { name: 'Codex' }).click();
  await expect(page.getByRole('radiogroup', { name: 'Codex models' })).toBeVisible({ timeout: 15_000 });
  if (shots) await page.screenshot({ path: `${shots}/03-model-picker.png` });
});
