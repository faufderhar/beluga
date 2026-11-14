import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import { runCommand } from '../src/core/commands.js';
import { planForHome } from '../src/core/plans/model.js';
import { Plans } from '../src/core/plans/plans.js';
import { PlansWork } from '../src/core/plans/work.js';
import type { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceController, shareNameOf, workspaceIdOf } from '../src/core/workspace-controller.js';
import { isMainCheckout } from '../src/workspaces/discovery.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { API } from '../src/ipc/api.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import { apiProxy, type BelugaClient } from '../src/ipc/client.js';
import { submitTyped } from '../src/ui/submit.js';
import { screenOver, waitFor } from './helpers.js';
import type { ClientStore } from '../src/client/client-store.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

let store: Store;
let screen: ClientStore;
let shares: ShareService;
let ctl: WorkspaceController;
let toasts: string[];
let trashed: string[];
let asked: Array<{ prompt: string; channel: string }>;
let askedInPlan: boolean[];
let repo: string;
let claude: string;

beforeEach(async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-ctl-')));
  repo = path.join(base, 'code', 'app');
  claude = path.join(base, 'claude');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', path.join(base, 'app.git')], { stdio: 'pipe' });
  sh(repo, 'init', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t'); // Beluga's own commits and merges need an identity (CI has none)
  sh(repo, 'config', 'user.name', 'T');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-m', 'init');
  sh(repo, 'remote', 'add', 'origin', path.join(base, 'app.git'));
  sh(repo, 'push', '-u', 'origin', 'main');
  sh(repo, 'remote', 'set-head', 'origin', 'main');
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  store = new Store(initialState('room'));
  shares = new ShareService([]);
  toasts = [];
  trashed = [];
  asked = [];
  askedInPlan = [];
  const shown = screenOver(store);
  screen = shown.screen;
  ctl = new WorkspaceController({
    manager: new WorkspaceManager(wsStore),
    store,
    shares,
    selfId: () => 'me',
    toast: (t) => void toasts.push(t),
    intend: shown.intend,
    askClaude: (prompt, channel) => {
      asked.push({ prompt, channel });
      askedInPlan.push(store.getState().planMode[channel] === true);
    },
    claudeHome: claude,
    moveToTrash: async (dir) => void trashed.push(dir),
  });
  await ctl.refresh();
});

/** A Claude Code session in `cwd` whose sub-agent made a worktree of its own (as Claude Code lays it out). */
function subAgentWorktree(cwd: string, agent: string, session = 'aaaaaaaa-0000-0000-0000-00000000000a'): string {
  const wt = path.join(repo, '.claude', 'worktrees', `agent-${agent}`);
  sh(repo, 'worktree', 'add', '-q', '-b', `worktree-agent-${agent}`, wt);
  const folder = path.join(claude, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(path.join(folder, session, 'subagents'), { recursive: true });
  writeFileSync(path.join(folder, `${session}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: session, cwd, message: { content: 'go' } })}\n`);
  const meta = path.join(folder, session, 'subagents', `agent-${agent}.meta.json`);
  writeFileSync(meta, JSON.stringify({ description: agent, worktreePath: wt, worktreeBranch: `worktree-agent-${agent}` }));
  // It finished a while ago (an agent that wrote lately may still be at work).
  const old = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(meta, old, old);
  return wt;
}

const branches = (): string => sh(repo, 'branch', '--list', 'worktree-agent-*');

const projectId = () => store.getState().projects.find((p) => p.root)!.id;

describe('WorkspaceController', () => {
  it('a thread record reaches every screen at once, without a refresh', () => {
    const ws = store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.kind === 'main')!;
    const thread = { parent: 'ws:top', parentTitle: 'top', root: 'ws:top', depth: 1, task: 't', startedAt: 1, owed: [] };
    ctl.setThread(ws.id, thread);
    expect(store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === ws.id)?.thread).toEqual(thread);
  });

  it('publishes projects and makes every workspace a private share', () => {
    const app = store.getState().projects.find((p) => p.root)!;
    const main = app.workspaces[0]!;
    expect(app.name).toBe('app');
    expect(shares.canAccess(shareNameOf(main.id), 'me', 'me')).toBe(true);
    expect(shares.canAccess(shareNameOf(main.id), 'bob', 'me')).toBe(false);
    expect(shares.infos).toEqual([]); // never advertised to the room
  });

  it('starts a worktree from a chosen branch with your own name, or with no message at all', async () => {
    sh(repo, 'checkout', '-b', 'feature');
    sh(repo, 'push', '-u', 'origin', 'feature');
    sh(repo, 'checkout', 'main');
    const namer = (): Promise<string> => Promise.reject(new Error('should not be asked'));
    await ctl.startWorktree(projectId(), 'do the thing', namer, { base: 'origin/feature', name: 'mine' });
    const mine = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.name === 'mine')!;
    expect(mine).toMatchObject({ base: 'origin/feature' });
    // Its row showed while it was made (no "Creating…" toast); now it's the real one.
    expect(toasts.some((t) => t.startsWith('Creating worktree'))).toBe(false);
    expect(mine.pending).toBeUndefined();
    expect(toasts).not.toContain('Naming the worktree…');
    expect(asked).toEqual([{ prompt: 'do the thing', channel: `ws:${mine.id}` }]);

    await ctl.startWorktree(projectId(), '   ', namer, { name: 'quiet' });
    const quiet = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.name === 'quiet')!;
    expect(quiet).toMatchObject({ base: 'origin/main' });
    expect(asked).toHaveLength(1);
    expect(await ctl.branches(projectId())).toMatchObject({ base: 'origin/main', branches: expect.arrayContaining(['origin/main', 'feature']) });
  });

  it('shows your first message while the worktree is made, then asks Claude under the same request (BLG-531)', async () => {
    const said: Array<{ prompt: string; channel: string; shown?: string }> = [];
    const c = new WorkspaceController({
      manager: new WorkspaceManager(new WorkspaceStore(path.join(repo, '..', '..', 'home'))),
      store,
      shares,
      selfId: () => 'me',
      toast: (t) => void toasts.push(t),
      intend: () => undefined,
      showAsk: (prompt, channel) => {
        store.dispatch({ type: 'chat', id: 'm1', from: 'me', text: prompt, ts: 1, byAgent: false, channel, request: 'r1' });
        return 'r1';
      },
      askClaude: (prompt, channel, o) => void said.push({ prompt, channel, ...(o?.shown ? { shown: o.shown } : {}) }),
      claudeHome: claude,
    });
    await c.refresh();
    let shownBefore = false;
    const unsub = store.subscribe(() => {
      // The pending row is up: the message is on its page already.
      const making = store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.pending);
      if (making && store.getState().log.some((l) => l.channel === `ws:${making.id}` && 'text' in l && l.text === 'fix it')) shownBefore = true;
    });
    const ws = (await c.startWorktree(projectId(), 'fix it', async () => 'fix', { name: 'early' }))!;
    unsub();
    expect(shownBefore).toBe(true);
    expect(said).toEqual([{ prompt: 'fix it', channel: `ws:${ws.id}`, shown: 'r1' }]);
    expect(store.getState().log.filter((l) => l.channel === `ws:${ws.id}`)).toHaveLength(1);
  });

  it('makes the worktree right away while a model names it, then takes that name', async () => {
    let name!: (n: string) => void;
    const naming = new Promise<string>((r) => (name = r));
    const started = ctl.startWorktree(projectId(), 'Please fix the login redirect bug', () => naming);
    // Made and Claude started before the model answers, under a quick name from the message.
    await waitFor(() => asked.length === 1, 8000);
    const ws = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.kind === 'worktree')!;
    expect(ws).toMatchObject({ name: 'fix-login-redirect-bug', branch: 'beluga/fix-login-redirect-bug' });
    expect(asked[0]).toEqual({ prompt: 'Please fix the login redirect bug', channel: `ws:${ws.id}` });
    expect(toasts).not.toContain('Naming the worktree…');
    name('login-redirect');
    await started;
    const renamed = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.id === ws.id)!;
    expect(renamed).toMatchObject({ name: 'login-redirect', branch: 'beluga/login-redirect', path: ws.path });
    expect(sh(ws.path, 'branch', '--show-current').trim()).toBe('beluga/login-redirect');
  });

  it('keeps the quick name when naming fails', async () => {
    await ctl.startWorktree(projectId(), 'add dark mode', () => Promise.reject(new Error('offline')));
    const ws = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.kind === 'worktree')!;
    expect(ws).toMatchObject({ name: 'add-dark-mode', branch: 'beluga/add-dark-mode' });
  });

  it('creates a worktree, opens it, runs Claude there, and saves its conversation', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'feature'))!;
    expect(screen.getState().view).toEqual({ kind: 'workspace', id: ws.id, tab: 'chat' });
    expect(ctl.inChannel(`ws:${ws.id}`)?.id).toBe(ws.id);
    expect(ctl.inChannel('room')).toBeUndefined();
    const place = ctl.place(`ws:${ws.id}`)!;
    expect(place).toMatchObject({ cwd: ws.path, autoEdit: true, resume: undefined, forkSession: false });
    place.onSession('sess-1');
    expect(ctl.place(`ws:${ws.id}`)?.resume).toBe('sess-1');
    expect(ctl.place('room')).toBeUndefined();
    // An epic's worktree (BLG-561): the board names other worktrees it works in; ones gone from disk are left out.
    const stop = ctl.setAlsoIn((id) => (id === ws.id ? [repo, path.join(repo, 'gone')] : []));
    expect(ctl.place(`ws:${ws.id}`)).toMatchObject({ additionalDirectories: [repo], alsoEdit: [repo] });
    stop();
    expect(ctl.place(`ws:${ws.id}`)).toMatchObject({ additionalDirectories: [] });
    expect(ctl.place(`ws:${ws.id}`)?.alsoEdit).toBeUndefined();
    store.dispatch({ type: 'chat', id: 'm1', from: 'me', text: 'build it', ts: 1, byAgent: false, channel: `ws:${ws.id}` });
    await waitFor(() => ctl.manager.loadHistory(ws.id).length === 1, 3000);
    ctl.stop();
  });

  it('reviews, commits and merges; on conflicts it hands off to Claude', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'change'))!;
    writeFileSync(path.join(ws.path, 'a.txt'), 'two\n');
    await ctl.commit(ws.id, 'edit a');
    expect(toasts).toContain('Committed all changes');
    await ctl.commit(ws.id);
    expect(toasts).toContain('Nothing to commit');
    ctl.open(ws.id, 'review');
    await waitFor(() => store.getState().review?.diff?.includes('+two'), 5000);
    expect(store.getState().review?.data?.files.map((f) => f.path)).toEqual(['a.txt']);
    await ctl.selectFile(5); // out of range is ignored
    sh(repo, 'commit', '--allow-empty', '-m', 'noop');
    writeFileSync(path.join(repo, 'a.txt'), 'three\n');
    sh(repo, 'commit', '-am', 'main edit');
    await ctl.merge(ws.id);
    expect(toasts.some((t) => t.includes('Merge conflict in 1 file'))).toBe(true);
    expect(store.getState().conflicts[ws.id]).toEqual(['a.txt']); // shown as a banner with "Solve conflict"
    expect(asked).toHaveLength(0); // nothing happens until you click it
    ctl.askClaudeToMerge(ws.id);
    expect(asked[0]?.prompt).toContain(`Merge branch ${ws.branch}`);
    expect(asked[0]?.prompt).toContain('Conflicting files: a.txt');
    expect(asked[0]?.channel).toBe(`ws:${ws.id}`);
    ctl.askClaudeToReview(ws.id);
    expect(asked[1]?.prompt).toMatch(/security/i);
    expect(asked[1]?.prompt).toContain('ready to merge');
  });

  it('merges cleanly, refuses a dirty main folder, forks, archives, restores and deletes', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'clean'))!;
    writeFileSync(path.join(ws.path, 'b.txt'), 'b\n');
    await ctl.commit(ws.id);
    // An untracked file doesn't stand in the way; an uncommitted edit to a tracked one does.
    writeFileSync(path.join(repo, 'scratch.txt'), 'x');
    const tracked = path.join(repo, sh(repo, 'ls-files').split('\n')[0]!);
    const original = readFileSync(tracked, 'utf8');
    writeFileSync(tracked, `${original}edited\n`);
    await ctl.merge(ws.id);
    expect(toasts.some((t) => t.includes('uncommitted changes'))).toBe(true);
    writeFileSync(tracked, original);
    await ctl.merge(ws.id);
    expect(toasts.some((t) => t.startsWith('Merged beluga/clean'))).toBe(true);

    const fork = (await ctl.fork(ws.id, 'clean v2'))!;
    expect(fork.forkedFrom).toBe(ws.id);
    expect(ctl.place(`ws:${fork.id}`)?.forkSession).toBe(false); // parent had no Claude session yet
    expect(await ctl.archive(fork.id)).toBe(true);
    expect(screen.getState().tabs).not.toContain(fork.id);
    await ctl.restore(fork.id);
    expect(ctl.manager.find(fork.id)?.archived).toBe(false);
    await ctl.remove(fork.id);
    expect(ctl.manager.find(fork.id)).toBeUndefined();
    expect(await ctl.archive('missing')).toBe(false);
    expect(toasts.some((t) => t.startsWith("Couldn't archive"))).toBe(true);
  });

  it('shows a new worktree at once (pending, its page open) and the real one takes its place under the same id', async () => {
    const making = ctl.newWorktree(projectId(), 'quick');
    // Before any git work: the row is there, and you're on its page.
    const row = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.name === 'quick')!;
    expect(row).toMatchObject({ pending: true, kind: 'worktree', base: 'origin/main' });
    expect(screen.getState().view).toEqual({ kind: 'workspace', id: row.id, tab: 'chat' });
    const ws = (await making)!;
    expect(ws.id).toBe(row.id);
    const after = store.getState().projects.find((p) => p.root)!.workspaces.filter((w) => w.name === 'quick');
    expect(after).toHaveLength(1);
    expect(after[0]!.pending).toBeUndefined();
    expect(existsSync(ws.path)).toBe(true);
    expect(screen.getState().view).toMatchObject({ kind: 'workspace', id: ws.id });

    // It can't be made: the row goes again, its page with it, and the toast says why.
    const failing = ctl.newWorktree(projectId(), 'nope', { base: 'origin/no-such-branch' });
    const ghost = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.name === 'nope')!;
    expect(ghost.pending).toBe(true);
    expect(await failing).toBeUndefined();
    expect(store.getState().projects.find((p) => p.root)!.workspaces.some((w) => w.name === 'nope')).toBe(false);
    expect(screen.getState().view.kind).not.toBe('workspace');
    expect(toasts.at(-1)).toMatch(/^Couldn't create the worktree: There's no branch called origin\/no-such-branch/);
  });

  it('shows a fork at once, with the conversation so far, and it carries the uncommitted work and Scratch', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'source'))!;
    store.dispatch({ type: 'system', channel: `ws:${ws.id}`, text: 'said before the fork' });
    writeFileSync(path.join(ws.path, 'wip.txt'), 'wip');
    mkdirSync(path.join(ws.path, '.beluga', 'scratch'), { recursive: true });
    writeFileSync(path.join(ws.path, '.beluga', 'scratch', 'shot.png'), 'png');

    const forking = ctl.fork(ws.id, 'source v2');
    // Before any git work: its row (a fork of the source) and its page, with the conversation already there.
    const row = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.name === 'source-v2')!;
    expect(row).toMatchObject({ pending: true, forkedFrom: ws.id });
    expect(screen.getState().view).toEqual({ kind: 'workspace', id: row.id, tab: 'chat' });
    expect(store.getState().log.some((l) => l.channel === `ws:${row.id}` && l.type === 'system' && l.text === 'said before the fork')).toBe(true);

    const fork = (await forking)!;
    expect(fork.id).toBe(row.id);
    expect(store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.id === fork.id)?.pending).toBeUndefined();
    expect(readFileSync(path.join(fork.path, 'wip.txt'), 'utf8')).toBe('wip');
    expect(readFileSync(path.join(fork.path, '.beluga', 'scratch', 'shot.png'), 'utf8')).toBe('png');
    const lines = store.getState().log.filter((l) => l.channel === `ws:${fork.id}` && l.type === 'system').map((l) => (l.type === 'system' ? l.text : ''));
    expect(lines.filter((t) => t === 'said before the fork')).toHaveLength(1); // shown early, not twice once loaded
    expect(lines.at(-1)).toMatch(/^Forked from “source” with its commits, uncommitted changes, Scratch and conversation/);

    // It can't be made: the row and its page go again, and the toast says why.
    const failing = ctl.fork('missing', 'ghost');
    expect(await failing).toBeUndefined();
    expect(store.getState().projects.find((p) => p.root)!.workspaces.some((w) => w.name === 'ghost')).toBe(false);
    expect(toasts.at(-1)).toMatch(/^Couldn't fork/);
  });

  it('archives and deletes out of the sidebar at once; a failure puts it back and says so', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'away'))!;
    const live = () => store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.id === ws.id);
    const archiving = ctl.archive(ws.id);
    // Already archived as far as you can see (the sidebar shows only live ones), its tab closed.
    expect(live()?.archived).toBe(true);
    expect(screen.getState().tabs).not.toContain(ws.id);
    expect(existsSync(ws.path)).toBe(true); // the disk work hasn't started yet
    expect(await archiving).toBe(true);
    expect(live()?.archived).toBe(true);
    expect(existsSync(ws.path)).toBe(false);

    // Deleting: gone from the list at once.
    const deleting = ctl.remove(ws.id);
    expect(live()).toBeUndefined();
    await deleting;
    expect(live()).toBeUndefined();
    expect(ctl.manager.find(ws.id)).toBeUndefined();

    // The disk refuses: back as it was, with why and that it's back.
    const kept = (await ctl.newWorktree(projectId(), 'kept'))!;
    const real = ctl.manager.archive.bind(ctl.manager);
    ctl.manager.archive = () => Promise.reject(new Error('the disk is full'));
    const failing = ctl.archive(kept.id);
    expect(store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.id === kept.id)?.archived).toBe(true);
    expect(await failing).toBe(false);
    expect(store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.id === kept.id)?.archived).toBeFalsy();
    expect(toasts.at(-1)).toBe("Couldn't archive: the disk is full. kept is back in the sidebar, as it was.");
    ctl.manager.archive = real;
  });

  it('a Restore while it’s still being archived waits for the archive, then brings it back', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'back'))!;
    writeFileSync(path.join(ws.path, 'mine.txt'), 'uncommitted\n');
    const archiving = ctl.archive(ws.id);
    // It shows as archived already, so Restore is there to click.
    expect(store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.id === ws.id)?.archived).toBe(true);
    const restoring = ctl.restore(ws.id);
    expect(await archiving).toBe(true);
    await restoring;
    expect(ctl.manager.find(ws.id)?.archived).toBe(false);
    expect(readFileSync(path.join(ws.path, 'mine.txt'), 'utf8')).toBe('uncommitted\n');
    expect(store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.id === ws.id)?.archived).toBeFalsy();
    expect(screen.getState().view).toMatchObject({ kind: 'workspace', id: ws.id });
    expect(toasts.some((t) => t.startsWith("Couldn't restore"))).toBe(false);
  });

  it('archives several in one repo one after another, each out of the sidebar at once', async () => {
    const a = (await ctl.newWorktree(projectId(), 'one'))!;
    const b = (await ctl.newWorktree(projectId(), 'two'))!;
    const both = Promise.all([ctl.archive(a.id), ctl.archive(b.id)]);
    const shown = store.getState().projects.find((p) => p.root)!.workspaces;
    expect(shown.find((w) => w.id === a.id)?.archived).toBe(true);
    expect(shown.find((w) => w.id === b.id)?.archived).toBe(true);
    expect(await both).toEqual([true, true]);
    expect(existsSync(a.path) || existsSync(b.path)).toBe(false);
  });

  it('archiving or deleting a conversation takes its sub-agents’ worktrees with it (branches kept; work in progress stays)', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'lead'))!;
    const done = subAgentWorktree(ws.path, 'a1');
    const dirty = subAgentWorktree(ws.path, 'a2');
    writeFileSync(path.join(dirty, 'a.txt'), 'half done\n');
    const working = subAgentWorktree(ws.path, 'a3');
    // No branch (detached): its commits would be lost with it.
    const detached = subAgentWorktree(ws.path, 'a4');
    sh(detached, 'checkout', '-q', '--detach');
    // Written to just now, in a session Beluga doesn't follow: maybe still working.
    const fresh = subAgentWorktree(ws.path, 'a5');
    const now = Date.now() / 1000;
    utimesSync(path.join(claude, 'projects', ws.path.replace(/[^a-zA-Z0-9]/g, '-'), 'aaaaaaaa-0000-0000-0000-00000000000a', 'subagents', 'agent-a5.meta.json'), now, now);
    store.dispatch({ type: 'claude_code', sessions: [{ id: 's', title: 's', cwd: ws.path, status: 'working', lastAt: 1, steps: 1, agents: [{ id: 'a3', description: 'a3', type: 'general-purpose', background: true, status: 'running', startedAt: 1, lastAt: 1, steps: 1, worktree: { path: working } }] }] });
    // Another conversation's sub-agent: not this one's to remove.
    const other = (await ctl.newWorktree(projectId(), 'other'))!;
    const theirs = subAgentWorktree(other.path, 'b1', 'bbbbbbbb-0000-0000-0000-00000000000b');
    await ctl.refresh();

    expect(await ctl.archive(ws.id)).toBe(true);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
    expect(existsSync(working)).toBe(true);
    expect(existsSync(detached)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(theirs)).toBe(true);
    expect(branches()).toContain('worktree-agent-a1');
    expect(toasts.at(-1)).toBe('Archived: everything of yours is kept, uncommitted work included. Removed its 1 sub-agent worktree too (branches kept). Kept 4 sub-agent worktrees: still working, uncommitted changes or no branch.');

    await ctl.remove(other.id);
    expect(existsSync(theirs)).toBe(false);
    expect(branches()).toContain('worktree-agent-b1');
    expect(toasts.at(-1)).toBe('Deleted. Removed its 1 sub-agent worktree too (branches kept).');
    // Nothing of its own: says only what it did.
    const plain = (await ctl.newWorktree(projectId(), 'plain'))!;
    await ctl.remove(plain.id);
    expect(toasts.at(-1)).toBe('Deleted.');
  });

  it('turns a draft into a chat with the first message, in the folder Beluga started in', async () => {
    const launch = path.dirname(repo);
    await ctl.startChat('chats', 'explain   this repo please', launch);
    const chat = store.getState().projects.find((p) => p.id === 'chats')!.workspaces[0]!;
    expect(chat).toMatchObject({ name: 'explain this repo please', path: launch, kind: 'chat' });
    expect(asked.at(-1)).toEqual({ prompt: 'explain   this repo please', channel: `ws:${chat.id}` });
    await ctl.remove(chat.id);
    expect(existsSync(launch)).toBe(true); // never deletes a folder you started a chat in
  });

  it.each(['/deploy staging', '/git:sync main', '//review changes'])('starts and runs the first skill or custom command %s in Plan mode', async (text) => {
    store.dispatch({ type: 'plan_mode', channel: 'draft', on: true });
    screen.dispatch({ type: 'view', view: { kind: 'draft', projectId: 'chats', dir: repo, back: { kind: 'overview' } } });
    const api = apiProxy(async (method, raw) => {
      expect(method).toBe('workspaces.startChat');
      const args = API['workspaces.startChat'].args.parse(raw);
      return HANDLERS['workspaces.startChat']({ workspaces: ctl } as Session, ...args);
    });
    submitTyped({ client: { store: screen, api } as BelugaClient, ui: () => ({}), patchUi: () => undefined, runUiAction: () => undefined }, text);
    await waitFor(() => asked.length > 0);
    const chat = store.getState().projects.find((p) => p.id === 'chats')!.workspaces[0]!;
    expect(chat).toMatchObject({ kind: 'chat', path: repo });
    expect(asked).toEqual([{ prompt: text.replace(/^\/\//, '/'), channel: `ws:${chat.id}` }]);
    expect(askedInPlan).toEqual([true]);
  });

  it.each([true, false, undefined])('starts the first chat message in the selected mode (%s)', async (plan) => {
    const args = API['workspaces.startChat'].args.parse(['chats', 'Explain this repo', repo, plan === undefined ? undefined : { plan }]);
    await HANDLERS['workspaces.startChat']({ workspaces: ctl } as Session, ...args);
    const chat = store.getState().projects.find((p) => p.id === 'chats')!.workspaces[0]!;
    expect(asked).toEqual([{ prompt: 'Explain this repo', channel: `ws:${chat.id}` }]);
    expect(askedInPlan).toEqual([plan === true]);
    expect(store.getState().planMode[`ws:${chat.id}`] === true).toBe(plan === true);
  });

  it('starts a worktree as a plan’s home with Plan with Tasks: the draft plan is there before its agent hears the first message', async () => {
    const work = new PlansWork({ store, plans: new Plans({ store, dir: null }), board: new BoardWork({ store, board: new Board({ store, dir: null, projectName: () => 'app' }), controller: ctl, selfId: () => 'me', selfName: () => 'Kay', askClaude: () => undefined }), git: null, askClaude: () => 'ask', intend: () => undefined, delayMs: 0 });
    const heard: Array<{ prompt: string; channel: string; planned: boolean; plan: boolean; terminal: boolean }> = [];
    const c = new WorkspaceController({
      manager: new WorkspaceManager(new WorkspaceStore(path.join(repo, '..', '..', 'home'))),
      store,
      shares,
      selfId: () => 'me',
      toast: (t) => void toasts.push(t),
      intend: () => undefined,
      planHere: (channel) => void work.here(channel),
      askClaude: (prompt, channel, o) =>
        void heard.push({ prompt, channel, planned: Boolean(planForHome(store.getState().plans, channel)), plan: store.getState().planMode[channel] === true, terminal: o?.terminal === true }),
      claudeHome: claude,
    });
    await c.refresh();
    const args = API['workspaces.startWorktree'].args.parse([projectId(), 'Add refunds to the admin', { name: 'refunds', tasks: true, terminal: true }]);
    const id = await HANDLERS['workspaces.startWorktree']({ workspaces: c, nameTask: async () => 'refunds' } as unknown as Session, ...args);
    const channel = `ws:${id}`;
    // Planned in the chat (milestones and tasks need it), never plan mode: a plan's own conversation has none.
    expect(heard).toEqual([{ prompt: 'Add refunds to the admin', channel, planned: true, plan: false, terminal: false }]);
    const plan = planForHome(store.getState().plans, channel)!;
    expect(plan.body).toBeUndefined();
    expect(work.forRun(channel, 'me')?.brief).toContain('a draft only you and the user see');
  });

  it('a worktree whose plan can’t be made plans first instead, and says why', async () => {
    const heard: Array<{ channel: string; plan: boolean }> = [];
    const c = new WorkspaceController({
      manager: new WorkspaceManager(new WorkspaceStore(path.join(repo, '..', '..', 'home'))),
      store,
      shares,
      selfId: () => 'me',
      toast: (t) => void toasts.push(t),
      intend: () => undefined,
      planHere: () => {
        throw new Error('Plans need the Beluga app');
      },
      askClaude: (_prompt, channel) => void heard.push({ channel, plan: store.getState().planMode[channel] === true }),
      claudeHome: claude,
    });
    await c.refresh();
    const ws = (await c.startWorktree(projectId(), 'Add refunds', async () => 'refunds', { name: 'refunds', tasks: true }))!;
    expect(heard).toEqual([{ channel: `ws:${ws.id}`, plan: true }]);
    expect(toasts).toContain('Couldn’t plan it with tasks (Plans need the Beluga app): its agent plans first instead');
  });

  it('organizes projects into groups and hides them', async () => {
    await ctl.setGroup(projectId(), 'work');
    expect(store.getState().projectGroups).toEqual([{ name: 'work', projects: [repo] }]);
    await ctl.renameGroup('work', 'Client work');
    expect(store.getState().projectGroups).toEqual([{ name: 'Client work', projects: [repo] }]);
    await ctl.renameGroup('nope', 'x');
    expect(toasts.at(-1)).toMatch(/No group called "nope"/);
    await ctl.ungroup('Client work');
    expect(store.getState().projectGroups).toEqual([]);
    await ctl.setGroup(projectId(), 'work');
    await ctl.setGroup(projectId(), undefined);
    expect(store.getState().projectGroups).toEqual([]);
    await ctl.hideProject(projectId());
    expect(store.getState().projects.filter((p) => p.root)).toEqual([]);
  });

  it('arranges the sidebar at once, refuses what isn’t there, and shows hidden projects again', async () => {
    expect(store.getState().projectOrder).toEqual([repo]);
    expect(ctl.newGroup('Work', { before: { project: projectId() } })).toBe('Work');
    expect(store.getState().projectOrder).toEqual(['group:Work', repo]);
    expect(store.getState().projectGroups).toEqual([{ name: 'Work', projects: [] }]);
    expect(ctl.arrange({ project: projectId() }, { into: 'Work' })).toBe(true);
    expect(store.getState().projectOrder).toEqual(['group:Work']);
    expect(store.getState().projectGroups).toEqual([{ name: 'Work', projects: [repo] }]);
    expect(ctl.arrange({ project: 'nope' }, {})).toBe(false);
    expect(toasts.at(-1)).toMatch(/Project not found/);
    expect(ctl.newGroup('Work')).toBeUndefined();
    expect(toasts.at(-1)).toMatch(/already a group/);
    await ctl.hideProject(projectId());
    expect(store.getState().hiddenProjects).toEqual([repo]);
    expect(await ctl.showProject(repo)).toBe(true);
    expect(store.getState().hiddenProjects).toEqual([]);
    expect(store.getState().projectGroups).toEqual([{ name: 'Work', projects: [repo] }]);
    expect(await ctl.showProject('/not/hidden')).toBe(false);
  });

  it('deletes a project: its worktrees archived losslessly, out of the sidebar, the folder kept or trashed', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'tidy'))!;
    writeFileSync(path.join(ws.path, 'notes.txt'), 'mine\n');
    await ctl.setGroup(projectId(), 'work');
    const removing = ctl.removeProject(projectId());
    // Out of the sidebar before its worktree is archived.
    expect(store.getState().projects.filter((p) => p.root)).toEqual([]);
    expect(existsSync(ws.path)).toBe(true);
    expect(await removing).toBe(true);
    expect(store.getState().projects.filter((p) => p.root)).toEqual([]);
    expect(store.getState().hiddenProjects).toEqual([]);
    expect(store.getState().projectGroups).toEqual([{ name: 'work', projects: [] }]);
    expect(toasts.at(-1)).toMatch(/Removed app from Beluga\. 1 worktree archived/);
    expect(existsSync(repo)).toBe(true); // the folder stays without the checkbox
    expect(existsSync(ws.path)).toBe(false); // archived, its work kept in the archive
    expect(trashed).toEqual([]);
    // Its scanned root doesn't bring it back; adding it again does, with the worktree to restore.
    await ctl.refresh();
    expect(store.getState().projects.filter((p) => p.root)).toEqual([]);
    await ctl.addProject(repo);
    expect(store.getState().projects.find((p) => p.root)?.workspaces.find((w) => w.id === ws.id)?.archived).toBe(true);
    await ctl.restore(ws.id);
    expect(readFileSync(path.join(ws.path, 'notes.txt'), 'utf8')).toBe('mine\n');
    // With the checkbox: the folder goes to the Trash (never rm).
    expect(await ctl.removeProject(projectId(), true)).toBe(true);
    expect(trashed).toEqual([repo]);
    expect(toasts.at(-1)).toMatch(/in the Trash/);
    expect(await ctl.removeProject('nope')).toBe(false);
    expect(toasts.at(-1)).toMatch(/Project not found/);
  });

  it('adds a project back while its delete is still archiving: the delete can’t take it out again', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'tidy'))!;
    const id = projectId();
    const removing = ctl.removeProject(id);
    const adding = ctl.addProject(repo);
    expect(await removing).toBe(true);
    expect(await adding).toEqual({ project: { id, name: 'app' } });
    expect(store.getState().projects.find((p) => p.id === id)?.workspaces.find((w) => w.id === ws.id)?.archived).toBe(true);
    await ctl.refresh();
    expect(store.getState().projects.filter((p) => p.root).map((p) => p.id)).toEqual([id]);
  });

  it('says what adding did, or why it couldn’t, and a watched folder brings back what was removed from it', async () => {
    const id = projectId();
    expect(await ctl.removeProject(id)).toBe(true);
    expect(store.getState().projects.filter((p) => p.root)).toEqual([]);
    expect(await ctl.addFolder(path.dirname(repo))).toEqual({ found: 1 });
    expect(store.getState().projects.filter((p) => p.root).map((p) => p.id)).toEqual([id]);
    expect(await ctl.addProject('/definitely/not/here')).toEqual({ error: expect.stringMatching(/isn’t there anymore/) });
    const plain = mkdtempSync(path.join(os.tmpdir(), 'klaud-plain-'));
    const session = { workspaces: ctl, toast: (t: string) => void toasts.push(t), store } as unknown as Session;
    expect(await HANDLERS['projects.add'](session, plain)).toEqual({ error: expect.stringMatching(/isn't a git project/), canInit: true });
    expect(await HANDLERS['projects.initGit'](session, plain)).toEqual({ project: { id: expect.any(String), name: path.basename(plain) } });
    expect(isMainCheckout(plain)).toBe(true);
    expect(await HANDLERS['projects.add'](session, repo)).toEqual({ project: { id, name: 'app' } });
  });

  it('starts chats and adds projects or folders', async () => {
    const chat = (await ctl.newChat(projectId(), 'Question'))!;
    expect(chat.kind).toBe('chat');
    expect(ctl.place(`ws:${chat.id}`)?.autoEdit).toBe(false);
    await ctl.addProject(mkdtempSync(path.join(os.tmpdir(), 'klaud-plain-')));
    expect(toasts.at(-1)).toMatch(/not a git project/);
    await ctl.addFolder(path.dirname(repo));
    expect(toasts.at(-1)).toMatch(/1 project/);
    ctl.openInFinder('missing');
    expect(toasts.at(-1)).toMatch(/no longer exists/);
    ctl.open('missing');
    expect(workspaceIdOf('ws:abc')).toBe('abc');
    expect(workspaceIdOf('room')).toBeUndefined();
  });

  it('runs workspace commands against the current workspace', async () => {
    const session = { workspaces: ctl, toast: (t: string) => void toasts.push(t), intend: (i: Parameters<ClientStore['applyIntent']>[0]) => screen.applyIntent(i), store } as unknown as Session;
    const here = (): string => (screen.getState().view.kind === 'workspace' ? `ws:${(screen.getState().view as { id: string }).id}` : 'room');
    runCommand(session, 'merge', [], here());
    expect(toasts.at(-1)).toBe('Open a workspace first (Projects on the left)');
    runCommand(session, 'new', [], here());
    expect(toasts.at(-1)).toBe('Usage: /new <name>');
    runCommand(session, 'new', ['cmd', 'test'], here());
    // Its page opens at once; until git has made it, commands there say so.
    expect(screen.getState().view.kind).toBe('workspace');
    runCommand(session, 'fork', [], here());
    expect(toasts.at(-1)).toBe('This worktree is still being made: a moment');
    await waitFor(() => ctl.inChannel(here()) !== undefined, 5000);
    runCommand(session, 'fork', [], here());
    expect(toasts.at(-1)).toBe('Usage: /fork <name>');
    runCommand(session, 'review', [], here());
    expect(screen.getState().view).toMatchObject({ tab: 'review' });
    runCommand(session, 'project', ['oops'], here());
    expect(toasts.at(-1)).toContain('/project add <path>');
    runCommand(session, 'overview', [], here());
    expect(screen.getState().view.kind).toBe('overview');
    runCommand(session, 'room', [], here());
    expect(screen.getState().view.kind).toBe('room');
  });

  it('the main checkout is no conversation (BLG-70): opening it opens the project’s home, Claude never runs there, and New Chat makes a new chat each time', async () => {
    const main = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.kind === 'main')!;
    ctl.open(main.id);
    expect(screen.getState().view).toEqual({ kind: 'project', id: projectId() });
    expect(screen.getState().tabs).not.toContain(main.id);
    expect(ctl.place(`ws:${main.id}`)).toBeUndefined();
    expect(ctl.ensureLoaded(main.id)).toBeUndefined();
    const a = await ctl.newChat(projectId(), 'first question');
    const b = await ctl.newChat(projectId(), 'second question');
    expect(a!.id).not.toBe(b!.id);
    const chats = store.getState().projects.find((p) => p.root)!.workspaces.filter((w) => w.kind === 'chat');
    expect(chats.map((w) => w.name).sort()).toEqual(['first question', 'second question']);
    expect(ctl.place(`ws:${a!.id}`)?.cwd).toBe(repo);
  });
});
