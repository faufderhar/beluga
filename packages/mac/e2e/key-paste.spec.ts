import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * An API key pasted into the chat box (BLG-965): a card above the box says what it is and offers to
 * keep it in Beluga; ↩ keeps it, and the message says $NAME instead of the key. A paste with no key
 * (a commit hash, prose) never shows the card. With GIF set to a folder, frames for a GIF too.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const card = (page: Page) => page.locator('[data-key-card]');
const toolbar = (page: Page) => page.locator('main header').first();
const shot = (name: string): string => `../../.beluga/scratch/key-paste/${name}`;

// Fake keys, put together when the test runs: a whole one in the source would stop GitHub's push protection.
const fake = (prefix: string, body: string): string => `${prefix}${body}`;
const OPENAI = fake('sk-proj-', 'Q7vR2mT9kLp4XwZ8nB3cD6fG1hJ5sA0eY4uI7oP2qW9rT6yU3iO8pA1sD5fG7hJ2kL4zX6c');
const STRIPE = fake('sk_live_', '51Hq2Lm7RzX4cV1nB8tY3wK6pJ0dH5sGaPq9Wz2Xc7Vb4Nm1Lk8Jh5Gf3Ds6Aa');
const RESEND = fake('re_', 'Kd8Pq2Wx_7bN4mL1zR9cT6vY3hJ0fG5sQw');
const GITHUB = fake('ghp_', '7Rk2Lq9Xw4Mz8Nc1Vb6Tj3Hd5Fg0Ys2Pa4Qe');

test.use({ deviceScaleFactor: 2 });

async function open(page: Page, name: string, project = 'bob-api'): Promise<void> {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const row = sidebar(page).getByRole('button', { name, exact: true });
  const unfold = sidebar(page).getByRole('button', { name: `Show what's in ${project}` }).first();
  if (!(await row.isVisible()) && (await unfold.isVisible())) await unfold.click();
  await row.click();
  await expect(composer(page)).toBeVisible();
}

/** Paste as you would: the text on the clipboard, then ⌘V into the box. */
async function paste(page: Page, text: string): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await composer(page).focus();
  await page.keyboard.press('ControlOrMeta+V');
}

/** The daemon, from the page (as the app talks to it). */
async function daemon<T>(page: Page, fn: string, arg: unknown = null): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const w = window as unknown as { __kp?: Promise<unknown> };
      w.__kp ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      const c = await w.__kp;
      return new Function('c', 'arg', `return (${fn})(c, arg)`)(c, arg);
    },
    { fn, arg },
  ) as Promise<T>;
}

/** The box and the room above it, for pictures of the card. */
async function around(page: Page, room = 230): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = (await page.locator('[data-chat-box]').first().boundingBox())!;
  const top = Math.max(0, box.y - room);
  return { x: Math.max(0, box.x - 16), y: top, width: box.width + 32, height: box.y + box.height + 12 - top };
}

test('a pasted key becomes $NAME: kept for this chat, never in the message', async ({ page }) => {
  mkdirSync(shot(''), { recursive: true });
  await open(page, 'add-auth');
  const wsId = await daemon<string>(page, `(c) => c.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth').id`);

  await composer(page).pressSequentially('Can you add AI summaries to the digest email? Here is my key: ');
  await paste(page, OPENAI);
  await expect(card(page)).toHaveAttribute('data-key-card', 'ask');
  await expect(card(page)).toContainText('That looks like an OpenAI API key');
  await expect(card(page)).toContainText('sk-proj-••••zX6c');
  await expect(card(page).getByRole('textbox')).toHaveValue('OPENAI_API_KEY');
  await expect(card(page)).toContainText('for this chat only');
  await page.screenshot({ path: shot('01-card-light.png'), clip: await around(page) });

  // ↩ keeps it (it doesn't send): the message now names the variable, drawn as a key chip.
  await composer(page).press('Enter');
  await expect(card(page)).toHaveAttribute('data-key-card', 'done');
  await expect(composer(page)).toHaveValue('Can you add AI summaries to the digest email? Here is my key: $OPENAI_API_KEY');
  await expect(page.locator('[data-key-chip="OPENAI_API_KEY"]')).toBeVisible();
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: shot('02-kept-light.png'), clip: await around(page) });
  // It stays a while, then folds away.
  await expect(card(page)).toBeHidden({ timeout: 8_000 });

  // The daemon keeps it as this chat's own variable (the screens see only its name).
  const vars = await daemon<Array<{ key: string; value: string }>>(page, `(c, id) => c.api.env.worktree(id).then((w) => w.vars)`, wsId);
  expect(vars).toEqual([{ key: 'OPENAI_API_KEY', value: OPENAI }]);
  await expect.poll(() => daemon<string[]>(page, `(c, id) => c.store.getState().envKeys.worktrees?.[id] ?? []`, wsId)).toEqual(['OPENAI_API_KEY']);

  // The Keys pill lists it: put it in the message again, rename it (the words follow).
  const pill = page.locator('[data-chat-keys]');
  await expect(pill).toHaveText('1 key');
  await pill.click();
  const keysPanel = page.getByRole('dialog', { name: 'Keys for this chat' });
  await expect(keysPanel.locator('[data-chat-key="OPENAI_API_KEY"]')).toContainText('sk-proj-••••zX6c');
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('07-keys-panel-light.png'), clip: await around(page, 300) });
  await keysPanel.getByRole('button', { name: 'Change OPENAI_API_KEY' }).click();
  await keysPanel.getByLabel('Name').fill('openai key');
  await page.screenshot({ path: shot('08-keys-edit-light.png'), clip: await around(page, 300) });
  await keysPanel.getByRole('button', { name: 'Save' }).click();
  await expect(composer(page)).toHaveValue('Can you add AI summaries to the digest email? Here is my key: $OPENAI_KEY');
  await expect.poll(() => daemon<string[]>(page, `(c, id) => c.store.getState().envKeys.worktrees?.[id] ?? []`, wsId)).toEqual(['OPENAI_KEY']);
  await page.keyboard.press('Escape');

  // "@" offers it first (the pointer out of the way: hovering a row picks it).
  await page.mouse.move(2, 2);
  await composer(page).fill('Also use @');
  const list = page.getByRole('listbox');
  await expect(list.getByRole('option').first()).toContainText('$OPENAI_KEY');
  await page.screenshot({ path: shot('09-at-menu-light.png'), clip: await around(page, 300) });
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue('Also use $OPENAI_KEY ');
  await expect(page.locator('[data-key-chip="OPENAI_KEY"]')).toBeVisible();

  // Merging asks whether the project keeps it.
  await toolbar(page).getByRole('button', { name: 'More for this workspace' }).click();
  await page.getByRole('menuitem', { name: /Merge Locally…/ }).click();
  const panel = page.getByRole('dialog', { name: /^Merge/ });
  await expect(panel.locator('[data-merge-vars]')).toContainText('Keep OPENAI_KEY for bob-api');
  await expect(panel.locator('[data-merge-vars]').getByRole('checkbox')).toBeChecked();
  await panel.screenshot({ path: shot('05-merge-keep.png') });
  await panel.getByRole('button', { name: 'Cancel' }).click();
});

test('several keys from a .env, renamed on the card; esc leaves them as text', async ({ page }) => {
  mkdirSync(shot(''), { recursive: true });
  await open(page, 'add-auth');
  await paste(page, `PORT=3000\nSTRIPE_SECRET_KEY=${STRIPE}\nNODE_ENV=production\nRESEND_KEY=${RESEND}`);
  await expect(card(page)).toContainText('You pasted 2 secret keys');
  const names = card(page).getByRole('textbox');
  await expect(names).toHaveCount(2);
  await expect(names.nth(0)).toHaveValue('STRIPE_SECRET_KEY');
  await expect(names.nth(1)).toHaveValue('RESEND_KEY');
  await names.nth(1).fill('resend api key');
  await expect(names.nth(1)).toHaveValue('RESEND_API_KEY');
  await page.screenshot({ path: shot('03-two-keys-light.png'), clip: await around(page) });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: shot('03-two-keys-dark.png'), clip: await around(page) });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.emulateMedia({ colorScheme: 'light' });

  await composer(page).focus();
  await composer(page).press('Escape');
  await expect(card(page)).toBeHidden();
  await expect(composer(page)).toHaveValue(new RegExp(STRIPE));
});

test('↩ straight after the paste never sends the key', async ({ page }) => {
  await open(page, 'add-auth');
  await composer(page).pressSequentially('use ');
  await paste(page, STRIPE);
  // At once: it waits for the look and the card asks, or the card was up already and keeps it.
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeVisible();
  if ((await card(page).getAttribute('data-key-card')) === 'ask') await page.keyboard.press('Enter');
  await expect(composer(page)).toHaveValue('use $STRIPE_SECRET_KEY');
  await expect(page.getByText(STRIPE)).toHaveCount(0);
});

test('a paste with no key never asks, and ↩ right after it still sends', async ({ page }) => {
  await open(page, 'add-auth');
  await paste(page, 'fixed in 3f9a2c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39 yesterday');
  await page.keyboard.press('Enter');
  await expect(composer(page)).toHaveValue('');
  await expect(card(page)).toHaveCount(0);
});

test('a paste with no key never asks', async ({ page }) => {
  await open(page, 'add-auth');
  for (const text of ['fixed in 3f9a2c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39', 'OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'session 550e8400-e29b-41d4-a716-446655440000 expired', 'const API_KEY = process.env.API_KEY;']) {
    await composer(page).fill('');
    await paste(page, text);
    await expect(composer(page)).toHaveValue(text);
  }
  // Give a card every chance to show: none did.
  await expect(card(page)).toHaveCount(0);
});

test('dark: the card and the kept line', async ({ page }) => {
  mkdirSync(shot(''), { recursive: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page, 'add-auth');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await composer(page).pressSequentially('Open a PR for it with ');
  await paste(page, GITHUB);
  await expect(card(page)).toContainText('That looks like a GitHub token');
  await page.screenshot({ path: shot('04-card-dark.png'), clip: await around(page) });
  await composer(page).press('Escape');
  // A key this chat has already (kept here first, whatever ran before): named after it, nothing new saved.
  await daemon(page, `(c, { name, value }) => c.api.env.keepPasted({ workspaceId: c.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth').id }, [{ key: name, value }])`, { name: 'STRIPE_SECRET_KEY', value: STRIPE });
  await composer(page).fill('again: ');
  await paste(page, STRIPE);
  await expect(card(page)).toContainText('That’s your STRIPE_SECRET_KEY');
  await expect(card(page).locator('[data-key-keep]')).toContainText('Use $STRIPE_SECRET_KEY');
  await page.screenshot({ path: shot('06-already-yours-dark.png'), clip: await around(page) });
});

test('a sent message shows the key as its chip, never the key', async ({ page }) => {
  mkdirSync(shot(''), { recursive: true });
  await open(page, 'add-auth');
  await composer(page).pressSequentially('Send a test digest with ');
  await paste(page, RESEND);
  await expect(card(page)).toHaveAttribute('data-key-card', 'ask');
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue(/\$RESEND_API_KEY$/);
  await composer(page).press('Enter');
  const chip = page.locator('[data-key-ref="RESEND_API_KEY"]').first();
  await expect(chip).toBeVisible();
  await expect(page.getByText(RESEND)).toHaveCount(0);
  const at = (await chip.boundingBox())!;
  await page.screenshot({ path: shot('10-sent-chip-light.png'), clip: { x: Math.max(0, at.x - 420), y: Math.max(0, at.y - 60), width: 900, height: 140 } });
});

// ---------------------------------------------------------------- frames for a GIF (GIF=<folder>)

test('GIF: paste, see the card, keep it safe', async ({ page }) => {
  test.skip(!process.env.GIF, 'records frames for a GIF');
  test.setTimeout(90_000);
  const theme = process.env.GIF_THEME === 'dark' ? 'dark' : 'light';
  await page.emulateMedia({ colorScheme: theme });
  await open(page, 'add-auth');
  await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
  const clip = await around(page, 330);
  const dir = path.join(process.env.GIF!, theme);
  mkdirSync(dir, { recursive: true });
  const frames: Array<{ file: string; at: number }> = [];
  let recording = true;
  const recorder = (async () => {
    while (recording) {
      const at = Date.now();
      const file = path.join(dir, `f${String(frames.length).padStart(4, '0')}.png`);
      await page.screenshot({ path: file, clip });
      frames.push({ file, at });
    }
  })();
  const pause = (ms: number) => page.waitForTimeout(ms);

  await pause(700);
  await composer(page).click();
  await page.keyboard.type('Can you add AI summaries to the digest email? Here is my key: ', { delay: 24 });
  await pause(400);
  await paste(page, OPENAI);
  await expect(card(page)).toBeVisible();
  await pause(2200);
  // Kept: the key dissolves, the chip grows in, the card says so and folds away.
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeHidden({ timeout: 8_000 });
  await pause(500);
  // The Keys pill: what this chat keeps.
  await page.locator('[data-chat-keys]').click();
  await pause(1800);
  await page.keyboard.press('Escape');
  await composer(page).focus();
  await pause(400);
  // "@" offers it first, and it goes in as a chip.
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Then send a test digest to me with @', { delay: 24 });
  await pause(1500);
  await page.keyboard.press('Enter');
  await pause(1600);

  recording = false;
  await recorder;
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.at ?? f.at + 1200) - f.at) / 1000).toFixed(3)}`);
  writeFileSync(path.join(dir, 'frames.txt'), `${list.join('\n')}\nfile '${frames.at(-1)!.file}'\n`);
});
