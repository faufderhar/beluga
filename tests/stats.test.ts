import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StatsCounter } from '../src/core/stats/counter.js';
import { demoStats } from '../src/core/stats/demo.js';
import { emptyStats, loadStats, snapshotOf } from '../src/core/stats/file.js';
import { belugaBranches, fromHistory, observeWorkspaces, withPrs } from '../src/core/stats/tally.js';
import { type LogItem, Store, initialState } from '../src/core/store.js';
import { parseArgs } from '../src/ipc/api.js';
import { dailySeries, rangeStart, shiftDay, statDay, streaks, totalsBy, totalsOf } from '../src/shared/stats.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/** Your stats (BLG-755): counted live, backfilled from records, histories and GitHub, summed by project and agent. */

const ROOT = '/code/app';
const NOW = new Date(2026, 10, 7, 15).getTime();
const DAY = 86_400_000;
const SELF = 'me';

const ws = (id: string, more: Partial<Workspace> = {}): Workspace => ({ id, projectId: 'p1', projectRoot: ROOT, name: id, path: `/wt/${id}`, kind: 'worktree', branch: `beluga/${id}`, createdAt: NOW - 3 * DAY, external: false, ...more });
const project = (workspaces: Workspace[]): Project => ({ id: 'p1', name: 'app', root: ROOT, base: 'origin/main', workspaces });
const agentOf = (w: Workspace): string => w.agent?.runtime ?? 'claude';
const usage = (input: number, cost: number, days?: Record<string, { tokens: number; cost: number }>) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, cost, runs: 1, ...(days ? { days } : {}) });

describe('observing workspaces', () => {
  it('backfills worktrees, chats, archives and tokens from the records, on their own days', () => {
    const made = NOW - 3 * DAY;
    const twoDaysAgo = statDay(NOW - 2 * DAY);
    const list = [
      ws('a', { usage: usage(1000, 1, { [twoDaysAgo]: { tokens: 600, cost: 0.6 } }) }),
      ws('b', { archived: true, archive: { freedBytes: 0, keptBytes: 0, remake: [], at: NOW - DAY }, agent: { runtime: 'codex', label: 'Codex' } }),
      ws('c', { kind: 'chat', branch: undefined }),
      ws('other-tool', { external: true }),
    ];
    const file = observeWorkspaces(emptyStats(NOW), [project(list)], agentOf, NOW);
    const all = totalsOf(snapshotOf(file, false), '');
    expect(all).toMatchObject({ worktrees: 2, chats: 1, archived: 1, tokens: 1000, cost: 1 });
    // 600 on the day they were spent, the other 400 on the day it was made.
    expect(file.days[twoDaysAgo]![ROOT]!.claude!.tokens).toBe(600);
    expect(file.days[statDay(made)]![ROOT]!.claude!.tokens).toBe(400);
    expect(totalsBy(snapshotOf(file, false), 'agent', '').get('codex')).toMatchObject({ worktrees: 1, archived: 1 });
  });

  it('then counts only what changed: tokens spent since, one archived since, one made', () => {
    let file = observeWorkspaces(emptyStats(NOW), [project([ws('a', { usage: usage(1000, 1) })])], agentOf, NOW);
    const same = observeWorkspaces(file, [project([ws('a', { usage: usage(1000, 1) })])], agentOf, NOW);
    expect(same).toBe(file);
    file = observeWorkspaces(file, [project([ws('a', { usage: usage(1500, 1.5), archived: true }), ws('n', { createdAt: NOW })])], agentOf, NOW);
    const today = totalsOf(snapshotOf(file, false), statDay(NOW));
    expect(today).toMatchObject({ tokens: 500, cost: 0.5, archived: 1, worktrees: 1 });
  });

  it('counts a workspace with no real date on the last day it was used, never in 1970', () => {
    const lastAt = NOW - 2 * DAY;
    const list = [ws('dateless', { createdAt: 0, usage: { ...usage(100, 0.1), lastAt } }), ws('never-used', { createdAt: 0 })];
    const file = observeWorkspaces(emptyStats(NOW), [project(list)], agentOf, NOW);
    expect(Object.keys(file.days).sort()).toEqual([statDay(lastAt), statDay(NOW)]);
    expect(totalsOf(snapshotOf(file, false), '').worktrees).toBe(2);
  });
});

describe('the chat history backfill', () => {
  const items: LogItem[] = [
    { id: '1', type: 'chat', channel: 'ws:a', from: SELF, name: 'Me', text: 'hello there', ts: NOW - DAY, byAgent: false },
    { id: '2', type: 'chat', channel: 'ws:a', from: 'friend', name: 'Mia', text: 'not mine', ts: NOW - DAY, byAgent: false },
    { id: '3', type: 'chat', channel: 'ws:a', from: SELF, name: 'Me', text: 'my agent wrote', ts: NOW - DAY, byAgent: true },
    {
      id: '4',
      type: 'agent',
      channel: 'ws:a',
      subagents: [],
      requestId: 'r',
      owner: SELF,
      ownerName: 'Me',
      requesterName: 'Me',
      status: 'done',
      text: '',
      steps: [],
      ts: NOW - DAY,
      endTs: NOW - DAY + 90_000,
      agent: { runtime: 'codex', label: 'Codex' },
    },
    { id: '5', type: 'chat', channel: 'ws:a', from: SELF, name: 'Me', text: 'after counting began', ts: NOW + 1, byAgent: false },
  ];

  it('counts your prompts and your agent’s runs from before counting began', () => {
    const file = fromHistory(emptyStats(NOW), items, SELF, ROOT, 'claude', NOW);
    const t = totalsBy(snapshotOf(file, false), 'agent', '');
    expect(t.get('claude')).toMatchObject({ prompts: 1, chars: 'hello there'.length });
    expect(t.get('codex')).toMatchObject({ agentMs: 90_000, runs: 1 });
    expect(file.hours.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe('pull requests from GitHub', () => {
  it('keeps Beluga’s own, with lines on the day they merged, and replaces what it knew', () => {
    const p = project([ws('a', { agent: { runtime: 'codex', label: 'Codex' } })]);
    const prs = [
      { number: 1, headRefName: 'beluga/a', createdAt: new Date(NOW - 2 * DAY).toISOString(), mergedAt: new Date(NOW - DAY).toISOString(), additions: 30, deletions: 5 },
      { number: 2, headRefName: 'beluga/deleted-since', createdAt: new Date(NOW - DAY).toISOString(), mergedAt: null },
      { number: 3, headRefName: 'someone-else', createdAt: new Date(NOW - DAY).toISOString() },
    ];
    const file = withPrs(emptyStats(NOW), p, prs, belugaBranches(p, agentOf), 'claude', NOW);
    expect(Object.keys(file.prs).sort()).toEqual([`${ROOT}#1`, `${ROOT}#2`]);
    const t = totalsBy(snapshotOf(file, false), 'agent', '');
    expect(t.get('codex')).toMatchObject({ prsOpened: 1, prsMerged: 1, linesAdded: 30, linesRemoved: 5 });
    expect(t.get('claude')).toMatchObject({ prsOpened: 1, prsMerged: 0 });
    expect(file.prsAt[ROOT]).toBe(NOW);
  });
});

describe('reading the stats', () => {
  it('sums ranges, days and streaks', () => {
    let file = emptyStats(NOW);
    for (const ago of [0, 1, 2, 5, 6]) file = fromHistory(file, [{ id: String(ago), type: 'chat', channel: 'ws:a', from: SELF, name: 'Me', text: 'x', ts: NOW - ago * DAY, byAgent: false }], SELF, ROOT, 'claude', NOW + 1);
    const snap = snapshotOf(file, false);
    expect(totalsOf(snap, rangeStart('week', NOW)).prompts).toBe(5);
    expect(totalsOf(snap, rangeStart('week', NOW), shiftDay(statDay(NOW), -2)).prompts).toBe(2);
    expect(dailySeries(snap, 'prompts', NOW, 3).map((d) => d.value)).toEqual([1, 1, 1]);
    expect(streaks(snap, NOW)).toEqual({ current: 3, longest: 3 });
    expect(snap.since).toBeLessThanOrEqual(NOW - 6 * DAY);
  });

  it('starts from your first real day, past one counted in 1970 by a record with no date', () => {
    const file = { ...emptyStats(NOW), days: { '1970-01-01': { [ROOT]: { claude: { worktrees: 1 } } }, [statDay(NOW - 5 * DAY)]: { [ROOT]: { claude: { prompts: 1 } } } } };
    expect(statDay(snapshotOf(file, false).since)).toBe(statDay(NOW - 5 * DAY));
    // Nothing real at all: from when counting began.
    const only = { ...emptyStats(NOW), days: { '1970-01-01': { [ROOT]: { claude: { worktrees: 1 } } } } };
    expect(snapshotOf(only, false).since).toBe(NOW);
  });

  it('makes a repeatable demo year for every project', () => {
    const p = project([]);
    const a = demoStats([p], NOW);
    expect(a).toEqual(demoStats([p], NOW));
    expect(Object.keys(a.days).length).toBeGreaterThan(150);
    expect(Object.keys(a.prs).length).toBeGreaterThan(5);
    // The month view is what Usage opens on. Claude, Codex and the local model each merged one there.
    const monthAgo = NOW - 30 * DAY;
    const merged = new Set(Object.values(a.prs).filter((p) => p.merged !== undefined && p.merged >= monthAgo).map((p) => p.agent));
    expect([...merged].sort()).toEqual(['claude', 'codex', 'local']);
  });
});

describe('the counter', () => {
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('counts your prompts and your runs live, pastes the Mac reports, and writes a while later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'stats-'));
      const file = path.join(dir, 'stats.json');
      const store = new Store(initialState('test', 'ask'));
      store.dispatch({ type: 'identity', selfId: SELF, isHost: true });
      store.dispatch({ type: 'projects', projects: [project([ws('a')])] });
      const counter = new StatsCounter({ store, file, historyDir: null, listPrs: null, now: () => NOW });
      counter.start();
      counter.prompt('ws:a', 'fix it');
      // Not prompts: a slash command, the room, and what Beluga writes in the chat for you.
      counter.prompt('ws:a', '/clear');
      counter.prompt('room', 'hi all');
      store.dispatch({ type: 'chat', id: 'm1', from: SELF, text: 'Switched to Codex: here is the story so far', ts: NOW, byAgent: false, channel: 'ws:a' });
      // A friend's request your agent ran: not your time.
      store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'f1', requester: 'friend', event: 'started', text: '', ts: NOW, channel: 'ws:a' });
      store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'f1', requester: 'friend', event: 'done', text: 'ok', ts: NOW + 30_000, channel: 'ws:a' });
      store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'r1', requester: SELF, event: 'started', text: '', ts: NOW, channel: 'ws:a' });
      store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'r1', requester: SELF, event: 'done', text: 'ok', ts: NOW + 60_000, channel: 'ws:a' });
      await tick();
      counter.note({ kind: 'paste', chars: 1200, channel: 'ws:a' });
      counter.note({ kind: 'dictation', ms: 30_000 });
      const t = totalsOf(counter.snapshot(), '');
      expect(t).toMatchObject({ prompts: 1, chars: 6, agentMs: 60_000, runs: 1, pasted: 1200, dictationMs: 30_000 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(totalsOf(snapshotOf(loadStats(file, NOW), false), '').worktrees).toBe(1);
      expect(JSON.parse(readFileSync(file, 'utf8')).v).toBe(1);
      counter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('backfills chat histories once, beside what it counted live', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'stats-'));
    mkdirSync(path.join(dir, 'history'));
    const old: LogItem = { id: 'o', type: 'chat', channel: 'ws:a', from: SELF, name: 'Me', text: 'from before', ts: NOW - DAY, byAgent: false };
    writeFileSync(path.join(dir, 'history', 'a.json'), JSON.stringify([old]));
    const store = new Store(initialState('test', 'ask'));
    store.dispatch({ type: 'identity', selfId: SELF, isHost: true });
    store.dispatch({ type: 'projects', projects: [project([ws('a')])] });
    const listPrs = vi.fn(async () => '[]');
    const counter = new StatsCounter({ store, file: null, historyDir: path.join(dir, 'history'), listPrs, now: () => NOW });
    counter.start();
    counter.prompt('new-worktree:p1', 'make it so', 'codex');
    await tick();
    await counter.backfill();
    await counter.backfill();
    expect(totalsOf(counter.snapshot(), '').prompts).toBe(2);
    expect(totalsBy(counter.snapshot(), 'agent', '').get('codex')?.prompts).toBe(1);
    expect(listPrs).toHaveBeenCalledTimes(1);
    counter.stop();
  });
});

describe('the API', () => {
  it('takes only a length or a time from the Mac', () => {
    expect(() => parseArgs('stats.note', [{ kind: 'paste', chars: 12, channel: 'ws:a' }])).not.toThrow();
    expect(() => parseArgs('stats.note', [{ kind: 'paste', chars: 12, text: 'secret' }])).toThrow();
    expect(() => parseArgs('stats.note', [{ kind: 'dictation', ms: 0 }])).toThrow();
  });
});
