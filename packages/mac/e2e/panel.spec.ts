import { expect, test, type Locator, type Page } from './fixtures.js';
import { termText } from './helpers.js';

/**
 * The workspace screen: the conversation stays in the center, and the right panel has the
 * Changes, Files, Terminal and Info tabs (⌥⌘0 hides it, ⌥⌘1…4 pick a tab). ⌘J's terminal can
 * also be a drawer under the chat. A diff or a file can take the center for a while (Esc goes back).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const tab = (page: Page, name: string) => panel(page).getByRole('tab', { name, exact: true });

async function openWorkspace(page: Page, name = 'add-auth'): Promise<void> {
  // The projects are in (right after a reload they arrive a moment later).
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

/** Its height once it has stopped sliding (the drawer animates in). */
async function settledHeight(target: Locator): Promise<number> {
  let last = -1;
  await expect
    .poll(async () => {
      const h = (await target.boundingBox())?.height ?? 0;
      const still = Math.abs(h - last) < 0.5;
      last = h;
      return still;
    }, { intervals: [120] })
    .toBe(true);
  return last;
}

/** The preview is kept between tests (it's the daemon's): open src unless a file there already opened it. */
async function showAuthInTree(page: Page): Promise<void> {
  const src = panel(page).getByRole('treeitem', { name: 'src' });
  await expect(src).toBeVisible();
  if ((await src.getAttribute('aria-expanded')) !== 'true') await src.click();
  await expect(panel(page).getByRole('treeitem', { name: 'auth.ts' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a workspace has what Claude made on top and what runs below; the keys pick them and each workspace keeps its own', async ({ page }) => {
  await openWorkspace(page);
  await expect(panel(page).getByRole('tablist', { name: 'Panel', exact: true }).getByRole('tab')).toHaveText([/^Changes/, 'Files', 'Scratch', 'Info']);
  await expect(panel(page).getByRole('tablist', { name: 'Panel bottom' }).getByRole('tab')).toHaveText(['Terminal', 'Background']);
  // It has commits ahead: Changes is where it starts.
  await expect(tab(page, 'Changes')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Meta+Alt+4');
  await expect(tab(page, 'Info')).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByRole('complementary', { name: 'Inspector' })).toContainText('This workspace');
  await page.keyboard.press('Meta+Alt+7');
  await expect(tab(page, 'Background')).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page)).toContainText('No background commands');
  await page.keyboard.press('Meta+Alt+2');
  await expect(tab(page, 'Files')).toHaveAttribute('aria-selected', 'true');
  // Another workspace has its own tab; coming back finds Files again.
  await openWorkspace(page, 'webhook-retries');
  await page.keyboard.press('Meta+Alt+4');
  await openWorkspace(page, 'add-auth');
  await expect(tab(page, 'Files')).toHaveAttribute('aria-selected', 'true');
  // The group chat has no workspace: just Info, and the terminal below.
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await expect(panel(page).getByRole('tablist', { name: 'Panel' }).getByRole('tab')).toHaveText(['Info', 'Terminal']);
});

test('⌥⌘0 hides and shows the panel, and the toolbar button does too', async ({ page }) => {
  await openWorkspace(page);
  // Hidden, it's out of the accessibility tree too, so it's found by its label here.
  const aside = page.locator('aside[aria-label="Panel"]');
  await expect(aside).toHaveAttribute('aria-hidden', 'false');
  await page.keyboard.press('Meta+Alt+0');
  await expect(aside).toHaveAttribute('aria-hidden', 'true');
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(async () => (await aside.boundingBox())?.width ?? 0).toBeLessThan(2);
  await page.getByRole('button', { name: /^Show the panel/ }).click();
  await expect(aside).toHaveAttribute('aria-hidden', 'false');
  await expect(tab(page, 'Changes')).toBeVisible();
});

test('Changes: a file’s diff right in the panel, closed with Esc, and in full with ⌘↩', async ({ page }) => {
  await openWorkspace(page);
  await tab(page, 'Changes').click();
  await expect(panel(page).getByText(/2 files changed/)).toBeVisible();
  await panel(page).getByRole('option', { name: /server\.ts/ }).click();
  const diff = panel(page).getByRole('region', { name: 'Changes in server.ts' });
  await expect(diff).toBeVisible();
  await expect(diff.locator('tr').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(diff).toBeHidden();
  // Arrow keys move through the files; ⌘↩ opens the one picked in full.
  await panel(page).getByRole('listbox', { name: 'Changed files' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(panel(page).getByRole('region', { name: 'Changes in auth.ts' })).toBeVisible();
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByRole('button', { name: 'Back to Chat' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('listbox', { name: 'Files' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Back to Chat' })).toBeHidden();
  await expect(composer(page)).toBeVisible();
});

test('Changes: grouped by folder, each folder folds, and the arrows walk what’s shown', async ({ page }) => {
  await openWorkspace(page);
  await tab(page, 'Changes').click();
  await expect(panel(page).getByText(/2 files changed/)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Group by Folder' }).click();
  const src = panel(page).getByRole('group', { name: 'src' });
  const folder = src.getByRole('button', { name: /src/ });
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await expect(src.getByRole('option')).toHaveCount(2);
  await page.screenshot({ path: '../../.beluga/scratch/changes-by-folder.png' });
  await panel(page).getByRole('listbox', { name: 'Changed files' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(panel(page).getByRole('region', { name: 'Changes in auth.ts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await folder.click();
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await expect(src.getByRole('option')).toHaveCount(0);
  // Back to one list: the folder shows beside each name again.
  await panel(page).getByRole('button', { name: 'Show as One List' }).click();
  await expect(panel(page).getByRole('option', { name: /auth\.ts/ })).toContainText('src');
});

test('Files: a tree you search by name, a preview with colors, and the file in full', async ({ page }) => {
  await openWorkspace(page);
  await tab(page, 'Files').click();
  await showAuthInTree(page);
  await panel(page).getByRole('treeitem', { name: 'auth.ts' }).click();
  const preview = panel(page).getByRole('region', { name: 'auth.ts' });
  await expect(preview.getByText('requireUser').first()).toBeVisible();
  // Filtering keeps the folders above a match and drops the rest.
  await panel(page).getByLabel('Search file names').fill('serv');
  await expect(panel(page).getByRole('treeitem', { name: 'server.ts' })).toBeVisible();
  await expect(panel(page).getByRole('treeitem', { name: 'auth.ts' })).toBeHidden();
  await expect(panel(page).getByRole('treeitem', { name: 'NOTES.md' })).toBeHidden();
  await panel(page).getByLabel('Search file names').press('Escape');
  await expect(panel(page).getByRole('treeitem', { name: 'NOTES.md' })).toBeVisible();
  // The arrows show each file they land on, no Enter needed.
  await panel(page).getByRole('treeitem', { name: 'auth.ts' }).click();
  await page.keyboard.press('ArrowDown');
  const next = (await panel(page).locator('[role="treeitem"][aria-selected="true"]').getAttribute('aria-label'))!;
  expect(next).not.toBe('auth.ts');
  await expect(panel(page).getByRole('region', { name: next })).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(preview.getByText('requireUser').first()).toBeVisible();
  // In full, then back; the tree's arrows keep stepping through files while it's open.
  await preview.getByRole('button', { name: 'Open in full' }).click();
  await expect(page.getByRole('main').getByRole('region', { name: 'auth.ts' })).toBeVisible();
  await page.getByRole('button', { name: /^Show the panel/ }).click();
  await panel(page).getByRole('treeitem', { name: 'auth.ts' }).click();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('main').getByRole('region', { name: next })).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('main').getByRole('region', { name: 'auth.ts' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Chat' }).click();
  await expect(composer(page)).toBeVisible();
});

test('Terminal in the panel: + adds a shell for this workspace, and it runs there', async ({ page }) => {
  await openWorkspace(page);
  await tab(page, 'Terminal').click();
  const term = panel(page).getByRole('region', { name: 'Terminal' });
  await expect(term.getByRole('tab', { name: /^Shell/ }).first()).toBeVisible();
  await term.getByRole('button', { name: 'New shell' }).click();
  await expect(term.getByRole('tab', { name: /^Shell \d+/ })).toBeVisible();
  await term.locator('.xterm').click();
  await page.keyboard.type('pwd; echo panel-$((6*7))\n');
  await expect.poll(() => termText(term), { timeout: 15_000 }).toContain('panel-42');
  await expect.poll(() => termText(term)).toMatch(/add-auth/);
  await term.getByRole('tab', { name: /^Shell \d+/ }).hover();
  await term.getByRole('button', { name: /^Close Shell \d+/ }).click();
  await expect(term.getByRole('tab', { name: /^Shell \d+/ })).toHaveCount(0);
});

test('⌘J opens the terminal under the chat when that’s your choice (Settings › Terminal), and it remembers its height', async ({ page }) => {
  await page.keyboard.press('Meta+,');
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('dialog').getByRole('tab', { name: 'Bottom Drawer' }).click();
  await page.keyboard.press('Escape');
  await openWorkspace(page);
  await page.keyboard.press('Meta+J');
  const drawer = page.getByRole('main').getByRole('region', { name: 'Terminal' });
  await expect(drawer).toBeVisible();
  // ⌘J puts the keyboard in it.
  await expect(drawer.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type('echo drawer-$((6*7))\n');
  await expect.poll(() => termText(drawer), { timeout: 15_000 }).toContain('drawer-42');
  // The conversation stays above it.
  await expect(composer(page)).toBeVisible();
  // It's a group of the center's dock, under the chat's: drag the divider between them to make it taller; the height is kept.
  const group = page.getByRole('main').locator('.dv-groupview').filter({ has: page.getByRole('tab', { name: 'Terminal', exact: true }) });
  const before = await settledHeight(drawer);
  const box = (await group.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await drawer.boundingBox())!.height).toBeGreaterThan(before + 80);
  const taller = (await drawer.boundingBox())!.height;
  await page.reload();
  await openWorkspace(page);
  await expect(drawer).toBeVisible();
  expect(Math.abs((await settledHeight(drawer)) - taller)).toBeLessThan(4);
  // It's in one place: the panel has no Terminal tab while it's under the chat.
  await expect(tab(page, 'Terminal')).toHaveCount(0);
  // ⌘J puts the keyboard in it; typing there, ⌘J puts it away.
  await page.keyboard.press('Meta+J');
  await expect(drawer.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.press('Meta+J');
  await expect(drawer).toBeHidden();
  await expect(composer(page)).toBeFocused();
  // Its ⋯ menu moves it to the panel, where ⌘J shows it from then on.
  await page.keyboard.press('Meta+J');
  await drawer.getByRole('button', { name: 'Terminal options' }).click();
  await page.getByRole('menuitem', { name: 'Move to the Right Panel' }).click();
  await expect(panel(page).getByRole('region', { name: 'Terminal' })).toBeVisible();
});

test('dragging the panel’s edge resizes it, and the width is kept', async ({ page }) => {
  await openWorkspace(page);
  const before = (await panel(page).boundingBox())!.width;
  const edge = page.getByRole('separator', { name: 'Resize the panel' });
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x - 140, box.y + 300, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await panel(page).boundingBox())!.width).toBeGreaterThan(before + 100);
  const wider = (await panel(page).boundingBox())!.width;
  await page.reload();
  await expect(sidebar(page)).toBeVisible();
  await expect.poll(async () => Math.abs((await panel(page).boundingBox())!.width - wider)).toBeLessThan(3);
  // Never past 60% of the window.
  const now = (await edge.boundingBox())!;
  await page.mouse.move(now.x + 1, now.y + 300);
  await page.mouse.down();
  await page.mouse.move(10, now.y + 300, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await panel(page).boundingBox())!.width).toBeLessThanOrEqual(1440 * 0.6 + 1);
});

test('Run shows the terminal without taking the keyboard from the message box', async ({ page }) => {
  await openWorkspace(page);
  await page.keyboard.press('Meta+Alt+4');
  await composer(page).click();
  await page.keyboard.press('Meta+R');
  await expect(tab(page, 'Terminal')).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByRole('region', { name: 'Terminal' }).getByRole('tab', { name: /^Run/ })).toBeVisible({ timeout: 15_000 });
  await expect(composer(page)).toBeFocused();
  // The center never left the conversation.
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await page.keyboard.press('Meta+R');
});

test('a tab moves beside the chat and back; the chat keeps what you were typing', async ({ page }) => {
  await openWorkspace(page);
  const center = page.getByRole('tablist', { name: 'Center' });
  // The chat alone has no strip of its own.
  await expect(center).toHaveCount(0);
  await composer(page).fill('still here');
  await tab(page, 'Files').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move Beside the Chat' }).click();
  // In the center's dock now (in the page's main area), out of the panel.
  await expect(center.getByRole('tab')).toHaveText(['Files']);
  await expect(panel(page).getByRole('tab', { name: 'Files', exact: true })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('tree', { name: 'Files' })).toBeVisible();
  await expect(composer(page)).toHaveValue('still here');
  // It shows whether the panel does or not.
  await page.keyboard.press('Meta+Alt+0');
  await expect(page.getByRole('main').getByRole('tree', { name: 'Files' })).toBeVisible();
  await page.keyboard.press('Meta+Alt+0');
  // After a reload it's still beside the chat.
  await page.reload();
  await openWorkspace(page);
  await expect(center.getByRole('tab')).toHaveText(['Files']);
  await center.getByRole('tab', { name: 'Files', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to the Panel' }).click();
  await expect(center).toHaveCount(0);
  await expect(panel(page).getByRole('tablist', { name: 'Panel', exact: true }).getByRole('tab')).toHaveText([/^Changes/, 'Files', 'Scratch', 'Info']);
  await composer(page).fill('');
});

test('drag a tab to the other group and it stays there; right-click moves it back; the dock under the top group folds to its tabs', async ({ page }) => {
  await openWorkspace(page);
  const top = panel(page).getByRole('tablist', { name: 'Panel', exact: true });
  const bottom = panel(page).getByRole('tablist', { name: 'Panel bottom' });
  await top.getByRole('tab', { name: 'Info', exact: true }).dragTo(bottom);
  await expect(bottom.getByRole('tab')).toHaveText(['Terminal', 'Info', 'Background']);
  await expect(bottom.getByRole('tab', { name: 'Info' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).locator('[data-panel-dock="true"]:visible').getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  // After a reload, it's still there.
  await page.reload();
  await openWorkspace(page);
  await expect(bottom.getByRole('tab')).toHaveText(['Terminal', 'Info', 'Background']);
  await bottom.getByRole('tab', { name: 'Info' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Top' }).click();
  await expect(top.getByRole('tab')).toHaveText([/^Changes/, 'Files', 'Scratch', 'Info']);
  // The dock folds to its tabs, and opens again from any of them.
  await panel(page).getByRole('button', { name: 'Hide the terminal dock' }).click();
  await expect(panel(page).locator('[data-panel-dock="true"]:visible')).toHaveCount(0);
  await bottom.getByRole('tab', { name: 'Terminal' }).click();
  await expect(panel(page).locator('[data-panel-dock="true"]:visible')).toBeVisible();
  // Reset Panel Layout puts everything back.
  await top.getByRole('tab', { name: 'Files' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset Panel Layout' }).click();
  await expect(top.getByRole('tab')).toHaveText([/^Changes/, 'Files', 'Scratch', 'Info']);
});
