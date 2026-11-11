import { expect, test, type Locator, type Page } from './fixtures.js';

/** The Usage view against the demo: plan meters, this week, disk by project, sorting, and putting things away. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const breakdown = (page: Page) => page.getByRole('table', { name: 'Disk and agent usage by workspace' });

/** "661k" / "1.0M" / "950" → a number, to check an order. */
const count = (text: string): number => {
  const m = /([\d.]+)\s*([kM]?)/.exec(text);
  if (!m) return 0;
  return Number(m[1]) * (m[2] === 'M' ? 1_000_000 : m[2] === 'k' ? 1000 : 1);
};
/** "28 KB" / "1.2 GB" → bytes. */
const bytes = (text: string): number => {
  const m = /([\d.]+)\s*(B|KB|MB|GB|TB)/.exec(text);
  if (!m) return 0;
  return Number(m[1]) * 1024 ** ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(m[2]!);
};
const descending = (xs: readonly number[]): boolean => xs.every((x, i) => i === 0 || xs[i - 1]! >= x);

/** The Claude cell (third) of each worktree row in a project's group, as token counts. */
async function tokensIn(group: Locator): Promise<number[]> {
  const rows = group.locator('[role=row][aria-label]');
  const cells = await rows.evaluateAll((els) => els.map((el) => el.children[2]?.textContent ?? ''));
  return cells.map(count);
}

async function openUsage(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Usage', exact: true }).click();
  await expect(page.getByText('in worktrees')).toBeVisible();
}

test('shows your plan, this week, and disk space by project', async ({ page }) => {
  await openUsage(page);
  const claude = page.getByRole('region', { name: 'Claude usage' });
  await expect(claude.getByRole('meter', { name: /5-hour: \d+% used/ })).toBeVisible();
  await expect(claude.getByRole('meter', { name: /Weekly: \d+% used/ })).toBeVisible();
  // Friends' windows, compact: every provider of theirs that shares a plan.
  const friends = page.getByRole('list', { name: 'Friends’ agent plan usage' });
  await expect(friends.getByRole('meter', { name: /^bob’s Claude: 5-hour/ })).toBeVisible();
  await expect(friends.getByRole('meter', { name: /^mia’s Codex: 5-hour/ })).toBeVisible();
  // A bar a day, this week's tokens and cost on top.
  await expect(page.getByRole('list', { name: 'Agent tokens per day, by project' }).getByRole('listitem')).toHaveCount(14);
  // Disk by project: a segment per project, and its legend jumps to the project's rows.
  const stack = page.getByRole('group', { name: 'Disk space by project' });
  await expect(stack.getByRole('button', { name: /^bob-api: / })).toBeVisible();
  await expect(breakdown(page).getByRole('rowheader', { name: /bob-api/ })).toBeVisible();
});

test('a card per provider, and the chip that makes one your default', async ({ page }) => {
  await openUsage(page);
  const claude = page.getByRole('region', { name: 'Claude usage' });
  const codex = page.getByRole('region', { name: 'Codex usage' });
  const local = page.getByRole('region', { name: 'Local usage' });
  // Quota windows where the plan has them, tokens and speed where not.
  await expect(codex.getByRole('meter', { name: /Weekly: 24% used/ })).toBeVisible();
  await expect(local.getByText('tok/s')).toBeVisible();
  await expect(local.getByRole('meter')).toHaveCount(0);
  await expect(claude.getByText('Default')).toBeVisible();
  await page.getByRole('main').screenshot({ path: '../../.beluga/scratch/01-usage-provider-cards.png' }).catch(() => undefined);
  await codex.getByRole('button', { name: 'Make Codex your default agent' }).click();
  await expect(codex.getByText('Default', { exact: true })).toBeVisible();
  await expect(claude.getByRole('button', { name: 'Make Claude your default agent' })).toBeVisible();
  // Details one tap away.
  await codex.getByRole('button', { name: 'Details' }).click();
  await expect(codex.getByText('gpt-5')).toBeVisible();
  await claude.getByRole('button', { name: 'Make Claude your default agent' }).click();
  await expect(claude.getByText('Default', { exact: true })).toBeVisible();
});

test('sorts the breakdown by size, tokens or recent, and remembers it', async ({ page }) => {
  await openUsage(page);
  const sort = page.getByRole('tablist', { name: 'Sort by' });
  await expect(sort.getByRole('tab', { name: 'Size' })).toHaveAttribute('aria-selected', 'true');
  // Projects: biggest on disk first.
  const heads = breakdown(page).getByRole('rowheader');
  await expect(heads.first()).toBeVisible();
  const disks = await breakdown(page).getByRole('rowgroup').evaluateAll((groups) => groups.map((g) => g.querySelector('[role=row]')?.children[1]?.textContent ?? ''));
  expect(descending(disks.map(bytes))).toBe(true);

  await sort.getByRole('tab', { name: 'Tokens' }).click();
  await expect(sort.getByRole('tab', { name: 'Tokens' })).toHaveAttribute('aria-selected', 'true');
  const api = breakdown(page).getByRole('rowgroup').filter({ has: page.getByRole('rowheader', { name: /bob-api/ }) });
  // The main folder stays first; the worktrees and chats follow, most tokens first.
  const tokens = (await tokensIn(api)).slice(1);
  expect(tokens.length).toBeGreaterThan(1);
  expect(descending(tokens)).toBe(true);

  await page.reload();
  await sidebar(page).getByRole('button', { name: 'Usage', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Sort by' }).getByRole('tab', { name: 'Tokens' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tablist', { name: 'Sort by' }).getByRole('tab', { name: 'Recent' }).click();
  await expect(page.getByRole('tablist', { name: 'Sort by' }).getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tablist', { name: 'Sort by' }).getByRole('tab', { name: 'Size' }).click();
});

test('Archive on a row asks first, and Cancel keeps the worktree', async ({ page }) => {
  await openUsage(page);
  const row = breakdown(page).getByRole('row', { name: 'add-auth', exact: true });
  await row.hover();
  await row.getByRole('button', { name: 'Archive add-auth…' }).click();
  const alert = page.getByRole('alertdialog', { name: /Archive “add-auth”\?/ });
  await expect(alert).toBeVisible();
  await expect(alert.getByText(/Everything of yours is kept/)).toBeVisible();
  await expect(alert.getByText(/branch .* and the conversation stay/)).toBeVisible();
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toBeHidden();
  await expect(row).toBeVisible();
});

test('Free up space lists what is safe to put away, and cleans it up after asking', async ({ page }) => {
  await openUsage(page);
  const card = page.getByRole('region', { name: 'Free up space' });
  await expect(card.getByRole('heading', { name: /^Free up / })).toBeVisible();
  await card.getByRole('button', { name: 'Clean Up…' }).click();
  const alert = page.getByRole('alertdialog');
  await expect(alert.getByRole('cell', { name: /sub-agent worktrees/ })).toBeVisible();
  // Cancel first: nothing happens.
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Clean Up…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^(Remove|Clean Up|Archive)$/ }).click();
  await expect(page.getByText(/Removed \d+ finished agent worktree/)).toBeVisible();
  await expect(card).toBeHidden({ timeout: 15_000 });
});

test('your stats: a number per thing, the year, and each project or agent ranked', async ({ page }) => {
  await openUsage(page);
  const stats = page.getByRole('region', { name: 'Your stats' });
  const strip = stats.getByRole('tablist', { name: 'What to show' });
  await expect(strip.getByRole('tab')).toHaveCount(8);
  await expect(strip.getByRole('tab', { name: /Agent time/ })).toHaveAttribute('aria-selected', 'true');
  // A square a day for the last year, coloured by the picked number.
  await expect(stats.getByRole('grid', { name: 'Agent time per day, the last year' }).getByRole('gridcell')).toHaveCount(53 * 7);
  // Pressing another number moves the calendar and the ranking to it.
  await strip.getByRole('tab', { name: /PRs merged/ }).click();
  await expect(stats.getByRole('grid', { name: 'PRs merged per day, the last year' })).toBeVisible();
  const byProject = stats.getByRole('list', { name: 'PRs merged by project' });
  await expect(byProject.getByRole('listitem').first()).toBeVisible();
  // By agent: Claude, Codex and a local model each get a bar (over the year: the demo's PRs fall on
  // days that move with the date, so a month may hold only Claude's).
  await stats.getByRole('tab', { name: 'Agents' }).click();
  await stats.getByRole('tablist', { name: 'Range' }).getByRole('tab', { name: 'Year' }).click();
  const byAgent = stats.getByRole('list', { name: 'PRs merged by agent' });
  await expect(byAgent.getByText('Claude', { exact: true })).toBeVisible();
  await expect(byAgent.getByText('Codex', { exact: true })).toBeVisible();
  // When you work, and a few highlights.
  await expect(stats.getByRole('grid', { name: 'Prompts by weekday and hour' }).getByRole('gridcell')).toHaveCount(168);
  await expect(stats.getByRole('list', { name: 'Highlights' }).getByText('Longest streak')).toBeVisible();
});

test('the trend: a band per agent, pointing shows the step, a name hides its band', async ({ page }) => {
  await openUsage(page);
  const stats = page.getByRole('region', { name: 'Your stats' });
  await stats.getByRole('tab', { name: 'Agents' }).click();
  const chart = stats.getByRole('img', { name: /over time: .*Claude/ });
  await expect(chart).toBeVisible();
  // Pointing at a step shows its numbers.
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await expect(chart.getByText('Claude')).toBeVisible();
  // A name below the chart leaves its band out, and brings it back.
  const legend = stats.getByRole('group', { name: 'Show or hide' });
  await legend.getByRole('button', { name: /^Codex/ }).click();
  await expect(legend.getByRole('button', { name: /^Codex/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(chart).not.toHaveAttribute('aria-label', /Codex/);
  await legend.getByRole('button', { name: /^Codex/ }).click();
  await expect(chart).toHaveAttribute('aria-label', /Codex/);
  // Share: each step as parts of 100%.
  await stats.getByRole('tab', { name: 'Share' }).click();
  await expect(stats.getByText('100%').first()).toBeVisible();
});

test('sessions: how much of each 5-hour session and each week you used', async ({ page }) => {
  await openUsage(page);
  const sessions = page.getByRole('region', { name: 'Plan sessions' });
  await expect(sessions.getByText(/of each session used, on average/)).toBeVisible();
  const blocks = sessions.getByRole('list', { name: '5-hour sessions, the last 7 days' }).getByRole('listitem');
  // The newest one: the oldest may be a sliver at the edge, mostly before these 7 days, under the next.
  await expect(blocks.last()).toBeVisible();
  await blocks.last().hover();
  await expect(sessions.getByText(/% used/)).toBeVisible();
  await sessions.getByRole('tab', { name: 'Weekly' }).click();
  await expect(sessions.getByRole('list', { name: 'Weeks, the last six' }).getByRole('listitem')).toHaveCount(6);
  // Codex here has 5-hour sessions only: nothing to switch between, so no switch.
  await sessions.getByRole('tab', { name: 'Codex' }).click();
  await expect(sessions.getByRole('tab', { name: '5-hour' })).toHaveCount(0);
  await expect(sessions.getByText(/of each session used/)).toBeVisible();
});

test('your card: a title earned from your stats, and the others to wear', async ({ page }) => {
  await openUsage(page);
  // The whole window: no panel beside Usage.
  await expect(page.locator('aside[aria-label="Panel"]')).toHaveAttribute('aria-hidden', 'true');
  const card = page.getByRole('region', { name: 'Your card' });
  const title = card.getByRole('heading', { level: 1 });
  await expect(title).toBeVisible();
  await expect(card.getByText(/^Because: /)).toBeVisible();
  // The 3D pass hangs on its lanyard.
  await expect(card.locator('canvas')).toBeVisible();
  // Wear another title, and go back.
  const first = await title.textContent();
  const chip = card.getByRole('button', { name: 'Code God' });
  await chip.click();
  await expect(title).toHaveText('Code God');
  await card.getByRole('button', { name: `Back to ${first}` }).click();
  await expect(title).toHaveText(first!);
});

test('your recap: a slide at a time, keys and clicks, your title at the end', async ({ page }) => {
  await openUsage(page);
  await page.getByRole('button', { name: 'Play Your Recap' }).click();
  const recap = page.getByRole('dialog', { name: 'Your recap' });
  await expect(recap.getByText('Your Beluga, so far')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(recap.getByText('Your agents worked for')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(recap.getByText('Your Beluga, so far')).toBeVisible();
  // The last bar: your title, and the way out.
  const bars = recap.getByRole('tablist', { name: 'Slides' }).getByRole('tab');
  await bars.last().click();
  await expect(recap.getByText('All of which makes you')).toBeVisible();
  await recap.getByRole('button', { name: 'Back to Your Stats' }).click();
  await expect(recap).toHaveCount(0);
  // Esc leaves too.
  await page.getByRole('button', { name: 'Play Your Recap' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Your recap' })).toHaveCount(0);
});

test('share your stats: a picture to save or copy, from your card and from the recap', async ({ page }) => {
  await openUsage(page);
  const card = page.getByRole('region', { name: 'Your card' });
  await card.getByRole('button', { name: 'Share…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Share Your Stats' });
  await expect(sheet.getByRole('img', { name: /the picture you'll share/ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Save Image…' })).toBeEnabled();
  await expect(sheet.getByRole('button', { name: 'Copy Image' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  // The recap's last slide shares too.
  await card.getByRole('button', { name: 'Play Your Recap' }).click();
  const recap = page.getByRole('dialog', { name: 'Your recap' });
  await recap.getByRole('tablist', { name: 'Slides' }).getByRole('tab').last().click();
  await recap.getByRole('button', { name: 'Share…' }).click();
  await expect(page.getByRole('dialog', { name: 'Share Your Stats' })).toBeVisible();
});

test('the leaderboard: standings by points, and each number head to head with how much more', async ({ page }) => {
  await openUsage(page);
  const board = page.getByRole('region', { name: 'Leaderboard' });
  await board.scrollIntoViewIfNeeded();
  // bob and mia's Macs send their numbers over the demo network.
  const standings = board.getByRole('list', { name: 'Standings' });
  await expect(standings.getByRole('listitem')).toHaveCount(3);
  await expect(standings.getByRole('listitem', { name: /^\d\. You, \d+ points$/ })).toBeVisible();
  for (const name of ['Prompt characters', 'Pull requests merged', 'Agent hours']) {
    const versus = board.getByRole('region', { name });
    await expect(versus.getByRole('img', { name: /^bob: / })).toBeVisible();
    await expect(versus.getByRole('img', { name: /^You: / })).toBeVisible();
  }
  await expect(board.getByRole('region', { name: 'Prompt characters' }).getByText(/^bob wrote [\d.]+× as much as you$/)).toBeVisible();
  await board.getByRole('tab', { name: 'Year' }).click();
  await expect(standings.getByRole('listitem')).toHaveCount(3);
});
