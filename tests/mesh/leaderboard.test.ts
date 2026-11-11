import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meshBoardLinks } from '../../src/core/leaderboard/links.js';
import { boardFrame, parseBoardFrame } from '../../src/core/leaderboard/protocol.js';
import { type BoardLinks, Leaderboard } from '../../src/core/leaderboard/service.js';
import type { BoardDays } from '../../src/shared/leaderboard.js';
import { statDay } from '../../src/shared/stats.js';
import { type Crowd, befriend, crowd, settle } from './helpers.js';

const peer = (c: string): string => c.repeat(32);

/** Links in memory: what each side sent, and a way to hand a frame or a link coming up to it. */
function fakeLinks(linked: string[]): BoardLinks & { sent: Array<{ to: string; payload: unknown }>; frame(from: string, p: unknown): void; up(peerId: string): void } {
  const frames = new Set<(from: string, p: unknown) => void>();
  const ups = new Set<(peerId: string) => void>();
  const sent: Array<{ to: string; payload: unknown }> = [];
  return {
    sent,
    linked: () => linked,
    send: (to, payload) => (sent.push({ to, payload }), true),
    onFrame: (fn) => (frames.add(fn), () => void frames.delete(fn)),
    onLink: (fn) => (ups.add(fn), () => void ups.delete(fn)),
    frame: (from, p) => frames.forEach((fn) => fn(from, p)),
    up: (peerId) => ups.forEach((fn) => fn(peerId)),
  };
}

describe('the leaderboard frame', () => {
  it('takes day sums and nothing malformed', () => {
    const days: BoardDays = { '2026-11-09': [1200, 1, 3_600_000] };
    expect(parseBoardFrame(boardFrame(days, 5))).toEqual({ at: 5, days });
    expect(parseBoardFrame({ v: 2, at: 1, days })).toBeUndefined();
    expect(parseBoardFrame({ v: 1, at: 1, days: { 'not-a-day': [1, 1, 1] } })).toBeUndefined();
    expect(parseBoardFrame({ v: 1, at: 1, days: { '2026-11-09': [-1, 0, 0] } })).toBeUndefined();
    expect(parseBoardFrame({ v: 1, at: 1, days: { '2026-11-09': [1, 0] } })).toBeUndefined();
    const tooMany = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [statDay(new Date(2025, 0, 1 + i).getTime()), [1, 0, 0]]));
    expect(parseBoardFrame({ v: 1, at: 1, days: tooMany })).toBeUndefined();
  });
});

describe('the swap', () => {
  it('sends your days to linked friends once, again when they change or a link comes back', () => {
    let mine: BoardDays = { '2026-11-09': [10, 0, 0] };
    const links = fakeLinks([peer('a')]);
    const board = new Leaderboard({ links, mine: () => mine, file: null, everyMs: 60_000, now: () => 7 });
    board.start();
    expect(links.sent).toEqual([{ to: peer('a'), payload: boardFrame(mine, 7) }]);
    board.sendAll();
    expect(links.sent).toHaveLength(1);
    mine = { '2026-11-09': [20, 1, 0] };
    board.sendAll();
    expect(links.sent).toHaveLength(2);
    links.up(peer('a'));
    expect(links.sent).toHaveLength(3);
    board.stop();
  });

  it('keeps what friends sent, newest only, on disk, and forgets ex-friends', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'board-')), 'leaderboard.json');
    const links = fakeLinks([]);
    const board = new Leaderboard({ links, mine: () => undefined, file });
    board.start();
    links.frame(peer('b'), boardFrame({ '2026-11-09': [5, 0, 0] }, 10));
    links.frame(peer('b'), boardFrame({ '2026-11-09': [1, 0, 0] }, 9));
    links.frame(peer('c'), { v: 1, at: 1, days: 'nope' });
    expect(board.of(peer('b'))?.days['2026-11-09']).toEqual([5, 0, 0]);
    expect(board.of(peer('c'))).toBeUndefined();
    board.stop();
    const again = new Leaderboard({ links: fakeLinks([]), mine: () => undefined, file });
    expect(again.of(peer('b'))?.at).toBe(10);
    again.keepOnly(new Set());
    expect(new Leaderboard({ links: fakeLinks([]), mine: () => undefined, file }).of(peer('b'))).toBeUndefined();
  });
});

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(() => net?.close());

describe('the leaderboard between two Macs', () => {
  it('friends get each other’s numbers over their link', async () => {
    const kay = await net.add('kay');
    const bob = await net.add('bob');
    await befriend(kay, bob);
    const kayDays: BoardDays = { '2026-11-08': [4000, 2, 7_200_000] };
    const bobDays: BoardDays = { '2026-11-08': [9000, 3, 3_600_000] };
    const kb = new Leaderboard({ links: meshBoardLinks(kay.mesh), mine: () => kayDays, file: null });
    const bb = new Leaderboard({ links: meshBoardLinks(bob.mesh), mine: () => bobDays, file: null });
    kb.start();
    bb.start();
    expect(await settle(() => kb.of(bob.identity.peerId))).toMatchObject({ days: bobDays });
    expect(await settle(() => bb.of(kay.identity.peerId))).toMatchObject({ days: kayDays });
    expect(kay.friend(bob.identity.peerId)?.beluga?.can ?? ['stats.board']).toContain('stats.board');
    kb.stop();
    bb.stop();
  }, 60_000);
});
