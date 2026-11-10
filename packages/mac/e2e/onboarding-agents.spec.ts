import { expect, test } from './fixtures.js';

/**
 * Onboarding finds your agents (BLG-507): right after the welcome, every agent Beluga can run with
 * where it stands here (the demo: Claude and its scripted Codex and OpenCode ready, no local endpoint), the first
 * ready one already yours, another a click away, Check Again, and Set Up… opening Settings › Agent
 * over the welcome, where the same rows show.
 */

test.use({ storageState: { cookies: [], origins: [] } });
const shots = process.env.BELUGA_SHOTS_DIR;

test('the welcome finds your agents, picks the first ready one, and lets you pick another', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await expect(welcome).toBeVisible();
  await expect(welcome.getByText('Claude Code, Codex, OpenCode, Grok Build or a model of your own')).toBeVisible();
  await expect(welcome.getByText('starting with Claude')).toHaveCount(0);
  if (shots) {
    // Once the welcome has drawn itself in (about three seconds).
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${shots}/01-hello.png` });
  }
  await welcome.getByRole('button', { name: /Get Started/ }).click();

  await expect(welcome.getByRole('heading', { name: 'Which agent is yours?' })).toBeVisible();
  const yours = welcome.getByRole('radiogroup', { name: 'Your agent' });
  await expect(welcome.getByTestId('agent-state-claude')).toHaveText('Ready');
  await expect(welcome.getByTestId('agent-state-codex')).toHaveText('Ready', { timeout: 15_000 });
  await expect(welcome.getByTestId('agent-state-opencode')).toHaveText('Ready', { timeout: 15_000 });
  await expect(welcome.getByTestId('agent-state-local')).toHaveText('No endpoint');
  await expect(welcome.getByText('Change it any time in Settings › Agent.')).toBeVisible();
  // The first ready one is yours already; a local model with no endpoint can't be picked.
  await expect(yours.getByRole('radio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'true');
  await expect(yours.getByRole('radio', { name: 'Local model' })).toBeDisabled();
  await expect(welcome.getByRole('button', { name: 'Set Up…' })).toBeVisible();
  await page.waitForTimeout(900);
  if (shots) await page.screenshot({ path: `${shots}/02-your-agents.png` });

  // Another one is a click away, and it's your agent at once.
  await yours.getByRole('radio', { name: 'Codex' }).click();
  // (It's checked only once the daemon's prefs say so: the radio follows your setting.)
  await expect(yours.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');
  await expect(yours.getByRole('radio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'false');
  if (shots) await page.screenshot({ path: `${shots}/03-codex-picked.png` });

  // Check Again asks them all again.
  await welcome.getByRole('button', { name: 'Check Again' }).click();
  await expect(welcome.getByRole('button', { name: 'Check Again' })).toBeEnabled({ timeout: 15_000 });
  await expect(yours.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');

  // Set Up… opens Settings › Agent over the welcome, with the same rows and the local models.
  await welcome.getByRole('button', { name: 'Set Up…' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Your agents' })).toBeVisible();
  await expect(settings.getByTestId('settings-agent-codex')).toContainText('yours');
  await expect(settings.getByTestId('settings-agent-local')).toContainText('No endpoint');
  await expect(settings.getByText('Run on your own models')).toBeInViewport();
  if (shots) await page.screenshot({ path: `${shots}/04-settings-over-welcome.png` });
  await settings.getByRole('heading', { name: 'Your agents' }).scrollIntoViewIfNeeded();
  if (shots) await page.screenshot({ path: `${shots}/05-settings-your-agents.png` });
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  // Back on the welcome: Continue goes on to the tour.
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(welcome.getByRole('heading', { name: 'Work on everything at once.' })).toBeVisible();
});
