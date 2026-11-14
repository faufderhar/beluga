import { expect, test, type Page } from './fixtures.js';

/**
 * A right-click menu closes on any press outside it, and only one is ever open (#467). Radix
 * closes a menu on an outside `pointerdown` or on focus leaving it. Windows' web view gave it
 * neither: a press after a right-click can come without its `pointerdown` (a "chorded" press:
 * `mousedown` and `click` only), and a web view without the page's focus sends no focus events.
 * So here presses come without a `pointerdown`, and focus never moves.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const project = (page: Page, name: string) => sidebar(page).locator('[data-drag^="project:"]').filter({ has: page.getByText(name, { exact: true }) }).first();
const menus = (page: Page) => page.getByRole('menu');

/** The events of a press at (x, y) with no `pointerdown`, as Windows' web view sends them. */
async function pressWithoutPointerDown(page: Page, x: number, y: number, button: 0 | 2): Promise<void> {
  await page.evaluate(
    ({ x, y, button }) => {
      const el = document.elementFromPoint(x, y)!;
      const at = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button, view: window };
      el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: button ? 2 : 1 }));
      el.dispatchEvent(new MouseEvent('mouseup', at));
      el.dispatchEvent(new MouseEvent(button ? 'contextmenu' : 'click', at));
    },
    { x, y, button },
  );
}

async function middleOf(page: Page, name: string): Promise<{ x: number; y: number }> {
  const box = (await project(page, name).boundingBox())!;
  return { x: box.x + 40, y: box.y + box.height / 2 };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(project(page, 'bob-api')).toBeVisible();
  // Focus stays where it is, as in a web view that doesn't have the page's focus.
  await page.evaluate(() => (HTMLElement.prototype.focus = () => undefined));
});

test('a click outside a project’s right-click menu closes it', async ({ page }) => {
  await project(page, 'bob-api').click({ button: 'right' });
  await expect(menus(page)).toHaveCount(1);
  await pressWithoutPointerDown(page, 1000, 500, 0);
  await expect(menus(page)).toHaveCount(0);
});

test('right-clicking another row swaps the menu, it never stacks a second one', async ({ page }) => {
  await project(page, 'bob-api').click({ button: 'right' });
  await expect(menus(page)).toHaveCount(1);
  const landing = await middleOf(page, 'landing');
  await pressWithoutPointerDown(page, landing.x, landing.y, 2);
  await expect(menus(page)).toHaveCount(1);
  await expect(project(page, 'landing')).toHaveAttribute('data-state', 'open');
  await expect(project(page, 'bob-api')).toHaveAttribute('data-state', 'closed');
});

test('after a right-click outside, a menu still closes', async ({ page }) => {
  await project(page, 'bob-api').click({ button: 'right' });
  await pressWithoutPointerDown(page, 1000, 500, 2);
  await pressWithoutPointerDown(page, 1000, 500, 0);
  await expect(menus(page)).toHaveCount(0);
  // And right-clicking the project again opens one menu, as before.
  await project(page, 'bob-api').click({ button: 'right' });
  await project(page, 'bob-api').click({ button: 'right' });
  await expect(menus(page)).toHaveCount(1);
});

test('leaving the window closes the menu, as a native menu does', async ({ page }) => {
  await project(page, 'bob-api').click({ button: 'right' });
  await expect(menus(page)).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(menus(page)).toHaveCount(0);
});

test('its items and submenus still work', async ({ page }) => {
  await project(page, 'bob-api').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Group' }).hover();
  await expect(menus(page)).toHaveCount(2);
  await page.getByRole('menuitem', { name: 'Move to Group' }).click();
  await expect(menus(page)).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(menus(page)).toHaveCount(0);
});

/**
 * A closed menu leaves the page, even when the web view never says its opening animation started
 * (#505). Radix's Popper holds a menu's animation off until it's placed, so Presence first reads
 * "no animation" and learns the real one only from `animationstart`. Windows' web view didn't
 * deliver it: on close Presence took the menu's own animation for an exit one and waited for an
 * `animationend` that never came, so every "closed" menu stayed on screen, live and clickable.
 * Without StrictMode, as the app ships: its second run of each effect hides this while developing.
 */
test.describe('without animationstart, as in Windows’ web view', () => {
  const inPage = (page: Page) => page.locator('[role="menu"]');
  /** One menu open, its opening animation over (a person never closes it sooner). */
  const openAndSettled = async (page: Page): Promise<void> => {
    await expect(inPage(page)).toHaveCount(1);
    await page.waitForFunction(() => {
      const menu = document.querySelector('[role="menu"][data-state="open"]');
      return menu !== null && getComputedStyle(menu).animationName !== 'none' && menu.getAnimations().length === 0;
    });
  };

  test.beforeEach(async ({ page }) => {
    // Captured on the window and stopped there: the menu itself never hears it.
    await page.addInitScript(() => window.addEventListener('animationstart', (e) => e.stopImmediatePropagation(), true));
    await page.goto('/?nostrict');
    await expect(project(page, 'bob-api')).toBeVisible();
  });

  test('right-clicking another project leaves one menu in the page', async ({ page }) => {
    await project(page, 'bob-api').click({ button: 'right' });
    await openAndSettled(page);
    await project(page, 'landing').click({ button: 'right' });
    await openAndSettled(page);
    await expect(project(page, 'landing')).toHaveAttribute('data-state', 'open');
  });

  test('Escape and a click outside take the menu out of the page', async ({ page }) => {
    await project(page, 'bob-api').click({ button: 'right' });
    await openAndSettled(page);
    await page.keyboard.press('Escape');
    await expect(inPage(page)).toHaveCount(0);
    await project(page, 'bob-api').click({ button: 'right' });
    await openAndSettled(page);
    await page.mouse.click(1000, 500);
    await expect(inPage(page)).toHaveCount(0);
  });

  test('a project’s ••• menu leaves the page too', async ({ page }) => {
    await project(page, 'bob-api').hover();
    await project(page, 'bob-api').getByRole('button', { name: 'More for bob-api' }).click();
    await openAndSettled(page);
    await page.keyboard.press('Escape');
    await expect(inPage(page)).toHaveCount(0);
  });
});
