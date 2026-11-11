import { expect, test } from './fixtures.js';
import { openGroupChat } from './helpers.js';

/**
 * Your MCP servers in the box you type in (BLG-252): a plug with how many are connected, an amber
 * dot when one needs you, and the list on hover with Sign In. The demo's servers are in src/agent/mock.ts.
 */

test('the box you type in shows your MCP servers, and signs you in from there', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  // A box to type in: the room's group chat (the window opens on the Overview, BLG-871).
  await openGroupChat(page);
  const chip = page.getByRole('button', { name: /^MCP servers: / });
  await expect(chip).toHaveText('2/5');
  await expect(chip).toHaveAttribute('data-mcp-chip', 'needs-you');
  if (process.env.MCP_BAR_SHOT) await chip.locator('..').screenshot({ path: process.env.MCP_BAR_SHOT });
  await chip.hover();
  const list = page.getByRole('dialog', { name: 'MCP servers' });
  await expect(list.getByText('2 of 5 connected · 2 to sign in · 1 failed')).toBeVisible();
  await expect(list.getByText('Set for bob-api')).toBeVisible();
  await page.screenshot({ path: process.env.MCP_CHIP_SHOT ?? 'test-results/mcp-chip.png' });

  const tab = page.context().waitForEvent('page');
  await list.getByRole('button', { name: 'Sign In' }).first().click();
  expect((await tab).url()).toContain('example.com/oauth/figma');
  await expect(chip).toHaveText('3/5');
  await expect(list.getByRole('button', { name: 'Sign In' })).toHaveCount(1);
});
