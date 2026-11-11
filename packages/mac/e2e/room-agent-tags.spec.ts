import { expect, test, type Page } from './fixtures.js';
import { openGroupChat } from './helpers.js';

/**
 * See and tag each person's agents in the room (BLG-520): "@" lists your Codex ("@codex") and each
 * person's agents by name with their marks ("@bob:codex", "@mia:local"); a message naming one runs
 * that agent on that person's Mac, and its answer is labelled with it. The demo's bob answers with
 * Claude and also has Codex; mia answers with Codex and has a local model.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const list = (page: Page) => page.getByRole('listbox', { name: 'Suggestions' });
const shots = process.env.BELUGA_SHOTS_DIR;

test('the room lists each agent by name with its mark, and @bob:codex runs bob’s Codex', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  // The window opens on the Overview; the room's group chat is under Channels (BLG-871).
  await openGroupChat(page);
  await expect(page.getByText('hey! just pushed my API notes')).toBeVisible();

  await composer(page).click();
  await composer(page).pressSequentially('@');
  await expect(list(page).getByRole('option', { name: /@bob:codex/ })).toBeVisible();
  for (const tag of ['@codex', '@bob:claude', '@bob:codex', '@mia:codex', '@mia:local']) await expect(list(page).getByRole('option', { name: new RegExp(`^${tag}\\b`) }).first()).toBeVisible();
  // Agents someone doesn't run aren't offered.
  await expect(list(page).getByRole('option', { name: /@bob:local|@mia:claude/ })).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/01-room-agent-tags.png` });

  await composer(page).pressSequentially('bob:');
  await expect(list(page).getByRole('option')).toHaveCount(2);
  if (shots) await page.screenshot({ path: `${shots}/02-bob-agents.png` });
  await list(page).getByRole('option', { name: /@bob:codex/ }).click();
  await expect(composer(page)).toHaveValue('@bob:codex ');
  await composer(page).pressSequentially('check the webhook retries');
  await composer(page).press('Enter');

  // bob's demo Mac says yes after a moment, and his Codex answers: labelled with its name. Its turn is
  // drawn whole, or split around the room's chatter when that lands while it runs (live-tail.ts): either.
  const turn = page.locator('[data-turn]').filter({ hasText: "bob's Codex" }).last();
  await expect(turn).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 30_000 });
  if (shots) await page.screenshot({ path: `${shots}/03-bob-codex-answered.png` });

  // Your own @codex runs your Codex, here.
  await composer(page).pressSequentially('@cod');
  await expect(list(page).getByRole('option', { name: /^@codex\b/ })).toBeVisible();
  await composer(page).press('Tab');
  await expect(composer(page)).toHaveValue('@codex ');
  await composer(page).pressSequentially('summarize the room');
  await composer(page).press('Enter');
  // Yours is named for itself ("Codex"), not for a person.
  await expect(page.getByText('@codex summarize the room')).toBeVisible();
  await expect(page.getByRole('main').getByText('Codex', { exact: true }).last()).toBeVisible({ timeout: 30_000 });
  if (shots) await page.screenshot({ path: `${shots}/04-your-codex-answered.png` });
});
