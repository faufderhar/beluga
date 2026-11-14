import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { Courier, SAVE_MS } from '../src/core/friend-share/courier.js';
import { Store, initialState } from '../src/core/store.js';
import { BRAKE_HOLD_MS, BRAKE_SENDS, TeamBoardSync } from '../src/core/team/board-sync.js';
import type { TaskDelta, TeamMsg } from '../src/core/team/protocol.js';
import type { TeamBoards, TeamLink } from '../src/core/team/service.js';
import { JsonFile, readJson } from '../src/net/mesh/files.js';
import { waitFor } from './helpers.js';
import { ASLEEP_MS, isFrozen } from '../src/daemon/lag.js';
import type { Project } from '../src/workspaces/types.js';

/**
 * BLG-942: a loop between teammates' Macs froze the daemon for seconds at a time (every click
 * waited). These are the guards that keep any such loop from doing that again: the outbox is
 * written in batches, the team board's brake holds a task going round, and a freeze leaves a
 * copy of what the daemon was doing.
 */

describe('a freeze is told apart from a slow moment and from sleep', () => {
  it('counts long stalls and a mostly-late period, never a Mac waking up', () => {
    expect(isFrozen({ p50: 1, p95: 3, max: 900 })).toBe(false);
    expect(isFrozen({ p50: 1, p95: 3, max: 6_000 })).toBe(true);
    expect(isFrozen({ p50: 900, p95: 2_000, max: 3_000 })).toBe(true);
    expect(isFrozen({ p50: 1, p95: 2, max: ASLEEP_MS + 1 })).toBe(false);
  });
});

describe('the courier’s outbox', () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(path.join(os.tmpdir(), 'courier-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is written once for a burst of frames, not once per frame, and at once on stop', async () => {
    const file = path.join(dir, 'team-outbox.json');
    const courier = new Courier<{ n: number }>({ isLinked: () => true, send: () => true, parse: (raw) => raw as { f: string; m: { n: number } } }, file);
    for (let n = 0; n < 500; n++) courier.send('kay', { n }, { reliable: true });
    expect(existsSync(file)).toBe(false);
    vi.advanceTimersByTime(SAVE_MS);
    // Written in the background: there a moment later, all 500 in one write.
    vi.useRealTimers();
    await waitFor(() => (readJson(file) as unknown[] | undefined)?.length === 500);

    courier.send('kay', { n: 500 }, { reliable: true });
    courier.stop();
    expect(readJson(file)).toHaveLength(501);
  });
});

describe('a big JSON file written in the background', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'json-file-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes once for many changes, never holds the thread for the disk, and ends with the newest', async () => {
    const file = path.join(dir, 'board.json');
    let value = { n: 0, big: 'x'.repeat(2_000_000) };
    const json = new JsonFile(file, () => value, 10);
    for (let n = 1; n <= 100; n++) {
      value = { ...value, n };
      json.changed();
    }
    expect(json.pending).toBe(true);
    await waitFor(() => !json.pending);
    expect((readJson(file) as { n: number }).n).toBe(100);
    // A change while a write is on its way is written right after it: the newest always wins.
    value = { ...value, n: 101 };
    json.changed();
    await new Promise((r) => setTimeout(r, 12));
    value = { ...value, n: 102 };
    json.changed();
    await waitFor(() => !json.pending);
    expect((readJson(file) as { n: number }).n).toBe(102);
    expect(readdirSync(dir)).toEqual(['board.json']);
  });

  it('flush writes now, and a write still on its way can’t land over it', async () => {
    const file = path.join(dir, 'plans.json');
    let value = { n: 1 };
    const json = new JsonFile(file, () => value, 0);
    json.changed();
    await new Promise((r) => setTimeout(r, 1));
    value = { n: 2 };
    json.changed();
    json.flush();
    expect(readJson(file)).toEqual({ n: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(readJson(file)).toEqual({ n: 2 });
    expect(json.pending).toBe(false);
  });
});

describe('the team board’s brake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Me, on a team with ata and mia: a fake team that only records what goes out. */
  function rig() {
    const store = new Store(initialState('test', 'ask'));
    store.dispatch({ type: 'projects', projects: [{ id: 'p', name: 'api', root: '/tmp/me/api', base: 'origin/main', workspaces: [] } as unknown as Project] });
    const board = new Board({ store, dir: null, projectName: () => 'api' });
    const links = [
      { id: 'l_ata', peerId: 'ata', projectId: 'p', theirProject: 'pa', since: 1 },
      { id: 'l_mia', peerId: 'mia', projectId: 'p', theirProject: 'pm', since: 1 },
    ] as unknown as TeamLink[];
    const sent: Array<{ to: string; d: TaskDelta }> = [];
    const team = {
      self: 'me',
      allLinks: () => links,
      linkById: (id: string) => links.find((l) => l.id === id),
      linksOf: (p: string) => links.filter((l) => l.projectId === p),
      teamed: (p: string) => p === 'p',
      nameOf: (id: string) => id,
      publish: () => undefined,
      send: (to: string, m: TeamMsg) => {
        if (m.k === 'ops') for (const d of m.tasks) sent.push({ to, d });
      },
      courier: { waitingFor: () => [], send: () => true },
      deps: { mesh: { isLinked: () => true } },
    } as unknown as TeamBoards;
    const brakes: string[] = [];
    const sync = new TeamBoardSync(team, { board, live: () => false, dir: null, onBrake: (id) => brakes.push(id) });
    for (const link of links) sync.joined(link, true);
    // What the team service does for its parts: every change to the board is heard.
    store.onAction((a) => sync.onAction(a));
    return { board, sync, sent, brakes };
  }

  it('holds a task ata keeps sending round, still writes every change, then sends it whole once', () => {
    const { board, sync, sent, brakes } = rig();
    const born = { at: 1, by: { kind: 'beluga' as const }, origin: 'manual' as const };
    for (let n = 1; n <= 200; n++) {
      sync.receive('ata', { k: 'ops', link: 'l_ata', tasks: [{ id: 'i_loop', fields: { title: { v: `take ${n}`, l: n, a: 'ata' }, status: { v: 'todo', l: 1, a: 'ata' } }, acts: [], born }] });
    }
    const toMia = () => sent.filter((s) => s.to === 'mia' && s.d.id === 'i_loop');
    // Passed on until the brake: not 200 frames.
    expect(toMia().length).toBe(BRAKE_SENDS);
    expect(brakes).toEqual(['i_loop']);
    // Every change still reached this board.
    expect(board.get('i_loop')?.title).toBe('take 200');

    vi.advanceTimersByTime(BRAKE_HOLD_MS);
    // Then once, whole, with the newest of everything, to every teammate.
    expect(toMia().length).toBe(BRAKE_SENDS + 1);
    expect(toMia().at(-1)!.d.fields.title).toEqual({ v: 'take 200', l: 200, a: 'ata' });
    expect(sent.filter((s) => s.to === 'ata' && s.d.id === 'i_loop').at(-1)!.d.fields.title).toEqual({ v: 'take 200', l: 200, a: 'ata' });
  });

  it('never holds an ordinary run of edits', () => {
    const { board, sent, brakes } = rig();
    const t = board.create({ projectId: 'p', title: 'Shared' }, { kind: 'person', id: 'me', name: 'me' });
    for (let n = 0; n < 10; n++) board.update(t.id, { title: `Shared ${n}` }, { kind: 'person', id: 'me', name: 'me' });
    expect(brakes).toEqual([]);
    expect(sent.filter((s) => s.to === 'mia' && s.d.id === t.id).at(-1)?.d.fields.title?.v).toBe('Shared 9');
  });
});
