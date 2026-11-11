import { expect, test, type Page } from './fixtures.js';

/**
 * Who's on a board (BLG-906), against the demo's team scene (BELUGA_DEMO_SCENE=team,
 * core/team/demo.ts): once bob teams up on bob-api, the board's header shows your faces in place
 * of the worktree filter; clicking them lists everyone, and bob's card opens his profile.
 */

test.skip(process.env.BELUGA_DEMO_SCENE !== 'team', 'needs BELUGA_DEMO_SCENE=team');

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

test('the board shows who is on it, and a person’s card', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const card = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible()) await card.getByRole('button', { name: 'Turn On' }).click();
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Tasks' }).click();
  await page.getByRole('button', { name: 'Team Up' }).first().click({ timeout: 60_000 });

  // The worktree filter is gone (Filter finds); the faces are there instead.
  await expect(page.getByRole('combobox', { name: 'Worktree' })).toHaveCount(0);
  const faces = page.getByRole('button', { name: 'On this board: you and bob' });
  await expect(faces).toBeVisible({ timeout: 30_000 });

  await faces.click();
  const people = page.getByRole('dialog', { name: 'People on this board' });
  await expect(people.getByText('(you)')).toBeVisible();
  await people.getByRole('button', { name: 'bob: Friend' }).click();
  const bob = people.getByRole('region', { name: 'bob’s card' });
  await expect(bob).toContainText('Friend');
  // Back to everyone, and in again.
  await bob.getByRole('button', { name: 'On this board' }).click();
  await people.getByRole('button', { name: 'bob: Friend' }).click();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/board-people-card.png` });
  await people.getByRole('button', { name: 'Open Profile' }).click();
  await expect(people).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'Chats' }).getByRole('tab', { name: 'bob' })).toHaveAttribute('aria-selected', 'true');
});
