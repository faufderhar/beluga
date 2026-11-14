import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Sentinel (docs/sentinel.md §3) on the demo's eleven sentinels: the list, Morning brief's page and
 * Run Now, a run's page with its report, the merge waiting on Fix what broke, and the event
 * triggers (Uptime guard's page, the webhook's URL), then a recipe made and turned on (Nightly
 * tests, with the sentinel that runs after it fails); then numbers (§10): Stripe revenue's Numbers
 * card and its chart over time, the Keep the numbers step; then the section's three tabs
 * (Sentinels · Dashboard · Chat), the Dashboard with every kind of tile, Add a Tile by description
 * making a draft sentinel, and the Sentinel chat (§12) with a delete that asks first. Screenshots
 * in light and dark go to .beluga/scratch/sentinel-*.png.
 */

const shots = path.join(import.meta.dirname, '..', '..', '..', '.beluga', 'scratch');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');

async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Charts draw in for a moment (recharts' animation): the picture waits for them.
    await page.waitForTimeout((await page.locator('.recharts-surface').count()) ? 1600 : 150);
    await page.screenshot({ path: path.join(shots, `sentinel-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function openList(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: /^Sentinel/ }).click();
  await expect(main(page).locator('[data-sentinel]').first()).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });

test('the list shows the demo’s sentinels, grouped by project, with their last runs', async ({ page }) => {
  await openList(page);
  const rows = main(page).locator('[data-sentinel]');
  await expect(rows).toHaveCount(11);
  // Each row leads with what it found.
  await expect(main(page).getByRole('row', { name: /^Morning brief, Every day at 7:00/ })).toContainText('3 commits landed');
  await expect(main(page).getByRole('row', { name: /^Nightly tests/ })).toContainText('Paused after 3 failures in a row');
  await expect(main(page).getByRole('row', { name: /^Fix what broke/ })).toContainText('Needs you');
  // The demo's run going now is the recorded one: nothing caught up, nothing failed.
  await expect(main(page).getByRole('row', { name: /^Watch the web/ })).toContainText('Running');
  await expect(main(page).getByRole('row', { name: /^Watch the web/ })).not.toContainText('Failed');
  await main(page).getByRole('textbox', { name: 'Find a sentinel' }).fill('nightly');
  await expect(rows).toHaveCount(1);
  await main(page).getByRole('textbox', { name: 'Find a sentinel' }).fill('');
  await expect(rows).toHaveCount(11);
  await shoot(page, 'list');
});

test('Morning brief’s page: When, Steps, Properties, History; Run Now starts a run', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Morning brief/ }).click();
  await expect(main(page).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Morning brief');
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText('Every day at 7:00');
  const steps = main(page).getByRole('region', { name: 'Steps' });
  await expect(steps.getByRole('textbox', { name: 'Step 1’s name' })).toHaveValue('Read what changed');
  // A step unfolds its fields: the presets over the prompt.
  await steps.getByRole('button', { name: 'Show its fields' }).first().click();
  await expect(steps.getByRole('button', { name: 'Write a brief of what changed' })).toBeVisible();
  await expect(main(page).getByRole('complementary', { name: 'Properties' })).toContainText('Your agent can look and tell you');
  const history = main(page).getByRole('region', { name: 'History' });
  // A week of runs, as seeded (the demo's start catches nothing up).
  await expect(history.locator('[data-run]')).toHaveCount(7);
  await shoot(page, 'page');
  const before = await history.locator('[data-run]').count();
  await main(page).getByRole('button', { name: 'Run Now' }).click();
  await expect(history.locator('[data-run]')).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(history.locator('[data-run]').first()).toContainText('you');
});

test('a run’s page: the line, the steps, the report', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Morning brief/ }).click();
  await main(page).getByRole('region', { name: 'History' }).locator('[data-run]').filter({ hasText: 'schedule' }).filter({ hasText: 'Done' }).first().click();
  await expect(main(page).locator('[data-run-page]')).toBeVisible();
  await expect(main(page).getByText(/^Morning brief · ran by schedule · .+ · .+ s$/)).toBeVisible();
  await expect(main(page).getByRole('region', { name: 'Report' })).toBeVisible();
  await main(page).getByRole('button', { name: 'Show output' }).first().click();
  // Its Claude's session, watched right in the run (BLG-330).
  await main(page).getByRole('button', { name: 'The agent’s session' }).click();
  const session = main(page).locator('[data-run-session]');
  await expect(session).toContainText('3 commits landed');
  await expect(session.getByRole('button', { name: 'Open the Chat' })).toBeVisible();
  await shoot(page, 'run');
});

test('a run that waits for you: Merge', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Fix what broke/ }).click();
  await main(page).getByRole('region', { name: 'History' }).locator('[data-run]').filter({ hasText: 'Needs you' }).first().click();
  const decide = main(page).getByTestId('sentinel-decide');
  await expect(decide).toContainText('Pull request #53 waits for you');
  await shoot(page, 'merge');
  await decide.getByRole('button', { name: 'Merge' }).click();
  await expect(main(page).getByRole('heading', { name: 'Merged #53' })).toBeVisible();
  await expect(decide).toHaveCount(0);
  await shoot(page, 'merge-done');
});

test('phase 2’s steps on a page: a service with its preset, and a merge that asks before it stops asking', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Watch the web/ }).click();
  const steps = main(page).getByRole('region', { name: 'Steps' });
  await expect(steps.locator('[data-step="http"]')).toContainText('Groqbot: POST api.groqbot.example');
  await steps.locator('[data-step="http"]').getByRole('button', { name: 'Show its fields' }).click();
  await expect(steps.getByRole('textbox', { name: 'URL' })).toHaveValue('https://api.groqbot.example/search');
  await expect(steps.getByRole('textbox', { name: 'Header 1’s value' })).toHaveValue('Bearer $GROQBOT_KEY');
  await expect(steps).toContainText('$VAR from Settings › Environment; headers never show in reports');
  await shoot(page, 'http-step');

  await openList(page);
  await main(page).getByRole('row', { name: /^Fix what broke/ }).click();
  await expect(main(page).getByRole('complementary', { name: 'Properties' })).toContainText('merge when the checks pass and you’ve approved');
  const merge = main(page).getByRole('region', { name: 'Steps' }).locator('[data-step="merge"]');
  await merge.getByRole('button', { name: 'Show its fields' }).click();
  await merge.getByRole('checkbox', { name: /Ask me before merging/ }).click();
  const alert = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'Merge without asking?' }));
  await expect(alert).toContainText('Merge without asking?');
  await alert.getByRole('button', { name: 'Merge Without Asking' }).click();
  await expect(merge).toContainText('Merges by itself when the checks pass');
  await expect(main(page).getByRole('complementary', { name: 'Properties' })).toContainText('merge by itself when the checks pass');
});

test('Describe it: Claude writes the sentinel, the page shows it working, then its answer', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('button', { name: 'New Sentinel' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'New Sentinel' });
  await expect(sheet.getByRole('tab', { name: /Describe it/ })).toHaveAttribute('aria-selected', 'true');
  await sheet.getByRole('combobox', { name: 'Where it works' }).click();
  await page.getByRole('option', { name: 'bob-api' }).click();
  await sheet.getByRole('textbox', { name: 'What should it do?' }).fill('Every weekday at 8, read yesterday’s commits and open issues, write me a brief, and make tasks for anything urgent');
  await sheet.getByRole('button', { name: 'Write It' }).click();
  await expect(main(page).locator('[data-sentinel-page]')).toBeVisible();
  const box = main(page).getByTestId('sentinel-ask');
  await expect(box).toContainText('Your agent is writing…');
  await expect(box).toContainText('Set it up: every weekday at 8:00', { timeout: 30_000 });
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText('Every weekday at 8:00');
  await expect(main(page).getByRole('region', { name: 'Steps' }).getByRole('textbox', { name: 'Step 1’s name' })).toHaveValue('Read what changed');
  await expect(main(page).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Read yesterday’s commits');
  // It starts paused: Turn On is the main button.
  await expect(main(page).getByRole('button', { name: 'Turn On' }).first()).toBeVisible();
  await expect(box.getByRole('button', { name: 'Open Chat' })).toBeVisible();
  await shoot(page, 'page-ask');
});

test('an event trigger: Uptime guard’s page, its events, and the down-then-back runs', async ({ page }) => {
  await openList(page);
  await expect(main(page).getByRole('row', { name: /^Uptime guard, When landing\.example\.com stops answering/ })).toBeVisible();
  await main(page).getByRole('row', { name: /^Uptime guard/ }).click();
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText('When landing.example.com stops answering (checked every 5 minutes), and when it’s back');
  const when = main(page).getByRole('region', { name: 'When' });
  await expect(when.getByRole('textbox', { name: 'Address to check' })).toHaveValue('https://landing.example.com');
  await expect(when).toContainText('Two misses in a row start a run');
  const history = main(page).getByRole('region', { name: 'History' });
  await expect(history.locator('[data-run]')).toHaveCount(2);
  await expect(history.locator('[data-run]').first()).toContainText('landing.example.com is back');
  await expect(history.locator('[data-run]').nth(1)).toContainText('landing.example.com stopped answering (503)');
  await shoot(page, 'uptime');
  // Another kind shows its events as cards: GitHub's five.
  await when.getByRole('combobox', { name: 'What starts it' }).click();
  await page.getByRole('option', { name: /When something happens on GitHub/ }).click();
  const cards = when.getByRole('radiogroup', { name: 'What starts it' });
  await expect(cards.getByRole('radio')).toHaveCount(5);
  await expect(cards.getByRole('radio', { name: /A workflow fails/ })).toHaveAttribute('aria-checked', 'true');
  await cards.getByRole('radio', { name: /An issue gets a label/ }).click();
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText('When an issue gets a label on GitHub');
  await expect(when.getByRole('textbox', { name: 'Label' })).toBeVisible();
  await shoot(page, 'events');
  // Back as it was (the demo stays tidy for the next test).
  await when.getByRole('combobox', { name: 'What starts it' }).click();
  await page.getByRole('option', { name: /When a site stops answering/ }).click();
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText(/^When example\.com stops answering/);
});

test('a webhook: its URL with Copy, the signature, Rotate Secret asks first', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^GitHub pushes/ }).click();
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText('When GitHub posts to its URL');
  const when = main(page).getByRole('region', { name: 'When' });
  const url = when.getByTestId('webhook-url');
  await expect(url).toHaveValue(/^https:\/\/quiet-harbor-demo\.trycloudflare\.com\/hook\/sn_[0-9a-f]+\/[0-9a-f]{64}$/, { timeout: 15_000 });
  const before = await url.inputValue();
  await expect(when.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled();
  await expect(when.getByRole('button', { name: 'Copy Secret' })).toBeVisible();
  await expect(when).toContainText('it’s live while this sentinel is on');
  await shoot(page, 'webhook');
  await when.getByRole('button', { name: 'Rotate Secret…' }).click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: /A new secret/ }));
  await expect(confirm).toContainText('the old ones stop working at once');
  await confirm.getByRole('button', { name: 'Rotate Secret' }).click();
  await expect(url).not.toHaveValue(before);
  await expect(url).toHaveValue(/\/[0-9a-f]{64}$/);
});

test('a recipe: the twelve to start from, Nightly tests made with the sentinel that fixes it, turned on', async ({ page }) => {
  await openList(page);
  const before = await main(page).locator('[data-sentinel]').count();
  await main(page).getByRole('button', { name: 'New Sentinel' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'New Sentinel' });
  await sheet.getByRole('tab', { name: /Recipe/ }).click();
  const recipes = sheet.getByRole('list', { name: 'Recipes', exact: true });
  await expect(recipes.getByRole('listitem')).toHaveCount(12);
  // And six that keep numbers, apart.
  await expect(sheet.getByRole('list', { name: 'Keep the numbers' }).getByRole('listitem')).toHaveCount(6);
  await expect(sheet.locator('[data-recipe="site-speed"]')).toContainText('Every 3 hours');
  await expect(recipes.locator('[data-recipe="fix-and-ship"]')).toContainText('When Sentry sees a new issue');
  await expect(recipes.locator('[data-recipe="review-new-prs"]')).toContainText('When a pull request opens');
  await sheet.getByRole('combobox', { name: 'Where it works' }).click();
  await page.getByRole('option', { name: 'bob-api' }).click();
  await shoot(page, 'recipes');
  await recipes.locator('[data-recipe="nightly-tests"]').click();
  // Its page, filled in and paused: Turn On is the main button.
  await expect(main(page).locator('[data-sentinel-page]')).toBeVisible();
  await expect(main(page).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Nightly tests');
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText('Every day at 2:00');
  await expect(main(page).getByRole('region', { name: 'Steps' }).getByRole('textbox', { name: 'Step 1’s name' })).toHaveValue('Run the tests');
  await main(page).getByRole('button', { name: 'Turn On' }).first().click();
  await expect(main(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await shoot(page, 'recipe-on');
  // The second sentinel came with it, waiting for the first to fail (paused until you turn it on too).
  await openList(page);
  await expect(main(page).locator('[data-sentinel]')).toHaveCount(before + 2);
  await expect(main(page).getByRole('row', { name: /^Fix the nightly failure, After “Nightly tests” fails/ })).toBeVisible();
  await main(page).getByRole('row', { name: /^Fix the nightly failure/ }).click();
  const steps = main(page).getByRole('region', { name: 'Steps' });
  await expect(steps.locator('[data-step]')).toHaveCount(3);
  await expect(steps.locator('[data-step="pr"]')).toBeVisible();
  await shoot(page, 'recipe-after');
});

// ---------------------------------------------------------------- numbers and dashboards (§10)

test('a sentinel’s Numbers: tiles with their change, compare, a chart over time whose point opens its run', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Stripe revenue/ }).click();
  const numbers = main(page).getByTestId('sentinel-numbers');
  await expect(numbers.getByRole('listitem')).toHaveCount(3);
  const revenue = numbers.locator('[data-metric="revenue"]');
  await expect(revenue).toContainText('$3,412');
  await expect(revenue).toContainText('+$232 (+7.3%)');
  await expect(revenue.locator('[data-tone="good"]')).toBeVisible();
  // Fewer failed payments is good: down from 3 to 1 shows green.
  await expect(numbers.locator('[data-metric="failed-payments"] [data-tone="good"]')).toContainText('−2');
  await numbers.getByRole('tab', { name: 'Last week' }).click();
  await expect(revenue).toContainText('+$602 (+21.4%)');
  await expect(revenue).toContainText('vs last week');
  await numbers.getByRole('tab', { name: 'Previous' }).click();
  await revenue.getByRole('button').click();
  const chart = numbers.getByTestId('sentinel-number-chart');
  await expect(chart).toContainText('Revenue over time');
  await expect(chart).toContainText('8 points');
  await expect(chart.locator('.recharts-surface')).toBeVisible();
  await numbers.scrollIntoViewIfNeeded();
  await chart.scrollIntoViewIfNeeded();
  await shoot(page, 'numbers');
  // A point opens its run.
  const box = (await chart.locator('.recharts-surface').boundingBox())!;
  await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2, { steps: 4 });
  await expect(chart.locator('.recharts-tooltip-wrapper')).toContainText('$3,412');
  await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2);
  await expect(main(page).locator('[data-run-page]')).toBeVisible();
  await expect(main(page).getByText(/^Stripe revenue · ran by schedule/)).toBeVisible();
});

test('Kept data: every number’s whole history to look at and export, and the files its runs kept, opened in Beluga (BLG-392)', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Stripe revenue/ }).click();
  const kept = main(page).getByTestId('sentinel-data');
  await kept.scrollIntoViewIfNeeded();
  const revenue = kept.locator('[data-metric="revenue"]');
  await expect(revenue).toContainText('Revenue');
  await expect(revenue).toContainText('8 runs');
  await shoot(page, 'kept-data');
  await revenue.click();
  const sheet = page.getByRole('dialog', { name: 'Revenue' });
  await expect(sheet).toContainText('8 runs, since');
  await expect(sheet.getByRole('columnheader', { name: 'Kept' })).toBeVisible();
  await expect(sheet.getByRole('cell', { name: '$3,412' }).or(sheet.getByRole('cell', { name: '3,412' })).first()).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  await expect(sheet.getByRole('button', { name: 'Show in Finder' })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'kept-data-history.png') });
  await sheet.getByRole('button', { name: 'Close' }).click();
  // A run's file: its steps' outputs, opened in the viewer (redacted, as everywhere).
  const run = kept.locator('[data-run]').first();
  await run.getByRole('button').nth(1).click();
  const file = page.getByRole('dialog');
  await expect(file.getByRole('button', { name: 'Show in Finder' })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'kept-data-file.png') });
  await file.getByRole('button', { name: 'Close' }).click();
  // Last job run's documents are its runs' files too.
  await openList(page);
  await main(page).getByRole('row', { name: /^Last job run/ }).click();
  const jobs = main(page).getByTestId('sentinel-data');
  await jobs.getByRole('button', { name: 'deploy landing.html' }).click();
  await expect(page.getByRole('dialog', { name: 'deploy landing.html' }).frameLocator('iframe').getByRole('heading', { name: 'deploy landing' })).toBeVisible();
});

test('Keep the numbers on a page: what it reads, each number with where it is, its unit and which way is good', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Site speed/ }).click();
  const steps = main(page).getByRole('region', { name: 'Steps' });
  const measure = steps.locator('[data-step="measure"]');
  await expect(measure).toContainText('Keep the numbers · Keeps Home page from the step before');
  await measure.getByRole('button', { name: 'Show its fields' }).click();
  await expect(measure.getByRole('combobox', { name: 'What it reads' })).toContainText('The step before');
  await expect(measure.getByRole('textbox', { name: 'Number 1’s label' })).toHaveValue('Home page');
  await expect(measure.getByRole('combobox', { name: 'Number 1’s unit' })).toContainText('Milliseconds');
  await expect(measure.getByRole('combobox', { name: 'Which way number 1 is good' })).toContainText('Down is good');
  // Its numbers: about 380 ms, a load time where down is good.
  await expect(main(page).getByTestId('sentinel-numbers').locator('[data-metric="home"]')).toContainText(/\d{3} ms/);
  await shoot(page, 'measure-step');
});

test('one Sentinel row, one page: the old Dashboard and Chat links land on it', async ({ page }) => {
  await openList(page);
  // No Dashboard row of its own in the sidebar, and no tabs: the board and the chat are Sentinel's page.
  await expect(sidebar(page).getByRole('button', { name: /^Dashboard/ })).toHaveCount(0);
  await expect(main(page).getByRole('tablist', { name: 'Sentinel' })).toHaveCount(0);
  await expect(main(page).locator('[data-dashboard]')).toBeVisible({ timeout: 20_000 });
  // Ask Sentinel is docked beside the page.
  await expect(main(page).locator('[data-sentinel-chat]')).toBeVisible();
  // The sidebar's Sentinel row stays selected with the chat open.
  await expect(sidebar(page).getByRole('button', { name: /^Sentinel/ })).toHaveAttribute('aria-current', /.+/);
  await main(page).getByRole('complementary', { name: 'Ask Sentinel' }).getByRole('button', { name: 'Close' }).click();
  await expect(main(page).locator('[data-sentinel-chat]')).toHaveCount(0);
  // ⌘K › Go to Dashboard still works: it lands on the page, the board in view.
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('Go to Dashboard');
  await page.keyboard.press('Enter');
  await expect(main(page).getByRole('region', { name: 'At a glance' })).toBeVisible();
});

/** The board picker's menu (named by its button, "Board: Overview"). */
const boardsMenu = (page: Page) => page.getByRole('menu', { name: /^Board: / });

/** Open At a glance's board picker (the page may still be settling as the demo's runs land: try again until it's open). */
async function openBoards(page: Page): Promise<void> {
  await expect(async () => {
    if (!(await boardsMenu(page).isVisible())) await main(page).getByRole('button', { name: /^Board: / }).click();
    await expect(boardsMenu(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Show another board in At a glance (its picker). */
async function pickBoard(page: Page, name: string): Promise<void> {
  await openBoards(page);
  await boardsMenu(page).getByText(name, { exact: true }).click();
  await expect(main(page).getByRole('button', { name: `Board: ${name}` })).toBeVisible();
}

test('the Dashboard: every kind of tile (numbers, series, a table, outputs from Claude and from an API, text, dividers), compare, Refresh', async ({ page }) => {
  await openList(page);
  const board = main(page).locator('[data-dashboard]');
  await expect(board).toBeVisible({ timeout: 20_000 });
  await expect(main(page).getByRole('button', { name: 'Board: Overview' })).toBeVisible();
  await openBoards(page);
  await expect(boardsMenu(page)).toContainText('Revenue');
  await expect(boardsMenu(page)).toContainText('Ops');
  await page.keyboard.press('Escape');
  for (const kind of ['number', 'series', 'table', 'output', 'text', 'divider']) await expect(board.locator(`[data-kind="${kind}"]`).first()).toBeVisible();
  await expect(board.locator('[data-kind="number"]').first()).toContainText('$3,412');
  // A series over time and a kept array (signups by day, as bars).
  await expect(board.locator('[data-kind="series"]')).toHaveCount(2);
  await expect(board.locator('[data-kind="series"]').nth(1)).toContainText('Signups by day');
  await expect(board.locator('[data-kind="series"]').nth(1).locator('.recharts-surface')).toBeVisible();
  // Outputs: the Morning brief's Claude step as Markdown, YouTube's answer as a JSON tree; each links its run.
  const brief = board.locator('[data-kind="output"]').filter({ hasText: 'This morning’s brief' });
  await expect(brief.locator('[data-look="markdown"]')).toContainText('3 commits landed');
  const youtube = board.locator('[data-kind="output"]').filter({ hasText: 'YouTube’s answer' });
  await expect(youtube.locator('[data-look="tree"]')).toContainText('subscriberCount');
  await expect(youtube.getByRole('button', { name: /Open the run/ })).toBeVisible();
  await expect(brief).toHaveAttribute('data-h', '2');
  // Last job run is paused: its table says so, quietly, and still shows its rows.
  const jobs = board.locator('[data-kind="table"]');
  await expect(jobs).toHaveAttribute('data-state', 'paused');
  await expect(jobs).toContainText('deploy landing');
  // Its columns as typed (BLG-381): headings from their labels, a person, a badge, a bar, a log that opens.
  await expect(jobs.getByRole('columnheader', { name: 'Finished' })).toBeVisible();
  await expect(jobs.getByText('Lena', { exact: true })).toBeVisible();
  await expect(jobs.locator('[title="62%"]')).toBeVisible();
  await jobs.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'dashboard-typed-table.png') });
  await jobs.getByRole('button', { name: 'Open log' }).first().click();
  const log = page.getByRole('dialog', { name: 'deploy landing.html' });
  await expect(log.frameLocator('iframe').getByRole('heading', { name: 'deploy landing' })).toBeVisible();
  await expect(log.getByRole('button', { name: 'Open in Default App' })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'dashboard-document.png') });
  await log.getByRole('button', { name: 'Close' }).click();
  await expect(log).toBeHidden();
  // A kind Beluga can't show says what it is, and offers its app and Finder.
  await jobs.getByRole('button', { name: 'nightly tests.zip' }).click();
  const zip = page.getByRole('dialog', { name: 'nightly tests.zip' });
  await expect(zip).toContainText('ZIP archive');
  await expect(zip).toContainText('Beluga can’t show a ZIP archive here');
  await expect(zip.getByRole('button', { name: 'Show in Finder' })).toBeVisible();
  await expect(zip.getByRole('button', { name: 'Open in Default App' })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'dashboard-document-info.png') });
  await zip.getByRole('button', { name: 'Close' }).click();
  await expect(zip).toBeHidden();
  await expect(board.locator('[data-kind="text"]')).toContainText('$3,412 yesterday');
  await shoot(page, 'dashboard');
  await brief.scrollIntoViewIfNeeded();
  await shoot(page, 'dashboard-outputs');
  // A tile's ⋯: Show as a table turns YouTube's answer into rows.
  await youtube.hover();
  await youtube.getByRole('button', { name: /^More for / }).click();
  // By the keyboard (the grid redraws as the demo's runs go on, so a hovered submenu can move under the pointer).
  await page.getByRole('menuitem', { name: 'Show as' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('menuitem', { name: 'A table' }).or(page.getByRole('menuitemcheckbox', { name: 'A table' })).focus();
  await page.keyboard.press('Enter');
  await expect(youtube.locator('[data-look="table"]')).toContainText('youtube#channel');
  await main(page).getByRole('button', { name: /^Compare: / }).click();
  await page.getByRole('menu', { name: /^Compare: / }).getByText('vs last week').click();
  await expect(board.locator('[data-kind="number"]').first()).toContainText('vs last week');
  await main(page).getByRole('button', { name: /^Compare: / }).click();
  await page.getByRole('menu', { name: /^Compare: / }).getByText('vs the run before').click();
  // Refresh on Ops runs its sentinels one at a time (Last job run is paused: two run).
  await pickBoard(page, 'Ops');
  await expect(board.locator('[data-tile]')).toHaveCount(4);
  await main(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(main(page).getByTestId('dashboard-fetching')).toContainText(/Fetching… \d of 2/);
  await expect(main(page).getByTestId('dashboard-fetching')).toHaveCount(0, { timeout: 40_000 });
});

test('Rename… on a number tile: its label turns into a field, and Enter keeps the new title', async ({ page }) => {
  await openList(page);
  const board = main(page).locator('[data-dashboard]');
  await expect(board).toBeVisible({ timeout: 20_000 });
  const tile = board.locator('[data-kind="number"]').first();
  const id = await tile.getAttribute('data-tile');
  const same = board.locator(`[data-tile="${id}"]`);
  await tile.hover();
  await tile.getByRole('button', { name: /^More for / }).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const field = same.getByRole('textbox', { name: 'Tile title' });
  await expect(field).toBeFocused();
  await field.fill('Money in');
  await page.keyboard.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(same).toContainText('Money in');
  await shoot(page, 'dashboard-renamed');
});

test('a tile goes anywhere on the grid, like a home screen: dropped with an empty row above it, it stays there; the logo shows in full colour', async ({ page }) => {
  await openList(page);
  const board = main(page).locator('[data-dashboard]');
  await pickBoard(page, 'Ops');
  await expect(board.locator('[data-tile]')).toHaveCount(4);
  const grid = board.getByRole('list', { name: /’s tiles$/ });
  const tile = board.locator('[data-kind="number"]').first();
  const id = (await tile.getAttribute('data-tile'))!;
  const same = board.locator(`[data-tile="${id}"]`);
  await same.scrollIntoViewIfNeeded();
  // The far-right column, two rows below the last: an empty row is left above it.
  const g = (await grid.boundingBox())!;
  const t = (await same.boundingBox())!;
  const step = (g.width + 10) / 6;
  const width = Math.round((t.width + 10) / step);
  const to = { x: g.x + step * (6 - width) + 20, y: g.y + g.height + 116 + 10 + 20 };
  await grid.screenshot({ path: path.join(shots, 'sentinel-dashboard-unplaced.png') });
  await page.mouse.move(t.x + 20, t.y + 20);
  await page.mouse.down();
  await page.mouse.move(t.x + 40, t.y + 40, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  // While it's lifted, only where it lands shows: the grid's empty cells stay unseen.
  await expect(grid.locator(':scope > [aria-hidden="true"]').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await grid.screenshot({ path: path.join(shots, 'sentinel-dashboard-snapping.png') });
  await page.mouse.up();
  await expect(same).toHaveCSS('grid-column-start', String(7 - width));
  await expect(async () => {
    const b = (await same.boundingBox())!;
    const now = (await grid.boundingBox())!;
    expect(b.x + b.width).toBeGreaterThan(now.x + now.width - 4);
    // An empty row between it and the tiles above (measured from the board's top: the pane may have scrolled).
    expect(b.y - now.y).toBeGreaterThan(g.height + 100);
  }).toPass();
  // The project's logo isn't greyed out until hovered.
  const logo = board.locator('[data-tile] [aria-label^="From "] > *').first();
  if (await logo.count()) await expect(logo).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await grid.screenshot({ path: path.join(shots, 'sentinel-dashboard-snapped.png') });
  await shoot(page, 'dashboard-placed');
});

test('Add a Tile takes a description: Claude adds it, and sets up a draft sentinel when nothing fetches it yet', async ({ page }) => {
  await openList(page);
  const board = main(page).locator('[data-dashboard]');
  await pickBoard(page, 'Ops');
  await expect(board.locator('[data-tile]')).toHaveCount(4);
  await main(page).getByRole('button', { name: 'Add to the board' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add to Ops' });
  await sheet.getByRole('textbox', { name: 'What should it show?' }).fill('the open PR count');
  await shoot(page, 'add-tile-describe');
  await sheet.getByRole('button', { name: 'Ask Your Agent' }).click();
  // Nothing kept it: Claude set up a draft that fetches it, and the tile says so until it's on.
  const draft = main(page).getByTestId('dashboard-draft');
  await expect(draft).toContainText('Open pull requests', { timeout: 30_000 });
  await expect(draft).toContainText('nothing runs until you turn it on');
  await expect(board.locator('[data-tile]')).toHaveCount(5);
  await expect(board.locator('[data-tile]').last()).toHaveAttribute('data-state', 'draft');
  await expect(board.locator('[data-tile]').last()).toContainText('draft: turn it on');
  await expect(main(page).getByTestId('dashboard-ask')).toContainText('set up');
  await shoot(page, 'add-tile-draft');
  // Review opens the draft: paused, with its steps; nothing ran.
  await draft.getByRole('button', { name: 'Review' }).click();
  await expect(main(page).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Open pull requests');
  await expect(main(page).getByRole('region', { name: 'Steps' }).locator('[data-step="measure"]')).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Turn On' }).first()).toBeVisible();
  // Pick it yourself is one tap away: a series of a kept array, sized.
  await main(page).getByRole('button', { name: /^Back/ }).first().click().catch(() => undefined);
  await openList(page);
  await pickBoard(page, 'Ops');
  await main(page).getByRole('button', { name: 'Add to the board' }).click();
  // Pick it: what's kept on the left, how it looks on the right (pictures, sizes as shapes, a preview).
  await sheet.getByRole('option', { name: /^Signups by day/ }).first().click();
  await expect(sheet.getByRole('radiogroup', { name: 'Show it as' }).getByRole('radio')).toHaveCount(2);
  await sheet.getByRole('radio', { name: 'Bars' }).click();
  await sheet.getByRole('radiogroup', { name: 'Size' }).getByRole('radio', { name: 'Big' }).click();
  await expect(sheet.getByTestId('tile-preview').locator('.recharts-surface')).toBeVisible();
  await shoot(page, 'add-tile-pick');
  // Somewhere new asks what from it, with ideas.
  await sheet.locator('[data-source="stripe"]').first().click();
  await expect(sheet.getByRole('button', { name: 'Revenue per day' })).toBeVisible();
  await shoot(page, 'add-tile-new');
  await sheet.getByRole('option', { name: /^Signups by day/ }).first().click();
  await sheet.getByRole('radio', { name: 'Bars' }).click();
  await sheet.getByRole('button', { name: 'Add to Ops' }).click();
  await expect(board.locator('[data-tile]')).toHaveCount(6);
});

test('the Sentinel chat: its own conversation about all of Sentinel; a delete asks first; Clear and New Chat', async ({ page }) => {
  await openList(page);
  const chat = main(page).locator('[data-sentinel-chat]');
  await expect(chat).toBeVisible();
  // The demo's short exchange.
  await expect(chat).toContainText('What did my sentinels find this week?');
  await expect(chat).toContainText('Site speed slowed');
  await shoot(page, 'chat');
  // Quiet: it isn't one of the sidebar's chats, nor in Unread.
  await expect(sidebar(page)).not.toContainText('What did my sentinels find');
  // Ask it to delete a sentinel: it asks you first, in the chat (and on the phone).
  const box = chat.getByRole('textbox').last();
  await box.fill('Delete the Site speed sentinel');
  await box.press('Enter');
  const card = chat.getByRole('alertdialog', { name: 'Approval needed' });
  await expect(card).toContainText('Your Claude wants to delete the sentinel “Site speed”', { timeout: 30_000 });
  await expect(card.getByRole('button', { name: 'Allow once' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Always' })).toHaveCount(0);
  await shoot(page, 'chat-delete-asks');
  await card.getByRole('button', { name: 'Decline' }).click();
  await expect(chat).toContainText('You said no, so “Site speed” keeps watching.', { timeout: 30_000 });
  // It still watches (the page is beside the chat).
  await expect(main(page).getByRole('row', { name: /^Site speed/ })).toBeVisible();
  // Clear empties it (the chat stays); New Chat makes another beside it, the picker goes between them.
  await chat.getByRole('button', { name: 'More for this chat' }).click();
  await page.getByRole('menuitem', { name: /^Clear/ }).click();
  // Empty again, it offers what to ask: what it builds, with examples naming your projects, and
  // Claude looking at your projects to suggest (BLG-333, BLG-590).
  await expect(chat.getByRole('button', { name: 'Suggest Some for Me' })).toBeVisible();
  await chat.getByRole('radio', { name: 'Watchers' }).click();
  await expect(chat.getByRole('button', { name: /^A Morning Brief for / })).toBeVisible();
  await shoot(page, 'chat-empty');
  await chat.getByRole('button', { name: 'New Chat', exact: true }).click();
  await expect(main(page).locator('[data-sentinel-chat]')).not.toHaveAttribute('data-sentinel-chat', 'main');
  await expect(main(page).getByRole('button', { name: /^Chat: / })).toBeVisible();
});

test('a schedule every few minutes: Through the day’s Every menu, on the clock, with a word about the plan', async ({ page }) => {
  await openList(page);
  await main(page).getByRole('row', { name: /^Morning brief/ }).click();
  const when = main(page).getByRole('region', { name: 'When' });
  await when.getByRole('tab', { name: 'Through the day' }).click();
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText('Every 3 hours');
  await when.getByRole('combobox', { name: 'Every how long' }).click();
  await expect(page.getByRole('option')).toHaveText([/^minute/, /^5 minutes/, /^10 minutes/, /^15 minutes/, /^30 minutes/, /^hour/, /^2 hours/, /^3 hours/, /^6 hours/, /^12 hours/]);
  await page.getByRole('option', { name: /^15 minutes/ }).click();
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText('Every 15 minutes');
  await expect(when.getByRole('tab', { name: 'Through the day' })).toHaveAttribute('aria-selected', 'true');
  // Morning brief asks its agent: 96 times a day is worth saying.
  await expect(when).toContainText('Its agent step runs up to 96 times a day');
  await shoot(page, 'every-15-minutes');
  // Back as it was.
  await when.getByRole('tab', { name: 'Every day' }).click();
  await expect(main(page).getByTestId('sentinel-sentence')).toHaveText('Every day at 7:00');
  await expect(when).not.toContainText('Its agent step runs up to');
});
