import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * A child thread that hits your usage limit (BLG-344): the parent's Threads panel says it waits and
 * when it goes on, and the child's chat has the usage limit card with its controls, as any chat.
 * The demo's Claude stops on the limit when its task is "usage limit" (src/agent/mock.ts).
 * Screenshots go to $BELUGA_SHOTS_DIR when it's set.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const shots = process.env.BELUGA_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png` });
  await page.waitForTimeout(1500);
}

test.use({ video: shots ? { mode: 'on', size: { width: 1440, height: 900 } } : 'off' });

test('a thread on the usage limit waits, says when it goes on, and its chat has the limit card', async ({ page, demo }) => {
  test.setTimeout(120_000);
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });
  await client.api.session.setPrefs({ agentThreads: true });
  client.close();
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await page.getByLabel('Worktree name').fill('e2e-limit');
  await composer(page).fill('start threads: capped=claude:usage limit');
  await page.getByRole('button', { name: /Create Worktree/ }).click();
  await expect(sidebar(page).getByRole('button', { name: 'e2e-limit', exact: true })).toBeVisible({ timeout: 20_000 });

  // The parent's panel: waiting, with the time it goes on; no failure reaches the parent.
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const row = inspector.locator('[data-thread-row]').filter({ has: page.getByRole('button', { name: /^Open capped,/ }) });
  await expect(row).toHaveAttribute('data-state', 'waiting_limit', { timeout: 40_000 });
  // Today it is just the time; past midnight (an evening run) the day comes first: "Nov 11, 01:05".
  await expect(row).toContainText(/Waiting · (?:\w+ \d{1,2}, )?\d\d:\d\d/);
  await expect(page.getByText(/child thread reported/)).toHaveCount(0);
  await shot(page, 'limit-01-panel-waiting');

  // The child's chat: the usage limit card, with when it continues and Don't Send.
  await row.getByRole('button', { name: /^Open capped,/ }).click();
  await expect(page.getByText(/You hit your Claude plan usage limit/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Sends “Continue where you left off\.” at .*, when your limit resets/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Don’t Send', exact: true })).toBeVisible();
  await shot(page, 'limit-02-child-card');
});
