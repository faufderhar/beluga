import { expect, test, type Page } from './fixtures.js';

/**
 * Settings › Agent › Models in chat decides what the model menu offers, on a project's home and in
 * a conversation. In a conversation the thinking meter is that conversation's; Settings applies again
 * when it isn't pinned.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const chip = (page: Page) => page.getByRole('button', { name: 'Agent, model and effort' });

test('the home and a conversation offer only the models turned on, and effort can be this conversation’s', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();

  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'What do you want to do in bob-api?' })).toBeVisible();
  await expect(chip(page)).toBeVisible();
  await chip(page).click();
  await expect(page.getByRole('radio', { name: /Haiku/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Auto' })).toBeVisible();
  await page.getByRole('radio', { name: 'High', exact: true }).click();
  await expect(chip(page)).toHaveText(/High/);
  await page.keyboard.press('Escape');

  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Agent' }).click();
  const models = settings.getByRole('heading', { name: 'Models in chat' });
  await expect(models).toBeVisible();
  await expect(settings.getByText('Only these appear in the chat’s model menu.')).toBeVisible();
  const haiku = settings.getByRole('switch', { name: 'Claude Haiku' });
  await expect(haiku).toHaveAttribute('aria-checked', 'true');
  await haiku.click();
  await expect(haiku).toHaveAttribute('aria-checked', 'false');
  await expect(settings.getByRole('switch', { name: 'Claude Opus' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  await chip(page).click();
  await expect(page.getByRole('radio', { name: /Haiku/ })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Opus/ })).toBeVisible();
  await page.keyboard.press('Escape');

  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(page.locator('textarea:not(.xterm-helper-textarea)')).toHaveAttribute('placeholder', /add-auth/);
  await expect(chip(page)).toHaveText(/High/);
  await chip(page).click();
  await expect(page.getByText('follows Settings', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Settings' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: /Haiku/ })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Low', exact: true }).click();
  await expect(page.locator('span').getByText('for this conversation', { exact: true })).toHaveCount(2);
  await expect(chip(page)).toHaveText(/Low/);
  await page.getByRole('radio', { name: 'Settings' }).click();
  await expect(chip(page)).toHaveText(/High/);
  await expect(chip(page)).not.toHaveText(/Low/);
});
