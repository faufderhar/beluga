import { expect, test, type Page } from './fixtures.js';

/** "@" in a worktree's chat keeps other projects' tasks last, apart, and asks before one goes in (BLG-397). */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

test('another project’s task is offered last, says so when picked, and goes in on the second pick', async ({ page }) => {
  await page.goto('/');
  // new-hero is the landing project's worktree; "Refund endpoint" is bob-api's task.
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name: 'new-hero', exact: true }).click();
  const box = page.locator('main textarea').last();
  const list = page.getByRole('listbox', { name: 'Suggestions' });

  // The first couple of letters: only this project's.
  // (With nothing of this project's to offer, there may be no list at all.)
  await box.fill('see @re');
  await expect(box).toHaveValue('see @re');
  await expect(list.getByText('Refund endpoint')).toHaveCount(0);

  await box.fill('see @refund');
  await expect(list).toContainText('In other projects, not this one');
  // (bob-api's epic "Refunds and launch" is offered there too.) Followed by its key: once picked, its title gives way to a note.
  const found = list.getByRole('option', { name: /Refund endpoint/ });
  await expect(found).toBeVisible();
  const key = /[A-Z]+-\d+/.exec((await found.textContent()) ?? '')![0];
  const option = list.getByRole('option', { name: new RegExp(`^${key} `) });
  if (process.env.BELUGA_SHOTS) await list.screenshot({ path: `${process.env.BELUGA_SHOTS}/01-other-project-section.png` });

  // The first pick only says it isn't this project's.
  await option.click();
  await expect(option).toContainText('not this project');
  await expect(box).toHaveValue('see @refund');
  if (process.env.BELUGA_SHOTS) await list.screenshot({ path: `${process.env.BELUGA_SHOTS}/02-other-project-asking.png` });

  // The second puts it in.
  await option.click();
  await expect(box).toHaveValue(/^see @[A-Z]+-\d+ $/);
});
