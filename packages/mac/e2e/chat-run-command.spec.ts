import { expect, test, type Page } from './fixtures.js';
import { termText } from './helpers.js';

/**
 * Run on a shell code block in the chat (BLG-968): the terminal opens where ⌘J keeps it (the
 * right panel, or the bottom drawer) and the command runs in its shell, there to watch.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const shot = (name: string): string => `../../.beluga/scratch/${name}.png`;

async function openWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
}

async function sendBlock(page: Page, lang: string, body: string): Promise<void> {
  await composer(page).fill(`Try this:\n\n\`\`\`${lang}\n${body}\n\`\`\``);
  await composer(page).press('Enter');
}

test('Claude says to paste a command in your terminal: Run on its block runs it there instead', async ({ page }) => {
  await openWorkspace(page);
  await composer(page).fill('How do I check my Node version?');
  await composer(page).press('Enter');
  // Claude's answer (the demo's): "Paste this in your terminal…" and a bash block.
  await expect(page.getByText('Paste this in your terminal')).toBeVisible({ timeout: 20_000 });
  const block = page.locator('pre', { hasText: 'node --version' }).last().locator('..');
  await block.hover({ position: { x: 8, y: 8 } });
  const run = block.locator('..').getByRole('button', { name: 'Run in the terminal' }).last();
  await expect(run).toBeVisible();
  await run.hover();
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot('04-run-on-claudes-answer') });
  await run.click();
  const term = page.getByRole('complementary', { name: 'Panel' }).getByRole('region', { name: 'Terminal' });
  await expect(term).toBeVisible();
  await expect.poll(() => termText(term), { timeout: 15_000 }).toMatch(/v\d+\.\d+\.\d+/);
  await page.screenshot({ path: shot('05-ran-claudes-command') });
});

test('Run on a shell block opens the terminal in the right panel and runs it there', async ({ page }) => {
  await openWorkspace(page);
  await sendBlock(page, 'bash', '# a note, left out\necho run-$((6*7))');
  const block = page.locator('pre', { hasText: 'echo run-' }).last().locator('..');
  await block.hover({ position: { x: 8, y: 8 } });
  const run = block.locator('..').getByRole('button', { name: 'Run in the terminal' }).last();
  await expect(run).toBeVisible();
  await run.hover();
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot('01-run-button') });
  await run.click();
  const term = page.getByRole('complementary', { name: 'Panel' }).getByRole('region', { name: 'Terminal' });
  await expect(term).toBeVisible();
  await expect.poll(() => termText(term), { timeout: 15_000 }).toContain('run-42');
  // The keyboard goes to the terminal: to answer what the command asks, or stop it.
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await page.screenshot({ path: shot('02-ran-in-panel') });

  // Already open: the next Run types into the same terminal.
  await sendBlock(page, 'sh', '$ echo again-$((7*6))');
  const again = page.locator('pre', { hasText: 'echo again-' }).last().locator('..');
  await again.hover({ position: { x: 8, y: 8 } });
  await again.locator('..').getByRole('button', { name: 'Run in the terminal' }).last().click();
  await expect.poll(() => termText(term), { timeout: 15_000 }).toContain('again-42');
});

test('Run uses the terminal under the chat when that is where it lives, and only runs the commands of a session', async ({ page }) => {
  await openWorkspace(page);
  // Keep the terminal under the chat (its ••• menu).
  await page.keyboard.press('Meta+J');
  const inPanel = page.getByRole('complementary', { name: 'Panel' }).getByRole('region', { name: 'Terminal' });
  await expect(inPanel).toBeVisible();
  await inPanel.getByRole('button', { name: 'Terminal options' }).click();
  await page.getByRole('menuitem', { name: 'Move Under the Chat' }).click();
  await page.getByRole('button', { name: 'Put the terminal away' }).click();
  await expect(page.getByRole('button', { name: 'Put the terminal away' })).toBeHidden();

  await sendBlock(page, 'console', '$ echo drawer-$((6*7))\nthis line is output, never run');
  const block = page.locator('[data-block="terminal"]').last();
  await block.hover({ position: { x: 8, y: 8 } });
  await block.getByRole('button', { name: 'Run in the terminal' }).click();
  // Under the chat (the center's dock), where it lives now.
  const drawer = page.getByRole('main').getByRole('region', { name: 'Terminal' }).filter({ has: page.getByRole('button', { name: 'Put the terminal away' }) });
  await expect(drawer).toBeVisible();
  await expect.poll(() => termText(drawer), { timeout: 15_000 }).toContain('drawer-42');
  expect(await termText(drawer)).not.toContain('command not found: this');
  await page.screenshot({ path: shot('03-ran-in-drawer') });
});

test('code that is not a shell has no Run', async ({ page }) => {
  await openWorkspace(page);
  await sendBlock(page, 'ts', 'const answer = 6 * 7;');
  const block = page.locator('pre', { hasText: 'const answer' }).last().locator('..');
  await block.hover({ position: { x: 8, y: 8 } });
  await expect(block.locator('..').getByRole('button', { name: 'Copy code' }).last()).toBeVisible();
  await expect(block.locator('..').getByRole('button', { name: 'Run in the terminal' })).toHaveCount(0);
});
