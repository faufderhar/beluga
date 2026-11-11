import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * The Overview shows everything, archived worktrees and chats too: segments with counts, a
 * project popup, a search (⌘F), and one-click Restore; deleting for good always asks first.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const row = (page: Page, name: string) => page.getByRole('listitem', { name: new RegExp(`^${name},`) });
/** Opening a workspace leaves the Overview for it (its header names it). */
async function expectOpened(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole('main')).toContainText(name);
}
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea):not([aria-label="Terminal input"])').first();
const segment = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}, \\d+$`) });

async function overview(page: Page): Promise<void> {
  await sidebar(page).getByRole('button', { name: 'Overview' }).click();
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();
}

/** Archive from the row's right-click menu (everything of yours is kept, uncommitted work too). */
async function archive(page: Page, name: string): Promise<void> {
  await segment(page, 'All').click();
  await row(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Archive/ }).click();
  const alert = page.getByRole('alertdialog', { name: new RegExp(`Archive “${name}”`) });
  await expect(alert).toContainText('Everything of yours is kept');
  await alert.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(alert).toBeHidden();
  await expect(row(page, name)).toHaveAccessibleName(`${name}, archived`, { timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await overview(page);
});

/** A demo worktree's folder (the demo keeps its records beside its projects; a project row's tooltip is its folder). */
async function folderOf(page: Page, name: string): Promise<string> {
  const title = await sidebar(page).locator('[title$="/bob-api"], [title$="/landing"]').first().getAttribute('title');
  const home = path.join(path.dirname(path.dirname(title!)), 'home');
  const records = JSON.parse(readFileSync(path.join(home, 'workspaces.json'), 'utf8')) as { workspaces: Array<{ name: string; path: string }> };
  return records.workspaces.find((w) => w.name === name)!.path;
}

test('an archived worktree is under Archived, and one click restores it as it was', async ({ page }) => {
  // Work in progress, a secret file git ignores, and dependencies that can be installed again.
  const dir = await folderOf(page, 'add-auth');
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env.local\n');
  writeFileSync(path.join(dir, 'package.json'), '{"name":"api"}');
  writeFileSync(path.join(dir, 'wip.txt'), 'half done');
  writeFileSync(path.join(dir, '.env.local'), 'TOKEN=1');
  mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'x'.repeat(200_000));
  await archive(page, 'add-auth');
  // It leaves the list at once; the folder goes in the background.
  await expect.poll(() => existsSync(dir), { timeout: 30_000 }).toBe(false);
  await segment(page, 'Archived').click();
  await expect(segment(page, 'Archived')).toHaveAttribute('aria-selected', 'true');
  const archived = row(page, 'add-auth');
  await expect(archived).toBeVisible();
  await expect(archived).toContainText('beluga/add-auth');
  // Archived smartly: it says what it freed.
  await expect(archived).toContainText(/Freed \d/);
  await expect(row(page, 'webhook-retries')).toBeHidden();

  // The segment is remembered.
  await page.reload();
  await overview(page);
  await expect(segment(page, 'Archived')).toHaveAttribute('aria-selected', 'true');

  await row(page, 'add-auth').hover();
  await row(page, 'add-auth').getByRole('button', { name: 'Restore' }).click();
  // Restoring opens it, and it's in the sidebar again.
  await expectOpened(page, 'add-auth');
  await expect(sidebar(page).getByRole('button', { name: 'add-auth', exact: true })).toBeVisible();
  // As it was: the work in progress and the secret file; dependencies are made again, not kept.
  expect(readFileSync(path.join(dir, 'wip.txt'), 'utf8')).toBe('half done');
  expect(readFileSync(path.join(dir, '.env.local'), 'utf8')).toBe('TOKEN=1');
  expect(existsSync(path.join(dir, 'node_modules'))).toBe(false);
  await overview(page);
  // Out of Archived (the demo keeps a plan's archived chat there, so it isn't empty).
  await expect(segment(page, 'Archived')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'add-auth')).toBeHidden();
  await segment(page, 'All').click();
  await expect(row(page, 'add-auth')).not.toHaveAccessibleName(/archived/);
});

test('search (⌘F) finds by name, branch and project; Esc clears it', async ({ page }) => {
  await segment(page, 'All').click();
  await page.keyboard.press('Meta+F');
  const search = page.getByRole('searchbox', { name: 'Search workspaces' });
  await expect(search).toBeFocused();
  await search.fill('webhook');
  await expect(row(page, 'webhook-retries')).toBeVisible();
  await expect(row(page, 'add-auth')).toBeHidden();
  await expect(segment(page, 'All')).toHaveAccessibleName('All, 1');

  await search.fill('beluga/new-hero');
  await expect(row(page, 'new-hero')).toBeVisible();
  await expect(row(page, 'webhook-retries')).toBeHidden();

  await search.fill('landing');
  await expect(row(page, 'new-hero')).toBeVisible();
  await expect(row(page, 'add-auth')).toBeHidden();

  await search.fill('zzzz nothing');
  await expect(page.getByText('No results for “zzzz nothing”')).toBeVisible();
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(row(page, 'add-auth')).toBeVisible();
});

test('the project popup narrows the list to one project', async ({ page }) => {
  await segment(page, 'All').click();
  await page.getByRole('button', { name: 'Project: All Projects' }).click();
  await page.getByRole('menuitem', { name: 'landing' }).click();
  await expect(row(page, 'new-hero')).toBeVisible();
  await expect(row(page, 'add-auth')).toBeHidden();
  await page.getByRole('button', { name: 'Project: landing' }).click();
  await page.getByRole('menuitem', { name: 'All Projects' }).click();
  await expect(row(page, 'add-auth')).toBeVisible();
});

test('the arrow keys move between rows and Return opens one', async ({ page }) => {
  await segment(page, 'All').click();
  const search = page.getByRole('searchbox', { name: 'Search workspaces' });
  await search.fill('a');
  await search.press('ArrowDown');
  const first = page.locator('[data-row]').first();
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-row]').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(first).toBeFocused();
  const name = (await first.getAttribute('aria-label'))!.split(',')[0]!;
  await page.keyboard.press('Enter');
  await expectOpened(page, name);
});

test('deleting an archived worktree asks first, in red; reading it changes nothing', async ({ page }) => {
  await archive(page, 'new-hero');
  await segment(page, 'Archived').click();
  await row(page, 'new-hero').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Delete Permanently/ }).click();
  const alert = page.getByRole('alertdialog', { name: /Delete “new-hero” permanently\?/ });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('beluga/new-hero');
  await expect(alert.getByRole('button', { name: 'Delete' })).toBeFocused();
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toBeHidden();
  await expect(row(page, 'new-hero')).toBeVisible();

  // ⌘⌫ asks the same.
  await row(page, 'new-hero').focus();
  await page.keyboard.press('Meta+Backspace');
  await expect(alert).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(alert).toBeHidden();

  // Read it without restoring: no message box, Space closes it.
  await row(page, 'new-hero').click();
  const peek = page.getByRole('dialog', { name: /new-hero/ });
  await expect(peek).toContainText('read only');
  await expect(peek.locator('textarea')).toHaveCount(0);
  await page.keyboard.press(' ');
  await expect(peek).toBeHidden();
  await expect(row(page, 'new-hero')).toHaveAccessibleName('new-hero, archived');

  // Restore from its menu, so the next tests find it as it was.
  await row(page, 'new-hero').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Restore' }).click();
  await expect(sidebar(page).getByRole('button', { name: 'new-hero', exact: true })).toBeVisible({ timeout: 20_000 });
});

test('archived work leaves the sidebar; the project menu shows it in the Overview', async ({ page }) => {
  await archive(page, 'webhook-retries');
  await expect(sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true })).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: /^Archived/ })).toHaveCount(0);
  await sidebar(page).getByRole('button', { name: 'bob-api', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Show Archived/ }).click();
  await expect(segment(page, 'Archived')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'webhook-retries')).toBeVisible();
  // Put it back for the tests after this one.
  await row(page, 'webhook-retries').hover();
  await row(page, 'webhook-retries').getByRole('button', { name: /^Restore/ }).click();
  await expect(sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true })).toBeVisible({ timeout: 15_000 });
});

test('the Chats header’s ••• shows archived chats in the Overview', async ({ page }) => {
  const text = 'Plan the spring trip';
  await sidebar(page).getByRole('button', { name: 'New chat (not tied to a project)' }).click();
  await expect(composer(page)).toBeVisible();
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(sidebar(page).getByRole('button', { name: text, exact: true })).toBeVisible({ timeout: 15_000 });
  // Nothing archived yet: no ••• to open.
  await expect(sidebar(page).getByRole('button', { name: 'Chats Options' })).toHaveCount(0);

  await overview(page);
  await segment(page, 'All').click();
  await row(page, text).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Archive/ }).click();
  const alert = page.getByRole('alertdialog', { name: new RegExp(`Archive “${text}”`) });
  await expect(alert).toContainText('The chat leaves the sidebar');
  await alert.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(row(page, text)).toHaveAccessibleName(`${text}, archived`, { timeout: 15_000 });
  await expect(sidebar(page).getByRole('button', { name: text, exact: true })).toHaveCount(0);
  await sidebar(page).getByRole('button', { name: 'Chats Options' }).click();
  await page.getByRole('menuitem', { name: 'Show Archived (1)' }).click();
  await expect(segment(page, 'Archived')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, text)).toBeVisible();
  // Put it back for the tests after this one.
  await row(page, text).hover();
  await row(page, text).getByRole('button', { name: /^Restore/ }).click();
  await expect(sidebar(page).getByRole('button', { name: text, exact: true })).toBeVisible({ timeout: 15_000 });
});
