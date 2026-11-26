import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Keys no list knows (BLG-977): a token shaped like a key (`rtl_…`) is asked about softly, with
 * Not a Key (remembered, with Undo); and any word you pick in the box can be kept as a key from
 * the pill over it (or ⌥⌘K). With GIF set to a folder, frames for a GIF too.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const card = (page: Page) => page.locator('[data-key-card]');
const shot = (name: string): string => `../../.beluga/scratch/key-paste/${name}`;

// Put together when the test runs: a whole key in the source would stop GitHub's push protection.
const fake = (prefix: string, body: string): string => `${prefix}${body}`;
const RATEL = fake('rtl_', 'k6RdVk9lLghguXqcpxATMBfV00FPbQPV');

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

async function paste(page: Page, text: string): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await composer(page).focus();
  await page.keyboard.press('ControlOrMeta+V');
}

/** Pick a word in the box, as a double-click or a drag would. */
async function pick(page: Page, word: string): Promise<void> {
  await composer(page).evaluate((el: HTMLTextAreaElement, w) => {
    el.focus();
    const at = el.value.indexOf(w);
    el.setSelectionRange(at, at + w.length);
  }, word);
}

async function around(page: Page, room = 230): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = (await page.locator('[data-chat-box]').first().boundingBox())!;
  const top = Math.max(0, box.y - room);
  return { x: Math.max(0, box.x - 16), y: top, width: box.width + 32, height: box.y + box.height + 12 - top };
}

test('a key nobody lists is asked about softly; Not a Key is remembered, and Undo takes it back', async ({ page }) => {
  mkdirSync(shot(''), { recursive: true });
  await open(page, 'add-auth');
  await composer(page).pressSequentially('Wire up the Ratel client with ');
  await paste(page, RATEL);
  await expect(card(page)).toHaveAttribute('data-key-card', 'ask');
  await expect(card(page)).toHaveAttribute('data-kind', 'maybe');
  await expect(card(page)).toContainText('Looks like a key');
  await expect(card(page)).toContainText('rtl_••••QPV'.replace('QPV', 'bQPV'));
  await expect(card(page).getByRole('textbox')).toHaveValue('RTL_API_KEY');
  // The words it means are marked in the box (a dotted underline: only maybe a key).
  await expect(page.locator('[data-key-mark="soft"]')).toHaveText(RATEL);
  await page.waitForTimeout(900);
  await page.screenshot({ path: shot('11-maybe-light.png'), clip: await around(page) });

  await card(page).locator('[data-key-not]').click();
  await expect(card(page)).toHaveAttribute('data-key-card', 'dismissed');
  await expect(card(page)).toContainText('rtl_');
  await expect(composer(page)).toHaveValue(`Wire up the Ratel client with ${RATEL}`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: shot('12-not-a-key-light.png'), clip: await around(page) });

  // Undo: asking again, and the prefix is forgotten.
  await card(page).locator('[data-key-undo]').click();
  await expect(card(page)).toHaveAttribute('data-key-card', 'ask');
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue('Wire up the Ratel client with $RTL_API_KEY');

  await expect(card(page)).toHaveAttribute('data-key-card', 'done');
  // A pointer on it holds it; off it, it folds.
  await page.mouse.move(2, 2);
  await expect(card(page)).toBeHidden({ timeout: 10_000 });

  // Kept once, learnt: the next rtl_ key is like yours, sure, not maybe.
  await composer(page).fill('');
  await paste(page, fake('rtl_', 'Zp3Xc8Vb1Nm6Lk2Jh9Gf4Ds7Aa0Qw5Er'));
  await expect(card(page)).toHaveAttribute('data-kind', 'sure');
  await expect(card(page)).toContainText('Like your RTL_API_KEY');
  await composer(page).press('Escape');

  // Not a Key, then the same kind again: never asked.
  await composer(page).fill('');
  await paste(page, fake('acme_', 'Zp3Xc8Vb1Nm6Lk2Jh9Gf4Ds7Aa0Qw5Er'));
  await expect(card(page)).toHaveAttribute('data-kind', 'maybe');
  await card(page).locator('[data-key-not]').click();
  await page.mouse.move(2, 2);
  await expect(card(page)).toBeHidden({ timeout: 10_000 });
  await composer(page).fill('');
  await paste(page, fake('acme_', 'Ty7Ui2Op5As8Df1Gh4Jk9Lz3Xc6Vb0Nm'));
  await page.waitForTimeout(600);
  await expect(card(page)).toHaveCount(0);
});

test('a word you pick: Keep as Key over it, named on the card, kept as $NAME', async ({ page }) => {
  mkdirSync(shot(''), { recursive: true });
  await open(page, 'add-auth');
  await composer(page).pressSequentially('The staging password is Hunter2Staging and it expires Friday');
  await pick(page, 'Hunter2Staging');
  const pill = page.locator('[data-key-pick]');
  await expect(pill).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot('13-pick-pill-light.png'), clip: await around(page, 120) });

  await pill.click();
  await expect(card(page)).toHaveAttribute('data-kind', 'picked');
  await expect(card(page)).toContainText('Keep it safe');
  const name = card(page).getByRole('textbox');
  await expect(name).toBeFocused();
  await page.keyboard.type('staging password');
  await expect(name).toHaveValue('STAGING_PASSWORD');
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot('14-picked-card-light.png'), clip: await around(page) });
  await page.keyboard.press('Enter');
  await expect(card(page)).toHaveAttribute('data-key-card', 'done');
  await expect(composer(page)).toHaveValue('The staging password is $STAGING_PASSWORD and it expires Friday');

  // The keyboard way: pick, ⌥⌘K.
  await composer(page).fill('token abcDEF123456ghi');
  await pick(page, 'abcDEF123456ghi');
  await expect(page.locator('[data-key-pick]')).toBeVisible();
  await page.keyboard.press('Alt+Meta+K');
  await expect(card(page)).toHaveAttribute('data-kind', 'picked');

  // Prose picked (spaces): no pill.
  await page.keyboard.press('Escape');
  await composer(page).fill('nothing secret here at all');
  await pick(page, 'secret here');
  await page.waitForTimeout(300);
  await expect(page.locator('[data-key-pick]')).toHaveCount(0);
});

test('dark: maybe a key, and the pill', async ({ page }) => {
  mkdirSync(shot(''), { recursive: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page, 'add-auth');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  // Another kind of key (the demo daemon remembers the rtl_ one kept above).
  const NOVA = fake('nova_', 'Hq4Wn7Ez2Rt9Ym3Ux6Ic1Ov8Pb5As0Dk');
  await composer(page).pressSequentially('Wire up the Nova client with ');
  await paste(page, NOVA);
  await expect(card(page)).toHaveAttribute('data-kind', 'maybe');
  await page.waitForTimeout(900);
  await page.screenshot({ path: shot('11-maybe-dark.png'), clip: await around(page) });
  await composer(page).press('Escape');
  await pick(page, NOVA);
  await expect(page.locator('[data-key-pick]')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot('13-pick-pill-dark.png'), clip: await around(page, 120) });
});

test('a key chip in the box ends before the next word, short names too', async ({ page }) => {
  await open(page, 'add-auth');
  const names = ['DB_URL', 'TOKEN', 'RTL_API_KEY', 'STAGING_PASSWORD'];
  await page.evaluate(async (names) => {
    const m = await import('/src/lib/boot.ts');
    const c = (await m.connect(m.capabilities(() => ({ ok: true, message: '' })))) as unknown as { store: { getState: () => { projects: Array<{ workspaces: Array<{ id: string; name: string }> }> } }; api: { env: { keepPasted: (w: object, rows: object[]) => Promise<unknown> } } };
    const id = c.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth')!.id;
    await c.api.env.keepPasted({ workspaceId: id }, names.map((n) => ({ key: n, value: `Zp3Xc8Vb1Nm6Lk2J${n}` })));
  }, names);
  await composer(page).fill(names.map((n) => `use $${n} and`).join('\n'));
  await expect(page.locator('[data-key-chip]')).toHaveCount(names.length);
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => [...document.querySelectorAll('[data-key-chip]')].map((chip) => chip.getBoundingClientRect().right - chip.parentElement!.firstElementChild!.getBoundingClientRect().right));
  for (const o of over) expect(o).toBeLessThanOrEqual(0.5);
});

// ---------------------------------------------------------------- frames for a GIF (GIF=<folder>)

test('GIF: maybe a key, then a word picked', async ({ page }) => {
  test.skip(!process.env.GIF, 'records frames for a GIF');
  test.setTimeout(90_000);
  const theme = process.env.GIF_THEME === 'dark' ? 'dark' : 'light';
  await page.emulateMedia({ colorScheme: theme });
  await open(page, 'add-auth');
  await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
  const clip = await around(page, 300);
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

  await pause(600);
  await composer(page).click();
  await page.keyboard.type('Wire up the Ratel client with ', { delay: 24 });
  await pause(300);
  await paste(page, RATEL);
  await expect(card(page)).toBeVisible();
  await pause(2200);
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeHidden({ timeout: 8_000 });
  await pause(300);
  await page.keyboard.type(' and log in as admin with Hunter2Staging', { delay: 24 });
  await pause(500);
  await pick(page, 'Hunter2Staging');
  await pause(1400);
  await page.locator('[data-key-pick]').click();
  await pause(900);
  await page.keyboard.type('admin password', { delay: 40 });
  await pause(900);
  await page.keyboard.press('Enter');
  await pause(2400);

  recording = false;
  await recorder;
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.at ?? f.at + 1200) - f.at) / 1000).toFixed(3)}`);
  writeFileSync(path.join(dir, 'frames.txt'), `${list.join('\n')}\nfile '${frames.at(-1)!.file}'\n`);
});
