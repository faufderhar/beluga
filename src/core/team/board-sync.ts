import path from 'node:path';
import { JournalFile, type JournalShape } from '../journal-file.js';
import type { Board } from '../board/board.js';
import { type Activity, type Actor, type Assignee, BRIEF_SECTIONS, type BriefSection, type Issue, isArchived, worktreeDoing } from '../board/model.js';
import type { Action } from '../store.js';
import { type Field, LOCAL_ACTS, type SharedTask, canon, digest, fieldsOf, fromBoard, isPresence, maxClock, merge, onBoard } from './crdt.js';
import type { TeamState, TeamWaiting } from './model.js';
import { type TaskDelta, type TeamMsg, fieldValue } from './protocol.js';
import type { TeamBoards, TeamLink, TeamPart } from './service.js';

/**
 * A team's board stays in step on every Mac (BLG-222). Every change to a task of a teamed project
 * here, however it was made (you, your Claude's task tools, a plan, a pull request moving it), is
 * seen as it reaches the shared state: the fields that differ from what the team has get a new
 * Lamport time and go to every teammate, with new activity. What comes from a teammate is merged
 * (crdt.ts), what won is written to the board quietly (no activity of its own: the author's
 * lines come with it), and passed on to the other teammates who haven't seen it, so a team of
 * three agrees even where two of them aren't linked to each other.
 *
 * Tasks keep one id on every Mac; each Mac gives them a key of its own project ("BLG-12" here may
 * be "API-40" on Ata's Mac), so keys never clash. Worktrees, branches, pull requests, proof files
 * and run details stay local; teammates see "Ata is working on this".
 *
 * Offline: changes wait in the courier's outbox (7 days). When a link comes up, both send a
 * digest of every field's clock; a different one is answered with a snapshot (everything, in
 * batches), so a teammate back after longer catches up too.
 *
 * File: `team-board.json` (each project's tasks as the team has them, and its clock).
 */

export interface BoardSyncDeps {
  readonly board: Board;
  /** A workspace is still here and not archived. */
  readonly live: (workspaceId: string) => boolean;
  /** Its Claude is at work there now (BLG-278: teammates see the task moving). */
  readonly running?: (workspaceId: string) => boolean;
  /** Where team-board.json lives; null: memory only. */
  readonly dir: string | null;
  /** A task went round too fast and is held for a moment (for the log: a loop to look into). */
  readonly onBrake?: (issueId: string, sends: number) => void;
}

/** What other parts hear: a teammate's change won here (assignment, BLG-223; issues, BLG-224). */
export interface TeamChange {
  readonly link: TeamLink;
  readonly issue: Issue;
  readonly won: Readonly<Record<string, Field>>;
  readonly fresh: boolean;
}

/** A delta that only says who's on a task now (`working.*`, `running.*`): nothing of the task itself. */
/** A task as the team has it, whole, as one frame: its fields, its newest lines, and (so a Mac that missed a drop stops passing that line on) the lines taken back. */
const whole = (t: SharedTask): TaskDelta => ({ id: t.id, fields: { ...t.fields }, acts: t.acts.slice(-SNAPSHOT_ACTS) as TaskDelta['acts'], ...(t.gone?.length ? { drop: [...t.gone] } : {}), ...(t.born ? { born: t.born } : {}) });

const presenceOnly = (d: TaskDelta): boolean => !d.acts.length && !d.drop?.length && !d.born && Object.keys(d.fields).length > 0 && Object.keys(d.fields).every(isPresence);

const BATCH_TASKS = 40;
/** What a Claude says while it works (words, steps, counts): never a start or a stop. */
const QUIET_EVENTS: ReadonlySet<string> = new Set(['text', 'tool', 'progress', 'sub']);
const BATCH_BYTES = 700_000;
const SNAPSHOT_ACTS = 60;
/** A linked teammate who hasn't acknowledged for this long counts as not having it. */
const SLOW_ACK_MS = 30_000;
/**
 * The brake: one task sent on more than BRAKE_SENDS times within BRAKE_WINDOW_MS is going round
 * (a loop between Macs, BLG-942), not being edited. Its changes are still merged and written here,
 * but held, and after BRAKE_HOLD_MS it goes once, whole, to every teammate (a whole task merges
 * the same as its pieces, so nothing is lost). A loop then costs one frame per task every few
 * seconds instead of freezing the daemon. (Sixty edits from three Macs at once, far faster than
 * people or their Claudes edit, send the busiest task on 37 times in the window; the loop that
 * froze a daemon on 2026-11-13 sent it on about 180.)
 */
export const BRAKE_SENDS = 80;
/** How soon after a change the team's copy is written. */
const SAVE_MS = 1000;
export const BRAKE_WINDOW_MS = 10_000;
export const BRAKE_HOLD_MS = 5_000;

export class TeamBoardSync implements TeamPart {
  private clocks: Record<string, number> = {};
  private tasks: Record<string, Record<string, SharedTask>> = {};
  /** team-board.json: megabytes for a busy team, so written in the background (BLG-942). */
  private readonly file: JournalFile<SharedTask> | undefined;
  private readonly listeners: Array<(c: TeamChange) => void> = [];
  private readonly reconciled = new Set<string>();
  private readonly locals: Array<(issue: Issue, changed: Readonly<Record<string, Field>>) => void> = [];
  /** My worktrees whose Claude was at work when last told (only a change goes out). */
  private runs = new Set<string>();
  /** When each task was last sent on (the brake's window). */
  private readonly sends = new Map<string, number[]>();
  /** Tasks held by the brake, and their project. */
  private readonly held = new Map<string, string>();
  private brakeTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly team: TeamBoards,
    private readonly deps: BoardSyncDeps,
  ) {
    this.file = deps.dir ? new JournalFile<SharedTask>(deps.dir, 'team-board', this.shape(), SAVE_MS) : undefined;
    this.load();
  }

  private get self(): string {
    return this.team.self;
  }

  /** Hear what a teammate changed (after it's on the board). */
  onChange(fn: (c: TeamChange) => void): void {
    this.listeners.push(fn);
  }

  /** Hear what changed here and went to the team (the fields, with their new clocks). */
  onLocal(fn: (issue: Issue, changed: Readonly<Record<string, Field>>) => void): void {
    this.locals.push(fn);
  }

  /** The team's copy of a task (undefined: not a team task). */
  shared(issueId: string): SharedTask | undefined {
    for (const byId of Object.values(this.tasks)) if (byId[issueId]) return byId[issueId];
    return undefined;
  }

  // ------------------------------------------------------------------ TeamPart

  joined(link: TeamLink, fresh: boolean): void {
    if (!fresh) {
      // Starting again (the network was off): what changed here meanwhile goes out now.
      if (this.reconciled.has(link.projectId) || !this.tasks[link.projectId]) return;
      this.reconciled.add(link.projectId);
      for (const issue of this.deps.board.list()) if (issue.projectId === link.projectId && (this.tasks[link.projectId]![issue.id] || !isArchived(issue))) this.observe(issue, true);
      return;
    }
    if (!this.tasks[link.projectId]) {
      this.tasks[link.projectId] = {};
      // Teaming up shares the board as it is (archived tasks stay yours).
      for (const issue of this.deps.board.list()) if (issue.projectId === link.projectId && !isArchived(issue)) this.observe(issue, false);
    }
    this.snapshot(link);
    this.save();
  }

  left(link: TeamLink): void {
    if (this.team.linksOf(link.projectId).length) return;
    // Nobody left to share with: your tasks stay as they are, and stop being team tasks.
    delete this.tasks[link.projectId];
    delete this.clocks[link.projectId];
    this.save();
  }

  linkUp(peerId: string): void {
    for (const link of this.team.allLinks()) if (link.peerId === peerId) this.team.courier.send(peerId, { k: 'digest', link: link.id, hash: this.hashOf(link.projectId) }, { reliable: false });
  }

  receive(from: string, m: TeamMsg): boolean {
    if (m.k !== 'ops' && m.k !== 'digest') return false;
    const link = this.team.linkById(m.link);
    if (!link || link.peerId !== from) return true;
    if (m.k === 'digest') {
      if (m.hash !== this.hashOf(link.projectId)) this.snapshot(link);
      return true;
    }
    for (const d of m.tasks) this.take(link, d);
    this.save();
    return true;
  }

  onAction(action: Action): void {
    // While a teammate's change is written, the team's copy already has it: only what follows from
    // it here (a parent's sub-tasks reaching Done) reads as a change, and goes out like any other.
    if (action.type === 'board_issue') this.observe(action.issue, true);
    if (action.type === 'board_remove') this.removed(action.id);
    // A Claude starting or stopping (not every word or step it says): its tasks say so to the team.
    if (action.type === 'agent_event' && !QUIET_EVENTS.has(action.event)) this.runsChanged();
  }

  private runsChanged(): void {
    const running = this.deps.running;
    if (!running) return;
    const doing = new Map<string, Issue[]>();
    for (const issue of this.deps.board.list()) {
      if (!this.team.teamed(issue.projectId)) continue;
      const ws = worktreeDoing(issue, this.deps.live);
      if (ws) doing.set(ws, [...(doing.get(ws) ?? []), issue]);
    }
    const now = new Set([...doing.keys()].filter((ws) => running(ws)));
    const flipped = [...new Set([...now, ...this.runs])].filter((ws) => now.has(ws) !== this.runs.has(ws));
    this.runs = now;
    for (const ws of flipped) for (const issue of doing.get(ws) ?? []) this.observe(issue, true);
  }

  view(): Partial<TeamState> {
    const working: Record<string, Array<{ peerId: string; name: string; running?: true }>> = {};
    for (const byId of Object.values(this.tasks)) {
      for (const t of Object.values(byId)) {
        for (const [name, f] of Object.entries(t.fields)) {
          if (!name.startsWith('working.') || f.v !== true) continue;
          const peerId = name.slice(8);
          if (peerId === this.self) continue;
          (working[t.id] ??= []).push({ peerId, name: this.team.nameOf(peerId), ...(t.fields[`running.${peerId}`]?.v === true ? { running: true as const } : {}) });
        }
      }
    }
    return { working, waiting: this.waiting() };
  }

  /**
   * Per task, the teammates whose Mac hasn't acknowledged a change of it yet (from the outbox).
   * Someone linked now normally acknowledges at once, so only a change waiting a while counts for them.
   */
  private waiting(): Record<string, TeamWaiting[]> {
    const now = Date.now();
    const out: Record<string, TeamWaiting[]> = {};
    for (const w of this.team.courier.waitingFor((m) => m.k === 'ops')) {
      if (w.m.k !== 'ops') continue;
      if (this.team.deps.mesh.isLinked(w.to) && now - w.since < SLOW_ACK_MS) continue;
      for (const d of w.m.tasks) {
        // Who's on it isn't a change they're missing.
        if (presenceOnly(d)) continue;
        const list = (out[d.id] ??= []);
        const i = list.findIndex((x) => x.peerId === w.to);
        const had = list[i];
        if (!had) list.push({ peerId: w.to, name: this.team.nameOf(w.to), since: w.since, mailed: w.mailed });
        else list[i] = { ...had, since: Math.min(had.since, w.since), mailed: had.mailed && w.mailed };
      }
    }
    return out;
  }

  stop(): void {
    // What the brake held is in the team's copy: the digest on the next link brings it.
    clearTimeout(this.brakeTimer);
    this.brakeTimer = undefined;
    try {
      this.file?.flush();
    } catch {
      // Best effort: it's in memory, and written on the next change.
    }
  }

  // ------------------------------------------------------------------ the brake

  /** A task's change to the project's teammates (but `except`), unless the brake holds it. */
  private pass(projectId: string, d: TaskDelta, except?: string, key?: string): void {
    if (this.braked(projectId, d.id)) return;
    for (const link of this.team.linksOf(projectId)) if (link.peerId !== except) this.team.send(link.peerId, { k: 'ops', link: link.id, tasks: [d] }, key);
  }

  private braked(projectId: string, id: string): boolean {
    if (this.held.has(id)) return true;
    const now = Date.now();
    const times = [...(this.sends.get(id) ?? []).filter((t) => now - t < BRAKE_WINDOW_MS), now];
    this.sends.set(id, times);
    if (times.length <= BRAKE_SENDS) return false;
    this.held.set(id, projectId);
    this.deps.onBrake?.(id, times.length);
    if (!this.brakeTimer) {
      this.brakeTimer = setTimeout(() => this.release(), BRAKE_HOLD_MS);
      this.brakeTimer.unref?.();
    }
    return true;
  }

  /** The held tasks go once, whole, to every teammate. */
  private release(): void {
    this.brakeTimer = undefined;
    const held = [...this.held];
    this.held.clear();
    for (const [id, projectId] of held) {
      this.sends.delete(id);
      const task = this.tasks[projectId]?.[id];
      if (!task) continue;
      const d = whole(task);
      for (const link of this.team.linksOf(projectId)) this.team.send(link.peerId, { k: 'ops', link: link.id, tasks: [d] });
    }
  }

  // ------------------------------------------------------------------ my changes

  private has = (id: string): boolean => Boolean(this.deps.board.get(id));

  private tick(projectId: string): number {
    const l = (this.clocks[projectId] ?? 0) + 1;
    this.clocks[projectId] = l;
    return l;
  }

  /** A task changed here: what differs from the team's copy goes to every teammate. */
  private observe(issue: Issue, send: boolean): void {
    const byId = this.tasks[issue.projectId];
    if (!byId || !this.team.teamed(issue.projectId)) return;
    const rec = byId[issue.id];
    // Private (BLG-501): never sent; one teammates had is taken back from them, as a delete.
    if (issue.private) {
      if (rec && rec.fields.deleted?.v !== true) this.takeBack(issue.projectId, issue.id, rec);
      return;
    }
    const ws = worktreeDoing(issue, this.deps.live);
    const mine = fieldsOf(issue, this.self, ws !== undefined, ws !== undefined && (this.deps.running?.(ws) ?? false));
    const changed: Record<string, Field> = {};
    for (const [name, value] of Object.entries(mine)) {
      const cur = rec?.fields[name];
      if (cur && canon(onBoard(name, cur.v, this.has)) === canon(value)) continue;
      // Nothing of mine to say yet (no one works on it, no deletion): only once it's something.
      if (!cur && (value === null || value === false) && isPresence(name)) continue;
      const v = cur ? fromBoard(name, value, cur.v, this.has) : value;
      if (cur && canon(v) === canon(cur.v)) continue;
      changed[name] = { v, l: this.tick(issue.projectId), a: this.self };
    }
    // New lines (never this Mac's own kinds, never one taken back); a line I took back (folded into the next) goes for everyone.
    const known = new Set([...(rec?.acts ?? []).map((a) => a.id), ...(rec?.gone ?? [])]);
    const added = issue.activity.filter((a) => !known.has(a.id) && !LOCAL_ACTS.has(a.kind));
    const present = new Set(issue.activity.map((a) => a.id));
    const oldest = issue.activity[0]?.at ?? 0;
    const own = new Set(rec?.own ?? []);
    const drop = (rec?.acts ?? []).filter((a) => own.has(a.id) && !present.has(a.id) && a.at >= oldest).map((a) => a.id);
    if (!Object.keys(changed).length && !added.length && !drop.length && rec) return;
    const born = rec?.born ?? { at: issue.createdAt, by: issue.createdBy, origin: issue.origin };
    const merged = merge(rec, { id: issue.id, fields: changed, acts: added, drop, born });
    const ownNow = [...[...own].filter((id) => !drop.includes(id)), ...added.map((a) => a.id)].slice(-400);
    byId[issue.id] = { ...merged.task, own: ownNow };
    this.save();
    if (!send) return;
    const delta: TaskDelta = { id: issue.id, fields: changed, acts: [...added] as TaskDelta['acts'], ...(drop.length ? { drop } : {}), ...(rec ? {} : { born }) };
    // Only who's on it now (no change of the task's own): the newest replaces what still waits for them.
    const key = presenceOnly(delta) ? `presence:${issue.id}` : undefined;
    this.pass(issue.projectId, delta, undefined, key);
    this.team.publish();
    if (Object.keys(changed).length) for (const fn of this.locals) fn(issue, changed);
  }

  private removed(id: string): void {
    for (const [projectId, byId] of Object.entries(this.tasks)) {
      const rec = byId[id];
      if (rec && rec.fields.deleted?.v !== true) this.takeBack(projectId, id, rec);
    }
  }

  /** Gone from the team: deleted here, or made private (sharing it again later is `deleted: false`, newer). */
  private takeBack(projectId: string, id: string, rec: SharedTask): void {
    const f: Field = { v: true, l: this.tick(projectId), a: this.self };
    this.tasks[projectId]![id] = { ...rec, fields: { ...rec.fields, deleted: f } };
    this.save();
    for (const link of this.team.linksOf(projectId)) this.team.send(link.peerId, { k: 'ops', link: link.id, tasks: [{ id, fields: { deleted: f }, acts: [] }] });
    this.team.publish();
  }

  // ------------------------------------------------------------------ theirs

  /** A teammate's word on one task: merged, written to the board, passed on. */
  private take(link: TeamLink, d: TaskDelta): void {
    const projectId = link.projectId;
    const byId = (this.tasks[projectId] ??= {});
    // Only values each field may hold; someone's "working" only from themselves.
    const fields: Record<string, Field> = {};
    for (const [name, f] of Object.entries(d.fields)) {
      const check = fieldValue(name);
      if (!check?.safeParse(f.v).success) continue;
      if (isPresence(name) && name.slice(8) !== f.a) continue;
      if (name === `working.${this.self}` || name === `running.${this.self}`) continue;
      fields[name] = f;
    }
    const other = this.deps.board.get(d.id);
    if (other && other.projectId !== projectId) return;
    const rec = byId[d.id];
    const merged = merge(rec, { id: d.id, fields, acts: d.acts, ...(d.drop ? { drop: d.drop } : {}), ...(d.born ? { born: d.born } : {}) });
    this.clocks[projectId] = Math.max(this.clocks[projectId] ?? 0, maxClock(fields));
    byId[d.id] = merged.task;
    const { won, added, dropped } = merged;
    // A line taken back that this board still shows (it came back before the drop was remembered): off the board too.
    const gone = new Set(merged.task.gone ?? []);
    const stale = (other?.activity ?? []).filter((a) => gone.has(a.id) && !dropped.includes(a.id)).map((a) => a.id);
    const changed = Object.keys(won).length > 0 || added.length > 0 || dropped.length > 0;
    if (!changed && !stale.length) return;
    const issue = this.write(projectId, merged.task, won, added, [...dropped, ...stale]);
    if (!changed) return;
    // Passed on to teammates who may not have it (each skips what it already has).
    const pass: TaskDelta = { id: d.id, fields: won, acts: [...added] as TaskDelta['acts'], ...(dropped.length ? { drop: [...dropped] } : {}), ...(merged.task.born ? { born: merged.task.born } : {}) };
    this.pass(projectId, pass, link.peerId);
    this.team.publish();
    if (issue) for (const fn of this.listeners) fn({ link, issue, won, fresh: !rec });
  }

  /** What won, onto the board (quietly: no activity of its own). */
  private write(projectId: string, task: SharedTask, won: Readonly<Record<string, Field>>, added: readonly Activity[], dropped: readonly string[]): Issue | undefined {
    const board = this.deps.board;
    const value = (name: string): unknown => onBoard(name, task.fields[name]?.v, this.has);
    const existing = board.get(task.id);
    {
      // My private task stays mine, whatever teammates' copies say (BLG-501).
      if (existing?.private) return undefined;
      if (task.fields.deleted?.v === true) {
        if (existing) board.remove(existing.id);
        return undefined;
      }
      if (!existing) {
        const title = task.fields.title?.v;
        const status = task.fields.status?.v;
        if (typeof title !== 'string' || typeof status !== 'string') return undefined;
        const brief = Object.fromEntries(BRIEF_SECTIONS.flatMap((s) => (typeof task.fields[`brief.${s}`]?.v === 'string' && task.fields[`brief.${s}`]!.v ? [[s, task.fields[`brief.${s}`]!.v as string]] : [])));
        const born = task.born ?? { at: Date.now(), by: { kind: 'beluga' } as Actor, origin: 'manual' as const };
        const assignee = value('assignee') as Assignee | null;
        const parent = value('parent') as string | null;
        const estimate = value('estimate') as number | null;
        const due = value('due') as string | null;
        const github = value('github') as Issue['github'] | null;
        return board.adoptTeam({
          id: task.id,
          projectId,
          title,
          status: status as Issue['status'],
          priority: (value('priority') as Issue['priority'] | null) ?? 'none',
          labels: (value('labels') as string[] | null) ?? [],
          ...(estimate ? { estimate } : {}),
          ...(due ? { due } : {}),
          ...(assignee ? { assignee } : {}),
          ...(parent ? { parent } : {}),
          blockedBy: value('blockedBy') as string[],
          related: value('related') as string[],
          ...(github ? { github } : {}),
          brief,
          activity: task.acts,
          createdAt: born.at,
          createdBy: born.by,
          origin: born.origin,
        });
      }
      const patch: Record<string, unknown> = {};
      const brief: Partial<Record<BriefSection, string>> = {};
      let by: Actor = { kind: 'beluga' };
      for (const [name, f] of Object.entries(won)) {
        const v = value(name);
        if (name.startsWith('brief.')) {
          brief[name.slice(6) as BriefSection] = typeof v === 'string' ? v : '';
          by = { kind: 'person', id: f.a, name: this.team.nameOf(f.a) };
        } else if (name === 'estimate' || name === 'due' || name === 'assignee' || name === 'parent' || name === 'github') patch[name] = v ?? undefined;
        else if (name !== 'deleted' && !isPresence(name)) patch[name] = v;
      }
      if (Object.keys(brief).length) patch.brief = brief;
      if (!Object.keys(patch).length && !added.length && !dropped.length) return existing;
      return board.applyTeam(existing.id, patch as Parameters<Board['applyTeam']>[1], added, dropped, by);
    }
  }

  // ------------------------------------------------------------------ catching up

  private hashOf(projectId: string): string {
    return digest(Object.values(this.tasks[projectId] ?? {}));
  }

  /** Everything the team has of a project, for one teammate, in batches. */
  private snapshot(link: TeamLink): void {
    const all = Object.values(this.tasks[link.projectId] ?? {});
    let batch: TaskDelta[] = [];
    let bytes = 0;
    const flush = (): void => {
      if (batch.length) this.team.send(link.peerId, { k: 'ops', link: link.id, tasks: batch });
      batch = [];
      bytes = 0;
    };
    for (const t of all) {
      const d = whole(t);
      const size = JSON.stringify(d).length;
      if (batch.length >= BATCH_TASKS || bytes + size > BATCH_BYTES) flush();
      batch.push(d);
      bytes += size;
    }
    flush();
  }

  // ------------------------------------------------------------------ the file

  /**
   * team-board.json and its journal, team-board.log (core/journal-file.ts, BLG-942): a change
   * writes only the tasks it touched, not the team's whole copy (megabytes for a busy team, once a
   * second while it's busy). The file keeps its shape: each project's tasks, and the clocks.
   */
  private shape(): JournalShape<SharedTask> {
    return {
      records: () => Object.entries(this.tasks).flatMap(([p, byId]) => Object.values(byId).map((t) => [`${p}/${t.id}`, t] as const)),
      // The clocks, and every project teamed (one with no tasks yet too).
      meta: () => ({ clocks: this.clocks, projects: Object.keys(this.tasks) }),
      pack: (t, key) => ({ p: key.slice(0, key.indexOf('/')), t }),
      keyOf: (w) => {
        const r = w as { p?: unknown; t?: { id?: unknown } } | undefined;
        return r && typeof r.p === 'string' && typeof r.t?.id === 'string' ? `${r.p}/${r.t.id}` : undefined;
      },
      toSnapshot: (meta, records, seq) => {
        const m = meta as { clocks: Record<string, number>; projects: readonly string[] };
        const tasks: Record<string, SharedTask[]> = Object.fromEntries(m.projects.map((p) => [p, []]));
        for (const r of records as Array<{ p: string; t: SharedTask }>) (tasks[r.p] ??= []).push(r.t);
        return { seq, clocks: m.clocks, tasks };
      },
      fromSnapshot: (raw) => {
        const tasks = raw.tasks && typeof raw.tasks === 'object' ? (raw.tasks as Record<string, unknown>) : {};
        const records = Object.entries(tasks).flatMap(([p, list]) => (Array.isArray(list) ? list.map((t: unknown) => ({ p, t })) : []));
        return { meta: { clocks: raw.clocks, projects: Object.keys(tasks) }, records, seq: typeof raw.seq === 'number' ? raw.seq : 0 };
      },
    };
  }

  private load(): void {
    const saved = this.file?.read();
    if (!saved?.raw) return;
    const meta = (saved.meta && typeof saved.meta === 'object' ? saved.meta : {}) as { clocks?: unknown; projects?: unknown };
    if (meta.clocks && typeof meta.clocks === 'object') this.clocks = { ...(meta.clocks as Record<string, number>) };
    if (Array.isArray(meta.projects)) for (const p of meta.projects) if (typeof p === 'string') this.tasks[p] ??= {};
    for (const r of saved.records as Array<{ p?: unknown; t?: SharedTask }>) {
      const t = r?.t;
      if (typeof r?.p !== 'string' || !t || typeof t.id !== 'string' || !t.fields || !Array.isArray(t.acts)) continue;
      (this.tasks[r.p] ??= {})[t.id] = t;
    }
    // What was read is what's on disk: only what changes from here is written.
    this.file?.baseline();
  }

  private save(): void {
    this.file?.changed();
  }
}
