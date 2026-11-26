import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures.js';

/**
 * BLG-988: a very long paste (a whole conversation) waits above the box as a file chip instead of
 * filling the words; Send gives the agent its first lines and the file Beluga kept it in.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

/** Paste as you would: the text on the clipboard, then ⌘V into the box. */
async function paste(page: Page, text: string): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await composer(page).focus();
  await page.keyboard.press('ControlOrMeta+V');
}

/** Your messages in the group chat, as they went. */
async function sent(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const w = window as unknown as { __lp?: Promise<{ store: { getState: () => { selfId: string; log: Array<{ type: string; channel: string; from: string; text: string }> } } }> };
    w.__lp ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' })))) as never;
    const c = await w.__lp;
    const s = c.store.getState();
    return s.log.filter((l) => l.type === 'chat' && l.channel === 'room' && l.from === s.selfId).map((l) => l.text);
  });
}

const conversation = Array.from({ length: 400 }, (_, i) => `${i % 2 ? 'Claude' : 'Kayra'}: message number ${i + 1} of a long conversation`).join('\n');

test('a very long paste waits as a file chip and goes as its first lines and the file', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await composer(page).fill('Summarize this for me');
  await paste(page, conversation);

  // At once: a chip with what it is, and the words stay as they were.
  const chip = page.getByRole('list', { name: 'Files to send' }).getByRole('listitem');
  await expect(chip).toContainText('Pasted text · 400 lines');
  await expect(composer(page)).toHaveValue('Summarize this for me');
  await expect(chip).toHaveAttribute('aria-busy', 'false');
  await page.screenshot({ path: '../../.beluga/scratch/long-paste-chip.png' });

  await composer(page).press('Enter');
  await expect(chip).toHaveCount(0);
  await expect.poll(async () => (await sent(page)).at(-1) ?? '').toContain('Pasted text (400 lines');
  const message = (await sent(page)).at(-1)!;
  expect(message.startsWith('Summarize this for me')).toBe(true);
  expect(message).toContain('message number 5 of');
  expect(message).not.toContain('message number 6 of');
  const file = /^`(\/[^`]+\.txt)`$/m.exec(message)?.[1];
  expect(file).toBeTruthy();
  expect(readFileSync(file!, 'utf8')).toBe(conversation);
  await page.screenshot({ path: '../../.beluga/scratch/long-paste-sent.png' });
});

test('a short paste still goes into the words', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await paste(page, 'just a few words');
  await expect(composer(page)).toHaveValue('just a few words');
  await expect(page.getByRole('list', { name: 'Files to send' })).toHaveCount(0);
});
