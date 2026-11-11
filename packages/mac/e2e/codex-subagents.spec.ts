import { expect, test, type Page } from './fixtures.js';

/**
 * Codex's own sub-agents (BLG-519) on the demo's Codex (the real runtime over the scripted
 * app-server, src/agent/runtime/codex/scripted.ts): `spawn…` starts two sub-agents, Darwin and
 * Noether. Each shows as a sub-agent row on the card, as Claude's do, with its name, role and
 * prompt, its own steps when opened, and a check once it's back; `…hold…` keeps them working
 * until Stop, which stops them too. Screenshots go to $BELUGA_SHOTS_DIR when it's set.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const chip = (page: Page) => page.getByRole('button', { name: 'Agent, model and effort' });
const shots = process.env.BELUGA_SHOTS_DIR;

test('Codex sub-agents show as rows with their steps and report, and Stop stops them', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();

  // A worktree on Codex whose first task spawns two sub-agents.
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await page.getByLabel('Worktree name').fill('e2e-codex-subs');
  await chip(page).click();
  await page.getByRole('tab', { name: 'Codex' }).click();
  const codexModels = page.getByRole('radiogroup', { name: 'Codex models' });
  await expect(codexModels).toBeVisible({ timeout: 15_000 });
  await codexModels.getByRole('radio').first().click();
  await page.keyboard.press('Escape');
  await expect(chip(page)).toContainText('Codex');
  await composer(page).fill('spawn two helpers');
  await page.getByRole('button', { name: /Create Worktree/ }).click();
  await expect(sidebar(page).getByRole('button', { name: 'e2e-codex-subs', exact: true })).toBeVisible({ timeout: 20_000 });

  // 1. Two rows, each named for its sub-agent and what it was asked.
  const rows = page.locator('[data-subagent]');
  const darwin = rows.filter({ hasText: 'Darwin (explorer) · Find the tests that cover the login flow' });
  const noether = rows.filter({ hasText: 'Noether (worker) · Check the docs mention the --remember flag' });
  await expect(darwin).toBeVisible({ timeout: 20_000 });
  await expect(noether).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/01-codex-subagents-working.png` });

  // Back with their reports: the lead answers and its steps fold away; Show Steps has both rows
  // checked off, their steps counted.
  await expect(page.getByText('echo: spawn two helpers').last()).toBeVisible({ timeout: 20_000 });
  const card = page.locator('[data-turn="done"]').last();
  await expect(card).toContainText('echo: spawn two helpers', { timeout: 15_000 });
  await card.hover();
  await card.getByRole('button', { name: 'Show Steps' }).click();
  await expect(darwin).toBeVisible();
  await expect(darwin).not.toHaveAttribute('data-running');
  await expect(noether).not.toHaveAttribute('data-running');
  await expect(darwin).toContainText('2 steps');
  await expect(noether).toContainText('1 steps');
  if (shots) await page.screenshot({ path: `${shots}/02-codex-subagents-done.png` });

  // 2. Opened, a row shows the sub-agent's own steps (what it ran).
  await darwin.getByRole('button').first().click();
  await expect(darwin).toContainText(/ls tests/);
  await expect(darwin).toContainText(/rg -n login tests/);
  if (shots) await darwin.screenshot({ path: `${shots}/03-codex-subagent-steps.png` });

  // 3. Sub-agents that keep working until stopped: Stop stops the run and them, each marked stopped.
  await composer(page).fill('spawn and hold');
  await composer(page).press('Enter');
  const held = page.locator('[data-subagent][data-running]');
  await expect(held).toHaveCount(2, { timeout: 20_000 });
  if (shots) await page.screenshot({ path: `${shots}/04-codex-subagents-holding.png` });
  const stop = page.getByRole('button', { name: 'Stop Codex' });
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await stop.click();
  await expect(stop).toHaveCount(0, { timeout: 20_000 });
  await expect(held).toHaveCount(0, { timeout: 15_000 });
  if (shots) await page.screenshot({ path: `${shots}/05-codex-subagents-stopped.png` });
});
