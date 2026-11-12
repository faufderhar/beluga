import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/**
 * The plan's chat (KLD-64): every message sent there reaches its Claude, right after the page
 * opens and while Claude is busy (queued with ⌥↩, then run; Return sends it now); Stop ends its
 * turn (BLG-10); images go with them as in any chat; and the narrow column never scrolls
 * sideways, whatever the conversation holds.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');
const chat = (page: Page) => page.getByRole('complementary', { name: 'Conversation' });
const box = (page: Page) => chat(page).getByRole('textbox', { name: 'Message your agent about the plan' });

// A 2×2 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==', 'base64');
const SCRATCH = path.join(import.meta.dirname, '../../../.beluga/scratch');

test.describe.configure({ mode: 'serial' });

/** A new plan of its own (so the demo's plan stays as other specs expect it), its page open. */
async function newPlan(page: Page, goal: string): Promise<void> {
  await page.goto('/');
  await openWork(page, 'Plans');
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await page.getByRole('button', { name: 'New Plan', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: /^Plan in / });
  await sheet.getByLabel('Goal').fill(goal);
  await sheet.getByRole('button', { name: 'Plan with Your Agent' }).click();
  await expect(box(page)).toBeVisible({ timeout: 20_000 });
}

/** Paste words as the clipboard's plain text. */
const pasteText = (el: Locator, text: string) =>
  el.evaluate((t, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);

test('messages sent right after the page opens and while Claude is busy all reach it', async ({ page }) => {
  await newPlan(page, 'Nightly export of invoices to the data warehouse');
  // At once, while Claude is still writing the first draft: queued (⌥↩), it waits its turn, then runs.
  await box(page).fill('add a retry budget');
  await box(page).press('Alt+Enter');
  await expect(box(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Approve Plan' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(chat(page)).toContainText('Added add a retry budget', { timeout: 30_000 });
  // Two in a row: the second is sent while Claude works on the first, queued (⌥↩) behind it.
  await box(page).fill('add an audit log');
  await box(page).press('Enter');
  await box(page).fill('add a dry run mode');
  await box(page).press('Alt+Enter');
  // Each was said in the chat, and each reached Claude (it changed the plan for each).
  for (const asked of ['add a retry budget', 'add an audit log', 'add a dry run mode']) {
    await expect(chat(page)).toContainText(`Added ${asked}`, { timeout: 30_000 });
  }
  await expect(chat(page).getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: path.join(SCRATCH, '10-plan-chat-delivered.png') });
});

test('while Claude works the box still sends, and Stop ends its turn (BLG-10)', async ({ page }) => {
  test.setTimeout(90_000);
  await newPlan(page, 'A plan to stop halfway');
  await expect(page.getByRole('button', { name: 'Approve Plan' }).first()).toBeVisible({ timeout: 30_000 });
  // "take your time" keeps this revision running (src/agent/mock.ts) so Stop is still there to click.
  await box(page).fill('add a retry budget, take your time');
  await box(page).press('Enter');
  // Claude works on it: the box says it reaches Claude now, and Stop is there.
  const stop = chat(page).getByRole('button', { name: 'Stop the agent' });
  await expect(stop).toBeVisible({ timeout: 10_000 });
  await expect(box(page)).toHaveAttribute('placeholder', /tell it now, or stop it/);
  await expect(chat(page).getByRole('button', { name: 'Send Now' })).toBeVisible();
  await stop.click();
  await expect(chat(page)).toContainText('Stopped by you', { timeout: 15_000 });
  await expect(stop).toHaveCount(0);
  // And it answers the next message as usual.
  await box(page).fill('add an audit log');
  await box(page).press('Enter');
  await expect(chat(page)).toContainText('Added add an audit log', { timeout: 30_000 });
  await page.screenshot({ path: path.join(SCRATCH, '13-plan-chat-stopped.png') });
});

test('the plan chat never scrolls sideways: long paths, code and tables wrap or scroll in their own block', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 760 });
  await newPlan(page, 'Wide content in a narrow chat');
  await expect(page.getByRole('button', { name: 'Approve Plan' }).first()).toBeVisible({ timeout: 30_000 });
  const long = `/Users/someone/Library/Application Support/CleanShot/media/${'very-long-folder-name-without-any-breaks-'.repeat(6)}/shot.png`;
  const message = [
    `look at ${long} and ${'x'.repeat(240)}`,
    '',
    '```',
    `const veryLongLine = ${JSON.stringify('y'.repeat(300))};`,
    '```',
    '',
    '| column one | column two | column three | column four | column five | column six |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${'wide '.repeat(12)} | ${'cell '.repeat(12)} | three | four | five | six |`,
  ].join('\n');
  await box(page).fill(message);
  await box(page).press('Enter');
  await expect(chat(page)).toContainText('veryLongLine', { timeout: 15_000 });
  await expect(chat(page)).toContainText('Added', { timeout: 30_000 });
  // Nothing in the column is wider than it: only code and tables scroll, inside themselves.
  const wide = await chat(page).evaluate((root) =>
    [root, ...root.querySelectorAll('*')]
      .filter((el) => {
        if (el.scrollWidth <= el.clientWidth + 1) return false;
        const ox = getComputedStyle(el).overflowX;
        // A code block or a table scrolling inside itself is fine.
        return !((ox === 'auto' || ox === 'scroll') && (el.tagName === 'PRE' || el.querySelector(':scope > table') || el.closest('pre')));
      })
      .filter((el) => getComputedStyle(el).overflowX !== 'visible' || el === root)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${el.scrollWidth}>${el.clientWidth}`),
  );
  expect(wide).toEqual([]);
  // And nothing spills past its right edge.
  const edge = await chat(page).evaluate((root) => {
    const right = root.getBoundingClientRect().right + 0.5;
    return [...root.querySelectorAll('*')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.right <= right) return false;
        for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible' && p.getBoundingClientRect().right <= right) return false;
        return true;
      })
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
  });
  expect(edge).toEqual([]);
  await page.screenshot({ path: path.join(SCRATCH, '11-plan-chat-no-sideways.png') });
});

test('an image path pasted in a sentence goes with the message as the image', async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga plan-paste-'));
  const shot = path.join(dir, 'CleanShot 2026-10-22 at 00.08.43@2x.png');
  writeFileSync(shot, PNG);
  await newPlan(page, 'A plan to talk about a screenshot');
  await expect(page.getByRole('button', { name: 'Approve Plan' }).first()).toBeVisible({ timeout: 30_000 });
  await box(page).fill('');
  await pasteText(box(page), `the header is cut off here “${shot}” please fix it`);
  await expect(box(page)).toHaveValue(/^the header is cut off here \[(?:image \d+|\d+\u2007[^\]\n]+)\] please fix it$/);
  await expect(chat(page).getByRole('group', { name: 'Images to send' }).locator('img')).toHaveCount(1);
  await page.screenshot({ path: path.join(SCRATCH, '12-plan-chat-pasted-path.png') });
  await box(page).press('Enter');
  await expect(chat(page).getByRole('group', { name: 'Images to send' })).toBeHidden();
  await expect(chat(page).getByRole('button', { name: /^Open image \d+/ }).last()).toBeVisible({ timeout: 15_000 });
  await expect(main(page).getByRole('alert')).toHaveCount(0);
});
