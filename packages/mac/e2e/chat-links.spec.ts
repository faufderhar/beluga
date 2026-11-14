import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * A chat's address (shared/chat-ref.ts): Copy Chat Link on a row, the link and the chip in a message.
 * The window has no OS deep links here, so a link in a message stands in for one: both end in
 * lib/chat-links.ts's openChatLink.
 */

/** A second connection to the demo daemon from the page (the app's own boot code), for driving it. */
async function daemon<T>(page: Page, fn: string, arg: unknown = null): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const w = window as unknown as { __links?: Promise<unknown> };
      w.__links ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      const c = await w.__links;
      return new Function('c', 'arg', `return (${fn})(c, arg)`)(c, arg);
    },
    { fn, arg },
  ) as Promise<T>;
}

const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

/** A worktree that shows in the sidebar: a plan's task worktrees stay off it (layout/plan-row.tsx), so they have no row to click. */
async function worktreeWithRow(page: Page): Promise<{ id: string; name: string; self: string }> {
  const { worktrees, self } = await daemon<{ worktrees: Array<{ id: string; name: string }>; self: string }>(
    page,
    `(c) => { const s = c.store.getState(); return { self: s.selfId, worktrees: s.projects.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && !w.archived).map((w) => ({ id: w.id, name: w.name })) }; }`,
  );
  await expect(sidebar(page).getByText('Your Mac', { exact: true })).toBeVisible();
  for (const w of worktrees) if (await sidebar(page).getByText(w.name, { exact: true }).count()) return { ...w, self };
  throw new Error(`No worktree has a row of its own among: ${worktrees.map((w) => w.name).join(', ')}`);
}

/** Your Mac open, its composer there: what you type goes to it. */
async function openYourMac(page: Page): Promise<void> {
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Ask your Mac anything' })).toBeVisible();
}

async function say(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test('copy a link from a row, open it, and read the chip', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  // Copy Chat Link on the row. Projects start folded.
  for (const project of ['bob-api', 'landing']) await sidebar(page).getByRole('button', { name: `Show what's in ${project}` }).first().click();
  const { id, name, self } = await worktreeWithRow(page);
  await sidebar(page).getByText(name, { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy Chat Link' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`beluga://chat/${self}/${encodeURIComponent(`ws:${id}`)}`);
  const link = await page.evaluate(() => navigator.clipboard.readText());

  // In another chat: the link, the chip, a chat on someone else's computer, one that's gone and a malformed link.
  await openYourMac(page);
  await say(page, `[to the worktree](${link}) and \`chat:${self}/ws:${id}\` and \`chat:someone-elses-computer-000000/ws:${id}\` and \`chat:${self}/ws:wt-gone\` and [broken](beluga://chat/${self}/%E0%A4%A)`);

  const chip = page.getByRole('button', { name: `Worktree ${name}` }).first();
  await expect(chip).toBeVisible();
  await expect(page.getByText('Private chat', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Chat removed', { exact: true }).first()).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/01-chips.png` });

  // A malformed link stays where you are and doesn't fail.
  const failed: string[] = [];
  page.on('pageerror', (e) => failed.push(e.message));
  await page.getByRole('link', { name: 'broken' }).click();
  await expect(page.getByRole('tablist', { name: 'Your Mac’s chats' })).toBeVisible();
  expect(failed).toEqual([]);

  // A rename shows on the chip at once: never a saved title.
  await daemon(page, `(c, id) => c.api.workspaces.rename(id, 'better-name')`, id);
  await expect(page.getByRole('button', { name: 'Worktree better-name' }).first()).toBeVisible();

  // The link opens that chat.
  await page.getByRole('link', { name: 'to the worktree' }).click();
  await expect(page.getByRole('textbox', { name: 'Tell Claude what to do in better-name' })).toBeVisible();
});

test('a plan row stays, and copies the link of its home chat', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const logged: string[] = [];
  page.on('console', (m) => logged.push(m.text()));
  page.on('pageerror', (e) => logged.push(e.message));
  await page.goto('/');
  const { project, plan, home, self } = await daemon<{ project: string; plan: string; home: string; self: string }>(
    page,
    `(c) => { const s = c.store.getState(); const p = s.plans.plans.find((x) => x.status === 'active' && x.home.startsWith('ws:')); return { project: s.projects.find((x) => x.id === p.projectId).name, plan: p.id, home: p.home, self: s.selfId }; }`,
  );

  await sidebar(page).getByRole('button', { name: `Show what's in ${project}` }).first().click();
  // Under its project: the row at the sidebar's top (plans/PlansNav.tsx) has no menu.
  const row = sidebar(page).locator(`[data-slot^="project:"] [data-plan-row="${plan}"]`).first();
  await expect(row).toBeVisible();
  // The crash came within a render or two: still there a moment later, and nothing said so.
  await page.waitForTimeout(500);
  await expect(row).toBeVisible();
  expect(logged.filter((l) => l.includes('Maximum update depth exceeded'))).toEqual([]);

  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy Chat Link' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`beluga://chat/${self}/${encodeURIComponent(home)}`);
});
