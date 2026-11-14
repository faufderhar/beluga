import { createHash } from 'node:crypto';
import { type Activity, type Actor, BRIEF_SECTIONS, type Issue } from '../board/model.js';

/**
 * How every teammate's copy of a task agrees (BLG-222), as pure functions. Each field is
 * last-writer-wins: it carries who set it (`a`, a peer id) and when, in Lamport time (`l`); the
 * higher `l` wins, then the higher `a`, then (never in practice) the larger value, so every Mac
 * picks the same one whatever order changes arrive in. Activity and comments are only ever added
 * (by id), in time order. A deleted task is a field too (`deleted`), so a delete wins or loses
 * like any other change.
 *
 * What travels is the task's words and state only: worktrees, branches, pull requests, proof
 * files and run details stay on the Mac they belong to. "Ata is working on this" is a field of
 * Ata's own (`working.<peerId>`), true while one of Ata's worktrees does it; `running.<peerId>`
 * is true while Ata's Claude is at work there right now (BLG-278: the card shows it moving).
 */

export interface Field {
  readonly v: unknown;
  readonly l: number;
  readonly a: string;
}

export interface Born {
  readonly at: number;
  readonly by: Actor;
  readonly origin: Issue['origin'];
}

/**
 * A task as the team has it. `own`: activity ids written on this Mac (never sent). `gone`: lines
 * their author took back: a line once taken back never comes back, whichever Mac passes it on
 * again later (without it, an add and its drop chase each other round a team of three forever).
 */
export interface SharedTask {
  readonly id: string;
  readonly fields: Readonly<Record<string, Field>>;
  readonly acts: readonly Activity[];
  readonly born?: Born;
  readonly own?: readonly string[];
  readonly gone?: readonly string[];
}

/** Lines kept per task (the board keeps as many). */
export const KEEP_ACTS = 200;
/** Taken-back line ids remembered per task (the newest). */
export const KEEP_GONE = 200;
/** Activity that never travels: it names worktrees, plans, proof files or other trackers that are this Mac's own. */
export const LOCAL_ACTS: ReadonlySet<Activity['kind']> = new Set(['worktree', 'plan', 'proof', 'project', 'private']);

/** JSON with keys in order: the same value always reads the same. */
export function canon(v: unknown): string {
  if (v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** Whether `x` wins over `y`. */
export function newer(x: Field, y: Field | undefined): boolean {
  if (!y) return true;
  if (x.l !== y.l) return x.l > y.l;
  if (x.a !== y.a) return x.a > y.a;
  return canon(x.v) > canon(y.v);
}

const byTime = (a: Activity, b: Activity): number => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export interface Incoming {
  readonly id: string;
  readonly fields: Readonly<Record<string, Field>>;
  readonly acts: readonly Activity[];
  readonly drop?: readonly string[];
  readonly born?: Born;
}

export interface Merged {
  readonly task: SharedTask;
  /** Fields that changed here (they won). */
  readonly won: Readonly<Record<string, Field>>;
  /** Activity that's new here. */
  readonly added: readonly Activity[];
  /** Activity taken back that was here. */
  readonly dropped: readonly string[];
}

/** Take in what a teammate's Mac says about a task. */
export function merge(local: SharedTask | undefined, inc: Incoming): Merged {
  const fields: Record<string, Field> = { ...(local?.fields ?? {}) };
  const won: Record<string, Field> = {};
  for (const [name, f] of Object.entries(inc.fields)) {
    if (!newer(f, fields[name])) continue;
    fields[name] = f;
    won[name] = f;
  }
  const before = local?.acts ?? [];
  const had = local?.gone ?? [];
  const fresh = (inc.drop ?? []).filter((id) => !had.includes(id));
  const gone = [...had, ...fresh].slice(-KEEP_GONE);
  const drop = new Set([...had, ...fresh]);
  const dropped = before.filter((a) => drop.has(a.id)).map((a) => a.id);
  const kept = before.filter((a) => !drop.has(a.id));
  const known = new Set(kept.map((a) => a.id));
  const added = inc.acts.filter((a) => !known.has(a.id) && !drop.has(a.id) && !LOCAL_ACTS.has(a.kind));
  const acts = [...kept, ...added].sort(byTime).slice(-KEEP_ACTS);
  const born = local?.born ?? inc.born;
  return { task: { id: inc.id, fields, acts, ...(born ? { born } : {}), ...(local?.own ? { own: local.own } : {}), ...(gone.length ? { gone } : {}) }, won, added, dropped };
}

/** The highest Lamport time a task's fields carry. */
export const maxClock = (fields: Readonly<Record<string, Field>>): number => Math.max(0, ...Object.values(fields).map((f) => f.l));

/** A hash of every field's clock across tasks: two Macs with the same one agree. */
export function digest(tasks: readonly SharedTask[]): string {
  const h = createHash('sha256');
  for (const t of [...tasks].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    h.update(t.id);
    for (const name of Object.keys(t.fields).sort()) {
      const f = t.fields[name]!;
      h.update(`\0${name}:${f.l}:${f.a}`);
    }
    h.update('\n');
  }
  return h.digest('hex');
}

// ---- a board task as fields, and back

/** Someone's own presence on a task (`working.<peerId>`, `running.<peerId>`): only they say it, and it never reaches the board. */
export const isPresence = (name: string): boolean => name.startsWith('working.') || name.startsWith('running.');

/** The fields a task has on this Mac (`working`: one of my worktrees does it now; `running`: its Claude is at work). */
export function fieldsOf(issue: Issue, self: string, working: boolean, running = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    labels: [...issue.labels],
    estimate: issue.estimate ?? null,
    due: issue.due ?? null,
    assignee: issue.assignee ?? null,
    parent: issue.parent ?? null,
    blockedBy: [...issue.blockedBy],
    related: [...issue.related],
    github: issue.github ?? null,
    deleted: false,
    [`working.${self}`]: working ? true : null,
    [`running.${self}`]: working && running ? true : null,
  };
  for (const s of BRIEF_SECTIONS) out[`brief.${s}`] = issue.brief[s] ?? '';
  return out;
}

/**
 * What a team value looks like on this board: links to tasks this Mac doesn't have are left out
 * (they show once those tasks arrive), so they never read as a change of mine.
 */
export function onBoard(name: string, v: unknown, has: (id: string) => boolean): unknown {
  if (name === 'parent') return typeof v === 'string' && has(v) ? v : null;
  if (name === 'blockedBy' || name === 'related') return Array.isArray(v) ? v.filter((id) => typeof id === 'string' && has(id)) : [];
  return v ?? null;
}

/** My value of a field as the team should have it: the links I can't see are kept as they were. */
export function fromBoard(name: string, mine: unknown, team: unknown, has: (id: string) => boolean): unknown {
  if ((name === 'blockedBy' || name === 'related') && Array.isArray(team) && Array.isArray(mine)) return [...new Set([...mine, ...team.filter((id) => typeof id === 'string' && !has(id))])];
  if (name === 'parent' && mine === null && typeof team === 'string' && !has(team)) return team;
  return mine;
}
