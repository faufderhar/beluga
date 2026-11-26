import { expect, test, type Page } from './fixtures.js';

/**
 * Straight to main (BLG-973): both new-worktree boxes (the project's home and the sidebar's New
 * worktree) have a Then pop-up, its own branch or Straight to main, remembered for the project.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const SHOTS = process.env.BELUGA_SHOTS;

async function openHome(page: Page, project = 'bob-api'): Promise<void> {
  await sidebar(page).getByText(project, { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: project })).toBeVisible();
}

test('the home’s new worktree can go straight to main, and the project remembers it', async ({ page }) => {
  await page.goto('/');
  await openHome(page);
  const then = page.getByRole('combobox', { name: 'Then' });
  await expect(then).toHaveText(/Its own branch/);
  await then.click();
  const menu = page.getByRole('listbox', { name: 'Then' });
  await expect(menu.getByRole('option')).toHaveText([/Its own branch/, /Straight to main/]);
  if (SHOTS) await page.getByRole('region', { name: 'Start something' }).screenshot({ path: `${SHOTS}/01-home-then-menu.png` });
  await menu.getByRole('option', { name: /Straight to main/ }).click();
  await expect(then).toHaveText(/Straight to main/);
  if (SHOTS) await page.getByRole('region', { name: 'Start something' }).screenshot({ path: `${SHOTS}/02-home-straight-to-main.png` });

  // The sidebar's New worktree box in the same project starts the same way.
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  const draft = page.getByRole('group', { name: 'New worktree' });
  await expect(draft.getByRole('combobox', { name: 'Then' })).toHaveText(/Straight to main/);
  if (SHOTS) await draft.screenshot({ path: `${SHOTS}/03-draft-straight-to-main.png` });

  // Back to its own branch: remembered too.
  await draft.getByRole('combobox', { name: 'Then' }).click();
  await page.getByRole('listbox', { name: 'Then' }).getByRole('option', { name: /Its own branch/ }).click();
  await openHome(page);
  await expect(page.getByRole('combobox', { name: 'Then' })).toHaveText(/Its own branch/);
});
