import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * Dragging a chat's row onto a chat (layout/chat-drag.tsx): a chip goes in the target's draft and
 * nothing is sent. What's carried is the row itself; the chat that would take it lights up. Esc
 * cancels; the same chat and the room do nothing.
 */

// A slower hand and a video for the proof (CHAT_DRAG_VIDEO=1).
const filming = Boolean(process.env.CHAT_DRAG_VIDEO);
test.use({ video: filming ? { mode: 'on', size: { width: 1440, height: 900 } } : 'off' });
const STEPS = filming ? 30 : 8;
const pause = async (page: Page): Promise<void> => {
  if (filming) await page.waitForTimeout(700);
};

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const ghost = (page: Page) => page.locator('[data-chat-ghost]');

/** A second connection to the demo daemon from the page (the app's own boot code), for driving it. */
async function daemon<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(
    async (fn) => {
      const w = window as unknown as { __drag?: Promise<unknown> };
      w.__drag ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      return new Function('c', `return (${fn})(c)`)(await w.__drag);
    },
    fn,
  ) as Promise<T>;
}

/** The sidebar's own rows for two worktrees (a plan's stay off it). */
async function setUp(page: Page): Promise<{ self: string; a: Worktree; b: Worktree }> {
  await page.goto('/');
  // The projects drawn first: a fold button read before then is never found.
  await expect(sidebar(page).getByRole('button', { name: /^(Show what's in|Fold) bob-api$/ }).first()).toBeVisible();
  for (const project of ['bob-api', 'landing']) {
    const unfold = sidebar(page).getByRole('button', { name: `Show what's in ${project}` }).first();
    if (await unfold.isVisible()) await unfold.click();
  }
  const { self, all } = await daemon<{ self: string; all: Worktree[] }>(page, `(c) => { const s = c.store.getState(); return { self: s.selfId, all: s.projects.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && !w.archived).map((w) => ({ id: w.id, name: w.name })) }; }`);
  const rows: Worktree[] = [];
  for (const w of all) if (await rowOf(page, w).count()) rows.push(w);
  if (rows.length < 2) throw new Error(`Two worktrees with rows are needed, among: ${all.map((w) => w.name).join(', ')}`);
  return { self, a: rows[0]!, b: rows[1]! };
}

interface Worktree {
  readonly id: string;
  readonly name: string;
}

const rowOf = (page: Page, w: Worktree) => sidebar(page).locator(`[data-chat-row="ws:${w.id}"]`).first();
const boxIn = (page: Page, w: Worktree) => page.getByRole('textbox', { name: `Tell Claude what to do in ${w.name}` });
const chip = (self: string, w: Worktree): string => `@${w.name} (chat: ${self}/ws:${w.id})`;
/** The chat that would take a drop: its conversation veiled, its box glowing. */
const glow = (page: Page) => page.locator('[data-chat-drop="box"]');
const veil = (page: Page) => page.locator('[data-chat-drop="pane"]');

/**
 * What a box would send: the box shows a chat as a short mention, a chip with its title
 * (chat/chat-box.ts), never its ref; out it goes whole, ref and all.
 */
async function sentFrom(page: Page, box: Locator): Promise<string> {
  const value = await box.inputValue();
  if (value.includes('(chat: ')) return `still whole in the box: ${value}`;
  return daemon<string>(page, `(c) => import('/src/chat/chat-box.ts').then((m) => m.plainWords(${JSON.stringify(value)}, c.store.getState()))`);
}
/**
 * What you sent from these chats: your words and your agent asks in their channels only. The demo's
 * friends say things in the room on timers, and those must not count.
 */
const sent = (page: Page, ...chats: Worktree[]): Promise<number> => {
  const channels = JSON.stringify(chats.map((w) => `ws:${w.id}`));
  return daemon<number>(page, `(c) => { const s = c.store.getState(); const here = ${channels}; return s.log.filter((l) => here.includes(l.channel) && ((l.type === 'chat' && l.from === s.selfId && !l.byAgent) || (l.type === 'agent' && l.requester === s.selfId))).length; }`);
};

/** Pick a row up and hold it over `to`, as a hand would. */
async function lift(page: Page, row: Locator, to: Locator): Promise<void> {
  const from = (await row.boundingBox())!;
  const over = (await to.boundingBox())!;
  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 64, from.y + from.height / 2 + 6, { steps: 3 });
  await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2, { steps: STEPS });
  await pause(page);
}

test('a row dropped on the open composer: a chip at the cursor, nothing sent', async ({ page }) => {
  const { self, a, b } = await setUp(page);
  await rowOf(page, a).click();
  const box = boxIn(page, a);
  await box.fill('compare this with');
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(12, 12));
  const before = await sent(page, a, b);
  await pause(page);
  await lift(page, rowOf(page, b), box);
  // The row itself is carried, as wide as it is in the sidebar less its nesting, swinging as it goes.
  await expect(ghost(page)).toContainText(b.name);
  const nesting = await rowOf(page, b).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft) - 8);
  const [carried, row] = await Promise.all([ghost(page).boundingBox(), rowOf(page, b).boundingBox()]);
  expect(Math.abs(carried!.width - (row!.width - nesting))).toBeLessThan(row!.width * 0.06);
  await expect(glow(page)).toBeVisible();
  await expect(veil(page)).toBeVisible();
  await page.mouse.up();
  await expect(glow(page)).toHaveCount(0);
  await expect.poll(() => sentFrom(page, box)).toBe(`compare this ${chip(self, b)} with`);
  await expect(page.getByLabel('Chat mentioned')).toContainText(b.name);
  await expect(ghost(page)).toHaveCount(0);
  await pause(page);
  expect(await sent(page, a, b)).toBe(before);
  // Still where it was: the drop opens nothing.
  await expect(box).toBeVisible();
  await box.fill('');
});

test('the carried row starts at its icon, and nothing is selected on the way (BLG-939)', async ({ page }) => {
  const { a, b } = await setUp(page);
  await rowOf(page, a).click();
  await expect(boxIn(page, a)).toBeVisible();
  const iconAt = (el: Element): number => el.querySelector('svg')!.getBoundingClientRect().left - el.getBoundingClientRect().left;
  const inRow = await rowOf(page, b).evaluate(iconAt);
  // Across the open chat's words, as a hand would go, and back over the sidebar.
  await lift(page, rowOf(page, b), page.locator('main').first());
  const inGhost = await ghost(page).evaluate(iconAt);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/chat-drag-carried.png` });
  expect(inRow).toBeGreaterThan(inGhost);
  expect(inGhost).toBeLessThan(16);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(ghost(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
});

test('a row dropped on the open chat’s log: the same', async ({ page }) => {
  const { self, a, b } = await setUp(page);
  await rowOf(page, a).click();
  const box = boxIn(page, a);
  await box.fill('');
  await lift(page, rowOf(page, b), page.locator('main').first());
  await expect(glow(page)).toBeVisible();
  await expect(veil(page)).toContainText('Drop to add it to your message');
  await page.mouse.up();
  await expect.poll(() => sentFrom(page, box)).toBe(`${chip(self, b)} `);
  await box.fill('');
});

test('a row dropped on another row: that row lights up, its chat opens with the chip in its draft', async ({ page }) => {
  const { self, a, b } = await setUp(page);
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  const before = await sent(page, a, b);
  await lift(page, rowOf(page, a), rowOf(page, b));
  await expect(rowOf(page, b)).toHaveClass(/over/);
  await page.mouse.up();
  const box = boxIn(page, b);
  await expect.poll(() => sentFrom(page, box)).toBe(`${chip(self, a)} `);
  await pause(page);
  expect(await sent(page, a, b)).toBe(before);
  // The chip stays with that chat's draft, not with the others.
  await rowOf(page, a).click();
  await expect(boxIn(page, a)).toHaveValue('');
  await rowOf(page, b).click();
  await expect.poll(() => sentFrom(page, box)).toBe(`${chip(self, a)} `);
  await box.fill('');
});

test('Your Mac’s row is a target and a source', async ({ page }) => {
  const { self, a } = await setUp(page);
  await rowOf(page, a).click();
  const mac = sidebar(page).locator('[data-chat-row^="mac:assistant"]');
  await lift(page, rowOf(page, a), mac);
  await page.mouse.up();
  const macBox = page.getByRole('textbox', { name: 'Ask your Mac anything' });
  await expect.poll(() => sentFrom(page, macBox)).toBe(`${chip(self, a)} `);
  await macBox.fill('');
  await lift(page, mac, rowOf(page, a));
  await page.mouse.up();
  await expect.poll(() => sentFrom(page, boxIn(page, a))).toMatch(new RegExp(`\\(chat: ${self}/mac:assistant[^)]*\\) $`));
  await boxIn(page, a).fill('');
});

test('a plan’s row takes a drop in its own chat, on its page, and can be dragged', async ({ page }) => {
  const { self, a } = await setUp(page);
  const home = await daemon<string>(page, `(c) => c.store.getState().plans.plans.find((x) => x.status === 'active' && x.home.startsWith('ws:')).home`);
  const row = sidebar(page).locator(`[data-slot^="project:"] [data-chat-row="${home}"]`).first();
  await lift(page, rowOf(page, a), row);
  await page.mouse.up();
  const box = page.getByRole('complementary', { name: 'Conversation' }).getByRole('textbox', { name: 'Message your agent about the plan' });
  await expect.poll(() => sentFrom(page, box)).toBe(`${chip(self, a)} `);
  await box.fill('');
  await rowOf(page, a).click();
  await lift(page, row, boxIn(page, a));
  await page.mouse.up();
  await expect.poll(() => sentFrom(page, boxIn(page, a))).toMatch(new RegExp(`\\(chat: ${self}/${home}\\) $`));
  await boxIn(page, a).fill('');
});

test('an Unread row is a source and a target (BLG-307)', async ({ page }) => {
  test.setTimeout(90_000);
  const { self, a, b } = await setUp(page);
  const unreadRow = (w: Worktree) => sidebar(page).getByRole('region', { name: 'Unread' }).locator(`[data-chat-row="ws:${w.id}"]`);
  const treeRow = (w: Worktree) => sidebar(page).locator(`[data-slot^="project:"] [data-chat-row="ws:${w.id}"]`).first();
  // Make a unread: its agent answers while you are elsewhere.
  await treeRow(a).click();
  await boxIn(page, a).fill('hello');
  await boxIn(page, a).press('Enter');
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  await expect(unreadRow(a)).toBeVisible({ timeout: 40_000 });
  await pause(page);
  // As a source: dropped on another chat's row.
  await lift(page, unreadRow(a), treeRow(b));
  await expect(treeRow(b)).toHaveClass(/over/);
  await page.mouse.up();
  await expect.poll(() => sentFrom(page, boxIn(page, b))).toBe(`${chip(self, a)} `);
  await boxIn(page, b).fill('');
  await pause(page);
  // As a target: another chat's row dropped on it.
  await lift(page, treeRow(b), unreadRow(a));
  await expect(unreadRow(a)).toHaveClass(/over/);
  await page.mouse.up();
  await expect.poll(() => sentFrom(page, boxIn(page, a))).toBe(`${chip(self, b)} `);
  await boxIn(page, a).fill('');
});

test('Esc cancels; the row still opens its chat afterwards', async ({ page }) => {
  const { a, b } = await setUp(page);
  await rowOf(page, a).click();
  const box = boxIn(page, a);
  await box.fill('keep me');
  await lift(page, rowOf(page, b), box);
  await page.keyboard.press('Escape');
  await expect(ghost(page)).toHaveCount(0);
  await expect(glow(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(box).toHaveValue('keep me');
  await box.fill('');
  await rowOf(page, b).click();
  await expect(boxIn(page, b)).toBeVisible();
  await expect(boxIn(page, b)).toHaveValue('');
});

test('the same chat and the room refuse: no highlight, no chip', async ({ page }) => {
  const { a, b } = await setUp(page);
  await rowOf(page, a).click();
  const box = boxIn(page, a);
  await box.fill('');
  // Its own composer, and its own row.
  await lift(page, rowOf(page, a), box);
  await expect(glow(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(box).toHaveValue('');
  await lift(page, rowOf(page, a), rowOf(page, a));
  await expect(rowOf(page, a)).not.toHaveClass(/over/);
  await page.mouse.up();
  await expect(box).toHaveValue('');
  // The room: its row and its box.
  const room = sidebar(page).getByRole('button', { name: 'Group chat' });
  await lift(page, rowOf(page, b), room);
  await expect(room).not.toHaveClass(/over/);
  await page.mouse.up();
  await expect(box).toBeVisible();
  await room.click();
  const roomBox = page.locator('main textarea:not(.xterm-helper-textarea)').last();
  await roomBox.fill('');
  await lift(page, rowOf(page, b), roomBox);
  await page.mouse.up();
  await expect(roomBox).toHaveValue('');
});

test('a press on a chat row in a project doesn’t move the project', async ({ page }) => {
  const { a } = await setUp(page);
  const order = (): Promise<string[]> => sidebar(page).locator('[data-drag^="project:"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-drag')!));
  const before = await order();
  const first = sidebar(page).locator('[data-drag^="project:"]').first();
  await lift(page, rowOf(page, a), first);
  await page.mouse.up();
  expect(await order()).toEqual(before);
});
