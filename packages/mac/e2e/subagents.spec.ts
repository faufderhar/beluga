import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Sub-agents are Claude's helpers, not your worktrees: a pretend Claude Code session in the demo's
 * bob-api project starts a sub-agent in its own worktree (one the demo made under
 * .claude/worktrees). The sidebar shows it under what started it, with a robot, not as a
 * worktree; its page follows it live with its model and effort. An old sub-agent worktree with
 * nothing to tie it to isn't listed at all (it would only jump away when clicked).
 */

test.describe.configure({ mode: 'serial' });

const SID = '5a0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
const AGENT = 'a3f9c1e07b2d';
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const iso = (ms: number): string => new Date(ms).toISOString();
const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SHOTS) return;
  // Screenshots only: let animations settle so the picture is still.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

/** bob-api unfolded (projects start folded) and its "Agents" row open: the main folder's sub-agents. */
async function showAgents(page: Page): Promise<void> {
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  const agents = sidebar(page).getByRole('group', { name: 'Sub-agents in bob-api' }).getByRole('button', { name: /^Agents/ });
  await expect(agents).toBeVisible({ timeout: 25_000 });
  if ((await agents.getAttribute('aria-expanded')) !== 'true') await agents.click();
}

let root = '';
let agentFile = '';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a sub-agent shows under what started it, as a robot, not as a worktree', async ({ page }) => {
  // The demo's projects sit side by side; a project row's tooltip is its folder (until it has news, so take either).
  const row = sidebar(page).locator('[title$="/bob-api"], [title$="/landing"]').first();
  await expect(row).toBeVisible();
  root = path.join(path.dirname((await row.getAttribute('title'))!), 'bob-api');
  const worktree = path.join(root, '.claude', 'worktrees', `agent-${AGENT}`);
  const folder = path.join(process.env.BELUGA_CLAUDE_HOME!, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  const agents = path.join(folder, SID, 'subagents');
  mkdirSync(agents, { recursive: true });
  const now = Date.now();
  writeFileSync(
    path.join(folder, `${SID}.jsonl`),
    line({ type: 'user', timestamp: iso(now - 4000), sessionId: SID, cwd: root, message: { role: 'user', content: 'Add tests for the webhook retries' } }) +
      line({ type: 'assistant', timestamp: iso(now - 3000), sessionId: SID, cwd: root, message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_W', name: 'Agent', input: { description: 'Write the webhook tests', subagent_type: 'typescript-reviewer', run_in_background: true, isolation: 'worktree' } }] } }),
  );
  writeFileSync(path.join(agents, `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: 'typescript-reviewer', description: 'Write the webhook tests', toolUseId: 'toolu_W', requestShape: 'background', model: 'sonnet', worktreePath: worktree, worktreeBranch: `agent-${AGENT}`, spawnedWithWorktree: true }));
  agentFile = path.join(agents, `agent-${AGENT}.jsonl`);
  const said = (content: unknown[], at: number) => line({ type: 'assistant', timestamp: iso(at), sessionId: SID, agentId: AGENT, isSidechain: true, cwd: worktree, effort: 'high', message: { role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content, usage: { input_tokens: 10, cache_read_input_tokens: 9000, output_tokens: 50 } } });
  writeFileSync(
    agentFile,
    line({ type: 'user', timestamp: iso(now - 2500), sessionId: SID, agentId: AGENT, isSidechain: true, cwd: worktree, message: { role: 'user', content: 'Write tests for the webhook retries' } }) +
      said([{ type: 'thinking', thinking: 'The retry logic lives in src/webhooks.ts; start by reading it.' }, { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: `${worktree}/src/webhooks.ts` } }], now - 2000),
  );

  // Under bob-api, as a sub-agent (robot, running), not among the worktrees: behind the project's
  // one "Agents" row (it started from the main folder), with projects folded until opened.
  await showAgents(page);
  const agent = sidebar(page).getByRole('button', { name: /^Sub-agent Write the webhook tests, Running/ });
  await expect(agent).toBeVisible({ timeout: 20_000 });
  await expect(sidebar(page).getByRole('button', { name: new RegExp(`^agent-${AGENT}`) })).toHaveCount(0);
  // The other agent worktree the demo has, which no conversation here started: not listed at all.
  await expect(sidebar(page).getByRole('button', { name: /^Sub-agents/ })).toHaveCount(0);
  // (Sub-agents earlier specs' conversations started may be listed under those; that worktree isn't.)
  const other = readdirSync(path.join(root, '.claude', 'worktrees')).find((n) => n.startsWith('agent-') && n !== `agent-${AGENT}`)!;
  await expect(sidebar(page).locator(`[data-subagent="${other.slice('agent-'.length)}"]`)).toHaveCount(0);
  await shot(page, 'subagents-sidebar');
});

test('a sub-agent that finished long ago stays under what started it, and stays put when opened', async ({ page }) => {
  // The demo's other agent worktree: an old session in bob-api started it (Beluga no longer follows that session).
  const other = readdirSync(path.join(root, '.claude', 'worktrees')).find((n) => n.startsWith('agent-') && n !== `agent-${AGENT}`)!;
  const wt = path.join(root, '.claude', 'worktrees', other);
  const folder = path.join(process.env.BELUGA_CLAUDE_HOME!, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  const old = '9b1c2d3e-4f50-4a6b-8c7d-8e9f00a1b2c4';
  const then = Date.now() - 3 * 86_400_000;
  mkdirSync(path.join(folder, old, 'subagents'), { recursive: true });
  writeFileSync(path.join(folder, `${old}.jsonl`), line({ type: 'user', timestamp: iso(then), sessionId: old, cwd: root, message: { role: 'user', content: 'Split the API work into packages' } }));
  const meta = path.join(folder, old, 'subagents', `${other}.meta.json`);
  writeFileSync(meta, JSON.stringify({ agentType: 'general-purpose', description: 'Retry policy package', worktreePath: wt, finished: true }));
  const transcript = path.join(folder, old, 'subagents', `${other}.jsonl`);
  writeFileSync(transcript, line({ type: 'user', timestamp: iso(then), sessionId: old, agentId: other.slice('agent-'.length), isSidechain: true, cwd: wt, message: { role: 'user', content: 'Write the retry policy package' } }));
  for (const f of [path.join(folder, `${old}.jsonl`), meta, transcript]) utimesSync(f, then / 1000, then / 1000);

  await showAgents(page);
  const row = sidebar(page).getByRole('button', { name: /^Sub-agent Retry policy package, Finished/ });
  await expect(row).toBeVisible({ timeout: 25_000 });
  await expect(row).toHaveAttribute('title', /started by “Split the API work into packages”/);
  await row.click();
  await expect(page.locator('main')).toContainText('Retry policy package', { timeout: 15_000 });
  // Opening it follows it live again: same place, same row (a fixed wait, on purpose: it doesn't move meanwhile).
  await page.waitForTimeout(2500);
  await expect(row).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: /^Sub-agent Retry policy package/ })).toHaveCount(1);
});

test('its page follows it live: who started it, model, effort, thinking and tools', async ({ page }) => {
  await showAgents(page);
  const row = sidebar(page).getByRole('button', { name: /^Sub-agent Write the webhook tests/ });
  await row.click();
  const monitor = page.locator(`[data-agent-monitor="${AGENT}"]`);
  await expect(monitor).toBeVisible({ timeout: 15_000 });
  // Clicking it doesn't move it: its row stays where it was, selected (a fixed wait, on purpose).
  await page.waitForTimeout(1500);
  await expect(row).toBeVisible();
  await expect(monitor).toContainText('a Claude Code session outside Beluga in bob-api');
  await expect(monitor).toContainText('Write the webhook tests');
  await expect(monitor).toContainText('Sonnet 5.5');
  await expect(monitor).toContainText('High effort');
  await expect(monitor).toContainText('Its own worktree');
  const log = page.getByRole('log', { name: 'Sub-agent Write the webhook tests' });
  await expect(log).toContainText('Write tests for the webhook retries');
  await expect(log).toContainText('webhooks.ts');
  // New lines show as they're written.
  appendFileSync(agentFile, line({ type: 'assistant', timestamp: iso(Date.now()), sessionId: SID, agentId: AGENT, isSidechain: true, cwd: path.join(root, '.claude', 'worktrees', `agent-${AGENT}`), effort: 'high', message: { role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r2', name: 'Bash', input: { command: 'npm test -- webhooks' } }] } }));
  await expect(log).toContainText('npm test', { timeout: 15_000 });
  // Started outside Beluga: you can watch, not steer from here.
  await expect(monitor).toContainText('started outside Beluga');
  // Never a place to start a conversation of your own.
  await expect(page.getByRole('button', { name: 'Start a Conversation Here' })).toHaveCount(0);
  await shot(page, 'subagent-monitor');
});

test('its Outputs: the screenshot and test log it made, wherever it put them, to look at', async ({ page }) => {
  await showAgents(page);
  await sidebar(page).getByRole('button', { name: /^Sub-agent Write the webhook tests/ }).click();
  const monitor = page.locator(`[data-agent-monitor="${AGENT}"]`);
  await expect(monitor).toBeVisible({ timeout: 15_000 });
  // It takes a screenshot (a real one: of this page) and runs the tests into a log, both in /tmp.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-out-'));
  const png = path.join(tmp, '01-webhooks-page.png');
  await page.screenshot({ path: png });
  writeFileSync(path.join(tmp, 'tests.log'), ' FAIL  src/webhooks.test.ts > retries 3 times\n   expected 3 calls, got 2\n\n Tests  1 failed | 11 passed (12)\n');
  const worktree = path.join(root, '.claude', 'worktrees', `agent-${AGENT}`);
  const said = (id: string, name: string, input: object) => line({ type: 'assistant', timestamp: iso(Date.now()), sessionId: SID, agentId: AGENT, isSidechain: true, cwd: worktree, message: { role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
  appendFileSync(agentFile, said('o1', 'Bash', { command: `npx playwright screenshot http://localhost:3000/webhooks ${png}` }) + said('o2', 'Bash', { command: `npm test 2>&1 | tee ${tmp}/tests.log` }));

  await monitor.getByRole('tab', { name: /^Outputs/ }).click();
  const list = monitor.getByRole('listbox', { name: 'Outputs' });
  await expect(list.getByRole('option')).toHaveCount(2, { timeout: 15_000 });
  await expect(monitor.getByRole('tab', { name: 'Outputs · 2' })).toBeVisible();
  // Following: the newest shows.
  await list.getByRole('option', { name: /01-webhooks-page\.png/ }).click();
  await expect(monitor.getByRole('img', { name: '01-webhooks-page.png' })).toBeVisible();
  await shot(page, 'subagent-outputs');
  await list.getByRole('option', { name: /tests\.log/ }).click();
  await expect(monitor.getByRole('region', { name: 'tests.log' })).toContainText('expected 3 calls, got 2');
  // Back to what it does.
  await monitor.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByRole('log', { name: 'Sub-agent Write the webhook tests' })).toBeVisible();
});

test('in the chat, background work sits where it started: a live dot while it runs, then it folds with the other steps', async ({ page }) => {
  const composer = page.locator('textarea:not(.xterm-helper-textarea)');
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name: 'new-hero', exact: true }).click();
  await expect(composer).toHaveAttribute('placeholder', /new-hero/);
  // Earlier specs answered here too: wait for this answer, not one of theirs.
  const done = page.locator('[data-turn="done"]');
  const answered = await done.count();
  await composer.fill('run the tests and keep them watching');
  await composer.press('Enter');
  // The demo's Claude runs the tests, leaves them watching in the background, and reads on.
  const steps = page.getByRole('list', { name: "The agent's steps" }).last();
  const live = steps.locator('[data-subagent][data-running="true"]');
  await expect(live).toContainText('Background · npm test --watch', { timeout: 20_000 });
  // Running: its live dot, never folded away.
  await expect(live.locator('[class*="live_claude"]')).toBeVisible();
  await shot(page, 'subagent-in-chat-running');

  // Answered: shown again, it's a finished row among the steps, folded with the older ones.
  await expect(done).toHaveCount(answered + 1, { timeout: 30_000 });
  const card = done.last();
  await card.hover();
  await card.getByRole('button', { name: 'Show Steps' }).click();
  const shown = card.getByRole('list', { name: "The agent's steps" });
  const earlier = shown.getByRole('button', { name: /^Show \d+ earlier steps/ });
  // With the fold closed it's inside it (finished, with steps after it), not among the last few.
  // (Its full record is read back first: wait for the steps after it.)
  await expect.poll(async () => Number(await earlier.getAttribute('data-folded-count').catch(() => '0')), { timeout: 10_000 }).toBeGreaterThanOrEqual(4);
  await expect(shown.locator('[data-step-kind="read"]').filter({ hasText: 'README' })).toHaveCount(1);
  await expect(shown.locator('[data-subagent]')).toHaveCount(0);
  await expect(earlier).toHaveAttribute('aria-expanded', 'false');
  // In the timeline, right after the step that started it (not trailing below the rest).
  // (Its full record is read back first; then the earlier steps open.)
  const kinds = async (): Promise<string[]> => {
    if (await earlier.isVisible()) await earlier.click();
    return shown.locator('[data-slot]').evaluateAll((els) => els.map((el) => (el.querySelector('[data-subagent]') ? 'sub' : ((el.querySelector('[data-step-kind]') as HTMLElement | null)?.dataset.stepKind ?? '?'))));
  };
  await expect.poll(kinds, { timeout: 10_000 }).toEqual(expect.arrayContaining(['bash', 'sub']));
  await expect(shown.locator('[data-subagent]')).toHaveCount(1);
  await expect(shown.locator('[data-subagent][data-running]')).toHaveCount(0);
  const now = await kinds();
  expect(now.indexOf('sub')).toBe(now.lastIndexOf('bash') + 1);
  await shot(page, 'subagent-in-chat-done');
});

test('its background commands: listed with how they run, and their output followed live (on its page and in the panel)', async ({ page }) => {
  await showAgents(page);
  await sidebar(page).getByRole('button', { name: /^Sub-agent Write the webhook tests/ }).click();
  const monitor = page.locator(`[data-agent-monitor="${AGENT}"]`);
  await expect(monitor).toBeVisible({ timeout: 15_000 });
  // It starts the tests in the background: Claude Code says where their output goes, and writes it there.
  const worktree = path.join(root, '.claude', 'worktrees', `agent-${AGENT}`);
  const tasks = path.join(mkdtempSync(path.join(os.tmpdir(), 'claude-e2e-')), 'proj', SID, 'tasks');
  mkdirSync(tasks, { recursive: true });
  const out = path.join(tasks, 'bwhtests.output');
  writeFileSync(out, '\u001b[2m RUN \u001b[22m v5.0.5\n ✓ src/webhooks.test.ts > retries once\n');
  const at = Date.now();
  appendFileSync(
    agentFile,
    line({ type: 'assistant', timestamp: iso(at), sessionId: SID, agentId: AGENT, isSidechain: true, cwd: worktree, message: { role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'bg1', name: 'Bash', input: { command: 'npx vitest --watch src/webhooks.test.ts', description: 'Watch the webhook tests', run_in_background: true } }] } }) +
      line({ type: 'user', timestamp: iso(at + 100), sessionId: SID, agentId: AGENT, isSidechain: true, cwd: worktree, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bg1', content: `Command running in background with ID: bwhtests. Output is being written to: ${out}. You will be notified when it completes.` }] }, toolUseResult: { backgroundTaskId: 'bwhtests' } }),
  );

  await monitor.getByRole('tab', { name: /^Background · 1 running/ }).click({ timeout: 15_000 });
  const list = monitor.getByRole('listbox', { name: 'Background commands' });
  await expect(list.getByRole('option', { name: /Watch the webhook tests/ })).toContainText('Running');
  const output = monitor.getByRole('region', { name: 'Output of Watch the webhook tests' });
  await expect(output).toContainText('$ npx vitest --watch src/webhooks.test.ts');
  await expect(output).toContainText('✓ src/webhooks.test.ts > retries once');
  await expect(output).not.toContainText('\u001b');
  // More comes: it shows as it's written.
  appendFileSync(out, ' ✓ src/webhooks.test.ts > gives up after 3 tries\n Tests  2 passed (2)\n');
  await expect(output).toContainText('gives up after 3 tries', { timeout: 10_000 });
  await shot(page, 'subagent-background');

  // The panel of its worktree has it too.
  // Background, below the rest.
  await page.getByRole('tablist', { name: 'Panel bottom' }).getByRole('tab', { name: 'Background', exact: true }).click();
  const panel = page.locator('[data-panel-dock="true"]:visible');
  await expect(panel.getByRole('region', { name: 'Output of Watch the webhook tests' })).toContainText('Tests  2 passed (2)');
  await shot(page, 'panel-background');
});
