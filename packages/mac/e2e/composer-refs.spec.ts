import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/**
 * A pasted image is referenced in the words where the cursor was ("[image 1]"), and the project
 * home's New Worktree box offers the same / and @ suggestions as a chat.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();

// A 2×2 red PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==';

test('a pasted image goes in the words where the cursor is', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  const box = composer(page);
  await box.fill('the bug is here and');
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(15, 15));
  await box.evaluate(async (el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  await expect(box).toHaveValue(/^the bug is here \[(?:image \d+|\d+\u2007[^\]\n]+)\] and$/);
  await expect(page.getByRole('group', { name: 'Images to send' }).locator('img')).toHaveCount(1);
  // Taking the image out takes its reference out of the words too.
  await page.getByRole('button', { name: /Remove image/ }).click({ force: true });
  await expect(box).toHaveValue('the bug is here and');
});

/** Paste words as the clipboard's plain text (what copying a path in Finder or CleanShot gives). */
const pasteText = (box: ReturnType<typeof composer>, text: string) =>
  box.evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);

test('a pasted path of a picture becomes the picture; a path to nothing stays words', async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga paste-'));
  const shot = path.join(dir, 'CleanShot 2026-10-21 at 22.11.43@2x.png');
  writeFileSync(shot, Buffer.from(PNG, 'base64'));
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  const box = composer(page);
  await box.fill('');
  await pasteText(box, `"${dir}/nothing here.png"`);
  await expect(box).toHaveValue(`"${dir}/nothing here.png"`);
  await box.fill('see ');
  await pasteText(box, `"${shot}"`);
  await expect(box).toHaveValue(/^see \[(?:image \d+|\d+\u2007[^\]\n]+)\] $/);
  const tray = page.getByRole('group', { name: 'Images to send' });
  await expect(tray.locator('img')).toHaveCount(1);
  await expect(tray.locator('img')).toHaveJSProperty('complete', true);
  await page.screenshot({ path: path.join(import.meta.dirname, '../../../.beluga/scratch/01-pasted-path-thumbnail.png') });
  await box.press('Enter');
  await expect(tray).toBeHidden();
  // The message carries the picture (a link to Beluga's copy, shown as a thumbnail).
  const sent = page.getByRole('button', { name: /^Open image \d+/ }).last();
  await expect(sent).toBeVisible();
  await expect(sent.locator('img')).toHaveJSProperty('complete', true);
  await page.screenshot({ path: path.join(import.meta.dirname, '../../../.beluga/scratch/02-sent-with-image.png') });
});

test('an image path inside pasted words becomes the image; the words stay (plain, quoted, smart quoted, escaped)', async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga paste-'));
  const shot = path.join(dir, 'CleanShot 2026-10-22 at 00.08.43@2x.png');
  writeFileSync(shot, Buffer.from(PNG, 'base64'));
  const notes = path.join(dir, 'notes.md');
  writeFileSync(notes, '# Notes');
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  const box = composer(page);
  const tray = page.getByRole('group', { name: 'Images to send' });
  for (const written of [shot, `"${shot}"`, `“${shot}”`, shot.replace(/ /g, '\\ ')]) {
    // Emptying the box takes its image off the tray too (an image leaves with its reference).
    await box.fill('');
    await pasteText(box, `the header is cut off in ${written}, can you fix it`);
    await expect(box).toHaveValue(/^the header is cut off in \[(?:image \d+|\d+\u2007[^\]\n]+)\], can you fix it$/);
    await expect(tray.locator('img')).toHaveCount(1);
  }
  // Paths that aren't images here stay words.
  await box.fill('');
  await pasteText(box, `read ${notes} and ${dir}/gone.png first`);
  await expect(box).toHaveValue(`read ${notes} and ${dir}/gone.png first`);
});

test('the plan chat takes pasted images, image paths in words, and files like any chat', async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga paste-'));
  const shot = path.join(dir, 'shot one.png');
  writeFileSync(shot, Buffer.from(PNG, 'base64'));
  const notes = path.join(dir, 'release notes.md');
  writeFileSync(notes, '# Notes');
  await page.goto('/');
  await openWork(page, 'Plans');
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await page.locator('main').getByRole('button', { name: /^Card checkout for launch,/ }).click();
  const chat = page.getByRole('complementary', { name: 'Conversation' });
  const box = chat.getByRole('textbox', { name: 'Message your agent about the plan' });
  const tray = chat.getByRole('group', { name: 'Images to send' });
  // A picture from the clipboard, where the cursor is.
  await box.fill('the bug is here and');
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(15, 15));
  await box.evaluate(async (el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  await expect(box).toHaveValue(/^the bug is here \[(?:image \d+|\d+\u2007[^\]\n]+)\] and$/);
  await expect(tray.locator('img')).toHaveCount(1);
  // An image's path in a sentence.
  await box.fill('also ');
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));
  await pasteText(box, `see '${shot}' too`);
  await expect(box).toHaveValue(/^also see \[(?:image \d+|\d+\u2007[^\]\n]+)\] too$/);
  await expect(tray.locator('img')).toHaveCount(2);
  // Another file's path: a chip.
  await pasteText(box, notes);
  await expect(chat.getByRole('list', { name: 'Files to send' })).toContainText('release notes.md');
  // Taking an image out takes its reference out too (nothing is sent: the demo's plan stays as it is).
  await chat.getByRole('button', { name: /Remove image/ }).last().click({ force: true });
  await expect(box).toHaveValue('also see too');
  await page.screenshot({ path: path.join(import.meta.dirname, '../../../.beluga/scratch/13-plan-chat-attachments.png') });
});

test('a pasted path of another file waits as a chip and goes as its path; a folder stays words', async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga paste-'));
  const notes = path.join(dir, 'release notes.md');
  writeFileSync(notes, '# Notes');
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  const box = composer(page);
  await box.fill('');
  await pasteText(box, dir);
  await expect(box).toHaveValue(dir);
  await box.fill('read this');
  await pasteText(box, notes.replace(/ /g, '\\ '));
  const chips = page.getByRole('list', { name: 'Files to send' });
  await expect(chips).toContainText('release notes.md');
  await expect(box).toHaveValue('read this');
  await box.press('Enter');
  await expect(chips).toBeHidden();
  await expect(page.getByText(notes).last()).toBeVisible();
});

test('⌘⇧V keeps a pasted path as words', async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga paste-'));
  const shot = path.join(dir, 'shot.png');
  writeFileSync(shot, Buffer.from(PNG, 'base64'));
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  const box = composer(page);
  await box.fill('');
  await box.focus();
  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyV');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  // The page's paste right after the keys (Playwright can't reach the system clipboard).
  await box.evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    if (el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))) document.execCommand('insertText', false, t);
  }, shot);
  await expect(box).toHaveValue(shot);
  await expect(page.getByRole('group', { name: 'Images to send' })).toBeHidden();
});

test('the New Worktree box suggests commands and the project’s files', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  const task = page.getByLabel('Task for the new worktree');
  await task.fill('/');
  const list = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option').first()).toBeVisible();
  await task.fill('look at @');
  await expect(list).toBeVisible();
  await task.press('Escape');
  await expect(list).toBeHidden();
});

/** A second connection to the demo daemon from the page (the app's own boot code), for driving it. */
async function daemon<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(
    async (fn) => {
      const w = window as unknown as { __refs?: Promise<unknown> };
      w.__refs ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      return new Function('c', `return (${fn})(c)`)(await w.__refs);
    },
    fn,
  ) as Promise<T>;
}

/** A worktree that isn't a plan's, as "@" and its row name it. */
async function aWorktree(page: Page): Promise<{ name: string; ref: string; id: string }> {
  await page.goto('/');
  return daemon(page, `(c) => { const s = c.store.getState(); const w = s.projects.flatMap((p) => p.workspaces).find((x) => x.kind === 'worktree' && !x.archived); return { name: w.name, id: w.id, ref: s.selfId + '/ws:' + w.id }; }`);
}

const options = (page: Page) => page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option');

/** A chat's mention as the box writes it (chat/chat-box.ts): its title in brackets, a chip over it, no ref. */
const short = (title: string): string => `[@\u2007${title.replace(/\s+/g, '\u00a0')}]`;

/** What the box would send: each short mention whole again, ref and all. */
async function sentFrom(page: Page, box: ReturnType<typeof composer>): Promise<string> {
  const value = await box.inputValue();
  return daemon<string>(page, `(c) => import('/src/chat/chat-box.ts').then((m) => m.plainWords(${JSON.stringify(value)}, c.store.getState()))`);
}

/** What copying the whole box puts on the clipboard. */
const copied = (box: ReturnType<typeof composer>): Promise<string> =>
  box.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(0, el.value.length);
    const data = new DataTransfer();
    el.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/plain');
  });

test('"@" offers a chat by its title; the prompt holds the reference and the chat shows the chip', async ({ page }) => {
  const { name, ref } = await aWorktree(page);
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  const box = page.getByRole('textbox', { name: 'Ask your Mac anything' });
  await box.fill(`what happened in @${name}`);
  const row = options(page).filter({ hasText: `@${name}` });
  await expect(row).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Chats');
  await row.click();
  // The box shows the chat as a chip with its title only: no parentheses, no ref.
  await expect(box).toHaveValue(`what happened in ${short(name)} `);
  const chipInBox = page.locator(`[data-testid="mention-highlighter"] [data-kind="chat"]`);
  await expect(chipInBox).toHaveText(new RegExp(name));
  await expect(page.getByTestId('mention-highlighter')).not.toContainText('(chat:');
  await expect(page.getByRole('group', { name: 'Chat mentioned' }).or(page.getByLabel('Chat mentioned'))).toContainText(name);
  // Copied, and as sent, the words carry the ref.
  expect(await copied(box)).toBe(`what happened in @${name} (chat: ${ref}) `);
  expect(await sentFrom(page, box)).toBe(`what happened in @${name} (chat: ${ref}) `);
  await page.screenshot({ path: path.join(import.meta.dirname, '../../../.beluga/scratch/20-chat-in-at-list.png') });
  await box.press('Enter');
  await expect(box).toHaveValue('');
  // The words sent keep the reference, the chat draws the chip, and the bubble shows no ref.
  await expect.poll(() => daemon<string[]>(page, `(c) => c.store.getState().log.filter((l) => l.type === 'chat').map((l) => l.text)`)).toContainEqual(`what happened in @${name} (chat: ${ref})`);
  const bubble = page.locator('main [data-mine="true"]').filter({ hasText: 'what happened in' }).last();
  await expect(bubble.getByRole('button', { name: `Worktree ${name}` })).toBeVisible();
  await expect(bubble).not.toContainText('(chat:');
  await page.screenshot({ path: path.join(import.meta.dirname, '../../../.beluga/scratch/21-chat-chip-sent.png') });
});

test('a pasted chat link becomes a chip; Backspace takes the chip whole; copy keeps the ref', async ({ page }) => {
  const { name, ref, id } = await aWorktree(page);
  const link = `beluga://chat/${ref.split('/')[0]}/${encodeURIComponent(`ws:${id}`)}`;
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  const box = page.getByRole('textbox', { name: 'Ask your Mac anything' });
  await box.fill('');
  await pasteText(box, link);
  await expect(box).toHaveValue(`${short(name)} `);
  await box.press('Backspace');
  await expect(box).toHaveValue(short(name));
  await box.press('Backspace');
  await expect(box).toHaveValue('');
  // In the middle of words, without their punctuation; copied, it keeps its ref.
  await pasteText(box, `see ${link}, please`);
  await expect(box).toHaveValue(`see ${short(name)}, please`);
  expect(await copied(box)).toBe(`see @${name} (chat: ${ref}), please`);
});

test('"@" doesn’t offer the chat you are in', async ({ page }) => {
  await aWorktree(page);
  for (const project of ['bob-api', 'landing']) await sidebar(page).getByRole('button', { name: `Show what's in ${project}` }).first().click();
  const shown = await daemon<string[]>(page, `(c) => c.store.getState().projects.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && !w.archived).map((w) => w.name)`);
  const here = await (async () => {
    for (const w of shown) if (await sidebar(page).getByText(w, { exact: true }).count()) return w;
    throw new Error('No worktree has a row');
  })();
  await sidebar(page).getByText(here, { exact: true }).first().click();
  const box = page.getByRole('textbox', { name: `Tell Claude what to do in ${here}` });
  await box.fill(`@${here}`);
  await expect(options(page).filter({ hasText: `@${here}` }).filter({ hasText: 'Worktree' })).toHaveCount(0);
});
