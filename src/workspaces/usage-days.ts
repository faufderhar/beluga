import type { UsageDay, WorkspaceUsage } from './types.js';

/** How many days of per-day usage a workspace keeps (enough for "this week" and a month's chart). */
export const USAGE_DAYS_KEPT = 35;

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local day a moment falls on, as "2026-10-18" (sorts by date as a string). */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A copy of `days` with `add` counted on `key`, keeping only the most recent `keep` days. */
export function addDay(days: Readonly<Record<string, UsageDay>> | undefined, key: string, add: UsageDay, keep = USAGE_DAYS_KEPT): Record<string, UsageDay> {
  const prev = days?.[key] ?? { tokens: 0, cost: 0 };
  const next = { ...days, [key]: { tokens: prev.tokens + add.tokens, cost: prev.cost + add.cost } };
  const kept = Object.keys(next).sort().slice(-keep);
  return Object.fromEntries(kept.map((k) => [k, next[k]!]));
}

/** Every token a run counted: input, output, cache reads and cache writes. */
export function tokensOf(u: Pick<WorkspaceUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> | undefined): number {
  return u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0;
}

export interface DayTotal {
  readonly key: string;
  /** Local midnight of that day (epoch ms). */
  readonly date: number;
  readonly tokens: number;
  readonly cost: number;
}

/** Tokens and cost per day over every workspace, for the last `count` days up to `now`'s, oldest first. */
export function dailyTotals(usages: ReadonlyArray<Pick<WorkspaceUsage, 'days'> | undefined>, now: number, count: number): DayTotal[] {
  const today = new Date(now);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1 - i)).getTime();
    const key = dayKey(date);
    let tokens = 0;
    let cost = 0;
    for (const u of usages) {
      const day = u?.days?.[key];
      if (!day) continue;
      tokens += day.tokens;
      cost += day.cost;
    }
    return { key, date, tokens, cost };
  });
}
