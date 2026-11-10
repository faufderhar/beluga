import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { MacAssistant } from '../src/core/assistant/assistant.js';
import { attachAssistant } from '../src/core/assistant/registry.js';
import { pretendSystem } from '../src/core/gateway/demo-system.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { sentinelChatChannel } from '../src/core/sentinel/model.js';
import { Store, initialState } from '../src/core/store.js';
import type { PullRequest } from '../src/core/work-store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { TerminalManager } from '../src/terminal/index.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { runId, setupId } from '../src/core/workbench.js';
import { ASSISTANT_TITLE, assistantChannel } from '../src/shared/assistant.js';
import { attach, waitFor } from './helpers.js';
import { posixSh } from '../src/terminal/pty.js';

/** Windows' runners make worktrees and start Git Bash several times slower. */
const SLOW = process.platform === 'win32' ? 3 : 1;

/** bash, or Git Bash on Windows. */
const BASH = process.platform === 'win32' ? (posixSh() ?? 'bash') : '/bin/bash';

const keys = deriveKeys(generateSecret());
let hub: Hub;
let base: string;
let terminals: TerminalManager;
const sessions: Session[] = [];
const home = process.env.BELUGA_HOME;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-bench-')));
  process.env.BELUGA_HOME = path.join(base, 'klaud-home');
  terminals = new TerminalManager();
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  terminals.closeAll();
  await hub?.close();
  process.env.BELUGA_HOME = home;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

function repo(files: Record<string, string> = {}): string {
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  const dir = path.join(base, 'code', 'app');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  return dir;
}

async function solo(dir: string, opts: { findPr?: (d: string, b: string) => Promise<PullRequest | undefined>; script?: (i: AgentRunInput) => Promise<string>; fixSetup?: AgentBackend['fixSetup']; agent?: Partial<AgentBackend> } = {}) {
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, reconnect: false });
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [], projects: [dir], hidden: [] });
  const workspaces = new WorkspaceManager(wsStore);
  await workspaces.refresh();
  const runs: AgentRunInput[] = [];
  const desktop: string[] = [];
  const opened: string[] = [];
  const session = new Session({
    client,
    store,
    shares: new ShareService([]),
    agentCwd: base,
    workspaces,
    terminals,
    hasGh: async () => true,
    findPr: opts.findPr ?? (async () => undefined),
    open: (t) => void opened.push(t),
    desktopNotify: (n) => void desktop.push(n.title),
    zoom: async () => ({ ok: true, message: '' }),
    copy: async () => undefined,
    saveSettings: () => undefined,
    createAgent: (): AgentBackend => ({
      run: async (input) => {
        runs.push(input);
        input.onEvent('usage', JSON.stringify({ input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300, cost: 0.05, session: 's1' }));
        return opts.script ? opts.script(input) : 'done';
      },
      ...(opts.fixSetup ? { fixSetup: opts.fixSetup } : {}),
      ...opts.agent,
    }),
  });
  const screen = attach(session);
  session.start();
  sessions.push(session);
  await waitFor(() => store.getState().self, 4000);
  return { session, store, state: store.getState, screen: screen.store, runs, workspaces, desktop, opened, bench: session.workbench! };
}

const projectOf = (w: WorkspaceManager) => w.list.find((p) => p.root)!;

describe('setup and run scripts', () => {
  it('runs the setup command in every new worktree, in its terminal, and reports the result', async () => {
    hub = await startHub({ keys });
    const dir = repo({ 'klaud.json': JSON.stringify({ scripts: { setup: 'echo installing && touch .ready', run: 'echo serving; sleep 30' } }) });
    const kay = await solo(dir);
    expect(projectOf(kay.workspaces).scripts?.setup).toEqual({ command: 'echo installing && touch .ready', source: 'klaud.json' });
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'feature');
    // It comes from the repository, so the first time it asks; "always" remembers this command.
    await waitFor(() => kay.state().approvals.length === 1, 4000);
    expect(kay.state().approvals[0]?.title).toBe("app's klaud.json wants to run its setup in new worktrees");
    kay.session.answerApproval('always');
    // A new worktree and a login shell can take a while on a busy CI runner: generous waits.
    await waitFor(() => kay.state().setup[ws!.id]?.status === 'done', SLOW * 20_000);
    const next = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'second');
    await waitFor(() => kay.state().setup[next!.id]?.status === 'done', SLOW * 20_000);
    expect(kay.state().approvals).toHaveLength(0);
    const setup = terminals.get(setupId(ws!.id))!;
    expect(setup.backlog()).toContain('installing');

    const run = kay.bench.run(ws!.id)!;
    await waitFor(() => run.backlog().includes('serving'), 20_000);
    expect(kay.bench.run(ws!.id)).toBe(run); // already running: the same session
    kay.bench.stopRun(ws!.id);
    await waitFor(() => !terminals.get(runId(ws!.id))?.running, 8000);
  }, 90_000);

  it('tells you when setup fails, and can be turned off', async () => {
    hub = await startHub({ keys });
    const dir = repo({ 'klaud.json': JSON.stringify({ scripts: { setup: 'exit 3' } }) });
    const kay = await solo(dir);
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'broken');
    await waitFor(() => kay.state().approvals.length === 1, 4000);
    kay.session.answerApproval('yes');
    await waitFor(() => kay.state().setup[ws!.id]?.status === 'failed', 8000);
    expect(kay.state().setup[ws!.id]?.detail).toBe('exit code 3');
    // You're looking at it, so it's a toast; from elsewhere it goes to the inbox (and the desktop).
    expect(kay.screen.getState().toast?.text).toContain('Setup failed in broken');
    // Your Claude is on, so it offers to fix it; yes sends it the failure, in that worktree.
    await waitFor(() => kay.state().approvals.length === 1, 4000);
    expect(kay.state().approvals[0]?.title).toBe("The setup didn't work in broken. Do you want me to fix it?");
    kay.session.answerApproval('yes');
    await waitFor(() => kay.runs.some((r) => r.prompt.includes('`exit 3` stopped with exit code 3')), 4000);
    kay.screen.dispatch({ type: 'view', view: { kind: 'overview' } });
    kay.bench.runSetup(ws!.id); // you asked for it: no question
    await waitFor(() => kay.state().inbox.some((n) => n.title === 'Setup failed in broken'), 8000);
    // The failure and the new "fix it?" question can reach the desktop as one.
    await waitFor(() => kay.desktop.some((t) => t === 'Setup failed in broken' || /^\d+ updates in Beluga$/.test(t)), 4000);
    kay.session.setPrefs({ autoSetup: false });
    const quiet = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'quiet');
    expect(kay.state().setup[quiet!.id]).toBeUndefined();
  });

  it('skips an install that has nothing to install, and remembers', async () => {
    hub = await startHub({ keys });
    const dir = repo();
    const kay = await solo(dir);
    const id = projectOf(kay.workspaces).id;
    kay.bench.setScript(id, 'setup', 'yarn');
    await waitFor(() => projectOf(kay.workspaces).scripts?.setup?.command === 'yarn', 4000);
    const ws = await kay.session.workspaces!.newWorktree(id, 'plain');
    await waitFor(() => !projectOf(kay.workspaces).scripts?.setup, 4000);
    expect(kay.state().setup[ws!.id]).toBeUndefined();
    expect(terminals.get(setupId(ws!.id))).toBeUndefined();
    // Setting one yourself again wins over what was learned.
    kay.bench.setScript(id, 'setup', 'make');
    await waitFor(() => projectOf(kay.workspaces).scripts?.setup?.command === 'make', 4000);
  });

  it('when setup fails, Claude works out the right one: it runs now and next time', async () => {
    hub = await startHub({ keys });
    const dir = repo({ 'Makefile': 'setup:\n\ttouch .ready\n' });
    const asked: string[] = [];
    const kay = await solo(dir, { fixSetup: async (_d, failed, output) => (asked.push(`${failed}|${output.includes('nope')}`), { command: 'touch .ready' }) });
    const id = projectOf(kay.workspaces).id;
    kay.bench.setScript(id, 'setup', 'echo nope && exit 2');
    await waitFor(() => projectOf(kay.workspaces).scripts?.setup?.command === 'echo nope && exit 2', 4000);
    const ws = await kay.session.workspaces!.newWorktree(id, 'learn');
    await waitFor(() => kay.state().setup[ws!.id]?.status === 'done', 8000);
    expect(kay.state().setup[ws!.id]?.command).toBe('touch .ready');
    expect(asked).toEqual(['echo nope && exit 2|true']);
    await waitFor(() => projectOf(kay.workspaces).scripts?.setup?.command === 'touch .ready', 4000);
  });

  it("a project's first new worktree has Claude work out its commands, once, and they're kept as Claude's", async () => {
    hub = await startHub({ keys });
    const dir = repo({ 'main.sh': 'echo hi' });
    const looked: Array<{ setup: boolean; run: boolean }> = [];
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const kay = await solo(dir, {
      agent: {
        workOutScripts: async (_d, want) => (looked.push(want), await answered, { setup: { command: 'touch .ready' }, run: { command: 'echo serving; sleep 30' } }),
      },
    });
    const id = projectOf(kay.workspaces).id;
    expect(projectOf(kay.workspaces).scripts).toEqual({});
    // Two while Claude is still looking still make one look.
    const one = await kay.session.workspaces!.newWorktree(id, 'one');
    const two = await kay.session.workspaces!.newWorktree(id, 'two');
    await waitFor(() => looked.length === 1, 4000);
    expect(looked).toEqual([{ setup: true, run: true }]);
    answer();
    await waitFor(() => projectOf(kay.workspaces).scripts?.run?.source === 'claude', 4000);
    expect(projectOf(kay.workspaces).scripts).toMatchObject({ setup: { command: 'touch .ready', source: 'claude' }, run: { command: 'echo serving; sleep 30', source: 'claude' } });
    // It came from reading the repository, so it asks before running by itself.
    await waitFor(() => kay.state().approvals.length >= 1, 4000);
    expect(kay.state().approvals[0]?.title).toBe("Claude worked out app's setup for new worktrees");
    kay.session.answerApproval('always');
    // Flaky on CI's runners only (BLG-268 PR): if it hangs again, say how far each worktree got.
    await waitFor(() => kay.state().setup[one!.id]?.status === 'done' && kay.state().setup[two!.id]?.status === 'done', 20_000).catch((err: unknown) => {
      const at = (id: string) => ({ setup: kay.state().setup[id], listed: Boolean(kay.workspaces.find(id)), terminal: terminals.get(setupId(id))?.backlog().slice(-300) });
      throw new Error(`${String(err)}: ${JSON.stringify({ one: at(one!.id), two: at(two!.id), approvals: kay.state().approvals.map((a) => a.title) })}`);
    });
    // Remembered: the next worktree just sets up, without asking Claude again.
    const three = await kay.session.workspaces!.newWorktree(id, 'three');
    await waitFor(() => kay.state().setup[three!.id]?.status === 'done', 20_000);
    expect(looked).toHaveLength(1);
    // Setting one yourself makes it yours.
    kay.bench.setScript(id, 'run', 'echo mine');
    await waitFor(() => projectOf(kay.workspaces).scripts?.run?.source === 'yours', 4000);
    expect(projectOf(kay.workspaces).scripts?.setup?.source).toBe('claude');
  }, 90_000);

  it("uses the project's own tooling (a Makefile) without asking Claude", async () => {
    hub = await startHub({ keys });
    const dir = repo({ Makefile: '.PHONY: setup dev\nsetup:\n\ttouch .ready\ndev:\n\techo dev\n' });
    const looked: unknown[] = [];
    const kay = await solo(dir, { agent: { workOutScripts: async (_d, want) => (looked.push(want), {}) } });
    expect(projectOf(kay.workspaces).scripts).toMatchObject({ setup: { command: 'make setup', source: 'detected' }, run: { command: 'make dev', source: 'detected' } });
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'made');
    await waitFor(() => kay.state().setup[ws!.id]?.status === 'done', 20_000);
    expect(looked).toEqual([]);
  }, 60_000);

  it('a setup guessed from a lockfile is checked by Claude once: the same answer keeps the guess, a fuller one is kept as Claude’s', async () => {
    hub = await startHub({ keys });
    const dir = repo({ 'package.json': '{}', 'package-lock.json': '{}', 'Makefile': 'dev:\n\techo dev\n' });
    const looked: Array<{ setup: boolean; run: boolean }> = [];
    const kay = await solo(dir, { agent: { workOutScripts: async (_d, want) => (looked.push(want), { setup: { command: 'npm install && (cd app && npm install)' } }) } });
    const id = projectOf(kay.workspaces).id;
    expect(projectOf(kay.workspaces).scripts?.setup).toEqual({ command: 'npm install', source: 'detected' });
    await kay.session.workspaces!.newWorktree(id, 'guess');
    await waitFor(() => projectOf(kay.workspaces).scripts?.setup?.source === 'claude', 4000);
    expect(looked).toEqual([{ setup: true, run: false }]);
    expect(projectOf(kay.workspaces).scripts?.setup?.command).toBe('npm install && (cd app && npm install)');
  }, 60_000);

  it("your Claude in a worktree is told the setup, and can correct it for the next worktree", async () => {
    hub = await startHub({ keys });
    const dir = repo();
    const kay = await solo(dir);
    const id = projectOf(kay.workspaces).id;
    kay.bench.setScript(id, 'setup', 'true');
    const ws = await kay.session.workspaces!.newWorktree(id, 'tells');
    const tools = kay.bench.setupForRun(ws!.id)!;
    expect(tools.brief).toContain('Beluga runs its setup once: `true` (set by the owner)');
    expect(tools.set('true', 'same')).toBe('The setup is already `true`.');
    expect(tools.set('true && (cd app && npm install)', 'app had no node_modules')).toContain('Saved');
    await waitFor(() => projectOf(kay.workspaces).scripts?.setup?.source === 'claude', 4000);
    expect(projectOf(kay.workspaces).scripts?.setup?.command).toBe('true && (cd app && npm install)');
    // Its runs get them.
    kay.session.askOwnClaude('hi', `ws:${ws!.id}`);
    await waitFor(() => kay.runs.length === 1, 4000);
    expect(kay.runs[0]?.setup?.brief).toContain('`true && (cd app && npm install)` (worked out by an agent)');
  }, 60_000);

  it("when the run fails it asks whether to fix it; yes has Claude find the right command, which starts", async () => {
    hub = await startHub({ keys });
    const dir = repo();
    const fixes: string[] = [];
    const kay = await solo(dir, { agent: { fixRun: async (_d, failed, output) => (fixes.push(`${failed}|${output.includes('no such thing')}`), { command: 'echo fixed; sleep 30' }) } });
    const id = projectOf(kay.workspaces).id;
    kay.bench.setScript(id, 'run', 'echo no such thing; exit 4');
    kay.bench.setScript(id, 'setup', 'true');
    const ws = await kay.session.workspaces!.newWorktree(id, 'runs');
    await waitFor(() => kay.state().setup[ws!.id]?.status === 'done', 20_000);
    kay.bench.run(ws!.id);
    await waitFor(() => kay.state().approvals.length === 1, 20_000);
    expect(kay.state().approvals[0]?.title).toBe("The run didn't work in runs. Do you want me to fix it?");
    expect(kay.state().approvals[0]?.detail).toContain('no such thing');
    kay.session.answerApproval('yes');
    await waitFor(() => terminals.get(runId(ws!.id))?.backlog().includes('fixed'), 20_000);
    expect(fixes).toEqual(['echo no such thing; exit 4|true']);
    await waitFor(() => projectOf(kay.workspaces).scripts?.run?.source === 'claude', 4000);
    expect(projectOf(kay.workspaces).scripts?.run).toEqual({ command: 'echo fixed; sleep 30', source: 'claude' });
    // Stopping it yourself isn't a failure.
    kay.bench.stopRun(ws!.id);
    await waitFor(() => !terminals.get(runId(ws!.id))?.running, 8000);
    await new Promise((r) => setTimeout(r, 300));
    expect(kay.state().approvals).toHaveLength(0);
  }, 90_000);

  it('lets you set the commands for yourself or for the team (beluga.json)', async () => {
    hub = await startHub({ keys });
    const dir = repo({ 'package-lock.json': '{}', 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) });
    const kay = await solo(dir);
    const id = projectOf(kay.workspaces).id;
    expect(projectOf(kay.workspaces).scripts).toMatchObject({ setup: { command: 'npm install', source: 'detected' }, run: { command: 'npm run dev', source: 'detected' } });
    kay.bench.setScript(id, 'setup', 'npm ci');
    await waitFor(() => projectOf(kay.workspaces).scripts?.setup?.source === 'yours', 4000);
    kay.bench.shareScripts(id);
    await waitFor(() => projectOf(kay.workspaces).scripts?.setup?.command === 'npm ci', 4000);
    expect(JSON.parse(execFileSync('cat', [path.join(dir, 'beluga.json')]).toString())).toEqual({ scripts: { setup: 'npm ci', run: 'npm run dev' } });
  });

  it('saves one command straight to beluga.json, dropping your own one for it', async () => {
    hub = await startHub({ keys });
    const dir = repo({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) });
    const kay = await solo(dir);
    const id = projectOf(kay.workspaces).id;
    kay.bench.setScript(id, 'run', 'npm start');
    await waitFor(() => projectOf(kay.workspaces).scripts?.run?.source === 'yours', 4000);
    kay.bench.setScript(id, 'run', 'npm run serve', true);
    await waitFor(() => projectOf(kay.workspaces).scripts?.run?.source === 'beluga.json', 4000);
    expect(projectOf(kay.workspaces).scripts?.run?.command).toBe('npm run serve');
    expect(JSON.parse(execFileSync('cat', [path.join(dir, 'beluga.json')]).toString())).toEqual({ scripts: { run: 'npm run serve' } });
    kay.bench.setScript(id, 'run', '', true);
    await waitFor(() => projectOf(kay.workspaces).scripts?.run?.source !== 'beluga.json', 4000);
    expect(JSON.parse(execFileSync('cat', [path.join(dir, 'beluga.json')]).toString())).toEqual({ scripts: {} });
  });
});

describe('pull requests', () => {
  it('asks Claude with your PR instructions, then follows the PR and its checks', async () => {
    hub = await startHub({ keys });
    const dir = repo();
    let pr: PullRequest | undefined;
    const kay = await solo(dir, { findPr: async () => pr });
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'auth');
    kay.bench.createPr(ws!.id, 'mention the migration');
    await waitFor(() => kay.runs.length === 1, 4000);
    expect(kay.runs[0]?.prompt).toContain('gh pr create --base main --head beluga/auth');
    expect(kay.runs[0]?.prompt).toContain('For this pull request, also: mention the migration');
    expect(kay.runs[0]?.prompt).toContain('## Why');

    kay.screen.dispatch({ type: 'view', view: { kind: 'overview' } });
    pr = { number: 7, url: 'https://github.com/x/app/pull/7', state: 'OPEN', title: 'Add auth', draft: false, checks: 'pending' };
    await kay.bench.refreshPrs(ws!.id);
    expect(kay.state().prs[ws!.id]?.number).toBe(7);
    await waitFor(() => kay.state().inbox.some((n) => n.title === 'Pull request #7 is open for auth'), 4000);
    pr = { ...pr, checks: 'failing' };
    await kay.bench.refreshPrs(ws!.id);
    await waitFor(() => kay.state().inbox.some((n) => n.title === 'Checks failing on PR #7'), 4000);
    kay.bench.fixChecks(ws!.id);
    await waitFor(() => kay.runs.length === 2, 4000);
    expect(kay.runs[1]?.prompt).toContain('gh run view --log-failed');
    kay.bench.openPr(ws!.id);
    expect(kay.opened).toEqual(['https://github.com/x/app/pull/7']);
  });

  it("stays quiet about PRs you didn't ask for, and ignores worktrees other tools made", async () => {
    hub = await startHub({ keys });
    const dir = repo();
    const asked: string[] = [];
    const kay = await solo(dir, { findPr: async (d) => (asked.push(d), { number: 9, url: 'u', state: 'OPEN', title: 'T', draft: false, checks: 'pending' }) });
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'quiet');
    kay.screen.dispatch({ type: 'view', view: { kind: 'overview' } });
    await kay.bench.refreshPrs(ws!.id);
    await kay.bench.refreshPrs(ws!.id);
    expect(kay.state().prs[ws!.id]?.number).toBe(9);
    expect(kay.state().inbox.filter((n) => n.kind === 'pr')).toEqual([]);

    execFileSync('git', ['worktree', 'add', '-q', '-b', 'agent-x', path.join(dir, '.claude', 'worktrees', 'agent-x')], { cwd: dir });
    await kay.session.workspaces!.refresh();
    const agent = projectOf(kay.workspaces).workspaces.find((w) => w.name === 'agent-x');
    expect(agent).toBeDefined();
    asked.length = 0;
    await kay.bench.refreshPrs(agent!.id);
    expect(asked).toEqual([]);
  });

  it('only offers PRs for worktrees, and explains a missing GitHub CLI', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const main = projectOf(kay.workspaces).workspaces.find((w) => w.kind === 'main')!;
    kay.bench.createPr(main.id);
    expect(kay.screen.getState().toast?.text).toContain('Pull requests are for worktrees');
    kay.store.dispatch({ type: 'gh', ok: false });
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'x');
    kay.bench.createPr(ws!.id);
    expect(kay.screen.getState().toast?.text).toContain('Install the GitHub CLI');
    // Installed and signed in since: the Mac's Check Again looks again (a plain refresh doesn't).
    await kay.bench.refreshPrs(ws!.id);
    expect(kay.state().gh).toBe(false);
    await kay.bench.refreshPrs(ws!.id, true);
    expect(kay.state().gh).toBe(true);
  });
});

describe('workspace conversations', () => {
  it("keeps what you sent a workspace before opening it", async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const ws = await kay.workspaces.createWorktree(projectOf(kay.workspaces).id, 'later');
    await kay.session.workspaces!.refresh();
    kay.session.askOwnClaude('fix the flaky test', `ws:${ws.id}`);
    await waitFor(() => kay.runs.length === 1, 4000);
    kay.session.workspaces!.open(ws.id);
    expect(kay.state().log.some((l) => l.channel === `ws:${ws.id}` && l.type === 'chat' && l.text === 'fix the flaky test')).toBe(true);
  });

  it('stops its terminals when a workspace is archived', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'shelly');
    expect(kay.bench.shell(ws!.id)?.running).toBe(true);
    expect(await kay.session.workspaces!.archive(ws!.id, true)).toBe(true);
    expect(kay.bench.terminals?.get(ws!.id)).toBeUndefined();
  });
});

describe('models, usage, space and search', () => {
  it('uses the model picked for a conversation, else your default', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'm');
    kay.bench.setModel(undefined, 'haiku');
    kay.session.askOwnClaude('hi', `ws:${ws!.id}`);
    await waitFor(() => kay.runs.length === 1, 4000);
    expect(kay.runs[0]?.model).toBe('haiku');
    kay.bench.setModel(`ws:${ws!.id}`, 'opus');
    kay.session.setPrefs({ effort: 'high' });
    kay.session.askOwnClaude('again', `ws:${ws!.id}`);
    await waitFor(() => kay.runs.length === 2, 4000);
    expect(kay.runs[1]).toMatchObject({ model: 'opus', effort: 'high' });
    expect(kay.workspaces.find(ws!.id)?.model).toBe('opus');
    kay.bench.setEffort(`ws:${ws!.id}`, 'low');
    expect(kay.workspaces.find(ws!.id)?.effort).toBe('low');
    kay.bench.setEffort(`ws:${ws!.id}`, undefined);
    expect(kay.workspaces.find(ws!.id)?.effort).toBeUndefined();
  });

  it('adds up tokens and cost per workspace and measures its folder', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'u');
    kay.session.askOwnClaude('one', `ws:${ws!.id}`);
    await waitFor(() => kay.workspaces.find(ws!.id)?.usage?.runs === 1, 4000);
    kay.session.askOwnClaude('two', `ws:${ws!.id}`);
    await waitFor(() => kay.workspaces.find(ws!.id)?.usage?.runs === 2, 4000);
    // The same conversation reports a running total: nothing new was added the second time.
    expect(kay.workspaces.find(ws!.id)?.usage).toMatchObject({ input: 1000, output: 200, cacheWrite: 300 });
    await kay.bench.measureDisk();
    expect(kay.state().disk[ws!.id]).toBeGreaterThan(0);
    expect(kay.bench.describe(ws!.id)).toMatch(/KB · 2k tokens$/);
  });

  it('searches open, saved and archived conversations', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const p = projectOf(kay.workspaces);
    const a = await kay.session.workspaces!.newWorktree(p.id, 'payments');
    const b = await kay.session.workspaces!.newWorktree(p.id, 'docs');
    kay.workspaces.saveHistory(b!.id, [{ id: 'x', type: 'chat', channel: `ws:${b!.id}`, from: 'z', name: 'bob', text: 'the Stripe webhook retries', ts: 5, byAgent: false }]);
    kay.session.askOwnClaude('wire the stripe webhook', `ws:${a!.id}`);
    await waitFor(() => kay.runs.length === 1, 4000);
    kay.bench.search('STRIPE webhook');
    const hits = kay.state().search.hits;
    expect(hits.map((h) => h.place)).toEqual(['app › payments', 'app › docs']);
    kay.bench.openHit(1);
    expect(kay.screen.getState().view).toMatchObject({ kind: 'workspace', id: b!.id });
    kay.bench.search('nothing like this');
    expect(kay.state().search.hits).toEqual([]);
  });

  it("doesn't find a deleted workspace's conversation, even one still open", async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'gone');
    kay.session.askOwnClaude('the Roberto handoff', `ws:${ws!.id}`);
    await waitFor(() => kay.runs.length === 1, 4000);
    kay.bench.search('roberto');
    expect(kay.state().search.hits.length).toBeGreaterThan(0);
    await kay.session.workspaces!.remove(ws!.id);
    expect(kay.state().log.some((l) => l.channel === `ws:${ws!.id}`)).toBe(false);
    // What comes back late through the room (the hub's echo of your message, its run's last words),
    // as it does on a slow computer: it never brings the conversation back.
    const late = kay.session as unknown as { handle(msg: { id: string; from: string; ts: number; sentAt: number; body: object }): Promise<void> };
    const self = kay.state().self!.peerId;
    await late.handle({ id: 'late-1', from: self, ts: Date.now(), sentAt: Date.now(), body: { kind: 'chat', mid: 'm-late', text: 'the Roberto handoff', channel: `ws:${ws!.id}`, byAgent: false } });
    await late.handle({ id: 'late-2', from: self, ts: Date.now(), sentAt: Date.now(), body: { kind: 'agent_event', requestId: 'r-late', requester: self, event: 'done', text: 'Roberto, done', channel: `ws:${ws!.id}` } });
    expect(kay.state().log.some((l) => l.channel === `ws:${ws!.id}`)).toBe(false);
    kay.bench.search('roberto');
    expect(kay.state().search.hits).toEqual([]);
    // Words left behind for one that's gone some other way (its project removed): not listed either.
    kay.store.dispatch({ type: 'log_upsert', channel: 'ws:wt-vanished', items: [{ id: 'y', type: 'chat', channel: 'ws:wt-vanished', from: 'z', name: 'bob', text: 'Roberto again', ts: 6, byAgent: false }] });
    kay.bench.search('roberto');
    expect(kay.state().search.hits).toEqual([]);
  });

  it('deleting or archiving a worktree stops the Claude working in it, and nothing lands in its conversation after', async () => {
    hub = await startHub({ keys });
    // A Claude that works until it's stopped (a slow one: Windows' runners showed it, BLG-728).
    const stopped: string[] = [];
    const kay = await solo(repo(), {
      script: (i) =>
        new Promise((resolve) => {
          const t = setTimeout(() => resolve('finished anyway'), 20_000);
          i.signal.addEventListener('abort', () => (clearTimeout(t), stopped.push(i.prompt), resolve('stopped')));
        }),
    });
    const p = projectOf(kay.workspaces);
    for (const [name, leave] of [
      ['deleted', (id: string) => kay.session.workspaces!.remove(id)],
      ['archived', (id: string) => kay.session.workspaces!.archive(id)],
    ] as const) {
      const ws = await kay.session.workspaces!.newWorktree(p.id, name);
      kay.session.askOwnClaude(`work in ${name}`, `ws:${ws!.id}`);
      await waitFor(() => kay.runs.some((r) => r.prompt.includes(`work in ${name}`)), 4000);
      await leave(ws!.id);
      expect(stopped.some((x) => x.includes(`work in ${name}`))).toBe(true);
      expect(kay.session.host.runningIn(`ws:${ws!.id}`)).toBe(false);
      if (name === 'deleted') {
        await new Promise((r) => setTimeout(r, 100));
        expect(kay.state().log.filter((l) => l.channel === `ws:${ws!.id}`)).toEqual([]);
        // Its run's last words, echoed back by the hub after the clear (on a slow computer): they don't land either.
        const self = kay.session.selfId;
        kay.session.send({ kind: 'agent_event', requestId: 'late', requester: self, event: 'error', text: 'Stopped: its worktree was deleted', channel: `ws:${ws!.id}` }, { to: self });
        kay.session.send({ kind: 'agent_event', requestId: 'marker', requester: self, event: 'error', text: 'after', channel: 'room' }, { to: self });
        await waitFor(() => kay.state().log.some((l) => l.channel === 'room' && 'text' in l && l.text === 'after'), 4000);
        expect(kay.state().log.some((l) => l.channel === `ws:${ws!.id}`)).toBe(false);
      }
    }
  });

  it('finds a word that only a Your Mac chat not in memory has, and opens that chat', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const dir = path.join(base, 'assistant');
    const mac = new MacAssistant({ store: kay.store, dir, selfId: () => 'me', system: pretendSystem() });
    attachAssistant(kay.session, mac);
    const chat = mac.newChat();
    const channel = assistantChannel(chat);
    const said = (id: string, text: string, ts: number) => ({ id, type: 'chat', channel, from: 'me', name: 'kay', text, ts, byAgent: false });
    writeFileSync(path.join(dir, 'chats', chat, 'history.json'), JSON.stringify([said('1', 'plan my trip', 5), said('2', 'the kumquat invoice', 6)]));
    expect(kay.state().log.some((l) => l.channel === channel)).toBe(false);

    kay.bench.search('kumquat');
    expect(kay.state().search.hits).toEqual([{ channel, place: `${ASSISTANT_TITLE} › plan my trip`, who: 'kay', text: 'the kumquat invoice', at: 4, ts: 6, id: '2' }]);
    kay.bench.openHit(0);
    expect(kay.screen.getState().view).toEqual({ kind: 'assistant', chat });
    expect(kay.state().log.filter((l) => l.channel === channel).map((l) => l.id)).toEqual(['1', '2']);
    mac.stop();
  });

  it('names a Your Mac chat in memory by its title and opens it, once per chat', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const dir = path.join(base, 'assistant');
    const mac = new MacAssistant({ store: kay.store, dir, selfId: () => 'me', system: pretendSystem() });
    attachAssistant(kay.session, mac);
    const chat = mac.newChat();
    const channel = assistantChannel(chat);
    kay.store.dispatch({ type: 'chat', id: 'a', from: 'me', text: 'the loaded quince', ts: 7, byAgent: false, channel });
    writeFileSync(path.join(dir, 'chats', chat, 'history.json'), JSON.stringify([{ id: 'a', type: 'chat', channel, from: 'me', name: 'kay', text: 'the loaded quince', ts: 7, byAgent: false }]));

    kay.bench.search('quince');
    expect(kay.state().search.hits.map((h) => [h.channel, h.place])).toEqual([[channel, `${ASSISTANT_TITLE} › the loaded quince`]]);
    kay.bench.openHit(0);
    expect(kay.screen.getState().view).toEqual({ kind: 'assistant', chat });
    mac.stop();
  });

  it('routes a hit in a Sentinel chat, and leaves the view alone for a channel it cannot open', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const say = (id: string, channel: string, text: string): void => kay.store.dispatch({ type: 'chat', id, from: 'me', text, ts: 8, byAgent: false, channel });
    say('s', sentinelChatChannel('c1'), 'a damson alert');
    kay.bench.search('damson');
    kay.bench.openHit(0);
    expect(kay.screen.getState().view).toEqual({ kind: 'sentinel_chat', chat: 'c1' });

    say('x', 'somewhere:else', 'a medlar note');
    kay.bench.search('medlar');
    kay.bench.openHit(0);
    expect(kay.screen.getState().view).toEqual({ kind: 'sentinel_chat', chat: 'c1' });
  });

  it('opens a hit in a chat with a friend or a group as that conversation, as the sidebar does', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const say = (id: string, channel: string, text: string): void => kay.store.dispatch({ type: 'chat', id, from: 'me', text, ts: 8, byAgent: false, channel });
    say('d', 'dm:peer123', 'a quince recipe');
    kay.bench.search('quince');
    kay.bench.openHit(0);
    expect(kay.screen.getState().view).toEqual({ kind: 'conversation', id: 'dm:peer123' });

    say('g', 'group:g7', 'a loquat tree');
    kay.bench.search('loquat');
    kay.bench.openHit(0);
    expect(kay.screen.getState().view).toEqual({ kind: 'conversation', id: 'group:g7' });
  });

  it('saves your own templates', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    kay.bench.saveTemplate('Write docs: document the public API in README.md');
    expect(kay.state().templates.at(-1)).toMatchObject({ name: 'Write docs', prompt: 'document the public API in README.md' });
    kay.bench.removeTemplate(kay.state().templates.at(-1)!.id);
    expect(kay.state().templates.some((t) => t.name === 'Write docs')).toBe(false);
    kay.bench.saveTemplate('Big change: plan it, then build it', true);
    expect(kay.state().templates.at(-1)).toMatchObject({ name: 'Big change', plan: true });
    kay.bench.removeTemplate(kay.state().templates.at(-1)!.id);
  });
});

describe('your shell, its names and your variables', () => {
  it('starts shells the way you set them up, with your variables, and names them for every screen', async () => {
    hub = await startHub({ keys });
    const dir = repo();
    const kay = await solo(dir);
    const project = projectOf(kay.workspaces);
    await waitFor(() => kay.state().projects.some((p) => p.id === project.id), 4000);
    kay.session.setPrefs({ shell: BASH, shellLogin: false, shellArgs: ['--norc', '--noprofile'] });
    kay.session.env.set(undefined, [{ key: 'KLAUD_T_MINE', value: 'mine' }, { key: 'KLAUD_T_BOTH', value: 'mine' }]);
    kay.session.env.set(project.id, [{ key: 'KLAUD_T_BOTH', value: 'project' }]);
    const shell = kay.bench.globalShell('shell:1', dir)!;
    shell.run('echo "got:$KLAUD_T_MINE:$KLAUD_T_BOTH:$0"');
    await waitFor(() => shell.backlog().includes('got:mine:project:'), 8000);
    expect(shell.shell).toBe(BASH);

    // Setup and run commands get them too (alongside Beluga's own).
    const ws = await kay.session.workspaces!.newWorktree(project.id, 'envy');
    kay.bench.setScript(project.id, 'run', 'echo "run:$KLAUD_T_BOTH:$KLAUD_WORKSPACE_NAME"; sleep 5');
    await waitFor(() => kay.workspaces.list.find((p) => p.id === project.id)?.scripts?.run?.source === 'yours', 4000);
    const run = kay.bench.run(ws!.id)!;
    await waitFor(() => run.backlog().includes('run:project:envy'), 8000);

    // Changing them marks what's still running with the old ones; a restart gives it the new ones (and keeps its name).
    expect(kay.state().termEnvStale).toEqual([]);
    kay.bench.renameTerminal('shell:1', 'mine');
    kay.session.env.set(undefined, [{ key: 'KLAUD_T_MINE', value: 'changed' }, { key: 'KLAUD_T_BOTH', value: 'mine' }]);
    await waitFor(() => kay.state().termEnvStale.includes('shell:1') && kay.state().termEnvStale.includes(`${ws!.id}:run`), 4000);
    const again = kay.bench.restartTerminal('shell:1')!;
    expect(kay.state().termEnvStale).not.toContain('shell:1');
    expect(kay.state().termNames['shell:1']).toBe('mine');
    again.run('echo "now:$KLAUD_T_MINE"');
    await waitFor(() => again.backlog().includes('now:changed'), 8000);
    kay.bench.stopRun(ws!.id);
    await waitFor(() => !kay.state().termEnvStale.includes(`${ws!.id}:run`), 4000);

    kay.bench.renameTerminal('shell:1', '  logs\n');
    expect(kay.state().termNames['shell:1']).toBe('logs');
    kay.bench.renameTerminal('shell:1', '');
    expect(kay.state().termNames['shell:1']).toBeUndefined();
    kay.bench.renameTerminal('shell:1', 'tail');
    kay.bench.closeTerminal('shell:1');
    expect(kay.state().termNames).toEqual({});
  });
});
