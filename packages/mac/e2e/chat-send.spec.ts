import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * A message from another chat (BLG-149): the agent in one chat sends with send_to_chat (the demo's
 * mock does what a message tells it). The other chat shows a card with the source, never your bubble.
 */

async function daemon<T>(page: Page, fn: string, arg: unknown = null): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const w = window as unknown as { __sends?: Promise<unknown> };
      w.__sends ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      const c = await w.__sends;
      return new Function('c', 'arg', `return (${fn})(c, arg)`)(c, arg);
    },
    { fn, arg },
  ) as Promise<T>;
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const box = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

/** Opens a chat, and waits until the box is that chat's own: what you type goes there. */
async function openChat(page: Page, name: string): Promise<void> {
  await sidebar(page).getByText(name, { exact: true }).first().click();
  await expect(box(page)).toHaveAttribute('placeholder', new RegExp(name));
}

async function say(page: Page, text: string): Promise<void> {
  await box(page).fill(text);
  await box(page).press('Enter');
}

test('a message from another chat is a card with its source, and the sender sees it delivered', async ({ page }) => {
  await page.goto('/');
  for (const project of ['bob-api', 'landing']) await sidebar(page).getByRole('button', { name: `Show what's in ${project}` }).first().click();
  const { worktrees, self } = await daemon<{ worktrees: Array<{ id: string; name: string }>; self: string }>(
    page,
    `(c) => { const s = c.store.getState(); return { self: s.selfId, worktrees: s.projects.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && !w.archived).map((w) => ({ id: w.id, name: w.name })) }; }`,
  );
  const named: Array<{ id: string; name: string }> = [];
  for (const w of worktrees) if (await sidebar(page).getByText(w.name, { exact: true }).count()) named.push(w);
  const target = named[0]!;
  const source = named[1]!;

  // The source chat's agent is told to send.
  await openChat(page, source.name);
  await say(page, `send to ${self}/ws:${target.id}: Please check the /deploy step and $deploy notes`);
  await expect(page.getByText(/That chat answered/).first()).toBeVisible({ timeout: 30_000 });
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/03-source.png` });

  // The target chat: a card that says who, and no message of yours.
  await openChat(page, target.name);
  const card = page.locator(`[data-from-chat="${self}/ws:${source.id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('an agent');
  await expect(card).toContainText('Please check the /deploy step');
  await expect(card.getByRole('button', { name: new RegExp(source.name) })).toBeVisible();
  await expect(page.locator('[class*="bubble"]').filter({ hasText: 'Please check the /deploy step' })).toHaveCount(0);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/02-card.png` });
});

test('a chain at the hop limit asks you, one time, and Stop answers it', async ({ page }) => {
  await page.goto('/');
  for (const project of ['bob-api', 'landing']) await sidebar(page).getByRole('button', { name: `Show what's in ${project}` }).first().click();
  const { worktrees, self } = await daemon<{ worktrees: Array<{ id: string; name: string }>; self: string }>(
    page,
    `(c) => { const s = c.store.getState(); return { self: s.selfId, worktrees: s.projects.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && !w.archived).map((w) => ({ id: w.id, name: w.name })) }; }`,
  );
  const named: Array<{ id: string; name: string }> = [];
  for (const w of worktrees) if (await sidebar(page).getByText(w.name, { exact: true }).count()) named.push(w);
  const a = `${self}/ws:${named[0]!.id}`;
  const b = `${self}/ws:${named[1]!.id}`;
  // A message that tells each chat to send on: hop 1, 2, 3, 4, and the fifth send is refused.
  const ball = `send to ${b}: send to ${a}: send to ${b}: send to ${a}: send to ${b}: stop here`;
  await openChat(page, named[0]!.name);
  await say(page, ball);
  await expect.poll(() => daemon<number>(page, `(c) => c.store.getState().approvals.filter((x) => x.kind === 'chain').length`), { timeout: 40_000 }).toBe(1);
  const { title, channel } = await daemon<{ title: string; channel: string }>(page, `(c) => c.store.getState().approvals.find((x) => x.kind === 'chain')`);
  expect(title).toMatch(/^Agents sent \d+ messages between these chats\.$/);
  const at = named.find((w) => `ws:${w.id}` === channel)!;
  await openChat(page, at.name);
  const card = page.getByRole('alertdialog', { name: 'Approval needed' });
  await expect(card).toContainText('Agents sent');
  await expect(card.getByRole('button', { name: 'Continue' })).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/04-question.png` });
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(card).toHaveCount(0);
});

test('a message that waits at a busy chat: its row shows the source, has no Edit, and Steer keeps it a card', async ({ page }) => {
  await page.goto('/');
  for (const project of ['bob-api', 'landing']) await sidebar(page).getByRole('button', { name: `Show what's in ${project}` }).first().click();
  const { worktrees, self } = await daemon<{ worktrees: Array<{ id: string; name: string }>; self: string }>(
    page,
    `(c) => { const s = c.store.getState(); return { self: s.selfId, worktrees: s.projects.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && !w.archived).map((w) => ({ id: w.id, name: w.name })) }; }`,
  );
  const named: Array<{ id: string; name: string }> = [];
  for (const w of worktrees) if (await sidebar(page).getByText(w.name, { exact: true }).count()) named.push(w);
  const target = named[0]!;
  // A chat of its own: the guard counts each pair of chats, and the tests above used these two.
  const source = named[2]!;
  const tray = page.getByRole('region', { name: 'Queued messages' });

  // The target works until the test lets it go.
  await openChat(page, target.name);
  await say(page, 'hold this chat');
  await expect
    .poll(() => daemon<string | undefined>(page, `(c, channel) => c.store.getState().log.filter((l) => l.type === 'agent' && l.channel === channel).at(-1)?.status`, `ws:${target.id}`))
    .toBe('started');

  await openChat(page, source.name);
  await say(page, `send to ${self}/ws:${target.id}: Please check the deploy notes`);

  await openChat(page, target.name);
  await expect(tray.getByRole('listitem')).toHaveCount(1, { timeout: 20_000 });
  await box(page).fill('my own words');
  await page.getByRole('group', { name: /is working/ }).getByRole('button', { name: 'Queue' }).click();

  const fromRow = tray.getByRole('listitem').filter({ hasText: 'Please check the deploy notes' });
  const myRow = tray.getByRole('listitem').filter({ hasText: 'my own words' });
  await expect(fromRow.locator(`[data-queue-from="${self}/ws:${source.id}"]`)).toContainText('an agent');
  await expect(fromRow.getByRole('button', { name: new RegExp(source.name) })).toBeVisible();
  await fromRow.hover();
  await expect(fromRow.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
  await expect(fromRow.getByRole('button', { name: 'Move down' })).toBeVisible();
  await expect(fromRow.getByRole('button', { name: 'Remove from the queue' })).toBeVisible();
  await expect(fromRow.getByRole('button', { name: 'Steer' })).toBeVisible();
  // Your own row is as it was.
  await myRow.hover();
  await expect(myRow.getByRole('button', { name: /^Edit/ })).toBeVisible();
  await expect(myRow.locator('[data-queue-from]')).toHaveCount(0);
  await fromRow.hover();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/06-tray.png` });

  // Steer lets the held run go: the message runs as a card with its source, never your bubble.
  await myRow.getByRole('button', { name: 'Remove from the queue' }).click({ force: true });
  await fromRow.getByRole('button', { name: 'Steer' }).click();
  const card = page.locator(`[data-from-chat="${self}/ws:${source.id}"]`).filter({ hasText: 'Please check the deploy notes' });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[class*="bubble"]').filter({ hasText: 'Please check the deploy notes' })).toHaveCount(0);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/07-steered.png` });
});
