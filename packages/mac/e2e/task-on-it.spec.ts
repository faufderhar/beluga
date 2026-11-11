import { expect, test, type Page } from './fixtures.js';

/** Who's on a task now shows under its card, apart from who it's for (BLG-278). */

const SHOT = process.env.TASK_ON_IT_SHOT;
// Pictures for the task, sharp.
test.use(SHOT ? { deviceScaleFactor: 2 } : {});
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

async function openBoard(page: Page) {
  // Tasks lives under Work (BLG-197).
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Tasks' }).click();
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();
  const board = page.getByRole('list', { name: 'Board' });
  await expect(board).toBeVisible();
  // The demo's task is a sub-task, tucked under its epic until opened out (exactly: the sidebar's Sentinel has a "Show all 10…").
  const showAll = page.getByRole('button', { name: 'Show All', exact: true });
  if (await showAll.isVisible()) await showAll.click();
  return board.getByRole('listitem', { name: /^In Progress/ });
}

test('a card says who is on it, and moves while their Claude works', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  let column = await openBoard(page);
  // The demo's worktree does it: you're on it, under the card.
  const card = () => column.getByRole('button', { name: /Idempotent webhook retries/ });
  await expect(card()).toContainText(/You · on it/);
  if (SHOT) {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    await column.screenshot({ path: `${SHOT}-idle.png` });
  }
  // Claude at work in its worktree: the card says so while it runs.
  await card().click();
  await page.getByRole('button', { name: 'Open Worktree' }).first().click();
  // The worktree's own box (the task page may still be on screen beside it, with its title and comment boxes).
  const composer = page.getByRole('textbox', { name: /^Tell Claude what to do in / });
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toHaveCount(0, { timeout: 90_000 });
  await composer.fill('run the full test suite');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toBeVisible({ timeout: 10_000 });
  if (SHOT) await page.screenshot({ path: `${SHOT}-conv.png` });
  column = await openBoard(page);
  await expect(card()).toContainText(/You · working/, { timeout: 15_000 });
  if (SHOT) {
    await page.mouse.move(0, 0);
    // Frames of the card for a GIF (the ring turning, the line moving).
    for (let i = 0; i < 24; i++) {
      await card().screenshot({ path: `${SHOT}-live-${String(i).padStart(2, '0')}.png`, animations: 'allow' });
      await page.waitForTimeout(60);
    }
  }
});
