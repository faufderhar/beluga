import { expect, test, type Page } from './fixtures.js';

/**
 * A long list of models (BLG-945, GitHub #504): the demo's OpenCode has DeepSeek, Kimi and
 * OpenRouter set up. The picker shows each provider's models under its name, draws a page at a
 * time, and a search field finds Kimi or DeepSeek wherever they're served.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const chip = (page: Page) => page.getByRole('button', { name: 'Agent, model and effort' });
const shots = process.env.BELUGA_SHOTS_DIR;

test('OpenCode’s many models: under their providers, a page at a time, and searchable', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await chip(page).click();
  await page.getByRole('tab', { name: 'OpenCode' }).click();

  const models = page.getByRole('radiogroup', { name: 'OpenCode models' });
  await expect(models).toBeVisible({ timeout: 15_000 });
  const search = page.getByRole('searchbox', { name: 'Search OpenCode models' });
  await expect(search).toBeVisible();
  // Each provider's models under its name.
  await expect(models.getByRole('group', { name: 'DeepSeek' })).toBeVisible();
  await expect(models.getByRole('group', { name: 'Moonshot AI (Kimi)' })).toBeVisible();
  // A page drawn; the rest as you scroll to them.
  const more = models.getByText(/^\d+ more…$/);
  await expect(more).toBeVisible();
  const drawn = await models.getByRole('radio').count();
  if (shots) await page.screenshot({ path: `${shots}/01-opencode-providers.png` });
  await more.scrollIntoViewIfNeeded();
  await expect.poll(() => models.getByRole('radio').count()).toBeGreaterThan(drawn);
  await expect(more).toHaveCount(0);

  // Kimi, from Moonshot AI and through OpenRouter, the best matches first.
  await search.fill('kimi');
  await expect(models.getByRole('radio').first()).toContainText('Kimi K2 Thinking');
  await expect(models.getByRole('radio', { name: /Kimi K2 \(free\)/ })).toBeVisible();
  await expect(models.getByRole('radio', { name: /DeepSeek/ })).toHaveCount(0);
  if (shots) {
    await page.screenshot({ path: `${shots}/02-search-kimi.png` });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/02b-search-kimi-dark.png` });
    await page.emulateMedia({ colorScheme: 'light' });
  }

  await search.fill('deepseek free');
  await expect(models.getByRole('radio')).toHaveCount(1);
  await expect(models.getByRole('radio').first()).toContainText('DeepSeek R1 (free)');

  await search.fill('nothing like this');
  await expect(models.getByText('No OpenCode model matches “nothing like this”.')).toBeVisible();

  // Enter picks the best match; the chip says it.
  await search.fill('deepseek reasoner');
  await search.press('Enter');
  await expect(chip(page)).toContainText('DeepSeek Reasoner');
  if (shots) await page.screenshot({ path: `${shots}/03-picked-deepseek.png` });
});
