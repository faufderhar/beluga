import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * Dragging a file or folder from the Files tree onto a message box (layout/file-drag.tsx):
 * "@src/server.ts " or "@src/ " goes into that draft and nothing is sent. A short press still
 * opens or folds the row. Escape, and a drop that misses the box, insert nothing. A shared
 * folder's list has no tree rows, so it doesn't drag.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const ghost = (page: Page) => page.locator('[data-file-ghost]');
const glow = (page: Page) => page.locator('[data-file-drop="box"]');
const homeBox = (page: Page) => page.getByRole('textbox', { name: 'Task for the new worktree' });

/** A second connection to the demo daemon, to count what was sent. */
async function daemon<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(
    async (body) => {
      const w = window as unknown as { __fileDrag?: Promise<unknown> };
      w.__fileDrag ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      return new Function('c', `return (${body})(c)`)(await w.__fileDrag);
    },
    fn,
  ) as Promise<T>;
}

/** Your words and the runs you started in this chat. The demo's friends talk on timers. */
const sentIn = (page: Page, id: string): Promise<number> =>
  daemon<number>(page, `(c) => { const s = c.store.getState(); const channel = ${JSON.stringify(`ws:${id}`)}; return s.log.filter((l) => l.channel === channel && ((l.type === 'chat' && l.from === s.selfId && !l.byAgent) || (l.type === 'agent' && l.requester === s.selfId))).length; }`);

async function openHome(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeVisible();
  await panel(page).getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(panel(page).getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
}

/** A press that doesn't move still folds the folder. Then its files are there to drag. */
async function showServer(page: Page): Promise<void> {
  const src = panel(page).getByRole('treeitem', { name: 'src', exact: true });
  if ((await src.getAttribute('aria-expanded')) !== 'true') await src.click();
  await expect(src).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page).getByRole('treeitem', { name: 'server.ts', exact: true })).toBeVisible();
}

/** Pick a tree row up and hold it over `to`. The first move is past the drag slop. */
async function lift(page: Page, row: Locator, to: Locator): Promise<void> {
  const from = (await row.boundingBox())!;
  const over = (await to.boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 44, from.y + from.height / 2 + 6, { steps: 3 });
  await page.mouse.move(over.x + over.width / 2, over.y + Math.min(over.height / 2, 24), { steps: 8 });
}

test('a file and a folder dropped on the project home composer stay in the draft', async ({ page }) => {
  await openHome(page);
  await showServer(page);
  const box = homeBox(page);
  const file = panel(page).getByRole('treeitem', { name: 'server.ts', exact: true });
  await lift(page, file, box);
  await expect(ghost(page)).toContainText('server.ts');
  await expect(glow(page)).toBeVisible();
  await page.mouse.up();
  await expect(box).toHaveValue('@src/server.ts ');
  await expect(page.locator('[data-mention="@src/server.ts"]')).toHaveAttribute('data-kind', 'file');
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeVisible();
  await expect(panel(page).getByRole('region', { name: 'server.ts' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Files to send' })).toHaveCount(0);
  await expect(ghost(page)).toHaveCount(0);

  await box.fill('');
  const src = panel(page).getByRole('treeitem', { name: 'src', exact: true });
  await lift(page, src, box);
  await expect(ghost(page)).toContainText('src');
  await page.mouse.up();
  await expect(box).toHaveValue('@src/ ');
  await expect(page.locator('[data-mention="@src/"]')).toHaveAttribute('data-kind', 'folder');
  await expect(src).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeVisible();
});

test('Escape cancels, and a drop off the box inserts nothing', async ({ page }) => {
  await openHome(page);
  await showServer(page);
  const box = homeBox(page);
  const file = panel(page).getByRole('treeitem', { name: 'server.ts', exact: true });
  await lift(page, file, box);
  await expect(ghost(page)).toBeVisible();
  await expect(glow(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(box).toHaveValue('');
  await expect(ghost(page)).toHaveCount(0);
  await expect(panel(page).getByRole('region', { name: 'server.ts' })).toHaveCount(0);

  const heading = page.getByRole('heading', { name: 'What do you want to do in bob-api?' });
  await lift(page, file, heading);
  await expect(glow(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(box).toHaveValue('');
  await expect(panel(page).getByRole('region', { name: 'server.ts' })).toHaveCount(0);
});

test('the same drag in a worktree stays in that chat and does not send', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  const box = page.getByRole('textbox', { name: 'Tell Claude what to do in add-auth' });
  await expect(box).toBeVisible();
  const id = await daemon<string>(page, `(c) => c.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth' && w.kind === 'worktree')?.id ?? ''`);
  expect(id).not.toBe('');
  await panel(page).getByRole('tab', { name: 'Files', exact: true }).click();
  const src = panel(page).getByRole('treeitem', { name: 'src', exact: true });
  await expect(src).toBeVisible();
  if ((await src.getAttribute('aria-expanded')) !== 'true') await src.click();
  const file = panel(page).getByRole('treeitem', { name: 'auth.ts', exact: true });
  await expect(file).toBeVisible();
  const before = await sentIn(page, id);
  await lift(page, file, box);
  await expect(glow(page)).toBeVisible();
  await page.mouse.up();
  await expect(box).toHaveValue('@src/auth.ts ');
  await expect(page.locator('[data-mention="@src/auth.ts"]')).toHaveAttribute('data-kind', 'file');
  await expect(panel(page).getByRole('region', { name: 'auth.ts' })).toHaveCount(0);
  expect(await sentIn(page, id)).toBe(before);
});

test("a shared folder's files don't drag", async ({ page }) => {
  await page.goto('/');
  const payments = sidebar(page).getByRole('button', { name: 'payments', exact: true });
  if (!(await payments.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api, shared by bob' }).getByRole('button', { name: "Show what's in bob-api" }).click();
  await payments.click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  const row = page.getByRole('listbox', { name: 'Files' }).getByRole('option', { name: 'src', exact: true });
  await expect(row).toBeVisible();
  const from = (await row.boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 80, from.y + from.height / 2 + 30, { steps: 6 });
  await expect(ghost(page)).toHaveCount(0);
  await page.mouse.up();
});
