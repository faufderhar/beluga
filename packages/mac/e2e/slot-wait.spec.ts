import { expect, test, type Page } from './fixtures.js';

/**
 * Past the limit of conversations your Claude works in at once (Settings › Claude › Working at
 * once), a message says it waits for a free Claude instead of "the current task", and offers to
 * start it now or change the limit.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

async function open(page: Page, name: string, project = 'bob-api'): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: project }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toBeVisible();
}

test('a message past the limit waits for a free Claude, and says so', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  const slider = settings.getByRole('slider', { name: 'Conversations at once' });
  await expect(slider).toHaveValue('10');
  await slider.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '../../.beluga/scratch/02-settings-working-at-once.png' });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveValue('1');
  await slider.blur();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  await open(page, 'add-auth');
  // A long run (the demo's "take your time" script, src/agent/mock.ts): a quick one would free the agent before Start now.
  await composer(page).fill('Write the whole auth module with tests, take your time');
  await page.keyboard.press('Enter');
  await open(page, 'webhook-retries');
  await composer(page).fill('can you continue');
  await page.keyboard.press('Enter');
  const notice = page.getByRole('status').filter({ hasText: 'Waiting for a free agent' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('working in 1 other conversation');
  await expect(page.getByLabel('Queued messages')).toContainText('waiting for a free agent: 1 other conversation is working');
  await page.screenshot({ path: '../../.beluga/scratch/01-waiting-for-a-free-claude.png' });
  await notice.getByRole('button', { name: 'Start now' }).click();
  await expect(notice).toBeHidden();
});
