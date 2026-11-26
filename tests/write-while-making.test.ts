import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { HeldAsks } from '../src/core/held-asks.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { TerminalManager } from '../src/terminal/index.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { waitFor } from './helpers.js';

/**
 * Writing in a worktree while it's still being made (Open in Worktree on a pull request, a new
 * worktree): the page and its message box show at once, what you write is in its conversation at
 * once, and its agent gets it once git has made the folder. If it can't be made, you're told.
 */

const keys = deriveKeys(generateSecret());
let hub: Hub;
let base: string;
let terminals: TerminalManager;
const sessions: Session[] = [];
const home = process.env.BELUGA_HOME;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-held-')));
  process.env.BELUGA_HOME = path.join(base, 'beluga-home');
  terminals = new TerminalManager();
  hub = await startHub({ keys });
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  terminals.closeAll();
  await hub?.close();
  process.env.BELUGA_HOME = home;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

/** A project whose origin has a teammate's branch, fix/email, for a pull request to be on. */
function repo(): string {
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin], { stdio: 'pipe' });
  const dir = path.join(base, 'code', 'app');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  git(dir, 'push', '-q', 'origin', 'main:fix/email');
  return dir;
}

async function solo(dir: string) {
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, reconnect: false });
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [], projects: [dir], hidden: [] });
  const workspaces = new WorkspaceManager(wsStore);
  await workspaces.refresh();
  const runs: AgentRunInput[] = [];
  const session = new Session({
    client,
    store,
    shares: new ShareService([]),
    agentCwd: base,
    workspaces,
    terminals,
    hasGh: async () => false,
    findPr: async () => undefined,
    open: () => undefined,
    desktopNotify: () => undefined,
    zoom: async () => ({ ok: true, message: '' }),
    copy: async () => undefined,
    saveSettings: () => undefined,
    createAgent: (): AgentBackend => ({
      nameTask: async () => 'named',
      run: async (input) => {
        runs.push(input);
        return 'Looked.';
      },
    }),
  });
  session.start();
  sessions.push(session);
  await waitFor(() => store.getState().self, 4000);
  const pid = workspaces.list.find((p) => p.root)!.id;
  return { session, state: store.getState, runs, pid };
}

type Head = { number: number; branch: string; base: string };
const mine = (state: () => ReturnType<Store['getState']>, channel: string): string[] => state().log.filter((l) => l.channel === channel && l.type === 'chat').map((l) => (l.type === 'chat' ? l.text : ''));
type Card = Extract<ReturnType<Store['getState']>['log'][number], { type: 'agent' }>;
const cards = (state: () => ReturnType<Store['getState']>, channel: string): Card[] => state().log.filter((l): l is Card => l.channel === channel && l.type === 'agent');

describe('writing in a worktree while it is being made', () => {
  it('shows your message at once, and its agent gets it once the worktree is made', { timeout: 20_000 }, async () => {
    const kay = await solo(repo());
    let answer!: (pull: Head) => void;
    const job = kay.session.workspaces!.openPull(kay.pid, 12, () => new Promise<Head>((r) => (answer = r)), { id: 'wt-0123456789ab' });
    const channel = 'ws:wt-0123456789ab';
    await waitFor(() => kay.session.workspaces!.isMaking(channel), 2000);
    expect(kay.session.submit('Review this pull request', { channel })).toBe(true);
    // Sent, never queued: in its conversation now, nobody asked yet (there's no folder for its agent).
    expect(mine(kay.state, channel)).toEqual(['Review this pull request']);
    expect(kay.state().log.find((l) => l.channel === channel && l.type === 'chat')).not.toHaveProperty('queued');
    expect(kay.runs).toHaveLength(0);
    // Its agent's card is under it already, making the worktree as its first step.
    await waitFor(() => cards(kay.state, channel).length === 1, 2000);
    const card = cards(kay.state, channel)[0]!;
    expect(card).toMatchObject({ status: 'started', steps: ['make_worktree pr-12'] });
    const step = () => kay.session.host.stepsFor(channel, card.id).steps[0];
    expect(step()).toMatchObject({ tool: 'make_worktree', status: 'running', label: 'Made the worktree pr-12', doing: 'Making the worktree pr-12' });
    answer({ number: 12, branch: 'fix/email', base: 'main' });
    const ws = await job;
    expect(ws?.id).toBe('wt-0123456789ab');
    await waitFor(() => kay.runs.length === 1, 4000);
    expect(step()).toMatchObject({ status: 'done' });
    expect(kay.runs[0]!.prompt).toContain('Review this pull request');
    expect(kay.runs[0]!.place?.cwd).toBe(ws!.path);
    // Said once, one card: its agent goes on in the card that made the worktree.
    expect(mine(kay.state, channel)).toEqual(['Review this pull request']);
    await waitFor(() => cards(kay.state, channel)[0]?.status === 'done', 4000);
    expect(cards(kay.state, channel)).toHaveLength(1);
    expect(cards(kay.state, channel)[0]!.text).toBe('Looked.');
  });

  it('a Retry of the same message while it waits is the same message', { timeout: 20_000 }, async () => {
    const kay = await solo(repo());
    let answer!: (pull: Head) => void;
    const job = kay.session.workspaces!.openPull(kay.pid, 12, () => new Promise<Head>((r) => (answer = r)), { id: 'wt-0123456789ac' });
    const channel = 'ws:wt-0123456789ac';
    await waitFor(() => kay.session.workspaces!.isMaking(channel), 2000);
    kay.session.submit('Run the tests', { channel, id: 'm1' });
    kay.session.submit('Run the tests', { channel, id: 'm1' });
    answer({ number: 12, branch: 'fix/email', base: 'main' });
    await job;
    await waitFor(() => kay.runs.length >= 1, 4000);
    await new Promise((r) => setTimeout(r, 100));
    expect(kay.runs).toHaveLength(1);
    expect(mine(kay.state, channel)).toEqual(['Run the tests']);
  });

  it('its card says the message was not sent when the worktree can’t be made', { timeout: 20_000 }, async () => {
    const kay = await solo(repo());
    let fail!: (err: Error) => void;
    const job = kay.session.workspaces!.openPull(kay.pid, 12, () => new Promise<Head>((_, reject) => (fail = reject)), { id: 'wt-0123456789ad' });
    const channel = 'ws:wt-0123456789ad';
    await waitFor(() => kay.session.workspaces!.isMaking(channel), 2000);
    kay.session.submit('Review this pull request', { channel });
    fail(new Error('gh is not signed in'));
    await expect(job).rejects.toThrow('gh is not signed in');
    await waitFor(() => cards(kay.state, channel)[0]?.status === 'error', 2000);
    expect(cards(kay.state, channel)[0]!.text).toMatch(/The worktree couldn’t be made, so this wasn’t sent/);
    expect(kay.session.host.stepsFor(channel, cards(kay.state, channel)[0]!.id).steps[0]).toMatchObject({ status: 'error' });
    expect(kay.runs).toHaveLength(0);
  });

  it('Stop on its card while the worktree is made takes the message back, and its agent never gets it', { timeout: 20_000 }, async () => {
    const kay = await solo(repo());
    let answer!: (pull: Head) => void;
    const job = kay.session.workspaces!.openPull(kay.pid, 12, () => new Promise<Head>((r) => (answer = r)), { id: 'wt-0123456789ae' });
    const channel = 'ws:wt-0123456789ae';
    await waitFor(() => kay.session.workspaces!.isMaking(channel), 2000);
    kay.session.submit('Review this pull request', { channel });
    expect(kay.session.host.stopRun(channel)).toEqual({ stopped: true, returned: ['Review this pull request'] });
    await waitFor(() => cards(kay.state, channel)[0]?.status === 'error', 2000);
    answer({ number: 12, branch: 'fix/email', base: 'main' });
    expect((await job)?.id).toBe('wt-0123456789ae');
    await new Promise((r) => setTimeout(r, 200));
    expect(kay.runs).toHaveLength(0);
  });

  it('a worktree that is made goes as before', { timeout: 20_000 }, async () => {
    const kay = await solo(repo());
    const ws = await kay.session.workspaces!.openPull(kay.pid, 12, { number: 12, branch: 'fix/email', base: 'main' });
    expect(kay.session.workspaces!.holdAsk(`ws:${ws!.id}`, { go: () => undefined, drop: () => undefined })).toBe(false);
    kay.session.submit('Hello', { channel: `ws:${ws!.id}` });
    await waitFor(() => kay.runs.length === 1, 4000);
  });
});

describe('a new worktree’s first message', () => {
  it('has its agent’s card at once, making the worktree as its first step, then its agent’s work', { timeout: 20_000 }, async () => {
    const kay = await solo(repo());
    const job = kay.session.workspaces!.startWorktree(kay.pid, 'Add request logging', async () => 'request-logging', { id: 'wt-0123456789af', nameLater: true });
    const channel = 'ws:wt-0123456789af';
    await waitFor(() => cards(kay.state, channel).length === 1, 2000);
    expect(cards(kay.state, channel)[0]).toMatchObject({ steps: ['make_worktree add-request-logging'] });
    await job;
    await waitFor(() => cards(kay.state, channel)[0]?.status === 'done', 4000);
    expect(kay.runs).toHaveLength(1);
    expect(cards(kay.state, channel)).toHaveLength(1);
    expect(kay.session.host.stepsFor(channel, cards(kay.state, channel)[0]!.id).steps[0]).toMatchObject({ tool: 'make_worktree', status: 'done' });
  });
});

describe('held asks', () => {
  it('go in the order they were written, a turn after the worktree is made', () => {
    const later: Array<() => void> = [];
    const held = new HeldAsks((run) => void later.push(run));
    const done: string[] = [];
    held.hold('wt-1', { go: () => done.push('a'), drop: () => done.push('drop a') });
    held.hold('wt-1', { go: () => done.push('b'), drop: () => done.push('drop b') });
    held.hold('wt-2', { go: () => done.push('other'), drop: () => done.push('drop other') });
    expect(held.count('wt-1')).toBe(2);
    held.release('wt-1', true);
    // Whatever made it asks its own first message first.
    expect(done).toEqual([]);
    later.splice(0).forEach((run) => run());
    expect(done).toEqual(['a', 'b']);
    expect(held.count('wt-1')).toBe(0);
    held.release('wt-2', false);
    later.splice(0).forEach((run) => run());
    expect(done).toEqual(['a', 'b', 'drop other']);
  });

  it('one that throws leaves the others to go, and releasing twice asks once', () => {
    const later: Array<() => void> = [];
    const held = new HeldAsks((run) => void later.push(run));
    const done: string[] = [];
    held.hold('wt-1', { go: () => { throw new Error('boom'); }, drop: () => undefined });
    held.hold('wt-1', { go: () => done.push('b'), drop: () => undefined });
    held.release('wt-1', true);
    held.release('wt-1', true);
    later.splice(0).forEach((run) => run());
    expect(done).toEqual(['b']);
  });
});
