import { expect, test, type Page } from './fixtures.js';
import { pick } from './helpers.js';

/** BLG-623: a Share sheet adds people one at a time (a friend, what they can do, Share) and lists only who has it. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shots = process.env.SHARE_SHOTS;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a worktree is shared by picking a friend and a level; only who has it is listed, changed or removed in place', async ({ page }) => {
  const row = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await page.keyboard.press('Meta+Alt+4');
  await page.getByRole('button', { name: 'Share this worktree' }).click();
  const sheet = page.getByRole('dialog', { name: /^Share “webhook-retries”/ });
  const people = sheet.getByRole('list', { name: 'People with access' });
  // Nobody but you yet: no row of friends with "No access".
  await expect(people.getByRole('listitem')).toHaveCount(1);
  await expect(people).toContainText('Only you so far');
  await expect(sheet.getByRole('button', { name: 'Share', exact: true })).toBeDisabled();
  if (shots) await sheet.screenshot({ path: `${shots}/01-share-empty.png` });

  await pick(sheet, 'Friend to share with', 'bob');
  await pick(sheet, 'What they can do', 'Can follow');
  if (shots) await sheet.screenshot({ path: `${shots}/02-share-picked.png` });
  await sheet.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(people.getByRole('listitem')).toHaveCount(2);
  await expect(sheet.getByRole('combobox', { name: 'Access for bob' })).toContainText('Can follow');
  await expect(people).toContainText('read-only');
  if (shots) await sheet.screenshot({ path: `${shots}/03-share-added.png` });

  await pick(sheet, 'Access for bob', 'Remove access');
  await expect(people.getByRole('listitem')).toHaveCount(1);
});

test('a shared worktree has a green dot in the sidebar; changing access from the project keeps it to that worktree (BLG-940)', async ({ page }) => {
  const nav = sidebar(page);
  const row = nav.getByRole('button', { name: 'webhook-retries', exact: true });
  if (!(await row.isVisible())) await nav.getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  const dot = (name: string) => nav.getByRole('button', { name, exact: true }).getByRole('img', { name: /^Shared with/ });
  await expect(dot('webhook-retries')).toHaveCount(0);

  await row.click();
  await page.keyboard.press('Meta+Alt+4');
  await page.getByRole('button', { name: 'Share this worktree' }).click();
  const sheet = page.getByRole('dialog', { name: /^Share “webhook-retries”/ });
  await pick(sheet, 'Friend to share with', 'bob');
  await pick(sheet, 'What they can do', 'Can follow');
  await sheet.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(sheet.getByRole('combobox', { name: 'Access for bob' })).toContainText('Can follow');
  await sheet.getByRole('button', { name: 'Done' }).click();

  // Only that worktree: its row has the dot, saying who; the project's others don't.
  await expect(dot('webhook-retries')).toHaveAttribute('aria-label', 'Shared with bob');
  const others = nav.locator('[data-kind="worktree"]').filter({ hasNot: page.getByRole('img', { name: /^Shared with/ }) });
  await expect(others.first()).toBeVisible();
  if (shots) {
    await nav.screenshot({ path: `${shots}/04-sidebar-shared-light.png` });
    await page.emulateMedia({ colorScheme: 'dark' });
    await nav.screenshot({ path: `${shots}/05-sidebar-shared-dark.png` });
    await page.emulateMedia({ colorScheme: 'light' });
  }

  // The project's Share with…: bob has one worktree; giving him more to do there doesn't hand him the whole project.
  await nav.getByRole('button', { name: 'bob-api' }).first().click({ button: 'right', position: { x: 60, y: 10 } });
  await page.getByRole('menuitem', { name: 'Share with…' }).click();
  const project = page.getByRole('dialog', { name: /^Share “bob-api”/ });
  const bob = project.getByRole('listitem').filter({ hasText: 'bob' });
  await expect(bob).toContainText('one worktree');
  await pick(project, 'Access for bob', 'Can work here');
  await expect(project.getByRole('combobox', { name: 'Access for bob' })).toContainText('Can work here');
  await expect(bob).toContainText('one worktree');
  if (shots) await project.screenshot({ path: `${shots}/06-project-sheet-one-worktree.png` });
  await project.getByRole('button', { name: 'Done' }).click();
  await expect(dot('webhook-retries')).toBeVisible();
  await expect(others.first()).toBeVisible();
});
