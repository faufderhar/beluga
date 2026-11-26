import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * The sidebar tells you which conversations finished or need you, Slack-style: a bold name and
 * a count, a glow while Claude waits on you, a tally on the project, and an Unread section at
 * the top that's only there while something is.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
// A conversation's message box (not a plan page's name or chat, which may still be leaving the screen).
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea):not([aria-label="Plan name"]):not([aria-label="Message your agent about the plan"])');
const unreadSection = (page: Page) => sidebar(page).getByRole('region', { name: 'Unread' });
const row = (page: Page, name: string): Locator => sidebar(page).getByRole('button', { name, exact: true });
const projectRow = (page: Page, name: string): Locator => sidebar(page).getByRole('button', { name, exact: true }).and(page.locator('[aria-expanded]'));

async function openWorkspace(page: Page, name: string, project: string): Promise<void> {
  await expect(projectRow(page, project)).toBeVisible();
  if (!(await row(page, name).isVisible())) {
    const show = sidebar(page).getByRole('button', { name: `Show what's in ${project}` }).first();
    if (await show.isVisible()) await show.click();
  }
  await row(page, name).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

/** Read whatever other tests left unread, so the Unread section starts as empty as it can. */
async function readLeftovers(page: Page): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const next = unreadSection(page).locator('[data-signal-row="unread"]').first();
    if (!(await next.isVisible().catch(() => false))) return;
    const before = await unreadSection(page).locator('[data-signal-row="unread"]').count();
    await next.click();
    await expect.poll(() => unreadSection(page).locator('[data-signal-row="unread"]').count()).toBeLessThan(before);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await expect(projectRow(page, 'bob-api')).toBeVisible();
});

test('a run that finishes while you are elsewhere marks its row and project until you open it', async ({ page }) => {
  test.setTimeout(90_000);
  await openWorkspace(page, 'add-auth', 'bob-api');
  await composer(page).fill('Take a deep dive into the webhooks, take your time');
  await composer(page).press('Enter');
  const auth = row(page, 'add-auth');
  await expect(auth).toHaveAttribute('data-signal-row', 'working', { timeout: 10_000 });

  // Somewhere else (another project) while Claude works.
  await openWorkspace(page, 'new-hero', 'landing');
  await expect(auth).toHaveAttribute('data-signal-row', 'unread', { timeout: 40_000 });
  await expect(auth.locator('[data-signal="unread"]')).toHaveText('1');
  await expect(auth.getByText('add-auth')).toHaveCSS('font-weight', '650');
  await expect(auth).toHaveAttribute('title', /Your agent finished · 1 new message/);

  // The project adds it up, and folded, that's how you notice.
  const project = projectRow(page, 'bob-api');
  await expect(project.locator('[data-tally]')).toHaveAttribute('data-tally', /^\d+:[1-9]/);
  await project.getByRole('button', { name: 'Fold bob-api' }).click();
  await expect(auth).toBeHidden();
  await expect(project.locator('[data-tally]')).toBeVisible();
  await project.getByRole('button', { name: "Show what's in bob-api" }).first().click();

  // It's in Unread, a click away; opening it reads it (it stays there, plain, while you're in it).
  const listed = unreadSection(page).getByRole('button', { name: /^add-auth · Your agent finished/ });
  await expect(listed).toBeVisible();
  await listed.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await expect(auth).not.toHaveAttribute('data-signal-row', 'unread');
  await expect(auth.getByText('add-auth')).not.toHaveCSS('font-weight', '650');
  await expect(unreadSection(page).getByRole('button', { name: 'add-auth · read' })).toBeVisible();

  // Leaving it lets it go.
  await openWorkspace(page, 'new-hero', 'landing');
  await expect(unreadSection(page).getByRole('button', { name: /^add-auth ·/ })).toHaveCount(0);
});

test("Claude's question makes the row need you until it's answered; Unread comes and goes", async ({ page }) => {
  test.setTimeout(90_000);
  await readLeftovers(page);
  await openWorkspace(page, 'add-auth', 'bob-api');
  const startedEmpty = (await unreadSection(page).count()) === 0;

  await openWorkspace(page, 'new-hero', 'landing');
  await composer(page).fill('Which session store should we pick for auth?');
  await composer(page).press('Enter');
  await expect(page.getByRole('button', { name: /Signed cookies/ })).toBeVisible({ timeout: 15_000 });

  // Away from it, it needs you: the lit edge, the glow, the tooltip, and the project says so too.
  await openWorkspace(page, 'add-auth', 'bob-api');
  const hero = row(page, 'new-hero');
  await expect(hero).toHaveAttribute('data-signal-row', 'needs');
  await expect(hero.locator('[data-signal="needs"]')).toBeVisible();
  await expect(hero).toHaveAttribute('title', /Your agent asks a question/);
  await expect(projectRow(page, 'landing').locator('[data-tally]')).toHaveAttribute('data-tally', /^[1-9]/);
  await expect(unreadSection(page).getByRole('button', { name: /^new-hero · Your agent asks a question/ })).toBeVisible();

  // Settings › Appearance can leave the section out.
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Appearance' }).click();
  const toggle = page.getByRole('switch', { name: 'Unread in the sidebar' });
  await toggle.click();
  await expect(unreadSection(page)).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(unreadSection(page)).toBeVisible();

  // Opening it doesn't answer it: it still needs you.
  await hero.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /pick an option/);
  await expect(hero).toHaveAttribute('data-signal-row', 'needs');

  // Answering does.
  await page.getByRole('button', { name: /Signed cookies/ }).click();
  await expect(hero).not.toHaveAttribute('data-signal-row', 'needs', { timeout: 15_000 });
  await expect(unreadSection(page).getByRole('button', { name: /^new-hero · Your agent asks/ })).toHaveCount(0);
  if (startedEmpty) {
    await openWorkspace(page, 'add-auth', 'bob-api');
    await expect(unreadSection(page)).toHaveCount(0);
  }
});

test('the project you are in is lit, and its tools leave with the pointer', async ({ page }) => {
  await openWorkspace(page, 'add-auth', 'bob-api');
  const project = projectRow(page, 'bob-api');
  await expect(project).toHaveAttribute('data-current', 'true');
  await expect(projectRow(page, 'landing')).not.toHaveAttribute('data-current', 'true');
  // Its home lights it too.
  await project.click();
  await expect(project).toHaveAttribute('data-current', 'true');
  // Clicked, then the pointer moves away: the row keeps focus, but its tools fold back.
  await page.mouse.move(600, 400);
  await expect(project.getByRole('button', { name: 'New chat in bob-api' })).toHaveCSS('opacity', '0');
});

test("an Unread row has its chat's right-click menu, and Rename… there renames it", async ({ page }) => {
  test.setTimeout(90_000);
  // Its agent answers while you are elsewhere.
  await openWorkspace(page, 'webhook-retries', 'bob-api');
  await composer(page).fill('hello');
  await composer(page).press('Enter');
  await openWorkspace(page, 'new-hero', 'landing');
  const listed = unreadSection(page).getByRole('button', { name: /^webhook-retries · / });
  await expect(listed).toBeVisible({ timeout: 40_000 });

  // The menu its row has in a project's list.
  await listed.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Remind Me Later' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByLabel('Worktree name').fill('webhook-renamed');
  await page.keyboard.press('Enter');
  await expect(unreadSection(page).getByRole('button', { name: /^webhook-renamed · / })).toBeVisible();
  await expect(row(page, 'webhook-renamed')).toBeVisible();
});
