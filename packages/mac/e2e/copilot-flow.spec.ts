import { expect, test, type Page } from './fixtures.js';

/**
 * A worktree on GitHub Copilot (BLG-873): the demo's Copilot is the real Copilot runtime over a
 * scripted `copilot --acp` (src/agent/runtime/copilot/scripted.ts: `P` → `echo: P`, run without
 * asking as Copilot runs a read-only command; `ask…` asks first; `wait…` works until stopped).
 * Pick Copilot on Auto, run a task, approve a command, stop it mid-turn. BELUGA_SHOTS_DIR keeps
 * a screenshot of each screen. tests/copilot-flow.test.ts is the same flow one level down.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const chip = (page: Page) => page.getByRole('button', { name: 'Agent, model and effort' });
const shots = process.env.BELUGA_SHOTS_DIR;

test('start a worktree on Copilot, run a task, approve a command, stop mid-turn', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();

  // Settings › Agent lists Copilot, ready; and your agent asks before commands.
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(settings.getByTestId('settings-agent-copilot')).toContainText('Ready', { timeout: 15_000 });
  if (shots) await page.screenshot({ path: `${shots}/copilot-01-settings-agent.png` });
  const ask = settings.getByRole('switch', { name: 'Self approval' });
  if ((await ask.getAttribute('aria-checked')) !== 'true') await ask.click();
  await expect(ask).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // 1. A new worktree, on Copilot's Auto (the picker's agent rail), with its first task.
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await page.getByLabel('Worktree name').fill('e2e-copilot');
  await chip(page).click();
  await page.getByRole('tab', { name: 'Copilot' }).click();
  const models = page.getByRole('radiogroup', { name: 'Copilot models' });
  await expect(models).toBeVisible({ timeout: 15_000 });
  await expect(models.getByRole('radio').first()).toContainText('Auto');
  if (shots) await page.screenshot({ path: `${shots}/copilot-02-agent-picker.png` });
  await models.getByRole('radio').first().click();
  await page.keyboard.press('Escape');
  await expect(chip(page)).toContainText('Copilot');
  await composer(page).fill('say hello');
  await page.getByRole('button', { name: /Create Worktree/ }).click();
  await expect(sidebar(page).getByRole('button', { name: 'e2e-copilot', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('echo: say hello').last()).toBeVisible({ timeout: 20_000 });

  // 2. A command that changes things asks you; Allow runs it.
  await composer(page).fill('ask to run the tests');
  await composer(page).press('Enter');
  const approval = page.getByRole('alertdialog', { name: 'Approval needed' });
  await expect(approval).toContainText('echo ask to run the tests', { timeout: 20_000 });
  if (shots) await page.screenshot({ path: `${shots}/copilot-03-approval.png` });
  await approval.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('echo: ask to run the tests').last()).toBeVisible({ timeout: 20_000 });
  if (shots) await page.screenshot({ path: `${shots}/copilot-04-worktree.png` });

  // 3. Stop it mid-turn: the box names the agent at work here, Copilot.
  await expect(page.getByRole('textbox', { name: 'Tell Copilot what to do in e2e-copilot' })).toBeVisible();
  await composer(page).fill('wait for the build');
  await composer(page).press('Enter');
  const stop = page.getByRole('button', { name: 'Stop Copilot' });
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await stop.click();
  await expect(stop).toHaveCount(0, { timeout: 15_000 });
});
