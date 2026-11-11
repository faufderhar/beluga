import { expect, test, type Page } from './fixtures.js';
import { openGroupChat, personRow, pick } from './helpers.js';

/** The Mac app's web view against a real Beluga (the demo): what you click does what it says. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

async function openWorkspace(page: Page, name = 'add-auth'): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
}

/** The full-page terminal (no sidebar row of its own: ⌘6, the Go menu, ⌘K). */
async function openTerminalPage(page: Page): Promise<void> {
  await expect(sidebar(page)).toBeVisible();
  // (Right after a reload the window may not be listening yet: try again.)
  await expect(async () => {
    await page.keyboard.press('Meta+Digit6');
    await expect(page.locator('header').first()).toContainText('Terminal', { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('shows the room, its people and projects', async ({ page }) => {
  await expect(personRow(page, 'bob')).toBeVisible();
  await expect(sidebar(page).getByText('bob-api', { exact: true }).first()).toBeVisible();
  await openGroupChat(page);
  await expect(page.getByText('hey! just pushed my API notes')).toBeVisible();
});

test('the room’s chat is no place of its own: Overview first, its group chat under Channels (BLG-871)', async ({ page }) => {
  await expect(page.locator('header').first()).toContainText('Overview');
  // No Chat row at the top, nor in the Go menu's keys: ⌘3 goes nowhere.
  await expect(sidebar(page).getByRole('button', { name: 'Chat', exact: true })).toHaveCount(0);
  await page.keyboard.press('Meta+Digit3');
  await expect(page.locator('header').first()).toContainText('Overview');
  // bob is in the room: its group chat is the first of Channels, with the room's call.
  await openGroupChat(page);
  await expect(page.getByText('hey! just pushed my API notes')).toBeVisible();
  await expect(page.locator('header').first().getByRole('button', { name: /Call the Room/ })).toBeVisible();
});

test("talks to Claude in a workspace and shows its run", async ({ page }) => {
  await openWorkspace(page);
  // The center is always the conversation (its changes, files and terminal are in the right panel).
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await composer(page).fill('Add a health check endpoint');
  await composer(page).press('Enter');
  await expect(page.getByText('Add a health check endpoint').last()).toBeVisible();
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 20_000 });
});

test('shows what changed, file by file: in the panel, then in full', async ({ page }) => {
  await openWorkspace(page);
  const panel = page.getByRole('complementary', { name: 'Panel' });
  await panel.getByRole('tab', { name: 'Changes' }).click();
  await panel.getByRole('option', { name: /auth\.ts/ }).click();
  await expect(panel.getByRole('region', { name: 'Changes in auth.ts' }).getByText('requireUser').first()).toBeVisible();
  await panel.getByRole('button', { name: 'Open in full' }).click();
  await page.getByRole('main').getByRole('tab', { name: 'Split' }).click();
  await expect(page.getByRole('main').getByText('requireUser').first()).toBeVisible();
  await page.getByRole('button', { name: 'Back to Chat' }).click();
  await expect(composer(page)).toBeVisible();
});

test('the palette goes anywhere', async ({ page }) => {
  await page.keyboard.press('Meta+K');
  await page.keyboard.type('usage');
  await page.keyboard.press('Enter');
  // The Usage page: its title, or its space hero (both, once its numbers are in).
  await expect(page.getByRole('heading', { level: 1 }).or(page.getByText('in worktrees')).first()).toBeVisible();
});

test('switches to dark from Settings', async ({ page }) => {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Appearance' }).click();
  await pick(page, 'Appearance', 'Dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await pick(page, 'Appearance', 'Light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('⌘J shows the terminal in the right panel and runs a command in it', async ({ page }) => {
  await openWorkspace(page);
  // Each place has its own panel tab: wait until the workspace is the one showing.
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await page.keyboard.press('Meta+J');
  const term = page.getByRole('complementary', { name: 'Panel' }).getByRole('region', { name: 'Terminal' });
  await expect(term).toBeVisible();
  await term.locator('.xterm').click();
  await page.keyboard.type('echo dock-$((6*7))\n');
  await expect(term.getByText('dock-42').last()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Meta+J');
  await expect(term).toBeHidden();
});

test("the dock terminal takes the shell's keys: Tab completes after a click in its padding, ⌘← goes to the line's start", async ({ page }) => {
  await openWorkspace(page);
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await page.keyboard.press('Meta+J');
  const term = page.getByRole('complementary', { name: 'Panel' }).getByRole('region', { name: 'Terminal' });
  await expect(term).toBeVisible();
  await expect(term.locator('.xterm-rows')).toContainText(/\S/, { timeout: 15_000 });
  await composer(page).click();
  // The padding around the text, not the text: the keyboard goes to the shell all the same.
  const box = term.locator('.xterm').locator('..');
  const width = (await box.boundingBox())!.width;
  await box.click({ position: { x: width / 2, y: 3 } });
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type('echo $((6*7))tab-done > tab-probe-7731.txt\n');
  await page.keyboard.type('cat tab-probe-77');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(term.getByText('42tab-done').last()).toBeVisible({ timeout: 15_000 });
  // Emacs keys, whatever the test's environment says (an EDITOR=vi there puts zsh in vi mode).
  await page.keyboard.type('bindkey -e 2>/dev/null; clear\n');
  await page.keyboard.type('cho line-$((6*7))');
  await page.keyboard.press('Meta+ArrowLeft');
  await page.keyboard.type('e');
  await page.keyboard.press('Enter');
  await expect(term.getByText('line-42').last()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.type('rm tab-probe-7731.txt\n');
});

test('picks a model and how hard Claude thinks', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Agent, model and effort' }).click();
  await page.getByRole('radio', { name: /Opus/ }).click();
  await page.getByRole('radio', { name: 'High', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Agent, model and effort' })).toHaveText(/Opus · High/);
  // In a conversation the left step follows Settings again (it does not change every conversation).
  await page.getByRole('radio', { name: 'Settings' }).click();
});

test("opens a person's card beside their row", async ({ page }) => {
  // On the name, not its Add button.
  await personRow(page, 'bob').getByText('bob', { exact: true }).click();
  const card = page.getByRole('dialog', { name: 'bob' });
  // Not a friend yet: the card says how much you trust them, and offers to add them.
  await expect(card.getByText('Ask me each time.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Add bob as a friend' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
});

test('opens and closes shells without them coming back', async ({ page }) => {
  await openTerminalPage(page);
  const shells = page.getByRole('tab', { name: /^Shell \d+/ });
  await expect(shells.first()).toBeVisible();
  await page.getByRole('button', { name: 'New shell' }).click();
  await expect(shells).toHaveCount(2);
  await page.locator('.xterm').click();
  await page.keyboard.type('echo second-$((6*7))\n');
  await expect(page.getByText('second-42')).toBeVisible({ timeout: 15_000 });
  // Closing the one shown moves to the other, and it stays closed.
  await shells.nth(1).getByRole('button', { name: /^Close/ }).click();
  await expect(shells).toHaveCount(1);
  // Fixed waits, on purpose: they show the closed shell doesn't come back.
  await page.waitForTimeout(1500);
  await expect(shells).toHaveCount(1);
  await shells.first().getByRole('button', { name: /^Close/ }).click();
  await expect(page.getByText('No shells open')).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(shells).toHaveCount(0);
  await page.getByRole('button', { name: 'New shell' }).last().click();
  await expect(shells).toHaveCount(1);
});

test('renames a shell, for every screen, and Escape cancels', async ({ page }) => {
  await openTerminalPage(page);
  const first = page.getByRole('tab', { name: /^Shell \d+/ }).first();
  await expect(first).toBeVisible();
  // It has started: its prompt is in.
  await expect(page.locator('.xterm-rows')).toContainText(/\S/);
  await first.dblclick();
  await page.getByLabel('Terminal name').fill('build logs');
  await page.keyboard.press('Enter');
  const named = page.getByRole('tab', { name: /^build logs/ });
  await expect(named).toBeVisible();
  // Escape keeps the name it had.
  await named.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByLabel('Terminal name').fill('nope');
  await page.keyboard.press('Escape');
  await expect(named).toBeVisible();
  // It's shared state: a fresh window sees it too.
  await page.reload();
  await openTerminalPage(page);
  await expect(page.getByRole('tab', { name: /^build logs/ })).toBeVisible();
  // Empty goes back to its number.
  await page.getByRole('tab', { name: /^build logs/ }).dblclick();
  await page.getByLabel('Terminal name').fill('');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /^Shell \d+/ }).first()).toBeVisible();
});

test('sets an environment variable that new shells get', async ({ page }) => {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Environment', exact: true }).click();
  await page.getByRole('button', { name: 'Add variable' }).click();
  await page.getByLabel('Name', { exact: true }).last().fill('bad-name');
  await page.getByLabel(/^Value of/).last().click();
  await expect(page.getByText('Use letters, digits and _ only')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).last().fill('BELUGA_E2E_TOKEN');
  await page.getByLabel(/^Value of/).last().fill('tok-$((6*7))-secret');
  await page.getByLabel('Name', { exact: true }).last().click();
  await expect(page.getByRole('status').getByText('Saved')).toBeVisible();
  // Values are masked until you ask to see them.
  await expect(page.getByLabel('Value of BELUGA_E2E_TOKEN')).toHaveClass(/masked/);
  await page.getByRole('button', { name: 'Show BELUGA_E2E_TOKEN' }).click();
  await expect(page.getByLabel('Value of BELUGA_E2E_TOKEN')).not.toHaveClass(/masked/);
  await page.keyboard.press('Escape');
  await openTerminalPage(page);
  await page.getByRole('button', { name: 'New shell' }).first().click();
  await expect(page.locator('.xterm-rows')).toContainText(/\S/);
  await page.locator('.xterm').click();
  await page.keyboard.type('echo "got-$BELUGA_E2E_TOKEN"\n');
  await expect(page.getByText('got-tok-$((6*7))-secret')).toBeVisible({ timeout: 15_000 });
});

test('picks how the shell starts and how terminals look', async ({ page }) => {
  await openTerminalPage(page);
  await expect(page.locator('.xterm')).toBeVisible();
  await page.keyboard.press('Meta+,');
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal', exact: true }).click();
  const login = page.getByRole('switch', { name: 'Login shell' });
  await login.click();
  await expect(login).toHaveAttribute('aria-checked', 'false');
  await page.getByLabel('Extra arguments').fill('-i');
  await page.getByLabel('Extra arguments').press('Enter');
  await expect(page.getByText(/Started as: \S+ -i$/)).toBeVisible();
  await page.getByLabel('Terminal font size').fill('16');
  await page.getByRole('tab', { name: 'Bar' }).click();
  await expect(page.getByText('16 pt')).toBeVisible();
  // The open terminal follows right away.
  await expect(page.locator('.xterm .xterm-rows')).toHaveCSS('font-size', '16px');
  // The shell settings are Beluga's (shared); they're still there after a reload.
  await page.reload();
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+,');
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Login shell' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('switch', { name: 'Login shell' }).click();
  await page.getByLabel('Extra arguments').fill('');
  await page.getByLabel('Extra arguments').press('Enter');
  await expect(page.getByText(/Started as: \S+ -l$/)).toBeVisible();
});

test('adds a project from the Add Projects sheet, with its own icon', async ({ page }) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const repo = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-repo-')), 'pixel-app');
  mkdirSync(path.join(repo, 'public'), { recursive: true });
  writeFileSync(path.join(repo, 'public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="red"/></svg>');
  execFileSync('git', ['init', '-q', repo]);
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  await page.getByRole('menuitem', { name: 'Add Projects…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add projects' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('textbox', { name: 'Folder path' }).fill(repo);
  await sheet.getByRole('button', { name: 'Add', exact: true }).last().click();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
  const row = sidebar(page).getByRole('button', { name: /^pixel-app/ }).first();
  await expect(row).toBeVisible();
  await expect(row.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  // Nothing in it yet: no fold arrow (a project with worktrees keeps its own).
  await expect(sidebar(page).getByRole('button', { name: /^(Fold|Show what's in) pixel-app/ })).toHaveCount(0);
  // Your own bob-api (it has worktrees) keeps its fold arrow; bob's shared copy below has its own, not counted here.
  await expect(sidebar(page).getByRole('button', { name: 'bob-api', exact: true }).getByRole('button', { name: /^(Fold|Show what's in) bob-api/ })).toHaveCount(1);
  if (process.env.SHOTS) await sidebar(page).screenshot({ path: `${process.env.SHOTS}/sidebar-empty-project.png` });
});

test('starts a new project from the Add Projects sheet, with git and a first commit', async ({ page }) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const parent = mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-new-'));
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  await page.getByRole('menuitem', { name: 'New Project…' }).click();
  const sheet = page.getByRole('dialog', { name: 'New project' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Create Project' })).toBeDisabled();
  await sheet.getByRole('textbox', { name: 'Project name' }).fill('fresh-idea');
  await sheet.getByRole('textbox', { name: 'Where the new project goes' }).fill(parent);
  await expect(sheet.getByText(/with git and a first commit/)).toBeVisible();
  if (process.env.SHOTS) await sheet.screenshot({ path: `${process.env.SHOTS}/new-project-sheet.png` });
  await sheet.getByRole('button', { name: 'Create Project' }).click();
  await expect(sheet).toBeHidden();
  await expect(sidebar(page).getByRole('button', { name: /^fresh-idea/ }).first()).toBeVisible();
  const dir = path.join(parent, 'fresh-idea');
  expect(execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('Start fresh-idea');
  // A name that's taken by a folder with files in it is refused, in the sheet.
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  await page.getByRole('menuitem', { name: 'New Project…' }).click();
  await sheet.getByRole('textbox', { name: 'Project name' }).fill('fresh-idea');
  await sheet.getByRole('textbox', { name: 'Where the new project goes' }).fill(parent);
  await sheet.getByRole('button', { name: 'Create Project' }).click();
  await expect(sheet.getByRole('alert')).toContainText('already there');
});

test('Clone lists your GitHub repositories: pick one and its address fills in', async ({ page }) => {
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  // The demo's gh (e2e/fake-gh.mjs) answers user/repos with these; whatever else it knows stays.
  const file = path.join(process.env.BELUGA_HOME!, 'fake-gh.json');
  const before = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as object) : { prs: {} };
  const pushed = new Date(Date.now() - 2 * 86_400_000).toISOString();
  writeFileSync(
    file,
    JSON.stringify({
      ...before,
      repos: [
        { full_name: 'you/weather-app', clone_url: 'https://github.com/you/weather-app.git', ssh_url: 'git@github.com:you/weather-app.git', private: true, pushed_at: pushed, description: 'Forecasts on the lock screen' },
        { full_name: 'acme/docs-site', clone_url: 'https://github.com/acme/docs-site.git', ssh_url: 'git@github.com:acme/docs-site.git', private: false, pushed_at: pushed, description: null },
      ],
    }),
  );
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  await page.getByRole('menuitem', { name: 'Clone from Git…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Clone a project' });
  await expect(sheet).toBeVisible();
  const list = sheet.getByRole('list');
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list).toContainText('weather-app');
  await expect(list).toContainText('you · private · pushed 2d ago · Forecasts on the lock screen');
  await expect(sheet.getByRole('button', { name: 'Clone Project' })).toBeDisabled();

  await list.getByRole('listitem').filter({ hasText: 'weather-app' }).click();
  await expect(sheet.getByRole('textbox', { name: 'Git address' })).toHaveValue('https://github.com/you/weather-app.git');
  await expect(sheet.getByText(/Clones it into .*weather-app and adds it/)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Clone Project' })).toBeEnabled();
  if (process.env.SHOTS) await sheet.screenshot({ path: `${process.env.SHOTS}/clone-your-repos.png` });

  await sheet.getByRole('textbox', { name: 'Filter your repositories' }).fill('docs');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('docs-site');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
});

test('Clone with a hundred repositories and long names stays inside a short window', async ({ page }) => {
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  const file = path.join(process.env.BELUGA_HOME!, 'fake-gh.json');
  const before = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as object) : { prs: {} };
  const long = 'a-repository-with-a-really-long-name-that-goes-on-and-on-and-on-and-keeps-going-past-the-edge-of-the-sheet';
  const repos = Array.from({ length: 100 }, (_, i) => {
    const name = i % 3 === 0 ? `${long}-${i}` : `repo-${i}`;
    const owner = i % 4 === 0 ? 'an-organization-with-a-very-long-name-indeed' : 'you';
    return { full_name: `${owner}/${name}`, clone_url: `https://github.com/${owner}/${name}.git`, private: i % 2 === 0, pushed_at: new Date(Date.now() - i * 86_400_000).toISOString(), description: 'A description that is far too long to fit on one line of this sheet, so it has to end with an ellipsis somewhere'.repeat(2) };
  });
  writeFileSync(file, JSON.stringify({ ...before, repos }));
  await page.setViewportSize({ width: 820, height: 560 });
  await sidebar(page).getByRole('button', { name: /Add a project/ }).first().click();
  await page.getByRole('menuitem', { name: 'Clone from Git…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Clone a project' });
  const list = sheet.getByRole('list');
  await expect(list.getByRole('listitem')).toHaveCount(100);
  // The list scrolls inside the sheet; the sheet, its address and its buttons stay on screen.
  const box = (await sheet.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(560);
  await expect(sheet.getByRole('button', { name: 'Clone Project' })).toBeInViewport({ ratio: 1 });
  await expect(sheet.getByRole('textbox', { name: 'Git address' })).toBeInViewport({ ratio: 1 });
  const sizes = await list.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, wide: el.scrollWidth - el.clientWidth }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  // Long names end in an ellipsis instead of pushing the list sideways.
  expect(sizes.wide).toBe(0);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/clone-many-repos-short-window.png` });
  await list.getByRole('listitem').nth(99).scrollIntoViewIfNeeded();
  await list.getByRole('listitem').nth(99).click();
  await expect(sheet.getByRole('textbox', { name: 'Git address' })).toHaveValue(/-99\.git$/);
  await sheet.getByRole('button', { name: 'Cancel' }).click();
});

// ---- images in the chat, and the queue

/** A 1×1 PNG, pasted into the box the way ⌘V hands an image to the web view. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
async function pasteImage(page: Page): Promise<void> {
  await composer(page).evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG);
}

test("shows a friend's screenshot in the chat and opens it full size", async ({ page }) => {
  await openGroupChat(page);
  const thumb = page.getByRole('button', { name: /^Open image 1/ }).first();
  await expect(thumb).toBeVisible({ timeout: 15_000 });
  // Fetched from bob's computer through Beluga, and drawn.
  await expect.poll(() => thumb.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
  await thumb.click();
  const box = page.getByRole('dialog', { name: /image 1/ });
  await expect(box.getByRole('img')).toBeVisible();
  await expect(box.getByRole('button', { name: 'Copy' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
});

test('shows pasted images before sending, and in the message after', async ({ page }) => {
  await openGroupChat(page);
  await composer(page).click();
  await pasteImage(page);
  const pending = page.getByLabel('Images to send');
  await expect(pending.getByRole('img')).toHaveCount(1);
  // The image waits above the box as a thumbnail, with an "[image N]" in the words where the cursor was.
  await expect(composer(page)).toHaveValue(/^\[(?:image \d+|\d+\u2007[^\]\n]+)\] $/);
  // Removing it takes its "[image N]" out of the words too.
  await pending.getByRole('button', { name: /^Remove image/ }).click();
  await expect(pending).toBeHidden();
  await expect(composer(page)).not.toHaveValue(/\[image/);
  await composer(page).fill('');
  await pasteImage(page);
  await expect(pending.getByRole('img')).toHaveCount(1);
  await expect(composer(page)).toHaveValue(/^\[(?:image \d+|\d+\u2007[^\]\n]+)\] $/);
  const words = `pixel check ${Date.now()}`;
  // The box puts the cursor after "[image N]" on the next frame: type once that frame has run (KLD-84).
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await composer(page).pressSequentially(words);
  await composer(page).press('Enter');
  await expect(page.getByText(words)).toBeVisible();
  const sent = page.locator('[data-index]').filter({ hasText: words }).getByRole('button', { name: /^Open image \d+ \(png/ });
  await expect.poll(() => sent.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
});

test('queues messages while Claude works, reorders them, and sends one now', async ({ page }) => {
  await openWorkspace(page, 'webhook-retries');
  await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);
  await composer(page).fill('Take a deep dive into the codebase');
  await composer(page).press('Enter');
  // While Claude works, the send button splits into Queue and Steer.
  const split = page.getByRole('group', { name: 'Claude is working' });
  await expect(split).toBeVisible();
  for (const text of ['first in line', 'second in line', 'third in line']) {
    await composer(page).fill(text);
    await split.getByRole('button', { name: 'Queue' }).click();
  }
  const tray = page.getByRole('region', { name: 'Queued messages' });
  const rows = tray.getByRole('listitem');
  await expect(rows).toHaveText([/first in line/, /second in line/, /third in line/]);
  await rows.nth(2).hover();
  await rows.nth(2).getByRole('button', { name: 'Move up' }).click();
  await expect(rows).toHaveText([/first in line/, /third in line/, /second in line/]);
  await rows.nth(0).hover();
  await rows.nth(0).getByRole('button', { name: 'Remove from the queue' }).click();
  await expect(rows).toHaveCount(2);
  // Edit pulls it out of the queue and back into the box.
  await rows.nth(1).hover();
  await rows.nth(1).getByRole('button', { name: /^Edit/ }).click();
  await expect(composer(page)).toHaveValue('second in line');
  await expect(rows).toHaveCount(1);
  await composer(page).fill('');
  await rows.nth(0).hover();
  await rows.nth(0).getByRole('button', { name: 'Steer' }).click();
  await expect(tray).toBeHidden();
  // The demo Claude can't take a message mid-turn, so it stops and runs this next.
  await expect(page.getByText('Interrupted by a newer message').last()).toBeVisible();
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 20_000 });
});

// ---- the notification centre (the bell in the toolbar)

const bell = (page: Page) => page.getByRole('button', { name: /^Notifications/ }).first();
const centre = (page: Page) => page.getByRole('dialog', { name: 'Notifications' });
/** What happened, under Today and Earlier (not what waits for you). */
const history = (page: Page) => centre(page).getByRole('region', { name: /^(Today|Earlier)$/ }).getByRole('listitem');

/** Open the centre and empty it, so each test starts from nothing. */
async function emptyCentre(page: Page): Promise<void> {
  await bell(page).click();
  const clear = centre(page).getByRole('button', { name: 'Clear all' });
  if (await clear.isEnabled()) await clear.click();
  // What waits for you (the demo's knock, its merge) stays: answered, not cleared.
  await expect(history(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
}

async function sendTestNotification(page: Page): Promise<void> {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Send Test Notification' }).click();
  await expect(page.getByRole('status', { name: 'Test result' })).toContainText('Sent');
  await page.keyboard.press('Escape');
}

test('the bell opens the notification centre, with filters', async ({ page }) => {
  await emptyCentre(page);
  await sendTestNotification(page);
  await expect(bell(page)).toHaveAccessibleName(/1 new/);
  await bell(page).click();
  await expect(centre(page).getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(centre(page).getByText('Notifications work')).toBeVisible();
  await centre(page).getByRole('tab', { name: 'Mentions' }).click();
  await expect(centre(page).getByText('No mentions')).toBeVisible();
  await centre(page).getByRole('tab', { name: 'All' }).click();
  await expect(centre(page).getByText('Notifications work')).toBeVisible();
});

test('marks everything read, one unread again, and clears', async ({ page }) => {
  await emptyCentre(page);
  await sendTestNotification(page);
  await sendTestNotification(page);
  await bell(page).click();
  await expect(history(page)).toHaveCount(2);
  await centre(page).getByRole('button', { name: 'Mark all read' }).click();
  await expect(bell(page)).not.toHaveAccessibleName(/new/);
  await centre(page).getByRole('tab', { name: /Unread/ }).click();
  await expect(history(page)).toHaveCount(0);
  await centre(page).getByRole('tab', { name: 'All' }).click();
  // Hover a notification for read/unread and ×.
  const first = history(page).first();
  await first.hover();
  await first.getByRole('button', { name: 'Mark as unread' }).click();
  await expect(bell(page)).toHaveAccessibleName(/1 new/);
  await first.hover();
  await first.getByRole('button', { name: 'Clear' }).click();
  await expect(history(page)).toHaveCount(1);
  await centre(page).getByRole('button', { name: 'Clear all' }).click();
  await expect(history(page)).toHaveCount(0);
});

test('what waits for you is answered in the bell, and opens where it lives', async ({ page }) => {
  await bell(page).click();
  const waiting = centre(page).getByRole('region', { name: 'Waiting for you' });
  await expect(bell(page)).toHaveAccessibleName(/2 waiting for you/);
  // Someone at the door: let in right here.
  const knock = waiting.getByRole('listitem').filter({ hasText: 'zoe wants to come in' });
  await expect(knock).toContainText('Room');
  if (process.env.SHOTS) await centre(page).screenshot({ path: `${process.env.SHOTS}/bell-waiting.png` });
  await knock.getByRole('button', { name: 'Let in' }).click();
  await expect(knock).toHaveCount(0);
  await expect(bell(page)).toHaveAccessibleName(/1 waiting for you/);
  // A merge held for you: clicking it opens the run, where it waits.
  await waiting.getByRole('button', { name: /Merge the fix for #48\?/ }).click();
  await expect(centre(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Merge', exact: true }).first()).toBeVisible();
});

test('clicking a notification goes where it happened', async ({ page }) => {
  await emptyCentre(page);
  await openWorkspace(page);
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await composer(page).fill('Add a readiness probe');
  await composer(page).press('Enter');
  await expect(page.getByText('Add a readiness probe').last()).toBeVisible();
  // Somewhere else while Claude works: its finishing is news.
  await sidebar(page).getByRole('button', { name: 'Overview' }).click();
  await bell(page).click();
  const finished = centre(page).getByRole('button', { name: /Claude finished in add-auth/ });
  await expect(finished).toBeVisible({ timeout: 30_000 });
  await finished.click();
  await expect(centre(page)).toBeHidden();
  // add-auth is a worktree of its own (the demo plan's tasks run in checkout-*, KLD-23): its news opens it.
  // A plan task's news opening the plan is plan-black-box.spec.ts's.
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
});

test('effort follows Settings again, and Shift-Tab switches plan mode on and off', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Agent, model and effort' }).click();
  await page.getByRole('radio', { name: 'Max', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Agent, model and effort' })).toHaveText(/Max/);
  await page.getByRole('radio', { name: 'Settings' }).click();
  await expect(page.getByRole('radio', { name: 'Settings' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Agent, model and effort' })).not.toHaveText(/Max/);
  await page.keyboard.press('Escape');
  await composer(page).click();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('status').filter({ hasText: 'Planning' }).filter({ hasText: 'to act' })).toBeVisible();
  await expect(composer(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('status').filter({ hasText: 'Planning' }).filter({ hasText: 'to act' })).toHaveCount(0);
});
