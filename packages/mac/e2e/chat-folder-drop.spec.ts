import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * A folder dropped from Finder on a chat (BLG-1009) waits as a chip and goes as its location. Only
 * the app hears Finder drops, so the page gets a stand-in for the app's side: its daemon found the
 * way a page finds it, and the drop sent as the app sends it. It goes in once the page has started.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

/** The app's side, as far as a drop needs: its daemon, and its event listeners (others answer nothing). */
async function asTheApp(page: Page): Promise<void> {
  await page.evaluate(() => {
    const callbacks = new Map<number, (e: unknown) => void>();
    const listeners: { event: string; handler: number }[] = [];
    let next = 1;
    const w = window as unknown as Record<string, unknown>;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: (cb: (e: unknown) => void) => {
        const id = next++;
        callbacks.set(id, cb);
        return id;
      },
      invoke: async (cmd: string, args: { event?: string; handler?: number }) => {
        if (cmd === 'daemon_endpoint') return (await fetch('/__beluga/endpoint', { cache: 'no-store' })).json();
        if (cmd === 'plugin:event|listen' && args.event && args.handler) {
          listeners.push({ event: args.event, handler: args.handler });
          return args.handler;
        }
        return null;
      },
    };
    w.__dropPaths = (paths: string[], x: number, y: number) => {
      for (const l of listeners.filter((x) => x.event === 'tauri://drag-drop')) callbacks.get(l.handler)?.({ event: l.event, id: l.handler, payload: { paths, position: { x, y } } });
    };
  });
}

test('a folder dropped on a chat waits as a chip and goes as its location', async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-drop-'));
  const folder = path.join(dir, 'design-assets');
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'logo.svg'), '<svg/>');
  const file = path.join(dir, 'notes.md');
  writeFileSync(file, '# Notes\n');

  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  // Once started (a chat opened next listens for drops then).
  await asTheApp(page);
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await composer(page).fill('Use these for the new header');
  const box = (await composer(page).boundingBox())!;
  await page.evaluate(([paths, x, y]) => (window as unknown as { __dropPaths: (p: string[], x: number, y: number) => void }).__dropPaths(paths, x, y), [[folder, file], box.x + box.width / 2, box.y + box.height / 2] as const);

  const chips = page.getByRole('list', { name: 'Files to send' });
  await expect(chips.getByRole('listitem')).toHaveCount(2);
  await expect(chips.getByRole('listitem').first()).toContainText('design-assets');
  await expect(chips.getByRole('listitem').first()).toHaveAttribute('title', `Goes as its location: ${folder}/`);
  await page.screenshot({ path: '../../.beluga/scratch/01-folder-chip.png' });
  await page.locator('[data-drop-zone]').last().screenshot({ path: '../../.beluga/scratch/01b-folder-chip-close.png' });

  await composer(page).press('Enter');
  const sent = page.getByRole('link', { name: `${folder}/` }).last();
  await expect(sent).toBeVisible();
  await expect(composer(page)).toHaveValue('');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '../../.beluga/scratch/02-folder-sent.png' });
});
