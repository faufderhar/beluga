import { expect, test, type Page } from './fixtures.js';

/**
 * BLG-1017: a worktree's owner picks what forks of it bring of what git ignores, sees the files and
 * their size before any goes, and a secret-looking file in a pick only goes once it's ticked.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shots = process.env.FORK_CARRY_SHOTS;

test('Share › What Forks Bring: pick a git-ignored folder, tick its key, see what goes, Save', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await page.keyboard.press('Meta+Alt+4');
  await page.getByRole('button', { name: 'Share this worktree' }).click();
  const share = page.getByRole('dialog', { name: /^Share “webhook-retries”/ });
  await expect(share).toContainText('Files git ignores, like .context/, stay here unless you pick them');
  if (shots) await share.screenshot({ path: `${shots}/01-share-forks-section.png` });
  await share.getByRole('button', { name: 'What Forks Bring…' }).click();

  const sheet = page.getByRole('dialog', { name: /^What Forks of “webhook-retries” Bring/ });
  const ignored = sheet.getByRole('group', { name: 'Git-ignored paths' });
  const bench = ignored.getByRole('checkbox', { name: /bench-data\// });
  await expect(bench).not.toBeChecked();
  await expect(ignored).toContainText('7 files');
  await expect(ignored).toContainText('1 secret-looking, left out unless ticked');
  await expect(sheet).toContainText('0 files of what git ignores, plus Scratch');

  await bench.check();
  const secrets = sheet.getByRole('group', { name: 'Secret-looking files' });
  const key = secrets.getByRole('checkbox', { name: /bench-data\/typesafe\.env/ });
  await expect(key).not.toBeChecked();
  await expect(secrets).toContainText('Stays here');
  await expect(sheet).toContainText('6 files of what git ignores, plus Scratch');
  await key.check();
  await expect(secrets).toContainText('Goes with the fork');
  await expect(sheet).toContainText('7 files of what git ignores, plus Scratch');
  await sheet.getByRole('button', { name: 'Show Files' }).click();
  await expect(sheet.getByRole('list', { name: 'Files that would go' })).toContainText('bench-data/docs/case-1.md');
  if (shots) {
    await sheet.screenshot({ path: `${shots}/02-what-forks-bring-light.png` });
    await page.emulateMedia({ colorScheme: 'dark' });
    await sheet.screenshot({ path: `${shots}/03-what-forks-bring-dark.png` });
    await page.emulateMedia({ colorScheme: 'light' });
  }
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();

  // Kept: opening it again shows the same picks.
  await page.keyboard.press('Meta+Alt+4');
  await page.getByRole('button', { name: 'Share this worktree' }).click();
  await page.getByRole('dialog', { name: /^Share “webhook-retries”/ }).getByRole('button', { name: 'What Forks Bring…' }).click();
  const again = page.getByRole('dialog', { name: /^What Forks of “webhook-retries” Bring/ });
  await expect(again.getByRole('group', { name: 'Git-ignored paths' }).getByRole('checkbox', { name: /bench-data\// })).toBeChecked();
  await expect(again.getByRole('group', { name: 'Secret-looking files' }).getByRole('checkbox', { name: /typesafe\.env/ })).toBeChecked();
});
