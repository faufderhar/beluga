import { expect, test, type Page } from './fixtures.js';

/**
 * A new worktree answers the click at once (BLG-942): its row and its page (your message in its chat) show before
 * Beluga's daemon has even heard of it, however busy it is. Here the daemon's part is held back,
 * as a busy one would hold it, and the window still answers; let go, the worktree takes over.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

/** Calls of these methods wait until `release()`, as a busy daemon would make them wait. */
async function holdBack(page: Page, methods: readonly string[]): Promise<{ held: () => number; release: () => void }> {
  const waiting: Array<() => void> = [];
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = typeof message === 'string' && message.startsWith('{') ? (JSON.parse(message) as { t?: string; method?: string }) : undefined;
      if (frame?.t === 'call' && frame.method && methods.includes(frame.method)) waiting.push(() => server.send(message));
      else server.send(message);
    });
  });
  return { held: () => waiting.length, release: () => waiting.splice(0).forEach((go) => go()) };
}

async function openHome(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeVisible();
}

test('Open in Worktree on a pull request shows its worktree at once, before the daemon answers', async ({ page }) => {
  const daemon = await holdBack(page, ['issues.openPull']);
  await openHome(page);
  const row = page.locator('main').getByRole('region', { name: 'Pull Requests' }).locator('[data-pull="51"]');
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByRole('button', { name: 'Open #51 in a worktree' }).click();

  // The daemon hasn't heard of it yet, and its page and row are there.
  await expect.poll(daemon.held).toBe(1);
  await expect(page.getByText('Making pr-51…')).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: /pr-51/ }).first()).toBeVisible();

  daemon.release();
  await expect(page.getByText(/Pull request #51 “Decode emails safely in the user lookup”, checked out on fix\/plus-in-email/)).toBeVisible({ timeout: 15_000 });
  // One row for it, never two.
  await expect(sidebar(page).getByRole('button', { name: /pr-51/ })).toHaveCount(1);
});

test('a new worktree from the home shows at once with what you asked, before the daemon answers', async ({ page }) => {
  const daemon = await holdBack(page, ['workspaces.startWorktree']);
  await openHome(page);
  const box = page.getByLabel('Task for the new worktree');
  await box.fill('Add request logging');
  await box.press('Enter');

  await expect.poll(daemon.held).toBe(1);
  // Its page is a chat already: your message, then Claude starting under it (no "Making…" page).
  const main = page.locator('main');
  await expect(main.locator('[data-mine="true"]').getByText('Add request logging')).toBeVisible();
  await expect(main.locator('[data-claude-starting]')).toBeVisible();
  await expect(main.getByText(/Making add-request-logging|as soon as its folder is ready/)).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: /add-request-logging/ }).first()).toBeVisible();

  daemon.release();
  await expect(page.locator('textarea:not(.xterm-helper-textarea)')).toHaveAttribute('placeholder', /Tell Claude what to do in/, { timeout: 15_000 });
  await expect(page.locator('main').getByText('Add request logging').first()).toBeVisible();
});
