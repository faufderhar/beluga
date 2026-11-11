import { expect, test, type Page } from './fixtures.js';

/**
 * Codex's own MCP servers in Settings › Agent (BLG-518). The demo's Codex is the real Codex runtime
 * over a scripted app-server (src/agent/runtime/codex/scripted.ts) with a server of each kind:
 * figma waiting for a sign-in, github working, sentry that won't start, and a plugin's (linear).
 * With Claude and Codex both set up, the MCP group has a tab for each, yours first.
 * Screenshots go to $BELUGA_SHOTS_DIR when it's set.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shots = process.env.BELUGA_SHOTS_DIR;
/** The MCP group at the top of the pane, so a screenshot shows its rows. */
const toMcp = (page: Page) => page.getByRole('dialog').getByRole('heading', { name: 'MCP servers' }).evaluate((h) => h.scrollIntoView({ block: 'start' }));

test('Settings › Agent lists Codex’s MCP servers, turns one off and signs in to one', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();

  // Both agents set up: a tab each, yours (Claude, the demo's default) first.
  const tabs = settings.getByRole('tablist', { name: 'Whose MCP servers' });
  await expect(tabs.getByRole('tab', { name: 'Claude · yours' })).toHaveAttribute('aria-selected', 'true');
  await expect(settings.getByText('Servers your Claude uses')).toBeVisible();
  await toMcp(page);
  if (shots) await settings.screenshot({ path: `${shots}/01-mcp-claude-tab.png` });

  // Codex's: from its own config.toml, with how each is and its tools.
  await tabs.getByRole('tab', { name: 'Codex' }).click();
  await expect(settings.getByText('Servers your Codex uses')).toBeVisible();
  await expect(settings.getByText('Yours, in every project · Connected · 3 tools')).toBeVisible({ timeout: 15_000 });
  await expect(settings.getByText('From the linear plugin · Connected · 1 tool')).toBeVisible();
  await expect(settings.getByText('Yours, in every project · Couldn’t connect: No such file or directory (os error 2)')).toBeVisible();
  await expect(settings.getByText('Yours, in every project · Needs you to sign in')).toBeVisible();
  // No "Codex reads its own settings" fallback any more.
  await expect(settings.getByText('This list is Claude Code’s')).toHaveCount(0);
  await toMcp(page);
  if (shots) await settings.screenshot({ path: `${shots}/02-mcp-codex-tab.png` });

  // Turn github off (written to config.toml), then back on.
  const github = settings.getByRole('switch', { name: 'github on' });
  await expect(github).toHaveAttribute('aria-checked', 'true');
  await github.click();
  await expect(github).toHaveAttribute('aria-checked', 'false');
  await expect(settings.getByText('Yours, in every project · Turned off')).toBeVisible({ timeout: 15_000 });
  await toMcp(page);
  if (shots) await settings.screenshot({ path: `${shots}/03-mcp-codex-turned-off.png` });
  await github.click();
  await expect(settings.getByText('Yours, in every project · Connected · 3 tools')).toBeVisible({ timeout: 15_000 });

  // Sign in to figma: Codex's page opens in your browser, and the row waits until Codex says it's done.
  const signIn = settings.getByRole('button', { name: 'Sign In…' });
  await expect(signIn).toHaveCount(1);
  const tab = page.context().waitForEvent('page');
  await signIn.click();
  // The toast first: it's up for a few seconds, and the tab only counts as opened once its page starts loading (the network's pace).
  await expect(page.getByText('Signed in to figma')).toBeVisible({ timeout: 15_000 });
  expect((await tab).url()).toContain('example.com/oauth/figma/authorize');
  await expect(settings.getByText('Yours, in every project · Connected · 2 tools')).toBeVisible({ timeout: 15_000 });
  await expect(signIn).toHaveCount(0);
  await toMcp(page);
  if (shots) await settings.screenshot({ path: `${shots}/04-mcp-codex-signed-in.png` });

  // Codex as your agent: its tab comes first, marked yours.
  const yours = settings.getByRole('combobox', { name: 'Your agent' });
  await yours.scrollIntoViewIfNeeded();
  await yours.click();
  await page.getByRole('option', { name: /Codex/ }).first().click();
  await expect(tabs.getByRole('tab', { name: 'Codex · yours' })).toBeVisible({ timeout: 15_000 });
  await expect(tabs.getByRole('tab').first()).toHaveText('Codex · yours');
  await toMcp(page);
  if (shots) await settings.screenshot({ path: `${shots}/05-mcp-codex-yours.png` });
});
