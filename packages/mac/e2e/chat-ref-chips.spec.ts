import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * A chat named by its bare ref in a message ("<owner>/<channel>") is drawn as that chat's chip, with
 * its title of now: in your bubble, in an agent's answer and in a card from another chat's agent.
 */

async function daemon<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(
    async (fn) => {
      const w = window as unknown as { __bare?: Promise<unknown> };
      w.__bare ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      return new Function('c', `return (${fn})(c)`)(await w.__bare);
    },
    fn,
  ) as Promise<T>;
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const box = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

interface Worktree {
  readonly id: string;
  readonly name: string;
}

/** Two worktrees with rows, and this Mac's peer id. */
async function setUp(page: Page): Promise<{ self: string; source: Worktree; target: Worktree }> {
  await page.goto('/');
  // The projects drawn first: a fold button read before then is never found.
  await expect(sidebar(page).getByRole('button', { name: /^(Show what's in|Fold) bob-api$/ }).first()).toBeVisible();
  for (const project of ['bob-api', 'landing']) {
    const unfold = sidebar(page).getByRole('button', { name: `Show what's in ${project}` }).first();
    if (await unfold.isVisible()) await unfold.click();
  }
  const { worktrees, self } = await daemon<{ worktrees: Worktree[]; self: string }>(
    page,
    `(c) => { const s = c.store.getState(); return { self: s.selfId, worktrees: s.projects.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && !w.archived).map((w) => ({ id: w.id, name: w.name })) }; }`,
  );
  const named: Worktree[] = [];
  for (const w of worktrees) if (await sidebar(page).getByText(w.name, { exact: true }).count()) named.push(w);
  return { self, source: named[0]!, target: named[1]! };
}

async function openChat(page: Page, name: string): Promise<void> {
  await sidebar(page).getByText(name, { exact: true }).first().click();
  await expect(box(page)).toHaveAttribute('placeholder', new RegExp(name));
}

test('a bare chat ref is the chat’s chip: in your bubble and in the card from another chat’s agent', async ({ page }) => {
  const { self, source, target } = await setUp(page);
  const sourceRef = `${self}/ws:${source.id}`;
  const targetRef = `${self}/ws:${target.id}`;
  // The source's agent sends "send to <source>: stop here" to the target, whose agent sends "stop here" back.
  await openChat(page, source.name);
  await box(page).fill(`send to ${targetRef}: send to ${sourceRef}: stop here`);
  await box(page).press('Enter');
  const mine = page.locator('main [data-mine="true"]').filter({ hasText: 'send to' }).last();
  await expect(mine.getByRole('button', { name: `Worktree ${target.name}` })).toBeVisible();
  await expect(mine).not.toContainText(`${self}/`);

  await openChat(page, target.name);
  const card = page.locator(`[data-from-chat="${sourceRef}"]`).filter({ hasText: 'send to' }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  // In the words: the chip with the chat's title, never its ref.
  await expect(card.locator('[data-md]').getByRole('button', { name: `Worktree ${source.name}` })).toBeVisible();
  await expect(card).not.toContainText(`${self}/`);
  await expect(card).toContainText('stop here');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/bare-ref-card.png` });
});
