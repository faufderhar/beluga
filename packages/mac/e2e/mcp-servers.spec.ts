import { expect, test } from './fixtures.js';

/**
 * Settings › Claude › MCP servers (BLG-251): the servers your Claude gets from Claude Code, where
 * each comes from and how it is, and Sign In for one that needs it. The demo has one of each
 * (src/agent/mock.ts) and is "back from the browser" a moment after you sign in.
 */

test('Settings › Claude lists your MCP servers and signs you in to one', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(settings.getByText('Servers your Claude uses')).toBeVisible();
  await expect(settings.getByText('Yours, in every project · Needs you to sign in')).toBeVisible();
  await expect(settings.getByText('From the context7 plugin · Connected')).toBeVisible();
  await expect(settings.getByText('Set for bob-api · Needs you to sign in')).toBeVisible();
  await expect(settings.getByText('From the ratel plugin · Couldn’t connect: npx exited (code 1)')).toBeVisible();
  await expect(settings.getByText('A claude.ai connector · Connected')).toBeVisible();
  await settings.getByText('MCP servers').scrollIntoViewIfNeeded();
  await page.screenshot({ path: process.env.MCP_SHOT ?? 'test-results/mcp-servers.png' });

  // The sign-in page opens in a new tab here (your browser in the app); the row waits, then says so.
  const signIns = settings.getByRole('button', { name: 'Sign In…' });
  await expect(signIns).toHaveCount(2);
  const tab = page.context().waitForEvent('page');
  await signIns.first().click();
  await expect(settings.getByRole('button', { name: 'Waiting for Browser…' })).toBeVisible();
  // The toast first: it's up for a few seconds, and the tab only counts as opened once its page starts loading (the network's pace).
  await expect(page.getByText('Signed in to figma')).toBeVisible();
  expect((await tab).url()).toContain('example.com/oauth/figma');
  await expect(settings.getByText('Yours, in every project · Connected')).toBeVisible();
  await expect(signIns).toHaveCount(1);
});
