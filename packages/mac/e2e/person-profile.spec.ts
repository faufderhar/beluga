import { expect, test, type Page } from './fixtures.js';
import { openGroupChat } from './helpers.js';

/**
 * Someone's profile from where you see them (BLG-395): their name or picture in a chat opens their
 * card, and a profile picture on a card opens large. SHOTS=<folder>: screenshots there.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

test('a name in the room chat opens their card', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'Group chat' }).first().click();
  const name = page.getByRole('button', { name: 'bob’s profile' }).first();
  await expect(name).toBeVisible({ timeout: 20_000 });
  await name.click();
  const card = page.getByRole('dialog', { name: 'bob' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Message' })).toBeVisible();
  await shot(page, 'profile-room-card');
  // The same name again closes it.
  await name.click();
  await expect(card).toHaveCount(0);
});

test('a friend’s avatar opens their profile, and their picture opens large', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const turnOn = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await turnOn.isVisible()) await turnOn.getByRole('button', { name: 'Turn On' }).click();
  await openGroupChat(page);
  // mia's friend row (the demo gives her a picture): its avatar opens her profile.
  const avatar = sidebar(page).locator('[data-friend-row]').getByRole('button', { name: 'mia’s profile' });
  await expect(avatar).toBeVisible({ timeout: 40_000 });
  await avatar.click();
  const card = page.getByRole('dialog', { name: 'mia' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('in a meeting');
  await expect(card).toContainText('Trust');
  const zoom = card.getByRole('button', { name: 'See mia’s picture' });
  await expect(zoom).toBeVisible({ timeout: 20_000 });
  await shot(page, 'profile-friend-card');
  await zoom.click();
  const big = page.getByRole('dialog', { name: 'mia’s picture' });
  await expect(big.getByRole('img', { name: 'mia' })).toBeVisible();
  await shot(page, 'profile-picture-zoom');
  await page.keyboard.press('Escape');
  await expect(big).toHaveCount(0);
  await expect(card).toBeVisible();
  // Clicks in the card stay in it: the room chat behind is still there, her chat didn't open.
  await expect(page.getByText('Demo mode: bob, mia and every Claude are simulated.')).toBeVisible();
});

test('a friend’s profile shows how much of their plans they have left, when they share it (BLG-597)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const turnOn = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await turnOn.isVisible()) await turnOn.getByRole('button', { name: 'Turn On' }).click();
  // bob trusts you: his Claude and his Codex, what's left of each window and when it resets.
  const bob = sidebar(page).locator('[data-friend-row]').getByRole('button', { name: 'bob’s profile' });
  await expect(bob).toBeVisible({ timeout: 40_000 });
  await bob.click();
  const card = page.getByRole('dialog', { name: 'bob' });
  const claude = card.getByRole('group', { name: 'Claude plan usage' });
  await expect(claude).toBeVisible({ timeout: 20_000 });
  await expect(claude).toContainText('Max');
  await expect(claude.getByRole('meter', { name: '5-hour: 66% left' })).toBeVisible();
  await expect(claude).toContainText('Resets');
  await expect(card.getByRole('group', { name: 'Codex plan usage' }).getByRole('meter', { name: 'Weekly: 60% left' })).toBeVisible();
  await shot(page, 'profile-usage');
  await page.keyboard.press('Escape');
  // mia has you on "Ask me each time": hers stays hers.
  await sidebar(page).locator('[data-friend-row]').getByRole('button', { name: 'mia’s profile' }).click();
  const mia = page.getByRole('dialog', { name: 'mia' });
  await expect(mia).toContainText('doesn’t share how much of their plans is left with you');
  await expect(mia.getByRole('meter')).toHaveCount(0);
});
