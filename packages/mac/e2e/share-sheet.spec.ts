import { expect, test, type Page } from './fixtures.js';
import { optionLabels, pick, popup, popupMenu } from './helpers.js';

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
  await pick(sheet, 'What they can do', 'Can see');
  if (shots) await sheet.screenshot({ path: `${shots}/02-share-picked.png` });
  await sheet.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(people.getByRole('listitem')).toHaveCount(2);
  await expect(sheet.getByRole('combobox', { name: 'Access for bob' })).toContainText('Can see');
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
  await pick(sheet, 'What they can do', 'Can see');
  await sheet.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(sheet.getByRole('combobox', { name: 'Access for bob' })).toContainText('Can see');
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
  await pick(project, 'Access for bob', 'Can chat');
  await expect(project.getByRole('combobox', { name: 'Access for bob' })).toContainText('Can chat');
  await expect(bob).toContainText('one worktree');
  if (shots) await project.screenshot({ path: `${shots}/06-project-sheet-one-worktree.png` });
  await project.getByRole('button', { name: 'Done' }).click();
  await expect(dot('webhook-retries')).toBeVisible();
  await expect(others.first()).toBeVisible();
});

test('Hand off lives in Share: "Can take it over" hands a worktree over, and any share can come with a handoff note (BLG-967)', async ({ page }) => {
  const row = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  // No Hand Off of its own any more: ⌘K's "handoff" opens Share on "Can take it over".
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('handoff');
  await expect(page.getByRole('option', { name: /Hand Off to Someone/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Share So Someone Takes It Over/ }).click();
  const sheet = page.getByRole('dialog', { name: /^Share “webhook-retries”/ });
  await expect(sheet.getByRole('combobox', { name: 'What they can do' })).toContainText('Can take it over');
  const note = sheet.getByRole('checkbox', { name: /Write a handoff note/ });
  await expect(note).toBeChecked();
  await expect(note).toBeDisabled();
  await expect(sheet.getByRole('button', { name: 'Hand Over' })).toBeDisabled();
  // Who can take it over: the room's people with their agent, and friends, each saying which.
  await popup(sheet, 'Friend to share with').click();
  const inRoom = popupMenu(page).getByRole('option', { name: 'bob', exact: true }).first();
  await expect(inRoom).toContainText('In your room');
  await inRoom.click();
  // Their Beluga is asked first whether it could take it: the demo's bob doesn't take work from friends.
  await expect(sheet).toContainText('bob has turned off work from friends');
  await expect(sheet.getByRole('button', { name: 'Hand Over' })).toBeDisabled();
  if (shots) await sheet.screenshot({ path: `${shots}/07-take-over-cannot.png` });
  // bob the friend, over the network: no answer from the demo's network, so it goes ahead as before.
  await popup(sheet, 'Friend to share with').click();
  const friend = popupMenu(page).getByRole('option', { name: 'bob', exact: true }).nth(1);
  await expect(friend).toContainText('Friend');
  await friend.click();
  await expect(sheet).toContainText('bob gets the latest branch, this chat and the note in a worktree on their computer');
  await expect(sheet.getByRole('button', { name: 'Hand Over' })).toBeEnabled();
  if (shots) {
    await sheet.screenshot({ path: `${shots}/07-take-over-light.png` });
    await page.emulateMedia({ colorScheme: 'dark' });
    await sheet.screenshot({ path: `${shots}/08-take-over-dark.png` });
    await page.emulateMedia({ colorScheme: 'light' });
  }

  // Back to sharing here: the note is a choice now, off until you tick it.
  await pick(sheet, 'What they can do', 'Can chat');
  await expect(sheet.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  await expect(note).toBeEnabled();
  await expect(note).not.toBeChecked();
  await pick(sheet, 'Friend to share with', 'mia');
  await note.check();
  if (shots) await sheet.screenshot({ path: `${shots}/09-share-with-note.png` });
  await sheet.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(sheet.getByRole('combobox', { name: 'Access for mia' })).toContainText('Can chat');
  await pick(sheet, 'Access for mia', 'Remove access');
});

test('one ladder of what a friend can do: see, chat, fork, fork with secrets (BLG-1019)', async ({ page }) => {
  const row = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await page.keyboard.press('Meta+Alt+4');
  await page.getByRole('button', { name: 'Share this worktree' }).click();
  const sheet = page.getByRole('dialog', { name: /^Share “webhook-retries”/ });
  // bob already has it from the test before: mia, the one who doesn't.
  const labels = await optionLabels(popup(sheet, 'What they can do'));
  expect(labels.map((l) => l.split('\n')[0]!.trim())).toEqual(['Can see', 'Can chat', 'Can fork', 'Can fork with secrets', 'Can take it over']);
  await pick(sheet, 'Friend to share with', 'mia');
  await pick(sheet, 'What they can do', 'Can fork');
  await sheet.getByRole('button', { name: 'Share', exact: true }).click();
  const access = sheet.getByRole('combobox', { name: 'Access for mia' });
  await expect(access).toContainText('Can fork');
  await expect(sheet.getByRole('list', { name: 'People with access' })).toContainText('forks, never a secret');
  await pick(sheet, 'Access for mia', 'Can fork with secrets');
  await expect(access).toContainText('Can fork with secrets');
  await expect(sheet.getByRole('list', { name: 'People with access' })).toContainText('forks, with secrets');
  if (shots) {
    await sheet.screenshot({ path: `${shots}/10-levels-fork-secrets.png` });
    await popup(sheet, 'Access for mia').click();
    await page.screenshot({ path: `${shots}/11-levels-menu.png` });
    await page.keyboard.press('Escape');
  }
  await pick(sheet, 'Access for mia', 'Remove access');
});
