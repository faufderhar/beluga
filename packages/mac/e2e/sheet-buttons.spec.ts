import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/**
 * A sheet's buttons as macOS 26 draws them (docs/mac-controls.md, Push button): filled on the sheet,
 * and a default button that can't be pressed drawn as a plain one with its words dimmed, never the
 * accent faded (white words on pale blue). Plan Settings' Save is one until something moves.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');
const main = (page: Page) => page.locator('main');

async function openSettings(page: Page) {
  await page.goto('/');
  await openWork(page, 'Plans');
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Plan Options' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Plan Settings…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Plan Settings' });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The colours a button is drawn in. */
const look = (el: Element) => {
  const c = getComputedStyle(el);
  return { color: c.color, background: c.backgroundImage === 'none' ? c.backgroundColor : c.backgroundImage };
};

for (const scheme of ['light', 'dark'] as const) {
  test(`a sheet's default button that can't be pressed is drawn as a plain one (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    const sheet = await openSettings(page);
    const save = sheet.getByRole('button', { name: 'Save' });
    const cancel = sheet.getByRole('button', { name: 'Cancel' });
    await expect(save).toBeDisabled();
    // Off: Cancel's face and words (the whole button dimmed), not the accent.
    expect(await save.evaluate(look)).toEqual(await cancel.evaluate(look));
    await sheet.screenshot({ path: path.join(SHOTS, `sheet-buttons-${scheme}-off.png`) });
    // Something moved: Save is the accent again, white words on it.
    await sheet.getByRole('radio', { name: /^Check-ins/ }).click();
    await expect(save).toBeEnabled();
    expect((await save.evaluate(look)).background).not.toEqual((await cancel.evaluate(look)).background);
    await sheet.screenshot({ path: path.join(SHOTS, `sheet-buttons-${scheme}-on.png`) });
    await cancel.click();
  });
}
