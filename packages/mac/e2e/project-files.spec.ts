import { expect, test, type Page } from './fixtures.js';

/**
 * A project's page has Files over its main folder: browse the tree, search names (a regular
 * expression over the whole path) and contents, open a file beside the page or in full, and edit it.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const tab = (page: Page, name: string) => panel(page).getByRole('tablist', { name: 'Panel' }).getByRole('tab', { name, exact: true });

async function openHome(page: Page, project = 'landing'): Promise<void> {
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByText(project, { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: project })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a project’s page browses and searches its main folder, and opens a file in full', async ({ page }, info) => {
  await openHome(page);
  if (!(await panel(page).isVisible())) await page.keyboard.press('ControlOrMeta+Alt+0');
  await tab(page, 'Files').click();
  const tree = panel(page).getByRole('tree', { name: 'Files' });
  await expect(tree.getByRole('treeitem', { name: 'README.md' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('01-project-files.png') });

  // Names: a regular expression over the whole path, the match marked in the name.
  await panel(page).getByRole('radiogroup', { name: 'Search' }).getByRole('radio', { name: 'Names' }).click();
  await panel(page).getByRole('button', { name: 'Regular Expression' }).click();
  await panel(page).getByRole('textbox', { name: 'Search file names' }).fill('^READ.*\\.md$');
  await expect(tree.getByRole('treeitem', { name: 'README.md' })).toBeVisible();
  await expect(tree.locator('mark').first()).toHaveText('README.md');
  await page.screenshot({ path: info.outputPath('02-name-regex.png') });
  await panel(page).getByRole('textbox', { name: 'Search file names' }).fill('(unclosed');
  await expect(tree).toContainText('Not a valid pattern');

  // Contents, with the same flags.
  await panel(page).getByRole('radiogroup', { name: 'Search' }).getByRole('radio', { name: 'Contents' }).click();
  const box = panel(page).getByRole('textbox', { name: 'Search in the files’ contents' });
  await box.fill('Pric(e|ing)');
  const hits = panel(page).getByRole('tree', { name: 'Lines found' });
  await expect(hits.getByRole('status')).toContainText(/\d+ lines? in \d+ files?/);
  await page.screenshot({ path: info.outputPath('03-content-regex.png') });
  await box.fill('');
  await panel(page).getByRole('button', { name: 'Regular Expression' }).click();

  // A file previews beside the page, then opens in full across it; Esc goes back to the project.
  await panel(page).getByRole('radiogroup', { name: 'Search' }).getByRole('radio', { name: 'Names' }).click();
  await tree.getByRole('treeitem', { name: 'README.md' }).click();
  const file = panel(page).getByRole('region', { name: 'README.md' });
  await expect(file.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expect(file.getByRole('button', { name: 'Show Changes' })).toHaveCount(0);
  await file.getByRole('button', { name: 'Open in full' }).click();
  const back = page.getByRole('button', { name: 'Back to Project' });
  await expect(back).toBeVisible();
  await page.screenshot({ path: info.outputPath('04-in-full.png') });
  await back.click();
  // Exactly: the README still previews in the panel, and its own h1 is "Landing page".
  await expect(page.getByRole('heading', { level: 1, name: 'landing', exact: true })).toBeVisible();
});
