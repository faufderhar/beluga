import { expect, test, type Page } from './fixtures.js';

/**
 * A message from an external agent (BLG-121, BELUGA_DEMO_SCENE=external): its label on the message,
 * the driven-by strip above the chat, and its mark in the sidebar.
 */

test.skip(process.env.BELUGA_DEMO_SCENE !== 'external', 'needs BELUGA_DEMO_SCENE=external');
test.use({ video: 'on' });

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SHOTS) return;
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

test('a chat an external agent started says who sent what', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: "Show what's in bob-api" }).first().click();
  const row = sidebar(page).getByRole('button', { name: /fix-rate-limit/ }).first();
  await expect(sidebar(page).locator('[data-driven-by]')).toBeVisible();
  await row.click();
  await expect(page.locator('[data-driven-strip]')).toContainText('Driven by GrokBot');
  await expect(page.locator('[data-sent-by]').filter({ hasText: 'Sent by GrokBot' })).toHaveCount(2);
  await shot(page, '01-mac-sent-by-strip');
});
