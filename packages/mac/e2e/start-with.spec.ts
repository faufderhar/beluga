import { expect, test, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/**
 * Start with any agent (BLG-506): wherever work starts, one main button does it with the usual
 * agent and a small ▾ beside it offers every agent and model ("Start with Codex"), each with its
 * mark. The demo's Codex is the real Codex runtime over a scripted app-server (`P` → `echo: P`).
 * Screenshots go to $BELUGA_SHOTS_DIR when it's set.
 */

const shots = process.env.BELUGA_SHOTS_DIR;
const shot = async (page: Page, name: string): Promise<void> => {
  if (!shots) return;
  await page.waitForTimeout(300); // a menu's appear animation done
  await page.screenshot({ path: `${shots}/${name}.png` });
};
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');
const chip = (page: Page) => page.getByRole('button', { name: 'Agent, model and effort' });
const menu = (page: Page) => page.getByRole('menu').last();

test.describe.configure({ mode: 'serial' });

async function openTasks(page: Page): Promise<void> {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await openWork(page, 'Tasks');
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();
}

test('a task’s Start ▾ starts it with Codex; its card offers Start with ▸', async ({ page }) => {
  test.setTimeout(120_000);
  await openTasks(page);
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New Task' });
  await sheet.getByRole('button', { name: 'Write title and goal myself' }).click();
  await sheet.getByLabel('Title').fill('Say hello from Codex');
  await sheet.getByLabel('Goal').fill('A friendly hello.');
  await sheet.getByRole('button', { name: 'Create Task' }).click();
  await expect(sheet).toBeHidden();
  const row = page.getByRole('row', { name: /Say hello from Codex, Ready/ });
  await expect(row).toBeVisible();

  // Right-click: Start (its usual agent), and Start with ▸ every agent and model.
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Start with', exact: true }).hover();
  await expect(menu(page).getByRole('menuitem', { name: 'Codex', exact: true })).toBeVisible();
  await expect(menu(page).getByRole('menuitem', { name: /^Your agent/ })).toBeVisible();
  await shot(page, '01-task-card-start-with');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Its page: Start, and the ▾ beside it.
  await row.click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Say hello from Codex');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await shot(page, '02-task-page-start-split');
  await page.getByRole('button', { name: 'Start with another agent' }).click();
  const codex = menu(page).getByRole('menuitem', { name: 'Start with Codex', exact: true });
  await expect(codex).toBeVisible();
  // The default (your agent) is the checked one.
  await expect(menu(page).getByRole('menuitem', { name: /^Start with your agent/ })).toHaveAttribute('data-checked', 'true');
  await shot(page, '03-task-page-start-with-menu');
  await codex.click();

  // A new worktree for it, run by Codex.
  await expect(chip(page)).toContainText('Codex', { timeout: 30_000 });
  await expect(page.getByText(/^echo: /).last()).toBeVisible({ timeout: 30_000 });
  await shot(page, '04-task-started-on-codex');
});

test('the home composer’s Create Worktree ▾ makes the worktree with Codex', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'What do you want to do in bob-api?' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Task for the new worktree' }).fill('say hello from the home');
  await page.getByRole('textbox', { name: 'Worktree name' }).fill('e2e-start-with');
  await page.getByRole('button', { name: 'Create with another agent' }).click();
  await expect(menu(page).getByRole('menuitem', { name: 'Start with Codex', exact: true })).toBeVisible();
  await shot(page, '05-home-create-worktree-start-with');
  await menu(page).getByRole('menuitem', { name: 'Start with Codex', exact: true }).click();
  await expect(sidebar(page).getByRole('button', { name: 'e2e-start-with', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(chip(page)).toContainText('Codex', { timeout: 20_000 });
  await expect(page.getByText('echo: say hello from the home').last()).toBeVisible({ timeout: 30_000 });
  await shot(page, '06-home-worktree-on-codex');
});

test('a draft plan’s Approve ▾: approve it, worked by Codex; then Start ▾', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await openWork(page, 'Plans');
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await page.getByRole('button', { name: 'New Plan', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: /^Plan in / });
  await sheet.getByLabel('Goal').fill('Export orders as CSV for accounting');
  await sheet.getByRole('radiogroup', { name: 'How it runs' }).getByRole('radio', { name: /Step by Step/ }).click();
  await sheet.getByRole('button', { name: 'Plan with Your Agent' }).click();
  await expect(page.getByRole('button', { name: 'Approve Plan' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(main(page).locator('[data-ready]')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });

  await page.getByRole('button', { name: 'More ways to approve' }).first().click();
  const byCodex = menu(page).getByRole('menuitem', { name: 'Approve, worked by Codex', exact: true });
  await expect(byCodex).toBeVisible();
  await shot(page, '07-plan-approve-worked-by');
  await byCodex.click();
  await expect(page.getByRole('button', { name: 'Approve Plan' })).toHaveCount(0, { timeout: 20_000 });

  // Its agent is Codex now (⋯ › Agent for Its Work), and Start's ▾ has it checked.
  await page.getByRole('button', { name: 'Plan Options' }).click();
  await page.getByRole('menuitem', { name: 'Agent for Its Work' }).hover();
  await expect(menu(page).getByRole('menuitem', { name: 'Codex', exact: true })).toHaveAttribute('data-checked', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const startWith = page.getByRole('button', { name: 'Start with another agent' }).first();
  await expect(startWith).toBeVisible({ timeout: 20_000 });
  await startWith.click();
  await expect(menu(page).getByRole('menuitem', { name: 'Start with Codex', exact: true })).toHaveAttribute('data-checked', 'true');
  await shot(page, '08-plan-start-with');
  await page.keyboard.press('Escape');
});
