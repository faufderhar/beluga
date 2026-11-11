/**
 * ~/.beluga/stats.json: your stats (shared/stats.ts), plus what the counter needs to count only
 * what's new: each workspace's tokens when last seen, and what was already backfilled.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { STAT_KEYS, type StatsSnapshot, dayStart, isRealTime } from '../../shared/stats.js';
import { belugaHome } from '../home.js';

const Counts = z.object(Object.fromEntries(STAT_KEYS.map((k) => [k, z.number().min(0).optional()])) as Record<(typeof STAT_KEYS)[number], z.ZodOptional<z.ZodNumber>>);
const Day = z.record(z.string(), z.record(z.string(), Counts));
const Pr = z.object({ project: z.string(), agent: z.string(), number: z.number().int(), title: z.string().optional(), opened: z.number(), merged: z.number().optional(), added: z.number().min(0), removed: z.number().min(0) });
const PlanWindowSchema = z.object({ runtime: z.string(), kind: z.enum(['session', 'week']), resetsAt: z.number(), peak: z.number().min(0).max(100), open: z.literal(true).optional() });
/** A workspace as last counted: its tokens and cost then, and whether it was archived. */
const Seen = z.object({ t: z.number().min(0), c: z.number().min(0), a: z.literal(1).optional() });

export const StatsFileSchema = z.object({
  v: z.literal(1),
  /** When counting began on this Mac: history from before is backfilled, after is counted live. */
  startedAt: z.number(),
  days: z.record(z.string(), Day).default({}),
  prs: z.record(z.string(), Pr).default({}),
  hours: z
    .array(z.number().min(0))
    .length(168)
    .default(() => Array.from({ length: 168 }, () => 0)),
  seen: z.record(z.string(), Seen).default({}),
  /** Chat histories already read for prompts and agent time (once). */
  history: z.boolean().default(false),
  /** When each project's pull requests were last asked of GitHub. */
  prsAt: z.record(z.string(), z.number()).default({}),
  /** Plan windows as they went (oldest first, the open ones too). */
  plan: z.array(PlanWindowSchema).default([]),
});
export type StatsFile = z.infer<typeof StatsFileSchema>;
export type Seen = z.infer<typeof Seen>;

export const statsPath = (): string => path.join(belugaHome(), 'stats.json');

export const emptyStats = (now: number): StatsFile => ({ v: 1, startedAt: now, days: {}, prs: {}, hours: Array.from({ length: 168 }, () => 0), seen: {}, history: false, prsAt: {}, plan: [] });

/**
 * The file, or a new one starting now when there's none. One that fails its checks (a bad value
 * somewhere) is never thrown away: a copy is kept beside it, and every part that still reads is kept.
 */
export function loadStats(file: string, now: number): StatsFile {
  if (!existsSync(file)) return emptyStats(now);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    keepCopy(file, now);
    return emptyStats(now);
  }
  const parsed = StatsFileSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  keepCopy(file, now);
  return salvage(raw, now);
}

/** stats.json as it was, beside it ("stats.json.unreadable-<time>"), before it's written over. */
function keepCopy(file: string, now: number): void {
  try {
    copyFileSync(file, `${file}.unreadable-${now}`);
  } catch {
    // Can't copy (a locked folder): what still reads is kept all the same.
  }
}

/** Each entry of a record that passes `schema`; the rest left out. */
function goodEntries<T>(value: unknown, schema: z.ZodType<T>): Record<string, T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(value)) {
    const r = schema.safeParse(v);
    if (r.success) out[k] = r.data;
  }
  return out;
}

const AnyRecord = z.record(z.string(), z.unknown());

/** What still reads in a file that fails its checks: each day's project × agent counts, each PR, each plan window. */
export function salvage(raw: unknown, now: number): StatsFile {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const empty = emptyStats(typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) ? o.startedAt : now);
  const days: Record<string, Record<string, Record<string, z.infer<typeof Counts>>>> = {};
  for (const [key, day] of Object.entries(goodEntries(o.days, AnyRecord))) {
    const projects: Record<string, Record<string, z.infer<typeof Counts>>> = {};
    for (const [root, agents] of Object.entries(goodEntries(day, AnyRecord))) {
      const kept = goodEntries(agents, Counts);
      if (Object.keys(kept).length) projects[root] = kept;
    }
    if (Object.keys(projects).length) days[key] = projects;
  }
  const hours = StatsFileSchema.shape.hours.safeParse(o.hours);
  const plan = Array.isArray(o.plan) ? o.plan.flatMap((w) => PlanWindowSchema.safeParse(w).data ?? []) : [];
  return {
    ...empty,
    days,
    prs: goodEntries(o.prs, Pr),
    ...(hours.success ? { hours: hours.data } : {}),
    seen: goodEntries(o.seen, Seen),
    // Histories already read stay read: reading them again would count those prompts twice.
    history: o.history === true,
    prsAt: goodEntries(o.prsAt, z.number()),
    plan,
  };
}

export function saveStats(data: StatsFile, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * When your stats start: your first real day (or pull request). Days from a record with no real
 * date (1970) don't count; when there's nothing else, it's when counting began; nothing at all: 0.
 */
function sinceOf(data: StatsFile): number {
  const firsts = [...Object.keys(data.days).map(dayStart), ...Object.values(data.prs).map((p) => p.opened)];
  const real = firsts.filter(isRealTime);
  if (real.length) return Math.min(...real);
  return firsts.length ? data.startedAt : 0;
}

/** What the Usage tab gets: the stats, without the counter's bookkeeping. */
export function snapshotOf(data: StatsFile, backfilling: boolean): StatsSnapshot {
  return { days: data.days, prs: data.prs, hours: data.hours, plan: data.plan, since: sinceOf(data), ...(backfilling ? { backfilling } : {}) };
}
