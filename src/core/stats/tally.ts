/**
 * Counting, without timers or files (core/stats/counter.ts runs these): workspaces made, archived
 * and their tokens; prompts and agent time from a chat history; pull requests from GitHub.
 * Every function returns a new StatsFile.
 */
import { type PlanKind, type PlanWindow, type StatCounts, addToDay, dayStart, isRealTime, statDay } from '../../shared/stats.js';
import { worktreeOrigin } from '../../workspaces/origin.js';
import type { Project, Workspace } from '../../workspaces/types.js';
import { tokensOf } from '../../workspaces/usage-days.js';
import type { LogItem } from '../store.js';
import type { StatsFile } from './file.js';

/** Count `add` on the day `at` falls on, for `project` × `agent`. */
export function count(file: StatsFile, at: number, project: string, agent: string, add: Partial<StatCounts>): StatsFile {
  const key = statDay(at);
  return { ...file, days: { ...file.days, [key]: addToDay(file.days[key], project, agent, add) } };
}

/** `add`'s days and hours on top of `file`'s. */
export function addStats(file: StatsFile, add: Pick<StatsFile, 'days' | 'hours'>): StatsFile {
  let days = file.days;
  for (const [key, day] of Object.entries(add.days)) {
    for (const [root, agents] of Object.entries(day)) for (const [agent, counts] of Object.entries(agents)) days = { ...days, [key]: addToDay(days[key], root, agent, counts) };
  }
  return { ...file, days, hours: file.hours.map((h, i) => h + (add.hours[i] ?? 0)) };
}

/** A prompt at `at`: also counted in the week's hours. */
export function countPrompt(file: StatsFile, at: number, project: string, agent: string, chars: number): StatsFile {
  const d = new Date(at);
  const hours = file.hours.slice();
  const i = d.getDay() * 24 + d.getHours();
  hours[i] = (hours[i] ?? 0) + 1;
  return { ...count(file, at, project, agent, { prompts: 1, chars }), hours };
}

/** When a workspace was made, as best known: a record with no real date (0) takes the last time it was used, else now. */
const madeAt = (w: Workspace, now: number): number => (isRealTime(w.createdAt) ? w.createdAt : isRealTime(w.usage?.lastAt) ? w.usage.lastAt : now);

/** Workspaces Beluga counts: yours and chats (not another tool's worktrees, nor one still being made). */
const counted = (w: Workspace): boolean => !w.pending && (w.kind !== 'worktree' || worktreeOrigin(w) === 'beluga');

/**
 * What changed in the workspaces since they were last seen: new ones (made: on the day they were
 * made, with the tokens they already had on their days), tokens and cost spent since (today), and
 * ones archived since. The first time this is the backfill from every record Beluga keeps.
 */
export function observeWorkspaces(file: StatsFile, projects: readonly Project[], agentOf: (ws: Workspace, project: Project) => string, now: number): StatsFile {
  let out = file;
  let seen = file.seen;
  for (const p of projects) {
    for (const w of p.workspaces) {
      if (!counted(w)) continue;
      const root = p.root;
      const agent = agentOf(w, p);
      const tokens = tokensOf(w.usage);
      const cost = w.usage?.cost ?? 0;
      const was = seen[w.id];
      const archived = Boolean(w.archived);
      if (!was) {
        out = madeWith(out, w, root, agent, madeAt(w, now));
        if (archived && w.kind === 'worktree') out = count(out, w.archive?.at ?? w.usage?.lastAt ?? madeAt(w, now), root, agent, { archived: 1 });
      } else {
        const dt = Math.max(0, tokens - was.t);
        const dc = Math.max(0, cost - was.c);
        if (dt || dc) out = count(out, now, root, agent, { tokens: dt, cost: dc });
        if (archived && !was.a && w.kind === 'worktree') out = count(out, w.archive?.at ?? now, root, agent, { archived: 1 });
      }
      if (!was || was.t !== tokens || was.c !== cost || Boolean(was.a) !== archived) seen = { ...seen, [w.id]: { t: tokens, c: cost, ...(archived ? { a: 1 as const } : {}) } };
    }
  }
  return seen === file.seen ? out : { ...out, seen };
}

/** A workspace counted for the first time: made on its day, and its tokens on the days they were spent (the rest on the day it was made). */
function madeWith(file: StatsFile, w: Workspace, root: string, agent: string, made: number): StatsFile {
  let out = file;
  if (w.kind === 'worktree') out = count(out, made, root, agent, { worktrees: 1 });
  if (w.kind === 'chat') out = count(out, made, root, agent, { chats: 1 });
  const u = w.usage;
  if (!u) return out;
  let tokens = tokensOf(u);
  let cost = u.cost;
  for (const [key, day] of Object.entries(u.days ?? {})) {
    out = count(out, dayStart(key) + 12 * 3_600_000, root, agent, { tokens: day.tokens, cost: day.cost });
    tokens -= day.tokens;
    cost -= day.cost;
  }
  // From before days were kept: on the day it was made (better than nowhere).
  if (tokens > 0 || cost > 0.000_001) out = count(out, made, root, agent, { tokens: Math.max(0, tokens), cost: Math.max(0, cost) });
  return out;
}

/**
 * Prompts you sent and your agent's runs in one conversation's saved history, from before `before`
 * (counting live began then). `agentOf` names the agent when an item doesn't.
 */
export function fromHistory(file: StatsFile, items: readonly LogItem[], self: string, root: string, agent: string, before: number): StatsFile {
  let out = file;
  for (const it of items) {
    if (it.ts >= before) continue;
    if (it.type === 'chat' && isYourPrompt(it, self)) out = countPrompt(out, it.ts, root, agent, it.text.length);
    if (it.type === 'agent' && it.owner === self && (it.requester ?? self) === self && it.endTs) {
      const ms = it.endTs - (it.queuedUntil ?? it.ts);
      // A run longer than a day is a clock or a lost "done": not counted as time.
      if (ms > 0 && ms < 86_400_000) out = count(out, it.endTs, root, it.agent?.runtime ?? agent, { agentMs: ms, runs: 1 });
    }
  }
  return out;
}

/**
 * A chat line you typed to your agent, by the rules the live count uses (StatsCounter.prompt): not
 * your agent's words, not one another agent sent through you, not blank, not a /command.
 */
function isYourPrompt(it: Extract<LogItem, { type: 'chat' }>, self: string): boolean {
  return it.from === self && !it.byAgent && !it.via && Boolean(it.text.trim()) && !it.text.startsWith('/');
}

/** A pull request as `gh pr list --json number,title,headRefName,createdAt,mergedAt,additions,deletions` gives it. */
export interface GhPr {
  readonly number: number;
  readonly title?: string;
  readonly headRefName: string;
  readonly createdAt: string;
  readonly mergedAt?: string | null;
  readonly additions?: number;
  readonly deletions?: number;
}

/** The fields to ask gh for. */
export const GH_PR_FIELDS = 'number,title,headRefName,createdAt,mergedAt,additions,deletions';

export function parseGhPrs(out: string): GhPr[] {
  try {
    const list = JSON.parse(out) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((p): p is GhPr => typeof p === 'object' && p !== null && typeof p.number === 'number' && typeof p.headRefName === 'string' && typeof p.createdAt === 'string');
  } catch {
    return [];
  }
}

/** Branches Beluga's worktrees in `project` used (archived ones too) → the agent each one had. */
export function belugaBranches(project: Project, agentOf: (ws: Workspace, project: Project) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of project.workspaces) if (w.kind === 'worktree' && w.branch && worktreeOrigin(w) === 'beluga') out.set(w.branch, agentOf(w, project));
  return out;
}

/**
 * A project's pull requests from GitHub, kept when they came from Beluga: a worktree's branch, or
 * Beluga's own branch names (a worktree since deleted). Replaces what was known of each one.
 */
export function withPrs(file: StatsFile, project: Project, prs: readonly GhPr[], branches: ReadonlyMap<string, string>, fallbackAgent: string, now: number): StatsFile {
  const next = { ...file.prs };
  for (const pr of prs) {
    const agent = branches.get(pr.headRefName) ?? (pr.headRefName.startsWith('beluga/') ? fallbackAgent : undefined);
    if (agent === undefined) continue;
    const opened = Date.parse(pr.createdAt);
    if (!Number.isFinite(opened)) continue;
    const merged = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
    next[`${project.root}#${pr.number}`] = {
      project: project.root,
      agent,
      number: pr.number,
      ...(pr.title ? { title: pr.title.slice(0, 200) } : {}),
      opened,
      ...(Number.isFinite(merged) ? { merged } : {}),
      added: Math.max(0, pr.additions ?? 0),
      removed: Math.max(0, pr.deletions ?? 0),
    };
  }
  return { ...file, prs: next, prsAt: { ...file.prsAt, [project.root]: now } };
}

/** Plan windows kept (about three months of busy 5-hour sessions, and their weeks). */
export const PLAN_KEPT = 600;
/** A provider reports the same reset a little differently now and then. */
const SAME_RESET_MS = 10 * 60_000;

/** One window as a provider reports it now. */
export interface PlanReading {
  readonly runtime: string;
  readonly kind: PlanKind;
  readonly pct: number;
  readonly resetsAt?: number;
}

/**
 * What the plan usage says now: the open window of each kind goes up to its highest, one that reset
 * is closed (and a new one opened), and one past its reset closes. A window never used isn't kept.
 */
export function observePlan(file: StatsFile, readings: readonly PlanReading[], now: number): StatsFile {
  let plan: PlanWindow[] = file.plan;
  const close = (w: PlanWindow): PlanWindow => ({ runtime: w.runtime, kind: w.kind, resetsAt: w.resetsAt, peak: w.peak });
  // Past their reset: over, whatever was read.
  if (plan.some((w) => w.open && w.resetsAt < now - 60_000)) plan = plan.map((w) => (w.open && w.resetsAt < now - 60_000 ? close(w) : w));
  for (const r of readings) {
    if (r.resetsAt === undefined || r.resetsAt < now) continue;
    const i = plan.findIndex((w) => w.open && w.runtime === r.runtime && w.kind === r.kind);
    const open = i >= 0 ? plan[i]! : undefined;
    const pct = Math.max(0, Math.min(100, r.pct));
    if (open && Math.abs(open.resetsAt - r.resetsAt) <= SAME_RESET_MS) {
      if (pct > open.peak) plan = plan.map((w, j) => (j === i ? { ...w, peak: pct } : w));
      continue;
    }
    if (open) plan = plan.map((w, j) => (j === i ? close(w) : w));
    plan = [...plan, { runtime: r.runtime, kind: r.kind, resetsAt: r.resetsAt, peak: pct, open: true }];
  }
  if (plan === file.plan) return file;
  const kept = plan.filter((w) => w.open || w.peak > 0).slice(-PLAN_KEPT);
  return { ...file, plan: kept };
}
