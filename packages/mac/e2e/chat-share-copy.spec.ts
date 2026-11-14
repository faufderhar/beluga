import { expect, test, type Page } from './fixtures.js';

/**
 * BLG-152: in a chat another person owns (the demo's bob shares "refunds" with you to work in),
 * words that name a chat of yours ask at Send if a copy of it goes along. Share Copy sends the
 * copy with the message; Send Without It sends the words alone; Cancel sends nothing.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const REFUNDS = 'ws:bob-refunds';

/** A second connection to the demo daemon from the page (the app's own boot code), for reading its state. */
async function daemon<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(
    async (fn) => {
      const w = window as unknown as { __copy?: Promise<unknown> };
      w.__copy ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      return new Function('c', `return (${fn})(c)`)(await w.__copy);
    },
    fn,
  ) as Promise<T>;
}

/** Your messages in bob's refunds chat, as they went. */
const sentThere = (page: Page): Promise<string[]> => daemon<string[]>(page, `(c) => c.store.getState().log.filter((l) => l.type === 'chat' && l.channel === '${REFUNDS}' && l.from === c.store.getState().selfId).map((l) => l.text)`);

/** bob's refunds chat open, and the words for one worktree of yours in its box. */
async function setUp(page: Page): Promise<{ words: string; name: string }> {
  await page.goto('/');
  await expect.poll(() => daemon<boolean>(page, `(c) => c.store.getState().shared.some((w) => w.id === 'bob-refunds' && w.role === 'contribute')`), { timeout: 15_000 }).toBe(true);
  const mine = await daemon<{ self: string; id: string; name: string }>(page, `(c) => { const s = c.store.getState(); const w = s.projects.flatMap((p) => p.workspaces).find((w) => w.kind === 'worktree' && !w.archived); return { self: s.selfId, id: w.id, name: w.name }; }`);
  const refunds = sidebar(page).getByRole('button', { name: 'refunds' });
  if (!(await refunds.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api, shared by bob' }).getByRole('button', { name: "Show what's in bob-api" }).click();
  await refunds.click();
  // The click returns before the view moves: words typed now would stay in the last chat's box (its draft).
  await expect(page.locator(`[data-chat-box="${REFUNDS}"]`)).toBeVisible();
  return { words: `compare with @${mine.name} (chat: ${mine.self}/ws:${mine.id})`, name: mine.name };
}

async function sendAndAsk(page: Page, words: string, name: string) {
  await composer(page).fill(words);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await composer(page).press('Enter');
  const sheet = page.getByRole('alertdialog', { name: `Share a copy of “${name}” with bob?` });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('leaves this computer');
  return sheet;
}

test('Share Copy: the copy of your chat goes with the message', async ({ page }) => {
  const { words, name } = await setUp(page);
  const sheet = await sendAndAsk(page, words, name);
  await sheet.getByRole('button', { name: 'Share Copy' }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(async () => (await sentThere(page)).find((t) => t.startsWith('compare with'))).toContain(`A copy of the chat “${name}”`);
  await expect(composer(page)).toHaveValue('');
});

test('Send Without It: the words go, and no copy', async ({ page }) => {
  const { words, name } = await setUp(page);
  // The file's tests share one demo: only the message this test sends counts.
  const before = (await sentThere(page)).length;
  const sheet = await sendAndAsk(page, words, name);
  await sheet.getByRole('button', { name: 'Send Without It' }).click();
  await expect.poll(async () => (await sentThere(page)).slice(before).some((t) => t.startsWith('compare with'))).toBe(true);
  expect((await sentThere(page)).slice(before).some((t) => t.includes('A copy of the chat'))).toBe(false);
});

test('Cancel: nothing leaves, and the words stay in the box', async ({ page }) => {
  const { words, name } = await setUp(page);
  const before = (await sentThere(page)).length;
  const sheet = await sendAndAsk(page, words, name);
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
  await expect(composer(page)).toHaveValue(words);
  expect(await sentThere(page)).toHaveLength(before);
});
