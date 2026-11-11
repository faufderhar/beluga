import { describe, expect, it } from 'vitest';
import { type BoardPerson, type LeaderboardView, boardDaysOf, boardTotals } from '../src/shared/leaderboard.js';
import { EMPTY_STATS, type StatsSnapshot, statDay } from '../src/shared/stats.js';
import { boardRows, hasFriends, headlineOf, markKinds, racesOf, shortList, times } from '../packages/mac/src/views/usage/leaderboard-model.js';

const NOW = new Date(2026, 10, 10, 15).getTime();
const day = (ago: number): string => statDay(new Date(2026, 10, 10 - ago, 12).getTime());
const at = (ago: number): number => new Date(2026, 10, 10 - ago, 12).getTime();

describe('your days for the board', () => {
  it('sums characters and agent time over projects and agents, and counts merged PRs by the day they merged', () => {
    const stats: StatsSnapshot = {
      ...EMPTY_STATS,
      days: {
        [day(0)]: { '/a': { claude: { chars: 100, agentMs: 60_000, prompts: 2 }, codex: { chars: 50 } }, '/b': { claude: { agentMs: 30_000 } } },
        [day(1)]: { '/a': { '': { pasted: 900 } } },
        [day(500)]: { '/a': { claude: { chars: 7 } } },
      },
      prs: {
        'a#1': { project: '/a', agent: 'claude', number: 1, opened: at(3), merged: at(0), added: 1, removed: 0 },
        'a#2': { project: '/a', agent: 'claude', number: 2, opened: at(3), added: 1, removed: 0 },
      },
    };
    const days = boardDaysOf(stats, NOW);
    expect(days).toEqual({ [day(0)]: [150, 1, 90_000] });
    expect(boardTotals(days, 'week', NOW)).toEqual({ chars: 150, prs: 1, agentMs: 90_000 });
    expect(boardTotals({ [day(10)]: [5, 0, 0] }, 'week', NOW).chars).toBe(0);
    expect(boardTotals({ [day(10)]: [5, 0, 0] }, 'month', NOW).chars).toBe(5);
  });
});

const person = (name: string, d: [number, number, number] | undefined, me = false): BoardPerson => ({
  peerId: name.padEnd(32, 'x'),
  name,
  ...(me ? { me: true as const } : {}),
  ...(d ? { days: { [day(1)]: d } } : {}),
});

describe('the board', () => {
  const view: LeaderboardView = {
    network: true,
    people: [person('kay', [1000, 2, 3_600_000], true), person('bob', [2400, 4, 1_800_000]), person('mia', [500, 0, 7_200_000]), person('ata', undefined)],
  };

  it('has nothing to show without friends', () => {
    expect(hasFriends({ network: true, people: [person('kay', [1, 0, 0], true)] })).toBe(false);
    expect(hasFriends(view)).toBe(true);
  });

  it('gives up to 100 points a number against the leader, and places people by them', () => {
    const rows = boardRows(view, 'week', NOW);
    const by = Object.fromEntries(rows.map((r) => [r.person.name, r]));
    // bob: 100 + 100 + 25; kay: 41.7 + 50 + 50; mia: 20.8 + 0 + 100.
    expect(Math.round(by.bob!.points)).toBe(225);
    expect(Math.round(by.kay!.points)).toBe(142);
    expect(Math.round(by.mia!.points)).toBe(121);
    expect(rows.map((r) => r.person.name)).toEqual(['bob', 'kay', 'mia', 'ata']);
    expect(rows.map((r) => r.place)).toEqual([1, 2, 3, 4]);
    expect(by.ata!.waiting).toBe(true);
  });

  it('shares a place between people level on points', () => {
    const rows = boardRows({ network: true, people: [person('kay', [10, 1, 10], true), person('bob', [10, 1, 10])] }, 'week', NOW);
    expect(rows.map((r) => r.place)).toEqual([1, 1]);
  });

  it('races each number, most first, and says how much more than you', () => {
    const races = racesOf(view, 'week', NOW);
    const chars = races.find((r) => r.metric === 'chars')!;
    expect(chars.lanes.map((l) => l.person.name)).toEqual(['bob', 'kay', 'mia']);
    expect(chars.lanes[0]!.of).toBe(1);
    expect(chars.lanes[0]!.vsYou).toBeCloseTo(2.4);
    expect(chars.lanes[1]!.vsYou).toBeUndefined();
    expect(chars.headline).toBe('bob wrote 2.4× as much as you');
    const time = races.find((r) => r.metric === 'agentMs')!;
    expect(time.headline).toBe('mia kept agents working 2× as long as you');
    const prs = races.find((r) => r.metric === 'prs')!;
    expect(prs.headline).toBe('bob merged 2× as many as you');
  });

  it('says it plainly when you lead, nobody did anything, or only one did', () => {
    const lane = (name: string, value: number, me = false) => ({ person: person(name, [0, 0, 0], me), value, of: 0 });
    expect(headlineOf('chars', [lane('kay', 30, true), lane('bob', 10)])).toBe('You lead: 3× bob');
    expect(headlineOf('chars', [lane('kay', 0, true), lane('bob', 0)])).toBe('Nobody yet in this stretch');
    expect(headlineOf('prs', [lane('bob', 3), lane('kay', 0, true)])).toBe('Only bob so far');
    expect(headlineOf('prs', [lane('bob', 3), lane('kay', 3, true)])).toBe('bob and you are level');
    expect(headlineOf('prs', [lane('bob', 6), lane('mia', 3), lane('kay', 0, true)])).toBe('bob leads: 2× mia');
  });

  it('writes ratios short', () => {
    expect(times(2.43)).toBe('2.4×');
    expect(times(2)).toBe('2×');
    expect(times(12.6)).toBe('13×');
  });

  it('with many friends, shows the first few and you after a jump', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ person: person(`p${i}`, [1, 0, 0], i === 14) }));
    const short = shortList(items, 8);
    expect(short.shown.map((x) => x.person.name)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p14']);
    expect(short).toMatchObject({ hidden: 12, gap: true });
    const near = shortList(items.map((x, i) => ({ person: person(`p${i}`, [1, 0, 0], i === 3) })), 8);
    expect(near.shown.map((x) => x.person.name)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(near.gap).toBe(false);
    expect(shortList(items.slice(0, 5), 8)).toMatchObject({ hidden: 0, gap: false });
  });

  it('puts faces on the shared line only where there is room, five at most, the leader and you always', () => {
    const lane = (name: string, of: number, me = false) => ({ person: person(name, [0, 0, 0], me), value: of, of });
    const lanes = [lane('a', 1), lane('b', 0.98), lane('c', 0.8), lane('d', 0.6), lane('me', 0.59, true), lane('e', 0.4), lane('f', 0.2), lane('g', 0.05)];
    const kinds = markKinds(lanes);
    const faces = lanes.filter((l) => kinds.get(l.person.peerId) === 'face').map((l) => l.person.name);
    expect(faces).toEqual(['a', 'c', 'me', 'e', 'f']);
    expect(kinds.get(lanes[1]!.person.peerId)).toBe('dot');
    expect(kinds.get(lanes[3]!.person.peerId)).toBe('dot');
  });
});
