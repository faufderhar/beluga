import { expect, test, type Page } from './fixtures.js';

/** A worktree's link (BLG-878): Copy Link from its menu, pasted in another chat, is its chip there. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const toolbar = (page: Page) => page.locator('main header').first();

async function row(page: Page, name: string) {
  const it = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await it.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  return it;
}

test('Copy Link on a worktree, pasted in another chat, shows as its chip', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();

  // Right-click › Copy Link: the worktree's ref on the clipboard.
  await (await row(page, 'webhook-retries')).click({ button: 'right' });
  // The row's menu draws again as the busy demo moves on (as instant-worktrees.spec does for Delete…).
  await page.getByRole('menuitem', { name: 'Copy Link' }).dispatchEvent('click');
  await expect(page.getByText(/Copied a link to webhook-retries/).last()).toBeVisible();
  const ref = await page.evaluate(() => navigator.clipboard.readText());
  expect(ref).toMatch(/^worktree:[\w-]{3,80}$/);

  // The header's ••• has it too.
  await (await row(page, 'add-auth')).click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await toolbar(page).getByRole('button', { name: 'More for this workspace' }).click();
  await expect(page.getByRole('menuitem', { name: 'Copy Link' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Pasted in another worktree's chat: a chip in the box over the ref, as a pasted image is…
  await composer(page).fill(`compare this with ${ref}`);
  const inBox = page.getByTestId('mention-highlighter').locator('mark[data-kind="worktree"]');
  await expect(inBox).toContainText('webhook-retries');
  const box = (await composer(page).boundingBox())!;
  await page.screenshot({ path: '../../.beluga/scratch/03-worktree-chip-in-box.png', clip: { x: box.x - 16, y: box.y - 44, width: Math.min(box.width + 32, 640), height: box.height + 60 } });
  await composer(page).fill(`compare this with ${ref} and tell me what differs`);
  await expect(inBox).toContainText('webhook-retries');
  await page.screenshot({ path: '../../.beluga/scratch/04-worktree-chip-words-after.png', clip: { x: box.x - 16, y: box.y - 44, width: Math.min(box.width + 32, 640), height: box.height + 60 } });
  await composer(page).fill(`compare this with ${ref}`);

  // …and in the message once it is.
  await composer(page).press('Enter');
  const chip = page.getByRole('button', { name: /^Worktree webhook-retries in / }).first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: '../../.beluga/scratch/02-worktree-link-sent.png' });

  // A click opens it.
  await chip.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);
});
