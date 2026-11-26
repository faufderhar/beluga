import path from 'node:path';
import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test } from './fixtures.js';

/**
 * Settings › Traces (BLG-1014): your own observability tools, Ratel first, each with its own mark.
 * Connecting one asks only for its fields, Send Test says it took the trace (the demo's sends all
 * succeed, on this computer), and its key is never shown again: only "Saved".
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');

test('connect Ratel, test it, and see it under Connected without its key', async ({ page, demo }) => {
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Traces' }).click();

  const names = dialog.locator('[data-setting] > div > div:first-child');
  await expect(names.first()).toContainText('Ratel Cloud');
  await expect(dialog.getByRole('button', { name: 'Ratel Cloud website' })).toHaveAttribute('title', 'https://www.ratel.sh');
  await expect(dialog.locator('[data-setting="langfuse"]')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'traces-1-list.png') });
  await dialog.locator('[data-setting="another-otlp-endpoint"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'traces-1b-list-end.png') });
  await dialog.locator('[data-setting="ratel-cloud"]').scrollIntoViewIfNeeded();

  const ratel = dialog.locator('[data-setting="ratel-cloud"]');
  await ratel.getByRole('button', { name: 'Connect…' }).click();
  await dialog.getByLabel('API key').fill('rtl_e2e_key_1234567890');
  await dialog.getByRole('button', { name: 'Send Test' }).click();
  await expect(dialog.getByText(/Ratel Cloud took the test trace/)).toBeVisible();
  // Its switch keeps its width beside its long text.
  expect((await dialog.getByRole('switch', { name: 'Send what you and your agent wrote' }).boundingBox())!.width).toBe(32);
  await page.screenshot({ path: path.join(SHOTS, 'traces-2-form.png') });

  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Connected' })).toBeVisible();
  await expect(ratel.getByRole('switch', { name: 'Send to Ratel Cloud' })).toHaveAttribute('aria-checked', 'true');
  const list = await client.api.traces.list();
  expect(list).toEqual([expect.objectContaining({ id: 'ratel', on: true, saved: ['key'] })]);
  expect(JSON.stringify(list)).not.toContain('rtl_e2e_key');
  await page.screenshot({ path: path.join(SHOTS, 'traces-3-connected.png') });

  await ratel.getByRole('button', { name: 'Edit…' }).click();
  await expect(dialog.getByLabel('API key')).toHaveAttribute('placeholder', 'Saved (type to replace)');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Away from the buttons: a shot of the list at rest, not of one being hovered.
  await page.mouse.move(5, 5);
  await expect(dialog.getByRole('button', { name: 'Connect…' }).first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'traces-4-dark.png'), animations: 'disabled' });

  await ratel.getByRole('button', { name: 'Edit…' }).click();
  await dialog.getByRole('button', { name: 'Disconnect' }).click();
  await expect(dialog.getByRole('heading', { name: 'Connected' })).toHaveCount(0);
  expect(await client.api.traces.list()).toEqual([]);
  client.close();
});
