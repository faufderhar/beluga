import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * With the sidebar categories on, a chat's row does what it does in a project's list: Rename… edits
 * its name in place, Regenerate title is in its menu, and Shift+click picks a range of chats for
 * one menu. Screenshots go to $BELUGA_SHOTS_DIR when it's set.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const categories = (page: Page) => sidebar(page).locator('[role="region"]').filter({ has: page.locator('[data-category]') });
const NAMES = ['cat-pick-1', 'cat-pick-2', 'cat-pick-3'];
const shots = process.env.BELUGA_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/${name}.png` });
}

test('a category chat row renames, offers Regenerate title, and picks a range with Shift+click', async ({ page, demo }) => {
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });
  await client.api.session.setPrefs({ chatCategories: true, folded: [] });
  const project = client.store.getState().projects.find((p) => p.name === 'bob-api')!.id;
  for (const name of NAMES) await client.api.workspaces.newChat(project, name);
  client.close();
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const chat = (name: string) => categories(page).locator('[data-chat-id]').filter({ has: page.getByText(name, { exact: true }) });
  for (const name of NAMES) await expect(chat(name)).toBeVisible({ timeout: 20_000 });
  const order = await categories(page).locator('[data-chat-id]').evaluateAll((rows) => rows.map((r) => r.textContent ?? ''));
  const ours = NAMES.slice().sort((a, b) => order.findIndex((t) => t.includes(a)) - order.findIndex((t) => t.includes(b)));

  // Its menu has the project list's Rename… and Regenerate title.
  await chat(ours[0]!).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Regenerate title' })).toBeVisible();
  await shot(page, 'cat-1-menu');
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByLabel('Chat name').fill('cat-renamed');
  await shot(page, 'cat-2-renaming');
  await page.keyboard.press('Enter');
  await expect(chat('cat-renamed')).toBeVisible();
  ours[0] = 'cat-renamed';

  // Click, then Shift+click: the range is picked, and its menu acts on all of it.
  const status = sidebar(page).getByRole('status').filter({ hasText: /selected/ });
  await chat(ours[0]!).click();
  await chat(ours[2]!).click({ modifiers: ['Shift'] });
  await expect(status).toContainText('3 chats selected');
  await expect(categories(page).locator('[data-chat-selected]')).toHaveCount(3);
  // One box, also for the chat you're in (it shows under Projects too).
  await expect(chat(ours[0]!)).toHaveAttribute('data-chat-join', 'down');
  await expect(chat(ours[1]!)).toHaveAttribute('data-chat-join', 'up down');
  await expect(chat(ours[2]!)).toHaveAttribute('data-chat-join', 'up');
  await chat(ours[1]!).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Archive 3 Chats…' })).toBeVisible();
  await shot(page, 'cat-3-range-menu');
  await page.keyboard.press('Escape');
});

test('the picked chats regenerate their titles and settle at once, and a settled chat archives from its row', async ({ page, demo }) => {
  test.setTimeout(120_000);
  const asks = ['Draft the pricing copy', 'Plan the launch email', 'Sketch the onboarding flow'];
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });
  await client.api.session.setPrefs({ chatCategories: true, folded: [] });
  const project = client.store.getState().projects.find((p) => p.name === 'bob-api')!.id;
  const names = ['bulk-1', 'bulk-2', 'bulk-3'];
  for (const name of names) await client.api.workspaces.newChat(project, name);
  client.close();
  await page.goto('/');
  const row = (name: string) => categories(page).locator('[data-chat-id]').filter({ has: page.getByText(name, { exact: true }) });
  const inList = (list: string, name: string) => sidebar(page).getByRole('region', { name: list }).locator('[data-chat-id]').filter({ has: page.getByText(name, { exact: true }) });
  // Something in each to make a title from.
  for (const [i, name] of names.entries()) {
    await row(name).click();
    await page.locator('textarea:not(.xterm-helper-textarea)').first().fill(asks[i]!);
    await page.locator('textarea:not(.xterm-helper-textarea)').first().press('Enter');
  }
  for (const name of names) await expect(inList('Inbox', name)).toBeVisible({ timeout: 45_000 });
  const order = await categories(page).locator('[data-chat-id]').evaluateAll((rows) => rows.map((r) => r.textContent ?? ''));
  const ours = names.slice().sort((a, b) => order.findIndex((t) => t.includes(a)) - order.findIndex((t) => t.includes(b)));

  // Regenerate 3 Titles: each takes a name from its own conversation.
  await row(ours[0]!).click();
  await row(ours[2]!).click({ modifiers: ['Shift'] });
  await row(ours[1]!).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Remind Me Later About 3 Chats' })).toBeVisible();
  await shot(page, 'bulk-1-menu');
  await page.getByRole('menuitem', { name: 'Regenerate 3 Titles' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Regenerated titles of 3 chats.' })).toBeVisible({ timeout: 20_000 });
  for (const ask of asks) await expect(row(ask)).toBeVisible();
  await shot(page, 'bulk-2-regenerated');

  // Settle 3 Chats: all three go to Settled.
  await row(asks[0]!).click();
  const sorted = await categories(page).locator('[data-chat-id]').evaluateAll((rows) => rows.map((r) => r.textContent ?? ''));
  const titled = asks.slice().sort((a, b) => sorted.findIndex((t) => t.includes(a)) - sorted.findIndex((t) => t.includes(b)));
  await row(titled[0]!).click();
  await row(titled[2]!).click({ modifiers: ['Shift'] });
  await row(titled[1]!).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Settle 3 Chats' }).click();
  for (const ask of asks) await expect(inList('Settled', ask)).toBeVisible({ timeout: 15_000 });

  // A settled row: Archive beside Un-settle.
  await inList('Settled', asks[0]!).hover();
  await expect(page.getByRole('button', { name: `Un-settle ${asks[0]}` })).toBeVisible();
  await shot(page, 'bulk-3-settled-archive');
  await page.getByRole('button', { name: `Archive ${asks[0]}` }).click();
  const alert = page.getByRole('alertdialog', { name: /Archive/ });
  await alert.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(row(asks[0]!)).toHaveCount(0, { timeout: 15_000 });
});
