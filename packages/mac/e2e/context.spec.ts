import { expect, test, type Page } from './fixtures.js';

/**
 * The context meter beside the send button, Compact now, auto-compact when a conversation is
 * nearly full, and the divider each compaction leaves in the chat (the messages all stay; the
 * divider opens to show what Claude kept). The demo seeds each conversation's fill level and its
 * Claude fills the window as it works (src/demo.ts, src/agent/mock-context.ts).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const meter = (page: Page) => page.locator('[data-context-meter]');
const popover = (page: Page) => page.getByRole('dialog', { name: 'Context window' });
const dividers = (page: Page) => page.locator('[data-compact-divider]');

/** The fill percentage is the meter's first number. A cache rate may follow it ("48% · Cache 82%"). */
const fillPct = (text: string | null): number => Number(text?.match(/(\d+)%/)?.[1]);

async function open(page: Page, name: string, project = 'bob-api'): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: project }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('the meter shows how full the conversation is, with the details on hover', async ({ page }) => {
  await open(page, 'add-auth');
  await expect(meter(page)).toHaveText(/^\d+%\s*·\s*Cache \d+%$/);
  await expect(meter(page).locator('[data-cache-hit]')).toHaveAttribute('title', /Fresh .+ · cache read .+ · cache write/);
  await expect(meter(page)).toHaveAttribute('data-context-meter', 'normal');
  const pct = fillPct(await meter(page).textContent());
  expect(pct).toBeGreaterThan(0);
  await meter(page).hover();
  await expect(popover(page)).toBeVisible();
  await expect(popover(page).locator('[data-context-usage]')).toContainText(`${pct}% of 200k`);
  await expect(popover(page).locator('dd[data-cache-hit]')).toHaveText(/^\d+%$/);
  await expect(popover(page)).toContainText('Model window');
  await expect(popover(page)).toContainText('Auto-compact');
  await expect(popover(page).getByRole('button', { name: /Compact/ })).toBeEnabled();
  // Getting full: amber, and the toolbar says so quietly.
  await page.mouse.move(0, 0);
  await open(page, 'webhook-retries');
  await expect(meter(page)).toHaveAttribute('data-context-meter', /warn|full/);
  await expect(page.locator('header').getByText(/\d+% context/)).toBeVisible();
});

/** Auto-compact is off by default (Claude 5 has a 1M window); Settings › Claude turns it on or off. */
async function setAutoCompact(page: Page, on: boolean): Promise<void> {
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  const auto = settings.getByRole('switch', { name: 'Auto-compact' });
  if ((await auto.getAttribute('aria-checked')) !== String(on)) await auto.click();
  await expect(auto).toHaveAttribute('aria-checked', String(on));
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
}

test('a conversation past the threshold compacts on its own after Claude answers', async ({ page }) => {
  await setAutoCompact(page, true);
  await open(page, 'How do deploys work?');
  const before = fillPct(await meter(page).textContent());
  expect(before).toBeGreaterThanOrEqual(80);
  await composer(page).fill('how do the deploy scripts work?');
  await composer(page).press('Enter');
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 30_000 });
  const divider = dividers(page).filter({ hasText: /compact/i }).last();
  await expect(divider).toHaveAttribute('data-compact-divider', 'done', { timeout: 15_000 });
  await expect(divider).toContainText(/Auto-compacted · \d+k → \d+k tokens/);
  // Claude's working memory is small again; the conversation is all still there.
  await expect.poll(async () => fillPct(await meter(page).textContent())).toBeLessThan(30);
  await expect(page.getByText('how do the deploy scripts work?')).toBeVisible();
  await setAutoCompact(page, false);
});

test('Compact now leaves a divider that opens to show what Claude kept', async ({ page }) => {
  await open(page, 'How do deploys work?');
  await meter(page).click();
  await popover(page).getByRole('button', { name: 'Compact Now' }).click();
  // Compacting shows in the meter, then the divider lands (a manual one says "Context compacted").
  const divider = dividers(page).filter({ hasText: 'Context compacted' }).last();
  await expect(divider).toHaveAttribute('data-compact-divider', 'done', { timeout: 15_000 });
  await expect(divider).toContainText(/Context compacted · \d+k → \d+k tokens · \d{1,2}:\d{2}/);
  const already = (await dividers(page).count()) - 1;
  const toggle = divider.getByRole('button');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(divider.getByText('What your agent kept')).toBeVisible();
  await expect(divider.getByText('Open tasks')).toBeVisible();
  await expect(divider.getByText(/requireUser\(\)/).first()).toBeVisible();
  // Each divider opens on its own, and closes again.
  if (already) await expect(dividers(page).first().getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(divider.getByText('What your agent kept')).toHaveCount(0);
});

test('Settings › Claude has auto-compact with its threshold', async ({ page }) => {
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  const auto = settings.getByRole('switch', { name: 'Auto-compact' });
  // Off by default: Claude 5 models have a 1M context window.
  await expect(auto).toHaveAttribute('aria-checked', 'false');
  const slider = settings.getByRole('slider', { name: 'Compact at' });
  await expect(slider).toHaveValue('85');
  await expect(slider).toBeDisabled();
  await auto.click();
  await expect(slider).toBeEnabled();
  await expect(settings.getByText('When a conversation is 85% full')).toBeVisible();
  await auto.click();
  await expect(slider).toBeDisabled();
});
