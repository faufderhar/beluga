import { expect, test, type Page } from './fixtures.js';

/**
 * A worktree on Codex, the whole way (BLG-462): the demo's Codex is the real Codex runtime over a
 * scripted app-server (src/agent/runtime/codex/scripted.ts: `P` → `echo: P`; `ask…` asks first;
 * `wait…` works until stopped). Start a worktree on Codex, run a task, approve a command, stop it
 * mid-turn, hand off to Claude. tests/codex-flow.test.ts is the same flow one level down.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const chip = (page: Page) => page.getByRole('button', { name: 'Agent, model and effort' });

test('start a worktree on Codex, run a task, approve a command, stop mid-turn, hand off to Claude', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();

  // Your agent asks before commands (else a command leaving Codex's sandbox just runs).
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  const ask = settings.getByRole('switch', { name: 'Self approval' });
  if ((await ask.getAttribute('aria-checked')) !== 'true') await ask.click();
  await expect(ask).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // 1. A new worktree, on Codex (the picker's agent rail), with its first task.
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await page.getByLabel('Worktree name').fill('e2e-codex');
  await chip(page).click();
  await page.getByRole('tab', { name: 'Codex' }).click();
  const codexModels = page.getByRole('radiogroup', { name: 'Codex models' });
  await expect(codexModels).toBeVisible({ timeout: 15_000 });
  await codexModels.getByRole('radio').first().click();
  await page.keyboard.press('Escape');
  await expect(chip(page)).toContainText('Codex');
  await composer(page).fill('say hello');
  await page.getByRole('button', { name: /Create Worktree/ }).click();
  await expect(sidebar(page).getByRole('button', { name: 'e2e-codex', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('echo: say hello').last()).toBeVisible({ timeout: 20_000 });

  // 2. A command that leaves its sandbox asks you; Allow runs it.
  await composer(page).fill('ask to run the tests');
  await composer(page).press('Enter');
  const approval = page.getByRole('alertdialog', { name: 'Approval needed' });
  await expect(approval).toContainText('echo ask to run the tests', { timeout: 20_000 });
  await approval.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('echo: ask to run the tests').last()).toBeVisible({ timeout: 20_000 });

  // 3. Stop it mid-turn: the box names the agent at work here, Codex (not your default).
  await expect(page.getByRole('textbox', { name: 'Tell Codex what to do in e2e-codex' })).toBeVisible();
  await composer(page).fill('wait for the build');
  await composer(page).press('Enter');
  const stop = page.getByRole('button', { name: 'Stop Codex' });
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await stop.click();
  await expect(stop).toHaveCount(0, { timeout: 15_000 });

  // 4. Hand off to Claude: the picker's Claude models; Claude can't read Codex's conversation, so it asks how (BLG-592). Just switch, then Claude answers here.
  await chip(page).click();
  await page.getByRole('tab', { name: 'Claude' }).click();
  await page.getByRole('radiogroup', { name: 'Claude models' }).getByRole('radio').first().click();
  const how = page.getByRole('group', { name: 'How to move to Claude' });
  await expect(how).toBeVisible();
  await expect(how.getByRole('button', { name: /Write a handoff note first/ })).toBeEnabled();
  if (process.env.BELUGA_SHOTS) await page.screenshot({ path: process.env.BELUGA_SHOTS });
  await how.getByRole('button', { name: /Just switch/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/Switched from Codex to Claude/).last()).toBeVisible({ timeout: 20_000 });
  await expect(chip(page)).not.toContainText('Codex', { timeout: 20_000 });
  await composer(page).fill('carry on with the build');
  await composer(page).press('Enter');
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 30_000 });
});
