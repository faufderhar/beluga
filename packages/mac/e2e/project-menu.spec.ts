import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * A project's right-click and ⋯ menus: the item under the pointer lights up, choosing one does
 * only that (not also open the project), and Delete Project… asks before it removes anything.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const project = (page: Page, name: string) => sidebar(page).locator('[data-drag^="project:"]').filter({ has: page.getByText(name, { exact: true }) }).first();
const background = (l: Locator): Promise<string> => l.evaluate((el) => getComputedStyle(el).backgroundColor);
const CLEAR = 'rgba(0, 0, 0, 0)';

async function addRepo(page: Page, name: string): Promise<string> {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-menu-')), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  await page.getByRole('menuitem', { name: 'Add Projects…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add projects' });
  await sheet.getByRole('textbox', { name: 'Folder path' }).fill(dir);
  await sheet.getByRole('button', { name: 'Add', exact: true }).last().click();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(project(page, name)).toBeVisible();
  return dir;
}

test.use({ viewport: { width: 1440, height: 1600 } });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('the item under the pointer lights up, in the right-click menu and the ⋯ menu', async ({ page }) => {
  await project(page, 'bob-api').click({ button: 'right' });
  const finder = page.getByRole('menuitem', { name: 'Open in Finder' });
  const hide = page.getByRole('menuitem', { name: 'Hide Project' });
  await expect(finder).toBeVisible();
  expect(await background(finder)).toBe(CLEAR);
  await finder.hover();
  await expect.poll(() => background(finder)).not.toBe(CLEAR);
  // Moving on: the light moves with the pointer (a dangerous item lights up red).
  await hide.hover();
  await expect.poll(() => background(finder)).toBe(CLEAR);
  await expect.poll(() => background(hide)).not.toBe(CLEAR);
  await page.screenshot({ path: '../../.beluga/scratch/01-project-menu-hover.png' });
  await page.keyboard.press('Escape');

  await project(page, 'bob-api').hover();
  await project(page, 'bob-api').getByRole('button', { name: 'More for bob-api' }).click();
  const own = page.getByRole('menuitem', { name: 'Use the Project’s Own Icon' });
  await own.hover();
  await expect.poll(() => background(own)).not.toBe(CLEAR);
});

test('choosing from a project’s ⋯ menu does only that, it doesn’t also open the project', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: /^Overview/ }).click();
  await project(page, 'bob-api').hover();
  await project(page, 'bob-api').getByRole('button', { name: 'More for bob-api' }).click();
  await page.getByRole('menuitem', { name: 'Use the Project’s Own Icon' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toHaveCount(0);
});

test('Delete Project… asks first; it leaves Beluga and the folder is never touched', async ({ page }) => {
  const dir = await addRepo(page, 'del-one');
  await project(page, 'del-one').click({ button: 'right' });
  const del = page.getByRole('menuitem', { name: 'Delete Project…' });
  // At the bottom, after Hide Project.
  const items = await page.getByRole('menuitem').allTextContents();
  expect(items.slice(-2)).toEqual(['Hide Project', 'Delete Project…']);
  await del.click();
  const alert = page.getByRole('alertdialog', { name: 'Delete “del-one” from Beluga?' });
  await expect(alert).toBeVisible();
  // No way to send the folder anywhere from here.
  await expect(alert.getByRole('checkbox')).toHaveCount(0);
  await expect(alert).toContainText('isn’t touched');
  await page.screenshot({ path: '../../.beluga/scratch/02-delete-project-alert.png' });
  // Cancel does nothing.
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(project(page, 'del-one')).toBeVisible();

  await project(page, 'del-one').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete Project…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete from Beluga' }).click();
  await expect(project(page, 'del-one')).toHaveCount(0);
  // Not hidden: gone from Beluga (and still gone after a reload).
  await page.reload();
  await expect(sidebar(page)).toBeVisible();
  await expect(project(page, 'bob-api')).toBeVisible();
  await expect(project(page, 'del-one')).toHaveCount(0);
  expect(existsSync(path.join(dir, 'README.md'))).toBe(true);
});

test('a long folder path wraps inside the Delete Project alert', async ({ page }) => {
  const name = 'a-project-whose-folder-name-goes-on-and-on-well-past-the-alert-edge';
  await addRepo(page, name);
  await project(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete Project…' }).click();
  const alert = page.getByRole('alertdialog');
  const code = alert.locator('code').first();
  await expect(code).toContainText(name);
  const box = (await alert.boundingBox())!;
  const rect = (await code.boundingBox())!;
  expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width);
  await alert.screenshot({ path: '../../.beluga/scratch/03-delete-alert-long-path.png' });
  await alert.getByRole('button', { name: 'Cancel' }).click();
});

test('a long menu stays below the title bar and its rows start in one column', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  const row = project(page, 'bob-api');
  const box = (await row.boundingBox())!;
  // Right-clicked near the top: the menu is too tall to open downward, so it moves up.
  await row.click({ button: 'right', position: { x: 20, y: box.height / 2 } });
  const menu = page.getByRole('menu').first();
  await expect(menu).toBeVisible();
  const edges = (await menu.boundingBox())!;
  expect(edges.y).toBeGreaterThanOrEqual(52);
  expect(edges.y + edges.height).toBeLessThanOrEqual(760);
  // A name from the shared menu lines up with one of this window's own (which have icons).
  const nameX = (name: string) => page.getByRole('menuitem', { name, exact: true }).locator('span[class*="label"]').evaluate((el) => el.getBoundingClientRect().left);
  expect(await nameX('Open in Finder')).toBeCloseTo(await nameX('Hide Project'), 0);
  await page.screenshot({ path: '../../.beluga/scratch/02-project-menu-short-window.png' });
});
