import path from 'node:path';
import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test } from './fixtures.js';

/**
 * Settings › Appearance › Archive settled chats: a free number of days (14 by default, 0: never),
 * shown with the sidebar categories on, saved to the daemon when you leave the field.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');

test('Archive settled chats takes any whole number of days', async ({ page, demo }) => {
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });
  await client.api.session.setPrefs({ chatCategories: true });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('combobox', { name: 'Search settings' }).fill('Archive settled chats');
  await page.keyboard.press('Enter');

  const days = dialog.getByRole('spinbutton', { name: 'Archive settled chats after days' });
  await expect(days).toHaveValue('14');
  await expect(dialog.getByText(/A chat in Settled for 14 days is archived/)).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'archive-settled-1-default.png') });

  await days.fill('45');
  await days.press('Enter');
  await expect.poll(() => client.store.getState().prefs.archiveSettledDays).toBe(45);
  await expect(dialog.getByText(/A chat in Settled for 45 days is archived/)).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'archive-settled-2-custom.png') });

  await days.fill('0');
  await days.blur();
  await expect.poll(() => client.store.getState().prefs.archiveSettledDays).toBe(0);
  await expect(dialog.getByText('Settled chats stay until you archive them. 0 means never.')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'archive-settled-3-never.png') });
  client.close();
});
