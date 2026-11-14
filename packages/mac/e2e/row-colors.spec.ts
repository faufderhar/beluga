import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * Colours in the sidebar: a project's Color ▸ colours its row and its chats; a chat can have its
 * own, or None to stay plain; a chat outside any project takes one of its own. Nothing is coloured
 * before you pick. Screenshots (light and dark) go to $BELUGA_SHOTS_DIR when it's set.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shots = process.env.BELUGA_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  await page.waitForTimeout(400);
  await sidebar(page).screenshot({ path: `${shots}/${name}.png` });
}

async function pick(page: Page, row: ReturnType<Page['locator']>, color: string): Promise<void> {
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Color', exact: true }).hover();
  await page.getByRole('menuitem', { name: color, exact: true }).click();
}

test('projects and chats take the colour you pick, and nothing else changes', async ({ page, demo }) => {
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });
  await client.api.session.setPrefs({ folded: [] });
  const projects = client.store.getState().projects;
  const api = projects.find((p) => p.name === 'bob-api')!;
  const chats = projects.find((p) => !p.root)!;
  for (const name of ['color-login', 'color-billing', 'color-plain']) await client.api.workspaces.newChat(api.id, name);
  await client.api.workspaces.newChat(chats.id, 'color-ideas');
  client.close();
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const chat = (name: string) => sidebar(page).locator('[data-chat-id]').filter({ has: page.getByText(name, { exact: true }) }).first();
  const project = sidebar(page).locator('[data-drag^="project:"]').filter({ hasText: 'bob-api' });
  await expect(project).toBeVisible();
  // Unfolded, so its chats show under it.
  if ((await project.getAttribute('aria-expanded')) === 'false') await project.getByRole('button', { name: /Show what's in bob-api/ }).click();
  await expect(chat('color-login')).toBeVisible({ timeout: 20_000 });

  // Before anything is picked: no row is coloured.
  await expect(sidebar(page).locator('[data-row-color]')).toHaveCount(0);
  await shot(page, '01-plain');

  // The project, Blue: its row and every chat in it.
  await pick(page, project, 'Blue');
  await expect(project).toHaveAttribute('data-row-color', 'blue');
  await expect(chat('color-login')).toHaveAttribute('data-row-color', 'blue');
  await expect(chat('color-plain')).toHaveAttribute('data-row-color', 'blue');

  // A chat's own colour wins; None keeps one plain in a coloured project.
  await pick(page, chat('color-billing'), 'Pink');
  await expect(chat('color-billing')).toHaveAttribute('data-row-color', 'pink');
  await pick(page, chat('color-plain'), 'None');
  await expect(chat('color-plain')).not.toHaveAttribute('data-row-color');

  // A chat outside any project: a colour of its own.
  await expect(chat('color-ideas')).toBeVisible();
  await pick(page, chat('color-ideas'), 'Green');
  await expect(chat('color-ideas')).toHaveAttribute('data-row-color', 'green');
  await shot(page, '02-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, '03-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Same as Project again: it follows the project.
  await pick(page, chat('color-billing'), 'Same as Project (Blue)');
  await expect(chat('color-billing')).toHaveAttribute('data-row-color', 'blue');

  // Kept on this Mac: still there after a reload.
  await page.reload();
  await expect(chat('color-billing')).toHaveAttribute('data-row-color', 'blue', { timeout: 20_000 });
  await expect(chat('color-ideas')).toHaveAttribute('data-row-color', 'green');

  // The project back to None: its chats are plain again.
  await pick(page, project, 'None');
  await expect(project).not.toHaveAttribute('data-row-color');
  await expect(chat('color-login')).not.toHaveAttribute('data-row-color');
});
