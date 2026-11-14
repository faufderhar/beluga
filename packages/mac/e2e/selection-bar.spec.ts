import { expect, test, type Locator, type Page } from './fixtures.js';

/** Selecting text you're reading pops up Copy / Quote / Ask beside it, no right-click (BLG-917). */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea[data-composer]');
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Selected text' });

/** Drag across a line of text with the mouse, as you would to highlight it. */
async function dragAcross(page: Page, target: Locator): Promise<void> {
  // The text itself (a paragraph is often wider than its words).
  const box = await target.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getClientRects()[0]!;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  const y = box.y + Math.min(10, box.height / 2);
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 6 });
  await page.mouse.move(box.x + Math.min(box.width - 4, 320), y, { steps: 6 });
  await page.mouse.up();
}

test('selecting an answer shows Copy and Ask beside it', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toHaveCount(0, { timeout: 90_000 });
  await composer(page).fill('show me the data');
  await composer(page).press('Enter');
  await expect(page.getByRole('figure', { name: 'Table' }).filter({ hasText: 'Adyen' }).last()).toBeVisible({ timeout: 30_000 });

  const line = page.locator('main .selectable p').filter({ hasText: /(\w+ ){5}/ }).last();
  await expect(line).toBeVisible({ timeout: 30_000 });
  await line.scrollIntoViewIfNeeded();
  await dragAcross(page, line);
  await expect(bar(page)).toBeVisible();
  await expect(bar(page).getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(bar(page).getByRole('button', { name: /^Ask / })).toBeVisible();
  // It sits beside the selection, not over the far side of the window.
  const barBox = (await bar(page).boundingBox())!;
  const selBox = await page.evaluate(() => {
    const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(selBox.y);
  expect(selBox.y - (barBox.y + barBox.height)).toBeLessThan(20);
  const picked = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(picked.trim().length).toBeGreaterThan(2);
  const left = Math.max(0, selBox.x - 24);
  const clip = { x: left, y: Math.max(0, barBox.y - 24), width: Math.max(barBox.x + barBox.width, selBox.x + selBox.width) - left + 24, height: selBox.y + selBox.height - barBox.y + 60 };
  await page.screenshot({ path: '../../.beluga/scratch/01-selection-bar-light.png', clip });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '../../.beluga/scratch/02-selection-bar-dark.png', clip });
  await page.emulateMedia({ colorScheme: 'light' });

  // Copy: exactly what's selected, and the bar goes away.
  await bar(page).getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Copied the selection').last()).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(picked);

  // A click elsewhere clears it; Escape does too.
  await dragAcross(page, line);
  await expect(bar(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);

  // Ask: the selection lands in the box as a quote.
  await dragAcross(page, line);
  await bar(page).getByRole('button', { name: /^Ask / }).click();
  await expect(composer(page)).toBeFocused();
  expect(await composer(page).inputValue()).toMatch(/^> \S/);

  // Text you're typing keeps its own selection: no bar there.
  await composer(page).fill('a line I am typing right now');
  await composer(page).selectText();
  await page.mouse.up();
  await expect(bar(page)).toHaveCount(0);
});
