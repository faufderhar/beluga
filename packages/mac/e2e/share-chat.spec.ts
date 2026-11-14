import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';
import { pick } from './helpers.js';

/**
 * A plain chat (one in no project) is shared with a friend from its own Share sheet, as a worktree
 * is: its copy says chat, and gives its conversation and Scratch (it has no project files).
 * Screenshots go to $SHARE_SHOTS when it's set.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shots = process.env.SHARE_SHOTS;

test('a plain chat is shared with a friend from its Share sheet, in words that fit a chat', async ({ page, demo }) => {
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });
  await client.api.workspaces.newChat('chats', 'trip plans');
  client.close();
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'trip plans' }).first().click();
  await page.keyboard.press('Meta+Alt+4');
  await page.getByRole('button', { name: 'Share this chat' }).click();
  const sheet = page.getByRole('dialog', { name: /^Share “trip plans”/ });
  await expect(sheet).toContainText('Only this chat: people you add see its conversation and Scratch, and can ask your agent here.');
  await expect(sheet).not.toContainText('worktree');
  if (shots) await page.screenshot({ path: `${shots}/01-chat-share-sheet.png` });

  await pick(sheet, 'Friend to share with', 'bob');
  await pick(sheet, 'What they can do', 'Can follow');
  if (shots) await sheet.screenshot({ path: `${shots}/02-chat-share-picked.png` });
  await sheet.getByRole('button', { name: 'Share', exact: true }).click();
  const people = sheet.getByRole('list', { name: 'People with access' });
  await expect(people.getByRole('listitem')).toHaveCount(2);
  await expect(sheet.getByRole('combobox', { name: 'Access for bob' })).toContainText('Can follow');
  await expect(page.getByRole('status').filter({ hasText: 'can now follow along in trip plans' })).toBeVisible();
  await expect(page.getByText('can’t be shared this way')).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/03-chat-shared.png` });
});
