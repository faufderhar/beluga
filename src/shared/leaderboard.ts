/**
 * The leaderboard in the Usage tab (BLG-904): you and your friends, side by side, on three numbers
 * a day: the characters you wrote to your agents, the pull requests merged, and the time your
 * agents worked (tests and waits included: it's the run's whole time). Friends' Macs swap these
 * day sums over their link (core/leaderboard), and nothing else: no projects, no prompts, no
 * agents. Browser-safe: no imports at runtime.
 */
import { type StatsSnapshot, statDay } from './stats.js';

/** One day's numbers: characters in prompts, pull requests merged, agent time (ms). */
export type BoardDay = readonly [chars: number, prs: number, agentMs: number];
/** "2026-10-18" → that day (only days with something in them). */
export type BoardDays = Readonly<Record<string, BoardDay>>;

/** How far back a Mac sends its days: a year and a bit, so "this year" is whole. */
export const BOARD_DAYS = 400;

export type BoardMetric = 'chars' | 'prs' | 'agentMs';
export const BOARD_METRICS: readonly BoardMetric[] = ['chars', 'prs', 'agentMs'];
const SLOT: Record<BoardMetric, 0 | 1 | 2> = { chars: 0, prs: 1, agentMs: 2 };

export type BoardTotals = Readonly<Record<BoardMetric, number>>;
export const ZERO_BOARD: BoardTotals = { chars: 0, prs: 0, agentMs: 0 };

/** Which days the board sums. */
export type BoardRange = 'week' | 'month' | 'year';
const RANGE: Record<BoardRange, number> = { week: 7, month: 30, year: 365 };

/** One person on the board. */
export interface BoardPerson {
  readonly peerId: string;
  readonly name: string;
  /** You. */
  readonly me?: true;
  /** Their days; left out while nothing has come from them yet. */
  readonly days?: BoardDays;
  /** When their numbers came (epoch ms). */
  readonly at?: number;
  readonly online?: boolean;
  /** Their Beluga said what it does, and swapping numbers isn't in it: it needs an update. */
  readonly old?: true;
}

/** What the Usage tab asks for (`stats.leaderboard`). */
export interface LeaderboardView {
  /** The Beluga network runs here (friends need it). */
  readonly network: boolean;
  /** You first, then each friend. */
  readonly people: readonly BoardPerson[];
}

export const EMPTY_BOARD: LeaderboardView = { network: false, people: [] };

/** Your stats as board days: the last BOARD_DAYS days up to `now`, summed over projects and agents. */
export function boardDaysOf(stats: StatsSnapshot, now: number): BoardDays {
  const t = new Date(now);
  const from = statDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() - (BOARD_DAYS - 1)).getTime());
  const sums = new Map<string, [number, number, number]>();
  const at = (key: string): [number, number, number] => {
    let d = sums.get(key);
    if (!d) sums.set(key, (d = [0, 0, 0]));
    return d;
  };
  for (const [key, day] of Object.entries(stats.days)) {
    if (key < from) continue;
    for (const agents of Object.values(day)) {
      for (const c of Object.values(agents)) {
        if (!c.chars && !c.agentMs) continue;
        const d = at(key);
        d[0] += c.chars ?? 0;
        d[2] += c.agentMs ?? 0;
      }
    }
  }
  for (const pr of Object.values(stats.prs)) {
    if (pr.merged === undefined) continue;
    const key = statDay(pr.merged);
    if (key >= from) at(key)[1] += 1;
  }
  const out: Record<string, BoardDay> = {};
  for (const [key, [chars, prs, ms]] of [...sums].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (chars || prs || ms) out[key] = [Math.round(chars), prs, Math.round(ms)];
  }
  return out;
}

/** The first day key of `range` up to `now` (inclusive). */
export function boardStart(range: BoardRange, now: number): string {
  const t = new Date(now);
  return statDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() - (RANGE[range] - 1)).getTime());
}

/** Someone's three numbers over `range`. */
export function boardTotals(days: BoardDays | undefined, range: BoardRange, now: number): BoardTotals {
  if (!days) return ZERO_BOARD;
  const from = boardStart(range, now);
  const to = statDay(now);
  const sum = [0, 0, 0];
  for (const [key, d] of Object.entries(days)) {
    if (key < from || key > to) continue;
    for (const m of BOARD_METRICS) sum[SLOT[m]]! += d[SLOT[m]];
  }
  return { chars: sum[0]!, prs: sum[1]!, agentMs: sum[2]! };
}
