import { expect, test, type Page } from './fixtures.js';
import { openGroupChat } from './helpers.js';

/**
 * Back and forward between pages (the toolbar's arrows, ⌘[ and ⌘]): the page you were on comes
 * back with what was open on it (the sidebar, the right panel and its tab: Scratch, Info…).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const tab = (page: Page, name: string) => panel(page).getByRole('tab', { name, exact: true });
const backButton = (page: Page) => page.getByRole('button', { name: 'Go back', exact: true });
const forwardButton = (page: Page) => page.getByRole('button', { name: 'Go forward', exact: true });

async function openWorkspace(page: Page, name: string): Promise<void> {
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

const onOverview = (page: Page) => expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('back and forward go between pages and bring back the sidebar and the panel’s tab as they were', async ({ page }, info) => {
  // A fresh window: nowhere to go yet.
  await expect(backButton(page)).toBeDisabled();
  await expect(forwardButton(page)).toBeDisabled();

  await openWorkspace(page, 'add-auth');
  // Info in the panel on this worktree.
  await page.keyboard.press('Meta+Alt+4');
  await expect(tab(page, 'Info')).toHaveAttribute('aria-selected', 'true');
  await expect(backButton(page)).toBeEnabled();

  // Overview, with the sidebar hidden there.
  await page.keyboard.press('Meta+1');
  await onOverview(page);
  await page.keyboard.press('Control+Meta+s');
  await expect(sidebar(page)).toBeHidden();
  await page.screenshot({ path: info.outputPath('01-overview-no-sidebar.png') });

  // Back: the worktree, its sidebar showing and Info open, as you left it.
  await backButton(page).click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await expect(sidebar(page)).toBeVisible();
  await expect(tab(page, 'Info')).toHaveAttribute('aria-selected', 'true');
  await expect(forwardButton(page)).toBeEnabled();
  await page.screenshot({ path: info.outputPath('02-back-to-worktree.png') });

  // Forward: Overview again, without the sidebar.
  await forwardButton(page).click();
  await onOverview(page);
  await expect(sidebar(page)).toBeHidden();
  await expect(forwardButton(page)).toBeDisabled();

  // The keys do the same.
  await page.keyboard.press('Meta+BracketLeft');
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+BracketRight');
  await onOverview(page);
  await expect(sidebar(page)).toBeHidden();
  // Leave the sidebar showing for the next tests.
  await page.keyboard.press('Control+Meta+s');
  await expect(sidebar(page)).toBeVisible();
});

test('Scratch and a closed panel come back with their worktree, and going somewhere new clears forward', async ({ page }, info) => {
  await openWorkspace(page, 'add-auth');
  await page.keyboard.press('Meta+Alt+6');
  await expect(tab(page, 'Scratch')).toHaveAttribute('aria-selected', 'true');

  // Another worktree, with the panel hidden.
  await openWorkspace(page, 'webhook-retries');
  await page.keyboard.press('Meta+Alt+0');
  await expect(panel(page)).toBeHidden();

  // Back: add-auth with the panel open on Scratch.
  await backButton(page).click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await expect(tab(page, 'Scratch')).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: info.outputPath('03-back-scratch.png') });

  // Forward: webhook-retries, its panel still hidden.
  await forwardButton(page).click();
  await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);
  await expect(panel(page)).toBeHidden();

  // Back, then somewhere new: nothing ahead any more.
  await backButton(page).click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await expect(forwardButton(page)).toBeEnabled();
  await page.keyboard.press('Meta+1');
  await onOverview(page);
  await expect(forwardButton(page)).toBeDisabled();
  // Clicking the same place again adds nothing: one Back is add-auth.
  await page.keyboard.press('Meta+1');
  await backButton(page).click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  // Leave the panel showing for other tests.
  await page.keyboard.press('Meta+Alt+4');
  await expect(panel(page)).toBeVisible();
});

test('a worktree archived since is skipped: Back goes to the page before it, never to a blank one', async ({ page }) => {
  // The group chat, then add-auth, then the Overview.
  await openGroupChat(page);
  await expect(composer(page)).toBeVisible();
  await openWorkspace(page, 'add-auth');
  await page.keyboard.press('Meta+1');
  await onOverview(page);
  // Archive add-auth from the Overview.
  await page.getByRole('tab', { name: /^All, \d+$/ }).click();
  const row = page.getByRole('listitem', { name: /^add-auth,/ });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Archive/ }).click();
  const alert = page.getByRole('alertdialog', { name: /Archive “add-auth”/ });
  await alert.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(alert).toBeHidden();
  await expect(row).toHaveAccessibleName('add-auth, archived', { timeout: 15_000 });
  // Back skips it: the group chat.
  await backButton(page).click();
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeHidden();
  await expect(composer(page)).not.toHaveAttribute('placeholder', /add-auth/);
  await expect(page.getByRole('main')).not.toContainText('This view ran into a problem');
  // Forward: the Overview (add-auth isn't there to go to).
  await forwardButton(page).click();
  await onOverview(page);
  await expect(forwardButton(page)).toBeDisabled();
});
