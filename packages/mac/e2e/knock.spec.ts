import { expect, test, type Page } from './fixtures.js';

/**
 * Knocking on a teammate's worktree (BLG-416), against the demo's team scene
 * (BELUGA_DEMO_SCENE=team, core/team/demo.ts): bob teams up on bob-api and works on "Rate-limit
 * the login endpoint" (you knock, he lets you in), and knocks on your worktree doing "Idempotent
 * webhook retries" (its card in that chat). SHOTS=<folder>: screenshots there.
 */

test.describe.configure({ mode: 'serial' });
test.skip(process.env.BELUGA_DEMO_SCENE !== 'team', 'needs BELUGA_DEMO_SCENE=team');
test.use(process.env.SHOTS ? { deviceScaleFactor: 2 } : {});

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shot = async (page: Page, name: string, el?: ReturnType<Page['locator']>): Promise<void> => {
  if (!process.env.SHOTS) return;
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await (el ?? page).screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

async function openTasks(page: Page): Promise<void> {
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Tasks' }).click();
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
}

test('knock on a teammate’s worktree, and a teammate knocking on yours', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const card = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible()) await card.getByRole('button', { name: 'Turn On' }).click();
  await openTasks(page);
  // bob asked to team up on bob-api.
  await page.getByRole('button', { name: 'Team Up' }).first().click({ timeout: 60_000 });

  // His task: he's on it, in a worktree of his. Knock to Join.
  const list = page.getByRole('grid', { name: 'Tasks' });
  await list.getByRole('row', { name: /Rate-limit the login endpoint/ }).click();
  const head = page.locator('main header').filter({ hasText: 'bob is working on this' });
  await expect(head).toBeVisible({ timeout: 30_000 });
  await shot(page, '01-task-knock-to-join');
  await head.getByRole('button', { name: 'Knock to Join' }).click();
  await expect(head).toContainText('Knocked. Waiting for bob to let you in');
  await shot(page, '02-task-knocked-waiting', head);
  await expect(head).toContainText('bob let you in as an editor', { timeout: 20_000 });
  await shot(page, '03-task-let-in', head);

  // bob knocks on your worktree doing the webhook retries: the bell, and its card in the chat.
  await openTasks(page);
  // It's a sub-task, tucked under its epic.
  const all = page.getByRole('button', { name: 'Show All', exact: true });
  if (await all.isVisible()) await all.click();
  await list.getByRole('row', { name: /Idempotent webhook retries/ }).click();
  await page.getByRole('button', { name: 'Open Worktree' }).first().click();
  const knock = page.getByRole('region', { name: /bob is knocking/ });
  await expect(knock).toBeVisible({ timeout: 40_000 });
  await shot(page, '04-worktree-knock-card');
  await shot(page, '05-knock-card', knock);
  await page.getByRole('button', { name: /Notifications|Bell/i }).first().click();
  await shot(page, '06-bell');
  await page.keyboard.press('Escape');
  await knock.getByRole('button', { name: 'Let In as Editor' }).click();
  await shot(page, '07-after-let-in');
  await expect(knock).toBeHidden();
  await expect(page.getByText('You let bob in as an editor')).toBeVisible();
  await shot(page, '08-let-in-line');
});
