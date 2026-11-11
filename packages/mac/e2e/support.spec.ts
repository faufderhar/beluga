import { expect, test } from './fixtures.js';

/**
 * Supporting Beluga (BLG-900): one ask, a star on GitHub, never money. Opened by hand from the
 * palette it's the same Star sheet the third merge brings.
 */

test('the palette opens the Star sheet, with no coffee or payment anywhere', async ({ page }) => {
  // With the ask forced on, the third merge's own sheet comes up first (the next test).
  test.skip(process.env.BELUGA_DEMO_ASKS === 'star', 'the ask is forced on');
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+K');
  await page.keyboard.type('Star Beluga');
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Enjoying Beluga?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Star Beluga on GitHub' })).toBeFocused();
  await expect(sheet).not.toContainText(/coffee|\$\d|Stripe/i);
  const shots = process.env.BELUGA_SHOTS;
  if (shots) {
    await page.waitForTimeout(900);
    await sheet.screenshot({ path: `${shots}/star-sheet-light.png` });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(300);
    await sheet.screenshot({ path: `${shots}/star-sheet-dark.png` });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  }
  await sheet.getByRole('button', { name: 'Close' }).last().click();
  await expect(sheet).toBeHidden();
  await page.keyboard.press('Meta+K');
  await page.keyboard.type('coffee');
  await expect(page.getByRole('option', { name: /coffee/i })).toHaveCount(0);
});

// With BELUGA_DEMO_ASKS=star the demo has three merges and the star unanswered: the ask comes by itself.
test('the third merge brings the Star sheet by itself', async ({ page }) => {
  test.skip(process.env.BELUGA_DEMO_ASKS !== 'star', 'needs BELUGA_DEMO_ASKS=star');
  await page.goto('/');
  const sheet = page.getByRole('dialog', { name: 'You shipped your 3rd PR with Beluga' });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByRole('button', { name: 'Share feedback' })).toBeVisible();
  const shots = process.env.BELUGA_SHOTS;
  if (shots) {
    await page.waitForTimeout(1200);
    await sheet.screenshot({ path: `${shots}/star-sheet-third-merge.png` });
    await page.waitForTimeout(700);
    await sheet.screenshot({ path: `${shots}/star-sheet-third-merge-b.png` });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(400);
    await sheet.screenshot({ path: `${shots}/star-sheet-third-merge-dark.png` });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  }
  await sheet.getByRole('button', { name: 'Maybe later' }).last().click();
  await expect(sheet).toBeHidden();
  await page.waitForTimeout(3000);
  await expect(page.getByRole('dialog', { name: /PR with Beluga/ })).toHaveCount(0);
});
