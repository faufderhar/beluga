import { expect, test, type Page } from './fixtures.js';

/**
 * A worktree on Antigravity: the demo's Antigravity is the real Antigravity runtime over a scripted
 * `agy acp` (src/agent/runtime/antigravity/scripted.ts: `P` → `echo: P` after running `echo P`, which
 * it asks about first; `question` asks with its own ask_question; `wait…` works until stopped).
 * Pick Antigravity on Gemini, run a task, approve its command, answer its question on the card, stop
 * it mid-turn, then see its quota on its own usage card. BELUGA_SHOTS_DIR keeps a screenshot of each
 * screen. tests/antigravity-flow.test.ts is the same flow one level down.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const chip = (page: Page) => page.getByRole('button', { name: 'Agent, model and effort' });
const shots = process.env.BELUGA_SHOTS_DIR;

test('start a worktree on Antigravity, approve a command, answer its question, stop mid-turn', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();

  // Settings › Agent lists Antigravity among your ACP agents, ready; and your agent asks before commands.
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(settings.getByTestId('settings-agent-antigravity')).toHaveCount(0);
  await expect(settings.getByTestId('acp-agent-antigravity')).toContainText('Ready', { timeout: 15_000 });
  if (shots) await page.screenshot({ path: `${shots}/antigravity-01-settings-agent.png` });
  const ask = settings.getByRole('switch', { name: 'Self approval' });
  if ((await ask.getAttribute('aria-checked')) !== 'true') await ask.click();
  await expect(ask).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // 1. A new worktree, on Antigravity's Gemini (the picker's agent rail), with its first task.
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await page.getByLabel('Worktree name').fill('e2e-antigravity');
  await chip(page).click();
  await page.getByRole('tab', { name: 'Antigravity' }).click();
  const models = page.getByRole('radiogroup', { name: 'Antigravity models' });
  await expect(models).toBeVisible({ timeout: 15_000 });
  await expect(models.getByRole('radio').first()).toContainText('Gemini 3.8 Flash');
  if (shots) await page.screenshot({ path: `${shots}/antigravity-02-agent-picker.png` });
  await models.getByRole('radio').first().click();
  await page.keyboard.press('Escape');
  await expect(chip(page)).toContainText('Antigravity');
  await composer(page).fill('run the tests');
  await page.getByRole('button', { name: /Create Worktree/ }).click();
  await expect(sidebar(page).getByRole('button', { name: 'e2e-antigravity', exact: true })).toBeVisible({ timeout: 20_000 });

  // 2. Its command asks you first; Allow runs it.
  const approval = page.getByRole('alertdialog', { name: 'Approval needed' });
  await expect(approval).toContainText('echo run the tests', { timeout: 20_000 });
  if (shots) await page.screenshot({ path: `${shots}/antigravity-03-approval.png` });
  await approval.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('echo: run the tests').last()).toBeVisible({ timeout: 20_000 });

  // 3. Its own ask_question comes to you as a card; your pick is its next turn.
  await composer(page).fill('question');
  await composer(page).press('Enter');
  const pick = page.getByRole('button', { name: /Not now/ });
  await expect(pick).toBeVisible({ timeout: 20_000 });
  // Asked by the agent at work here, not your default one.
  await expect(page.getByText('Antigravity asks')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/antigravity-04-question.png` });
  await pick.click();
  await expect(page.getByText('answered: Not now').last()).toBeVisible({ timeout: 20_000 });
  if (shots) await page.screenshot({ path: `${shots}/antigravity-05-worktree.png` });

  // 4. Stop it mid-turn: the box names the agent at work here, Antigravity.
  await expect(page.getByRole('textbox', { name: 'Tell Antigravity what to do in e2e-antigravity' })).toBeVisible();
  await composer(page).fill('wait for the build');
  await composer(page).press('Enter');
  const stop = page.getByRole('button', { name: 'Stop Antigravity' });
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await stop.click();
  await expect(stop).toHaveCount(0, { timeout: 15_000 });

  // 5. Its quota on its own card: each group of models with its 5-hour and weekly limits.
  await sidebar(page).getByRole('button', { name: 'Usage', exact: true }).click();
  const card = page.getByRole('region', { name: 'Antigravity usage' });
  await expect(card.getByText('Gemini Models')).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole('meter', { name: 'Gemini Models 5-hour: 25% used' })).toBeVisible();
  await expect(card.getByRole('meter', { name: 'Gemini Models Weekly: 8% used' })).toBeVisible();
  await expect(card.getByRole('meter', { name: 'Claude and GPT models Weekly: 0% used' })).toBeVisible();
  await expect(card.getByText('AI Ultra')).toBeVisible();
  if (shots) {
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: `${shots}/antigravity-06-usage-card.png` });
    await page.screenshot({ path: `${shots}/antigravity-07-usage.png` });
  }
});

test('its question pops up in English and in Chinese, titled for Antigravity, and your pick goes back', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  // A worktree on Antigravity whose first task is a question in Chinese.
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await page.getByLabel('Worktree name').fill('e2e-antigravity-zh');
  await chip(page).click();
  await page.getByRole('tab', { name: 'Antigravity' }).click();
  const models = page.getByRole('radiogroup', { name: 'Antigravity models' });
  await expect(models).toBeVisible({ timeout: 15_000 });
  await models.getByRole('radio').first().click();
  await page.keyboard.press('Escape');
  await composer(page).fill('question zh');
  await page.getByRole('button', { name: /Create Worktree/ }).click();

  // In English: the card pops up, titled for the agent that asks.
  const pick = page.getByRole('button', { name: /暂不/ });
  await expect(pick).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Antigravity asks')).toBeVisible();
  await expect(page.getByText('现在部署到服务器吗？')).toBeVisible();

  // In Chinese (Settings › General › Language): the same card, its title in Chinese.
  await page.evaluate(() => localStorage.setItem('beluga.language', 'zh-CN'));
  await page.reload();
  // The worktree waits for you under Unread; its name isn't translated.
  const row = page.getByRole('button', { name: /^e2e-antigravity-zh/ }).first();
  if (!(await pick.isVisible().catch(() => false))) await row.click({ timeout: 20_000 });
  await expect(pick).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Antigravity 提问')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/antigravity-08-question-zh.png` });
  await pick.click();
  await expect(page.getByText('answered: 暂不').last()).toBeVisible({ timeout: 20_000 });
});
