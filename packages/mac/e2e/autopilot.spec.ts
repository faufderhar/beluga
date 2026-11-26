import { expect, test, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/**
 * Full Autopilot (BLG-981) and who plans, builds and checks a plan (BLG-982). In a chat, the mode
 * menu turns on Full Autopilot and the demo's stand-in (src/agent/mock.ts) approves the plan Plan
 * First proposes, saying so in the chat. New Plan says its agents as one sentence, split by Mix
 * Agents, and Autopilot's "Never wait for me" is Full Autopilot. Screenshots, light and dark, go to
 * .beluga/scratch/autopilot/.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();
const menu = (page: Page) => page.getByRole('menu').last();
const shot = (name: string): string => `../../.beluga/scratch/autopilot/${name}`;

async function both(page: Page, name: string, target: () => ReturnType<Page['locator']>): Promise<void> {
  await page.waitForTimeout(300);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await target().screenshot({ path: shot(`${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('a chat on Full Autopilot: the stand-in approves the plan and says why; one click turns it off', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await composer(page).press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Mode: Plan First' })).toBeVisible();

  // The mode menu has it, under the modes, as a switch (BLG-1023): it flips in place and the menu stays open.
  await page.getByRole('button', { name: 'Mode: Plan First' }).click();
  const item = menu(page).getByRole('menuitemcheckbox', { name: /Full Autopilot/ });
  await expect(item).toHaveAttribute('aria-checked', 'false');
  await both(page, '01-mode-menu', () => page.locator('main'));
  await item.click();
  await expect(item).toHaveAttribute('aria-checked', 'true');
  await both(page, '01b-switch-on', () => page.locator('main'));
  await page.keyboard.press('Escape');
  const chip = page.getByRole('button', { name: 'Turn off Full Autopilot' });
  await expect(chip).toBeVisible();

  await composer(page).fill('Add login to the API');
  await composer(page).press('Enter');
  // Nobody clicks Approve: the stand-in does, and the chat says what it chose and why.
  await expect(page.getByText(/Autopilot approved the plan for you\. Why:/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Approve plan' })).toHaveCount(0);
  await expect(page.getByText(/27 tests/)).toBeVisible({ timeout: 30_000 });
  await both(page, '02-chat-answered', () => page.locator('main'));

  // Off again: what the agent asks next waits for you.
  await chip.click();
  await expect(chip).toHaveCount(0);
  await page.getByRole('button', { name: /^Mode: / }).click();
  await expect(menu(page).getByRole('menuitemcheckbox', { name: /Full Autopilot/ })).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
});

test('New Plan: one sentence for its agents, Mix Agents for one per part, and Never wait for me on Autopilot', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await openWork(page, 'Plans');
  await page.getByRole('button', { name: 'New Plan', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: /^Plan in / });
  await sheet.getByLabel('Goal').fill('Export orders as CSV for accounting');

  // One agent for everything, said as a sentence.
  const agents = sheet.getByRole('group', { name: 'Agents' });
  await expect(agents).toContainText('Planned, built and checked by');
  await expect(agents.getByRole('combobox')).toHaveCount(1);
  await expect(sheet.getByRole('checkbox', { name: /Never wait for me/ })).toHaveCount(0);

  // Mix Agents: a picker per part; One Agent joins them again.
  await agents.getByRole('button', { name: 'Mix Agents' }).click();
  await expect(agents.getByRole('combobox')).toHaveCount(3);
  for (const part of ['Planner', 'Builder', 'Checker']) await expect(agents.getByRole('combobox', { name: part })).toBeVisible();
  await expect(agents).toContainText('and checked by');

  // Autopilot, all the way.
  await sheet.getByRole('radiogroup', { name: 'How it runs' }).getByRole('radio', { name: /^Autopilot/ }).click();
  const never = sheet.getByRole('checkbox', { name: /Never wait for me/ });
  await expect(never).toBeVisible();
  await never.check();
  await both(page, '03-new-plan', () => sheet);
  await agents.getByRole('button', { name: 'One Agent' }).click();
  await expect(agents.getByRole('combobox')).toHaveCount(1);

  await sheet.getByRole('button', { name: 'Plan with Your Agent' }).click();
  // Its page says it runs on Full Autopilot, and who plays each part.
  await expect(page.getByRole('button', { name: 'Runs on Full Autopilot' })).toBeVisible({ timeout: 60_000 });
  const agentsButton = page.getByRole('button', { name: /^Agents: Planner: .* · Builder: .* · Checker: / });
  await expect(agentsButton).toBeVisible();
  await agentsButton.click();
  for (const part of ['Planner', 'Builder', 'Checker']) await expect(menu(page).getByRole('menuitem', { name: new RegExp(`^${part}: `) })).toBeVisible();
  await both(page, '04-plan-agents-menu', () => page.locator('main'));
  await page.keyboard.press('Escape');
  // The draft was approved by the stand-in once it settled (the header's mode shows once it's approved).
  await expect(page.getByText(/Autopilot approved “.+” for you\. Why:/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Approve Plan' })).toHaveCount(0, { timeout: 20_000 });
  await both(page, '05-plan-approved', () => page.locator('main'));
});

test('Plan First, built by Codex: picked from the mode menu, Claude plans and Codex takes over once you approve', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  // Act has no Builder: it's for planning.
  await page.getByRole('button', { name: /^Mode: / }).click();
  await expect(menu(page).getByRole('menuitem', { name: /^Builder/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await composer(page).press('Shift+Tab');
  await page.getByRole('button', { name: 'Mode: Plan First' }).click();
  await menu(page).getByRole('menuitem', { name: /^Builder: Same Agent/ }).hover();
  await both(page, '06-build-with-menu', () => page.locator('main'));
  // The pick shows where it was made (BLG-1023): the menu stays open and the row says who builds.
  await page.getByRole('menuitem', { name: 'Codex', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^Builder: Codex/ })).toBeVisible();
  await both(page, '06b-builder-picked', () => page.locator('main'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // Closed, a chip beside the mode says it, and the banner too.
  await expect(page.getByRole('button', { name: /^Built by Codex/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'then Codex builds it' })).toBeVisible();

  await composer(page).fill('Add login to the API');
  await composer(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Approve plan' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('then Codex builds it, or type what to change below')).toBeVisible();
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await expect(page.getByText('Claude planned it; Codex builds it now.')).toBeVisible({ timeout: 30_000 });
  // The conversation is Codex's now, and Codex answers (the demo's Codex echoes the plan's last line).
  await expect(page.getByRole('button', { name: 'Agent, model and effort' })).toContainText('Codex');
  await expect(page.getByText(/^echo: /).last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/plan is handed over/).first()).toBeVisible();
  await both(page, '07-codex-builds', () => page.locator('main'));
});
