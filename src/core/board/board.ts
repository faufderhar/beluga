import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeJson } from '../../net/mesh/files.js';
import { BoardFile } from './board-file.js';
import { AgentRef } from '../../protocol.js';
import { agentName } from '../../shared/agent-label.js';
import type { Store } from '../store.js';
import { type Criterion, unexplained } from './criteria.js';
import { LABEL_COLORS, LABEL_ICONS, LABEL_NAME, type LabelColor, type LabelDef, type LabelIcon, MAX_CUSTOM_LABELS, cleanLabelName, inSet, labelsFor } from './labels.js';
import { dropKeptFile, dropProofFolder, keepProofFile, keepProofFiles, letGoProofFile } from './proof-files.js';
import { landProof } from './moved.js';
import {
  type Activity,
  type AnyAssignee,
  type ActivityKind,
  type Actor,
  type Assignee,
  BRIEF_SECTIONS,
  type BoardProject,
  type BoardState,
  type BriefRevision,
  type BriefSection,
  type CarriedFile,
  ISSUE_STATUSES,
  type Issue,
  type IssueGitHub,
  type IssueLink,
  type IssuePlan,
  type IssuePr,
  type IssueStatus,
  COALESCE_MS,
  KEEP_ACTIVITY,
  KEEP_PROOF,
  KEEP_REVISIONS,
  MAX_PROJECT_CONTEXT,
  PRIORITIES,
  PRIORITY_INFO,
  type Priority,
  type Proof,
  SECTION_INFO,
  STATUS_INFO,
  boardOf,
  byRank,
  findIssue,
  isOwnBoard,
  reposOf,
  showsOn,
  isArchived,
  isOpen,
  prefixFor,
  rankBetween,
  personOf,
  renamedActors,
  worktreeOf,
} from './model.js';

/**
 * The board: tasks per project, kept in ~/.beluga/board.json (readable only by you) and mirrored
 * into the shared state for every screen. Every change says who made it and goes into the
 * task's activity; brief edits keep their revisions. Without a folder (tests) it stays in memory.
 */

export interface BoardDeps {
  readonly store: Store;
  /** Where board.json lives; null: memory only. */
  readonly dir: string | null;
  /** A project's name (its key prefix comes from it), if the project is known. */
  readonly projectName: (projectId: string) => string | undefined;
  readonly now?: () => number;
  /** How long to wait before writing changes (several in a row are written once). */
  readonly saveDelayMs?: number;
  /** Fold the journal into board.json past this many bytes (board-file.ts; tests make it small). */
  readonly foldMinBytes?: number;
}

export interface NewIssue {
  /** The repo it runs in. */
  readonly projectId: string;
  /** The board it goes on (a board id); left out: its parent's, else its repo's own. */
  readonly board?: string;
  readonly title: string;
  readonly status?: IssueStatus;
  readonly priority?: Priority;
  readonly assignee?: Assignee;
  readonly labels?: readonly string[];
  readonly estimate?: number;
  readonly due?: string;
  readonly parent?: string;
  readonly blockedBy?: readonly string[];
  readonly brief?: Partial<Record<BriefSection, string>>;
  readonly autoTitle?: boolean;
  readonly drafting?: boolean;
  readonly plan?: IssuePlan;
  /** The GitHub issue it's made from. */
  readonly github?: IssueGitHub;
  /** The agent that works it (BLG-497); none: your default. */
  readonly agent?: AgentRef;
  /** Only you see it (BLG-501); a private parent's sub-tasks are private whatever this says. */
  readonly private?: boolean;
}

/** What Claude wrote for a task made from a description (agent/task-drafter.ts). */
export interface IssueDraft {
  readonly title: string;
  readonly goal: string;
  /** What Claude found looking at the code (a draft written after a quick look). */
  readonly context?: string;
  readonly acceptance: readonly string[];
  readonly labels: readonly string[];
  readonly priority?: Priority;
}

export interface IssuePatch {
  readonly title?: string;
  readonly status?: IssueStatus;
  readonly priority?: Priority;
  /** null: no one. */
  readonly assignee?: Assignee | null;
  readonly labels?: readonly string[];
  readonly estimate?: number | null;
  readonly due?: string | null;
  /** null: not a sub-task any more. */
  readonly parent?: string | null;
  /** The repo it runs in (a project id): it stays on its board, which covers the repo from then on. */
  readonly projectId?: string;
}

/** A board of its own: what it's called, the repos it covers, and its key prefix (worked out from the name when left out). */
export interface NewBoard {
  readonly name: string;
  readonly repos: readonly string[];
  readonly prefix?: string;
}

export type Relation = 'blocked_by' | 'blocks' | 'related';

const MAX_TITLE = 200;
const MAX_SECTION = 20_000;
const MAX_COMMENT = 8_000;
const MAX_LABELS = 12;
const MAX_BOARD_NAME = 60;
/** Repos one board covers, at most. */
const MAX_REPOS = 20;

const SavedLabel = z.object({ name: z.string().regex(LABEL_NAME), icon: z.enum(LABEL_ICONS), color: z.enum(LABEL_COLORS), hint: z.string().max(80).optional() });

const SavedContext = z.object({ text: z.string().max(MAX_PROJECT_CONTEXT), by: z.string().max(80), at: z.number().int().min(0) });

const BoardShape = z.object({
  version: z.literal(1),
  // Renamed from autoTasks when it turned off by default (tasks come from plans now): the old key is ignored.
  worktreeTasks: z.boolean().default(false),
  projects: z
    .record(
      z.string(),
      z.object({
        prefix: z.string().min(1).max(8),
        next: z.number().int().positive(),
        // A label that doesn't read any more is left out, not the board.
        labels: z.array(z.unknown()).optional().transform((list) => list?.flatMap((l) => { const r = SavedLabel.safeParse(l); return r.success ? [r.data as LabelDef] : []; })),
        // One that doesn't read is left out, not the project.
        context: z.unknown().optional().transform((c) => { const r = SavedContext.safeParse(c); return r.success ? r.data : undefined; }),
        name: z.string().max(MAX_BOARD_NAME).optional().catch(undefined),
        repos: z.array(z.string().max(200)).max(MAX_REPOS).optional().catch(undefined),
      }),
    )
    .default({}),
  issues: z.array(z.unknown()).default([]),
});

/** A task as saved: loosely checked (it's our own file), the rest filled in. */
const SavedIssue = z
  .object({
    id: z.string(),
    key: z.string(),
    number: z.number(),
    projectId: z.string(),
    title: z.string(),
    status: z.enum(ISSUE_STATUSES),
    priority: z.enum(PRIORITIES).default('none'),
    labels: z.array(z.string()).default([]),
    blockedBy: z.array(z.string()).default([]),
    related: z.array(z.string()).default([]),
    rank: z.number().default(0),
    brief: z.record(z.string(), z.string()).default({}),
    revisions: z.array(z.unknown()).default([]),
    worktrees: z.array(z.string()).default([]),
    proof: z.array(z.unknown()).default([]),
    activity: z.array(z.unknown()).default([]),
    createdAt: z.number(),
    updatedAt: z.number(),
    origin: z.enum(['manual', 'worktree', 'claude', 'plan', 'sync', 'github']).default('manual'),
    // The agent that works it (BLG-497): one that doesn't read is let go (your default works it).
    agent: AgentRef.optional().catch(undefined),
  })
  .passthrough();

const short = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
const cleanLabels = (labels: readonly string[]): string[] => [...new Set(labels.map((l) => oneLine(l, 32).toLowerCase()).filter(Boolean))].slice(0, MAX_LABELS);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const assigneeId = (a: Assignee | undefined): string => (a ? `person:${a.id}` : '');
/** Whoever it's given to, a person: one given to someone's Claude (an older Mac, an older teammate) is theirs. */
const personIn = (a: Assignee | null | undefined): Assignee | null | undefined => (a ? personOf(a as AnyAssignee) : a);
const statusText = (from: string, to: string): string => `moved this from ${from} to ${to}`;
/** "2 criteria are neither ticked nor explained (“A”; “B”)": the ones holding a task, named. */
const openWords = (open: readonly Criterion[]): string => `${open.length === 1 ? 'a criterion is' : `${open.length} criteria are`} neither ticked nor explained (${open.map((c) => `“${c.text}”`).join('; ')})`;
type IssueChange = Partial<{ -readonly [K in keyof Issue]: Issue[K] }>;
/** How far along a status is, for a parent following its sub-tasks (Canceled isn't on the way). */
const STAGE: Readonly<Record<IssueStatus, number>> = { backlog: 0, todo: 1, in_progress: 2, in_review: 3, in_plan: 3, done: 4, canceled: -1 };

/**
 * The parent's worktree or pull request is its own, not the one its sub-tasks are done in: one
 * worktree carrying the parent and its sub-tasks leaves it nothing of its own to move it along.
 */
function hasOwnWork(parent: Issue, kids: readonly Issue[]): boolean {
  const where = worktreeOf(parent);
  if (where) return !kids.some((k) => worktreeOf(k) === where);
  return parent.pr !== undefined && !kids.some((k) => k.pr?.url === parent.pr!.url);
}

/**
 * Where a parent goes when its sub-tasks (Canceled ones left out) move: Done when they're all
 * Done, In Review when they're all in review or done, In Progress once one is under way; nowhere
 * while none has started. A parent with work of its own (a worktree, a pull request, carried by
 * one, not the one its sub-tasks share) follows that to review and Done, so its sub-tasks only
 * take it as far as In Progress.
 */

function rollUpTo(parent: Issue, kids: readonly Issue[]): { readonly to: IssueStatus; readonly why: string } | undefined {
  if (!kids.length) return undefined;
  const all = kids.length === 1 ? 'its sub-task is' : `all ${kids.length} sub-tasks are`;
  let next: { to: IssueStatus; why: string } | undefined = kids.every((k) => k.status === 'done')
    ? { to: 'done', why: `${all} done` }
    : kids.some((k) => k.status === 'in_plan') && kids.every((k) => k.status === 'in_plan' || k.status === 'done')
      ? { to: 'in_plan', why: `${all} merged into the plan or done` }
    : kids.every((k) => STAGE[k.status] >= STAGE.in_review)
      ? { to: 'in_review', why: `${all} in review or done` }
      : kids.some((k) => STAGE[k.status] >= STAGE.in_progress)
        ? { to: 'in_progress', why: STAGE[parent.status] > STAGE.in_progress ? 'a sub-task is open again' : 'a sub-task is under way' }
        : undefined;
  if (!next || next.to === parent.status) return undefined;
  if (hasOwnWork(parent, kids)) {
    if (STAGE[next.to] > STAGE.in_progress) next = { to: 'in_progress', why: `${all} ${next.to === 'done' ? 'done' : 'in review or done'}` };
    if (STAGE[next.to] <= STAGE[parent.status]) return undefined;
  }
  return next;
}

const sameActor = (a: Actor, b: Actor): boolean => a.kind === b.kind && (a.kind === 'person' ? a.id === (b as typeof a).id : a.kind === 'claude' ? a.owner === (b as typeof a).owner : true);

/** A change to note in the activity; `was`/`now` let quick changes to one field become one line. */
interface Note {
  readonly kind: ActivityKind;
  readonly text: string;
  readonly assignee?: Assignee | null;
  readonly was?: string;
  readonly now?: string;
}

export class Board {
  private issues: Issue[] = [];
  private projects: Record<string, BoardProject> = {};
  private autoTasks = false;
  /** Sub-tasks are going Done with their parent: parents wait until it's over to follow them. */
  private cascading = 0;
  /** A merge is moving tasks to Done (see shipping): only their sub-tasks under way go with them. */
  private merging = 0;
  /** board.json and its journal: a change writes only the tasks it touched (board-file.ts, BLG-942). */
  private readonly file: BoardFile | undefined;
  /** board.json couldn't be read nor moved aside: changes stay in memory rather than overwrite it. */
  private readOnly = false;
  private readonly now: () => number;

  constructor(private readonly deps: BoardDeps) {
    this.now = deps.now ?? Date.now;
    this.file = deps.dir ? new BoardFile(deps.dir, () => ({ worktreeTasks: this.autoTasks, projects: this.projects, issues: this.issues }), deps.saveDelayMs ?? 300, deps.foldMinBytes) : undefined;
    this.load();
    // What was read is what's on disk: only what changes from here is written.
    this.file?.baseline();
    // Proof saved before files were kept (still in a worktree): kept now, while it's there.
    if (deps.dir) {
      const home = deps.dir;
      const before = this.issues;
      this.issues = this.issues.map((i) => {
        const proof = keepProofFiles(i.proof, i.id, home);
        return proof === i.proof ? i : { ...i, proof };
      });
      if (this.issues.some((i, n) => i !== before[n])) this.save();
    }
    deps.store.dispatch({ type: 'board_init', state: this.state() });
  }

  // ------------------------------------------------------------------ reading

  state(): BoardState {
    return { enabled: true, issues: this.issues, projects: this.projects, autoTasks: this.autoTasks };
  }

  list = (): readonly Issue[] => this.issues;

  /** A task by key ("BOB-12") or id; a clear error when there's none. */
  need(ref: string): Issue {
    const issue = findIssue(this.state(), ref);
    if (!issue) throw new Error(`There's no task ${ref}`);
    return issue;
  }

  get = (ref: string): Issue | undefined => findIssue(this.state(), ref);

  get autoTasksOn(): boolean {
    return this.autoTasks;
  }

  // ------------------------------------------------------------------ changing

  create(input: NewIssue, by: Actor, origin: Issue['origin'] = 'manual'): Issue {
    const title = oneLine(input.title, MAX_TITLE);
    if (!title) throw new Error('A task needs a title');
    this.needRepo(input.projectId);
    const parent = input.parent ? this.need(input.parent) : undefined;
    const boardId = input.board ?? (parent ? boardOf(parent) : input.projectId);
    if (parent && boardOf(parent) !== boardId) throw new Error('A sub-task is on its parent’s board');
    const project = this.covering(this.projectFor(boardId), boardId, input.projectId);
    const status = input.status ?? 'todo';
    const blockers = (input.blockedBy ?? []).map((ref) => this.need(ref).id);
    const at = this.now();
    const number = project.next;

    const brief = Object.fromEntries(
      BRIEF_SECTIONS.flatMap((s) => {
        const text = input.brief?.[s]?.trim();
        return text ? [[s, text.slice(0, MAX_SECTION)]] : [];
      }),
    ) as Issue['brief'];
    const issue: Issue = {
      id: short('i'),
      key: `${project.prefix}-${number}`,
      number,
      projectId: input.projectId,
      ...(boardId !== input.projectId ? { board: boardId } : {}),
      title,
      ...(input.autoTitle ? { autoTitle: true } : {}),
      ...(input.drafting ? { drafting: true } : {}),
      status,
      priority: input.priority ?? 'none',
      labels: this.allowedLabels(boardId, input.labels ?? [], [], by, origin),
      ...(input.estimate ? { estimate: input.estimate } : {}),
      ...(input.due && DAY.test(input.due) ? { due: input.due } : {}),
      // A sub-task is for whoever has its parent, unless it's given to someone else (BLG-512).
      ...(input.assignee ? { assignee: personOf(input.assignee as AnyAssignee) } : parent?.assignee ? { assignee: parent.assignee } : {}),
      ...(parent ? { parent: parent.id } : {}),
      ...(input.plan ? { plan: input.plan } : {}),
      ...(input.github ? { github: input.github } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.private || parent?.private ? { private: true as const } : {}),
      blockedBy: [...new Set(blockers)],
      related: [],
      rank: this.lastRank(status),
      brief,
      revisions: [],
      worktrees: [],
      proof: [],
      activity: [this.entry(by, 'created', origin === 'worktree' ? 'opened this task for a new worktree' : origin === 'plan' ? 'created this task from a plan' : origin === 'sync' ? 'brought this task over' : origin === 'github' && input.github ? `made this task from GitHub issue #${input.github.number}` : 'created this task', undefined, at)],
      createdAt: at,
      updatedAt: at,
      createdBy: by,
      ...(isOpen(status) ? {} : { closedAt: at }),
      origin,
    };
    this.projects = { ...this.projects, [boardId]: { ...project, next: number + 1 } };
    this.issues = [...this.issues, issue];
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: this.autoTasks });
    this.deps.store.dispatch({ type: 'board_issue', issue });
    this.save();
    if (parent) this.rollUp(parent.id);
    return this.need(issue.id);
  }

  update(ref: string, patch: IssuePatch, by: Actor): Issue {
    let issue = this.need(ref);
    const before = issue;
    const notes: Note[] = [];
    const next: { -readonly [K in keyof Issue]?: Issue[K] } = {};
    if (patch.title !== undefined) {
      const title = oneLine(patch.title, MAX_TITLE);
      if (!title) throw new Error('A task needs a title');
      if (title !== issue.title) {
        next.title = title;
        notes.push({ kind: 'title', text: `renamed this to “${title}”`, was: issue.title, now: title });
      }
    }
    if (patch.status && patch.status !== issue.status) {
      notes.push({ kind: 'status', text: statusText(STATUS_INFO[issue.status].label, STATUS_INFO[patch.status].label), was: STATUS_INFO[issue.status].label, now: STATUS_INFO[patch.status].label });
      next.status = patch.status;
      next.rank = this.lastRank(patch.status);
      // It moved on (a person's choice, or every criterion settled): no longer held for its checks.
      if (issue.needsChecks) next.needsChecks = undefined;
      if (issue.mergedHeld) next.mergedHeld = undefined;
      // Moved back out of the work: the worktree that carried it no longer ships it (nor does its branch).
      if (issue.carriedBy && (patch.status === 'backlog' || patch.status === 'todo' || patch.status === 'canceled')) {
        next.carriedBy = undefined;
        if (!issue.worktrees.length) next.branch = undefined;
      }
    }
    if (patch.priority && patch.priority !== issue.priority) {
      next.priority = patch.priority;
      notes.push({ kind: 'priority', text: patch.priority === 'none' ? 'removed the priority' : `set the priority to ${PRIORITY_INFO[patch.priority].label}`, was: issue.priority, now: patch.priority });
    }
    const assignee = personIn(patch.assignee);
    if (assignee !== undefined && !sameAssignee(assignee ?? undefined, issue.assignee)) {
      next.assignee = assignee ?? undefined;
      notes.push({ kind: 'assignee', text: assignee ? `assigned this to ${assignee.name}` : 'unassigned this', assignee, was: assigneeId(issue.assignee), now: assigneeId(assignee ?? undefined) });
    }
    if (patch.labels) {
      const labels = this.allowedLabels(boardOf(issue), patch.labels, issue.labels, by);
      if (labels.join('\0') !== issue.labels.join('\0')) {
        const added = labels.filter((l) => !issue.labels.includes(l));
        const removed = issue.labels.filter((l) => !labels.includes(l));
        next.labels = labels;
        notes.push({ kind: 'labels', text: [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : ''].filter(Boolean).join(' and ') });
      }
    }
    if (patch.estimate !== undefined && (patch.estimate ?? undefined) !== issue.estimate) {
      next.estimate = patch.estimate ?? undefined;
      notes.push({ kind: 'estimate', text: patch.estimate ? `estimated this at ${patch.estimate} ${patch.estimate === 1 ? 'point' : 'points'}` : 'removed the estimate', was: String(issue.estimate ?? ''), now: String(patch.estimate ?? '') });
    }
    if (patch.due !== undefined && (patch.due ?? undefined) !== issue.due) {
      if (patch.due && !DAY.test(patch.due)) throw new Error('A due date looks like 2026-11-03');
      next.due = patch.due ?? undefined;
      notes.push({ kind: 'due', text: patch.due ? `set it due ${patch.due}` : 'removed the due date', was: issue.due ?? '', now: patch.due ?? '' });
    }
    if (patch.parent !== undefined && (patch.parent ?? undefined) !== issue.parent) {
      if (patch.parent) {
        const parent = this.need(patch.parent);
        if (parent.id === issue.id || this.isAncestor(issue.id, parent.id)) throw new Error('A task can’t be a sub-task of itself or of its own sub-tasks');
        if (boardOf(parent) !== boardOf(issue)) throw new Error('A sub-task is on its parent’s board');
        next.parent = parent.id;
        notes.push({ kind: 'parent', text: `made this a sub-task of ${parent.key}` });
      } else {
        next.parent = undefined;
        notes.push({ kind: 'parent', text: 'made this a task of its own' });
      }
    }
    if (patch.projectId && patch.projectId !== issue.projectId) {
      this.needRepo(patch.projectId);
      const boardId = boardOf(issue);
      // It stays on its board (its key with it); the board covers the repo from now on.
      next.projectId = patch.projectId;
      next.board = boardId === patch.projectId ? undefined : boardId;
      const covered = this.covering(this.projectFor(boardId), boardId, patch.projectId);
      if (covered !== this.projects[boardId]) this.meta({ ...this.projects, [boardId]: covered });
      const name = (id: string): string => this.deps.projectName(id) ?? 'another repo';
      notes.push({ kind: 'project', text: `moved this to run in ${name(patch.projectId)}`, was: issue.projectId, now: patch.projectId });
    }
    if (!notes.length) return issue;
    const at = this.now();
    // One field changed again by the same person moments later: one line, from where it started.
    const last = issue.activity.at(-1);
    const only = notes.length === 1 ? notes[0]! : undefined;
    if (only?.was !== undefined && last && last.kind === only.kind && last.was !== undefined && sameActor(last.by, by) && at - last.at < COALESCE_MS) {
      const was = last.was;
      const back = was === only.now;
      const text = only.kind === 'status' ? statusText(was, only.now!) : only.text;
      const entries = back ? [] : [this.entry(by, only.kind, text, undefined, at, only.assignee, { was, now: only.now! })];
      issue = this.change(issue, next, entries, true, true);
      if ('assignee' in next) this.passAssignee(issue, before.assignee, by);
      return issue;
    }
    issue = this.change(issue, next, notes.map((n) => this.entry(by, n.kind, n.text, undefined, at, n.assignee, n.was !== undefined ? { was: n.was, now: n.now! } : undefined)));
    // Under a private task now: private like the rest of it (BLG-501).
    if (next.parent && !issue.private && this.get(next.parent)?.private) issue = this.setPrivate(issue.id, true, by);
    if ('assignee' in next) this.passAssignee(issue, before.assignee, by);
    // Under an assigned task now, with no one of its own: its parent's person's (BLG-512).
    const parent = next.parent ? this.get(next.parent) : undefined;
    if (parent?.assignee && !issue.assignee) issue = this.update(issue.id, { assignee: parent.assignee }, by);
    return issue;
  }

  /**
   * A task given to someone else: its open sub-tasks, all the way down, go with it (BLG-512),
   * except one given to another person, which keeps them. Finished ones keep who did them.
   */
  private passAssignee(issue: Issue, was: Assignee | undefined, by: Actor): void {
    for (const kid of this.issues.filter((i) => i.parent === issue.id && isOpen(i.status) && !isArchived(i))) {
      if (kid.assignee && !sameAssignee(kid.assignee, was)) continue;
      if (sameAssignee(kid.assignee, issue.assignee)) continue;
      this.update(kid.id, { assignee: issue.assignee ?? null }, by);
    }
  }

  /**
   * Claude's draft for a task made from a description: its title (unless someone renamed it
   * meanwhile), goal and criteria where they're empty, labels added, a priority if it had none.
   * No draft: the first line stays the title, and what was said becomes the goal if it says more.
   */
  finishDraft(ref: string, draft: IssueDraft | undefined, by: Actor, said = ''): Issue {
    const issue = this.need(ref);
    if (!issue.drafting) return issue;
    if (!draft) {
      const text = said.trim().slice(0, MAX_SECTION);
      const more = text && text.replace(/\s+/g, ' ') !== issue.title && !issue.brief.goal;
      return this.change(issue, { drafting: undefined, ...(more ? { brief: { ...issue.brief, goal: text } } : {}) }, []);
    }
    const renamed = issue.activity.some((a) => a.kind === 'title');
    const title = oneLine(draft.title, MAX_TITLE);
    const brief = { ...issue.brief };
    if (!brief.goal && draft.goal.trim()) brief.goal = draft.goal.trim().slice(0, MAX_SECTION);
    if (!brief.context && draft.context?.trim()) brief.context = draft.context.trim().slice(0, MAX_SECTION);
    if (!brief.acceptance && draft.acceptance.length) brief.acceptance = draft.acceptance.map((a) => `- [ ] ${oneLine(a, 300)}`).join('\n');
    return this.change(
      issue,
      {
        drafting: undefined,
        ...(title && !renamed ? { title } : {}),
        brief,
        labels: cleanLabels([...issue.labels, ...inSet(labelsFor(this.state(), boardOf(issue)), draft.labels).known]),
        ...(draft.priority && issue.priority === 'none' ? { priority: draft.priority } : {}),
      },
      [this.entry(by, 'brief', 'wrote the title and goal')],
    );
  }

  /**
   * Where the task lives in another tracker, and what both sides looked like as they last agreed
   * (sync/sync.ts); undefined: not linked any more. Quiet but for the first link and an unlink.
   */
  setLink(ref: string, link: IssueLink | undefined, note?: string): Issue {
    const issue = this.need(ref);
    if (!link && !issue.link) return issue;
    const entries = note ? [this.entry({ kind: 'beluga' }, 'link', note)] : [];
    return this.change(issue, { link }, entries, false);
  }

  /**
   * The GitHub issue a task is for, and what Claude was last asked to do about it (see
   * core/issues); `note` goes in the activity ("asked Claude to investigate #12").
   */
  setGitHub(ref: string, github: IssueGitHub | undefined, by: Actor, note?: string): Issue {
    const issue = this.need(ref);
    const was = issue.github;
    if (was?.repo === github?.repo && was?.number === github?.number && was?.url === github?.url && was?.step === github?.step && was?.host === github?.host && was?.investigated === github?.investigated) return issue;
    return this.change(issue, { github }, note ? [this.entry(by, 'link', note)] : [], Boolean(note));
  }

  /** The plan (and milestone) a task belongs to; undefined: none any more. */
  setPlan(ref: string, link: IssuePlan | undefined, by: Actor, text?: string): Issue {
    const issue = this.need(ref);
    const same = issue.plan?.id === link?.id && issue.plan?.milestone === link?.milestone && issue.plan?.task === link?.task;
    if (same) return issue;
    return this.change(issue, { plan: link }, text ? [this.entry(by, 'plan', text)] : [], Boolean(text));
  }

  /**
   * The agent (and model) that works the task from its next start (BLG-498); undefined: your
   * default agent. A worktree already working it keeps the agent it opened with.
   */
  setAgent(ref: string, agent: AgentRef | undefined, by: Actor): Issue {
    const issue = this.need(ref);
    const was = issue.agent;
    if (was?.runtime === agent?.runtime && was?.model === agent?.model && was?.label === agent?.label) return issue;
    const text = agent ? `chose ${agentName(agent, { model: true })} to work this` : 'left this to the default agent';
    return this.change(issue, { agent: agent ? { runtime: agent.runtime, label: agent.label, ...(agent.model ? { model: agent.model } : {}) } : undefined }, [this.entry(by, 'note', text)]);
  }

  /** Drop a card in a column, between two others (the board): its status and its place. */
  move(ref: string, status: IssueStatus, between: { readonly before?: string; readonly after?: string }, by: Actor): Issue {
    let issue = this.need(ref);
    if (status !== issue.status) issue = this.update(issue.id, { status }, by);
    let before = between.before ? this.get(between.before) : undefined;
    let after = between.after ? this.get(between.after) : undefined;
    if (!before && !after) return issue;
    // Neighbours too close (or tied) to fit between: spread the column out first.
    if (before && after && !(after.rank - before.rank > 1e-6)) {
      this.respace(status, issue.id);
      before = this.get(before.id);
      after = this.get(after.id);
    }
    return this.change(this.need(issue.id), { rank: rankBetween(before?.rank, after?.rank) }, []);
  }

  /** Write one section of the brief (or add to it); the old text is kept as a revision. */
  editBrief(ref: string, section: BriefSection, text: string, by: Actor, opts: { readonly reason?: string; readonly mode?: 'replace' | 'append' } = {}): Issue {
    const issue = this.need(ref);
    if (!BRIEF_SECTIONS.includes(section)) throw new Error(`The brief has no section "${section}"`);
    const before = issue.brief[section] ?? '';
    const added = text.trim();
    const after = (opts.mode === 'append' && before ? `${before.trimEnd()}\n${added}` : added).slice(0, MAX_SECTION);
    if (after === before) return issue;
    const reason = opts.reason ? oneLine(opts.reason, 200) : undefined;
    const revision = { id: short('r'), at: this.now(), by, section, before, after, ...(reason ? { reason } : {}) };
    const brief = { ...issue.brief, [section]: after };
    if (!after) delete brief[section];
    const edited = this.change(issue, { brief, revisions: keepRevisions([...issue.revisions, revision]) }, [this.entry(by, 'brief', `${before ? 'updated' : 'wrote'} ${SECTION_INFO[section].label}${reason ? ` — ${reason}` : ''}`)]);
    return section === 'acceptance' ? this.checksSettled(edited) : edited;
  }

  /**
   * Kept out of review: a criterion is neither ticked nor explained (task_update refused it, or its
   * pull request opened). The board shows "Needs its checks" until they're settled.
   */
  holdForChecks(ref: string): Issue {
    const issue = this.need(ref);
    return issue.needsChecks ? issue : this.change(issue, { needsChecks: true }, [], false);
  }

  /**
   * Every criterion ticked or explained now: no longer held; a pull request that waited moves it to
   * In Review, and work that already merged (see landed) moves it to Done.
   */
  private checksSettled(issue: Issue): Issue {
    if (!issue.needsChecks || unexplained(issue.brief.acceptance).length) return issue;
    if (issue.mergedHeld && isOpen(issue.status)) {
      const beluga: Actor = { kind: 'beluga' };
      return this.shipping(() =>
        this.change(issue, { needsChecks: undefined, mergedHeld: undefined, status: 'done', rank: this.lastRank('done'), worktreeGone: undefined }, [
          this.entry(beluga, 'status', `every criterion is ticked or explained and its work is merged: ${statusText(STATUS_INFO[issue.status].label, STATUS_INFO.done.label)}`),
        ]),
      );
    }
    const pr = issue.pr;
    const waiting = pr?.state === 'OPEN' && !pr.draft && pr.review !== 'CHANGES_REQUESTED' && (issue.status === 'backlog' || issue.status === 'todo' || issue.status === 'in_progress');
    if (!waiting) return this.change(issue, { needsChecks: undefined }, [], false);
    const beluga: Actor = { kind: 'beluga' };
    return this.change(issue, { needsChecks: undefined, status: 'in_review', rank: this.lastRank('in_review') }, [
      this.entry(beluga, 'status', `every criterion is ticked or explained: ${statusText(STATUS_INFO[issue.status].label, STATUS_INFO.in_review.label)}`),
    ]);
  }

  /** Put a section back the way a revision found it (that's a new revision too). */
  restoreRevision(ref: string, revisionId: string, by: Actor): Issue {
    const issue = this.need(ref);
    const revision = issue.revisions.find((r) => r.id === revisionId);
    if (!revision) throw new Error('That version isn’t kept any more');
    return this.editBrief(issue.id, revision.section, revision.before, by, { reason: 'restored an earlier version' });
  }

  /** A comment from a person, or a note from Claude (what it did, what it found). */
  comment(ref: string, text: string, by: Actor): Issue {
    const issue = this.need(ref);
    const body = text.trim().slice(0, MAX_COMMENT);
    if (!body) throw new Error('Nothing to say');
    return this.change(issue, {}, [this.entry(by, by.kind === 'claude' ? 'note' : 'comment', by.kind === 'claude' ? 'left a note' : 'commented', body)]);
  }

  /** Blockers both ways and related tasks; a loop of blockers is refused. */
  relate(ref: string, relation: Relation, otherRef: string, on: boolean, by: Actor): Issue {
    const issue = this.need(ref);
    const other = this.need(otherRef);
    if (other.id === issue.id) throw new Error('A task can’t be related to itself');
    if (relation === 'blocks') {
      this.relate(other.id, 'blocked_by', issue.id, on, by);
      return this.need(issue.id);
    }
    if (relation === 'related') {
      const has = issue.related.includes(other.id);
      if (has === on) return issue;
      const text = on ? `linked this to ${other.key}` : `unlinked ${other.key}`;
      const mine = this.change(issue, { related: on ? [...issue.related, other.id] : issue.related.filter((id) => id !== other.id) }, [this.entry(by, 'relation', text)]);
      const theirs = this.need(other.id);
      this.change(theirs, { related: on ? [...new Set([...theirs.related, issue.id])] : theirs.related.filter((id) => id !== issue.id) }, []);
      return mine;
    }
    const has = issue.blockedBy.includes(other.id);
    if (has === on) return issue;
    if (on && this.waitsOn(other.id, issue.id)) throw new Error(`${other.key} already waits on ${issue.key}: that would be a loop`);
    const mine = this.change(issue, { blockedBy: on ? [...issue.blockedBy, other.id] : issue.blockedBy.filter((id) => id !== other.id) }, [this.entry(by, 'relation', on ? `marked this as blocked by ${other.key}` : `removed ${other.key} as a blocker`)]);
    this.change(this.need(other.id), {}, [this.entry(by, 'relation', on ? `marked this as blocking ${issue.key}` : `${issue.key} no longer waits on this`)]);
    return mine;
  }

  addProof(ref: string, proof: Omit<Proof, 'id' | 'at' | 'by'>, by: Actor): Issue {
    const issue = this.need(ref);
    const title = oneLine(proof.title, 120);
    if (!title) throw new Error('Proof needs a title');
    const { from: _, gone: __, ...given } = proof;
    const made: Proof = { ...given, title, id: short('p'), at: this.now(), by };
    // Its file is copied now, so it outlives the worktree it was made in.
    const item = this.deps.dir ? keepProofFile(made, issue.id, this.deps.dir) : made;
    // Only proof is trimmed to the newest KEEP_PROOF: files someone added for the work stay.
    const all = [...issue.proof, item];
    const over = new Set(all.filter((p) => !p.context).slice(0, -KEEP_PROOF));
    if (this.deps.dir) for (const old of over) dropKeptFile(this.deps.dir, old.path);
    return this.change(issue, { proof: all.filter((p) => !over.has(p)) }, [this.entry(by, 'proof', item.context ? `added a file: ${title}` : `added proof: ${title}`)]);
  }

  removeProof(ref: string, proofId: string, by: Actor): Issue {
    const issue = this.need(ref);
    const gone = issue.proof.find((p) => p.id === proofId);
    if (!gone) return issue;
    if (this.deps.dir) dropKeptFile(this.deps.dir, gone.path);
    return this.change(issue, { proof: issue.proof.filter((p) => p.id !== proofId) }, [this.entry(by, 'proof', gone.context ? `removed a file: ${gone.title}` : `removed proof: ${gone.title}`)]);
  }

  /**
   * Keep proof files that are still somewhere else (`within`: only those in this folder, a
   * worktree about to be archived or deleted): copied into ~/.beluga/proof, and those whose file
   * is gone marked so. Quiet: no activity, the task's time untouched. → how many proofs changed.
   */
  keepProofs(within?: string): number {
    const home = this.deps.dir;
    if (!home) return 0;
    let n = 0;
    for (const issue of this.issues) {
      const proof = keepProofFiles(issue.proof, issue.id, home, within);
      if (proof === issue.proof) continue;
      n += proof.filter((p, i) => p !== issue.proof[i]).length;
      this.change(issue, { proof }, [], false);
    }
    return n;
  }

  // ------------------------------------------------------------------ the archive

  /**
   * To the Archive: off the board and out of Claude's lists, its words and history kept, its proof
   * files let go (screenshots kept as small JPEGs, see letGoProofFile). Only finished tasks (Done,
   * Canceled) go; a parent takes its finished sub-tasks along.
   */
  archive(ref: string, by: Actor): Issue {
    const issue = this.need(ref);
    if (isArchived(issue)) return issue;
    if (isOpen(issue.status)) throw new Error(`${issue.key} isn’t finished: only Done or Canceled tasks go to the Archive`);
    const home = this.deps.dir;
    const proof = home ? issue.proof.map((p) => letGoProofFile(p, home)) : issue.proof;
    const archived = this.change(issue, { archivedAt: this.now(), proof }, [this.entry(by, 'status', 'archived this')], false);
    for (const kid of this.issues.filter((i) => i.parent === issue.id && !isOpen(i.status) && !isArchived(i))) this.archive(kid.id, by);
    return archived;
  }

  /** Every Done task to the Archive (the ones a board shows, `showsOn`, or all of them). → how many went. */
  archiveDone(by: Actor, boardId?: string): number {
    const done = this.issues.filter((i) => i.status === 'done' && !isArchived(i) && (!boardId || showsOn(i, boardId)));
    for (const issue of done) this.archive(issue.id, by);
    return done.length;
  }

  /** Back on the board from the Archive (its proof files stay let go). */
  unarchive(ref: string, by: Actor): Issue {
    const issue = this.need(ref);
    if (!isArchived(issue)) return issue;
    return this.change(issue, { archivedAt: undefined }, [this.entry(by, 'status', 'brought this back from the Archive')]);
  }

  /** Delete every archived task for good (the ones a board shows, `showsOn`, or all of them). → how many went. */
  emptyArchive(boardId?: string): number {
    const gone = this.issues.filter((i) => isArchived(i) && (!boardId || showsOn(i, boardId)));
    for (const issue of gone) this.remove(issue.id);
    return gone.length;
  }

  /**
   * Only you see it, or the team does again (BLG-501). Its sub-tasks go with it, all the way
   * down, so a private epic is a board of your own inside the shared one. Making a shared task
   * private takes it back from teammates (team-board sync sends them a delete); sharing it sends
   * it as it is now. Another tracker (Linear) leaves a private task alone.
   */
  setPrivate(ref: string, on: boolean, by: Actor): Issue {
    const issue = this.need(ref);
    const tree = [issue, ...this.issues.filter((i) => this.isAncestor(issue.id, i.id))];
    for (const t of tree) {
      if (Boolean(t.private) === on) continue;
      const text = on ? (t === issue ? 'made this private' : 'made this private with its parent') : t === issue ? 'shared this with the team' : 'shared this with its parent';
      this.change(this.need(t.id), { private: on ? true : undefined }, [this.entry(by, 'private', text)]);
    }
    return this.need(issue.id);
  }

  /** Delete a task: its sub-tasks become tasks of their own, and nothing waits on it any more. */
  remove(ref: string): void {
    const issue = this.need(ref);
    if (this.deps.dir) dropProofFolder(this.deps.dir, issue.id);
    this.issues = this.issues.filter((i) => i.id !== issue.id);
    this.deps.store.dispatch({ type: 'board_remove', id: issue.id });
    for (const other of this.issues) {
      const touched = other.parent === issue.id || other.blockedBy.includes(issue.id) || other.related.includes(issue.id);
      if (!touched) continue;
      this.change(other, { ...(other.parent === issue.id ? { parent: undefined } : {}), blockedBy: other.blockedBy.filter((id) => id !== issue.id), related: other.related.filter((id) => id !== issue.id) }, [], false);
    }
    if (issue.parent) this.rollUp(issue.parent);
    this.save();
  }

  // ------------------------------------------------------------------ worktrees and pull requests

  /**
   * A worktree is doing this task now. One task per worktree, unless `shared`: a plan milestone's
   * one Claude does all of its tasks in one worktree (see plans/pilot.ts), so each of them links it.
   */
  linkWorktree(ref: string, workspaceId: string, info: { readonly branch?: string; readonly name?: string; readonly shared?: boolean }, by: Actor): Issue {
    const issue = this.need(ref);
    if (!info.shared) for (const other of this.issues) if (other.id !== issue.id && other.worktrees.includes(workspaceId)) this.change(other, { worktrees: other.worktrees.filter((w) => w !== workspaceId) }, []);
    if (issue.worktrees.at(-1) === workspaceId) return issue;
    return this.change(issue, { worktrees: [...issue.worktrees.filter((w) => w !== workspaceId), workspaceId], ...(info.branch ? { branch: info.branch } : {}), worktreeGone: undefined, carriedBy: undefined }, [this.entry(by, 'worktree', info.name ? `${info.shared ? 'joined' : 'started'} worktree ${info.name}` : 'started a worktree')]);
  }

  /**
   * Claude moved this task along from a worktree that isn't doing it (one doing a bigger task, or a
   * list of asks): that worktree carries it now, so its pull request merging makes it Done too. A
   * task with a worktree of its own (`live`: still there) keeps following that one.
   */
  carry(ref: string, ws: { readonly id: string; readonly branch?: string; readonly name?: string }, live: (workspaceId: string) => boolean): Issue {
    const issue = this.need(ref);
    const own = issue.worktrees.at(-1);
    if (own === ws.id || issue.carriedBy === ws.id || (own && live(own))) return issue;
    return this.change(issue, { carriedBy: ws.id, ...(ws.branch ? { branch: ws.branch } : {}) }, [this.entry({ kind: 'beluga' }, 'worktree', `its work is being done in worktree ${ws.name ?? ws.id}`)], false);
  }

  /** The worktree was renamed (a small model named it): a task titled after it follows. */
  retitle(ref: string, title: string): Issue {
    const issue = this.need(ref);
    const clean = oneLine(title, MAX_TITLE);
    if (!issue.autoTitle || !clean || clean === issue.title) return issue;
    return this.change(issue, { title: clean, autoTitle: true }, []);
  }

  /** Done with the question its worktree going away raised: Canceled, back to the Backlog, or keep it as it is. */
  settleGone(ref: string, next: 'canceled' | 'backlog' | 'keep', by: Actor): Issue {
    const issue = this.need(ref);
    const settled = this.change(issue, { worktreeGone: undefined }, []);
    return next === 'keep' ? settled : this.update(settled.id, { status: next }, by);
  }

  /** The worktree went away (archived or deleted) — or came back. */
  worktreeGone(workspaceId: string, gone: boolean, how: 'archived' | 'deleted' | 'restored'): void {
    for (const issue of this.issues) {
      if (issue.worktrees.at(-1) !== workspaceId) continue;
      // Merged into Plan: its work is in the plan's branch, so its worktree going away is expected.
      const ask = gone && isOpen(issue.status) && issue.status !== 'in_plan';
      // A deleted worktree can't be opened again: it's no longer the task's.
      const worktrees = how === 'deleted' ? issue.worktrees.filter((w) => w !== workspaceId) : issue.worktrees;
      this.change(issue, { worktreeGone: ask || undefined, worktrees }, [this.entry({ kind: 'beluga' }, 'worktree', `its worktree was ${how}`)]);
    }
  }

  /** The worktree's pull request as the workbench saw it: kept on the task, and the task's status follows it. */
  prChanged(workspaceId: string, pr: IssuePr | undefined): void {
    for (const issue of this.issues) {
      // Only the worktree doing it now (or carrying it): an older one's pull request is history.
      if (!followsWorktree(issue, workspaceId) || !pr) continue;
      const before = issue.pr;
      const same = before && before.number === pr.number && before.state === pr.state && before.checks === pr.checks && before.review === pr.review && before.draft === pr.draft && before.title === pr.title;
      if (same) continue;
      const beluga: Actor = { kind: 'beluga' };
      const notes: Activity[] = [];
      let status: IssueStatus | undefined;
      if (!before || before.number !== pr.number) notes.push(this.entry(beluga, 'pr', `opened pull request #${pr.number}`));
      if (pr.state === 'MERGED' && before?.state !== 'MERGED') {
        notes.push(this.entry(beluga, 'pr', `pull request #${pr.number} was merged`));
        // Already held by an earlier merge (its worktree into main): it stays held, no second line.
        if (isOpen(issue.status) && shipsWith(issue, workspaceId) && !issue.mergedHeld) {
          // Done, or In Review held while a criterion is neither ticked nor explained (BLG-952).
          const landed = this.landed(issue);
          this.shipping(() => this.change(issue, { pr, ...landed.patch }, [...notes, ...landed.notes]));
          continue;
        }
      } else if (pr.state === 'CLOSED' && before?.state !== 'CLOSED') {
        notes.push(this.entry(beluga, 'pr', `pull request #${pr.number} was closed without merging`));
      } else if (pr.state === 'OPEN') {
        if (pr.review === 'CHANGES_REQUESTED' && before?.review !== 'CHANGES_REQUESTED') {
          notes.push(this.entry(beluga, 'pr', 'changes were requested on the pull request'));
          if (issue.status === 'in_review') status = 'in_progress';
        } else if (pr.review === 'APPROVED' && before?.review !== 'APPROVED') notes.push(this.entry(beluga, 'pr', 'the pull request was approved'));
        if (pr.checks === 'failing' && before?.checks !== 'failing') notes.push(this.entry(beluga, 'pr', 'checks are failing'));
        if (!status && pr.review !== 'CHANGES_REQUESTED' && (issue.status === 'backlog' || issue.status === 'todo' || issue.status === 'in_progress') && (!before || before.number !== pr.number || pr.draft !== before.draft) && !pr.draft) status = 'in_review';
      }
      // Not to review while a criterion is neither ticked nor explained: held until it is (see checksSettled).
      const open = status === 'in_review' ? unexplained(issue.brief.acceptance) : [];
      if (open.length) {
        status = undefined;
        notes.push(this.entry(beluga, 'pr', `kept this out of In Review: ${openWords(open)}`));
      }
      if (status && status !== issue.status) notes.push(this.entry(beluga, 'status', `moved this from ${STATUS_INFO[issue.status].label} to ${STATUS_INFO[status].label}`));
      const moved = status && status !== issue.status;
      this.shipping(() => this.change(issue, { pr, ...(moved ? { status, rank: this.lastRank(status!), needsChecks: undefined } : {}), ...(open.length ? { needsChecks: true } : {}) }, notes));
    }
  }

  /**
   * Continue After Merge: its worktree carries on after pull request `number` merged. That PR is
   * history (kept in the activity); the task is worked on again, and the next PR is its own.
   */
  continuedAfterMerge(workspaceId: string, number: number): void {
    for (const issue of this.issues) {
      if (!followsWorktree(issue, workspaceId) || isArchived(issue) || issue.status === 'canceled') continue;
      if (issue.pr && issue.pr.number > number) continue;
      const beluga: Actor = { kind: 'beluga' };
      // Done, or held In Review by that merge (see landed): worked on again, and the next merge ships it.
      const reopen = issue.status === 'done' || (issue.mergedHeld === true && issue.status === 'in_review');
      this.change(issue, { pr: undefined, mergedHeld: undefined, ...(reopen ? { status: 'in_progress' as const, rank: this.lastRank('in_progress') } : {}) }, [
        this.entry(beluga, 'pr', `work continues in its worktree after pull request #${number} merged; the next change gets a new pull request`),
        ...(reopen ? [this.entry(beluga, 'status', statusText(STATUS_INFO[issue.status].label, STATUS_INFO.in_progress.label))] : []),
      ]);
    }
  }

  /**
   * Its branch's pull request, found merged after its worktree stopped being watched (archived or
   * gone, see BoardWork.sweepShipped): Done, like a merge seen live (or held, see landed).
   */
  branchShipped(ref: string, pr: IssuePr): Issue {
    const issue = this.need(ref);
    if (pr.state !== 'MERGED' || !isOpen(issue.status) || isArchived(issue) || issue.mergedHeld) return issue;
    const landed = this.landed(issue);
    return this.shipping(() => this.change(issue, { pr, ...landed.patch, worktreeGone: undefined }, [this.entry({ kind: 'beluga' }, 'pr', `pull request #${pr.number} was merged`), ...landed.notes]));
  }

  /** The worktree was merged into the project's main folder here. */
  worktreeMerged(workspaceId: string): void {
    for (const issue of this.issues) {
      if (!shipsWith(issue, workspaceId) || !isOpen(issue.status) || issue.mergedHeld) continue;
      const landed = this.landed(issue);
      this.shipping(() => this.change(issue, landed.patch, [this.entry({ kind: 'beluga' }, 'worktree', 'its worktree was merged into main'), ...landed.notes]));
    }
  }

  /**
   * Its work merged (BLG-952): Done when every criterion is ticked or explained, or it has none; else
   * In Review, held, with a line naming the open ones, until they're settled (see checksSettled) or
   * it's marked Done by hand.
   */
  private landed(issue: Issue): { readonly patch: IssueChange; readonly notes: readonly Activity[] } {
    const beluga: Actor = { kind: 'beluga' };
    const from = STATUS_INFO[issue.status].label;
    const open = unexplained(issue.brief.acceptance);
    if (!open.length) {
      return { patch: { status: 'done', rank: this.lastRank('done'), needsChecks: undefined, mergedHeld: undefined }, notes: [this.entry(beluga, 'status', statusText(from, STATUS_INFO.done.label))] };
    }
    const move = issue.status !== 'in_review';
    const why = `kept this out of Done: ${openWords(open)}`;
    return {
      patch: { needsChecks: true, mergedHeld: true, ...(move ? { status: 'in_review' as const, rank: this.lastRank('in_review') } : {}) },
      notes: [this.entry(beluga, 'status', move ? `${why}: ${statusText(from, STATUS_INFO.in_review.label)}` : why)],
    };
  }

  /**
   * A merge moving a task to Done: only its sub-tasks under way with no worktree of their own go with
   * it (see doneWithParent); ones filed for later stay, ones a worktree does follow that worktree.
   */
  private shipping<T>(fn: () => T): T {
    this.merging++;
    try {
      return fn();
    } finally {
      this.merging--;
    }
  }

  /**
   * Where a plan's work is now: merged into the plan's branch (Merged into Plan), or into main with the
   * plan (Done). `text` says how ("merged into plan/x", "merged into main via #12").
   */
  planMoved(ref: string, status: 'in_plan' | 'done', text: string): Issue {
    const issue = this.need(ref);
    if (issue.status === status || issue.status === 'canceled') return issue;
    const beluga: Actor = { kind: 'beluga' };
    return this.change(issue, { status, rank: this.lastRank(status) }, [this.entry(beluga, 'plan', text), this.entry(beluga, 'status', `moved this from ${STATUS_INFO[issue.status].label} to ${STATUS_INFO[status].label}`)]);
  }

  // ------------------------------------------------------------------ a plan moving between computers (BLG-806, see moved.ts)

  /** A repo's board here as its tasks' keys need it: its prefix and next number. */
  keysFor(projectId: string): { readonly prefix: string; readonly next: number } {
    const { prefix, next } = this.projectFor(projectId);
    return { prefix, next };
  }

  /**
   * Tasks whose plan moved here, made ready by prepareMoved: put on their repo's board (over the
   * record of an earlier move away, moving back), their proof files written, the board's next
   * number past every key they keep.
   */
  putMoved(issues: readonly Issue[], files: Readonly<Record<string, CarriedFile>>): void {
    const ids = new Set(issues.map((i) => i.id));
    for (const old of this.issues.filter((i) => ids.has(i.id) && i.movedTo)) this.remove(old.id);
    let projects = { ...this.projects };
    for (const i of issues) {
      const board = projects[i.projectId] ?? this.projectFor(i.projectId);
      projects = { ...projects, [i.projectId]: i.key.startsWith(`${board.prefix}-`) ? { ...board, next: Math.max(board.next, i.number + 1) } : board };
    }
    this.meta(projects);
    for (const i of issues) {
      const issue: Issue = { ...i, rank: this.lastRank(i.status), proof: landProof(i.proof, i.id, this.deps.dir, files) };
      this.issues = [...this.issues, issue];
      this.deps.store.dispatch({ type: 'board_issue', issue });
    }
    this.save();
  }

  /** Taken off again: a move that didn't finish (the plan stays where it was). */
  dropMoved(ids: readonly string[]): void {
    for (const id of ids) if (this.issues.some((i) => i.id === id)) this.remove(id);
  }

  /** Their plan moved to `to`: each goes to the Archive as the record of it (the task runs there now). */
  movedAway(ids: readonly string[], to: string, by: Actor): void {
    const home = this.deps.dir;
    for (const id of ids) {
      const issue = this.issues.find((i) => i.id === id);
      if (!issue || issue.movedTo) continue;
      const proof = home ? issue.proof.map((p) => letGoProofFile(p, home)) : issue.proof;
      this.change(issue, { movedTo: to, archivedAt: this.now(), proof }, [this.entry(by, 'plan', `moved with its plan to ${to}`)], false);
    }
  }

  // ------------------------------------------------------------------ team boards (core/team/board-sync.ts)

  /**
   * A teammate's task, new here: it keeps its id (the same on every Mac in the team) and gets a
   * key of this project's own. Its activity is what the team has of it; nothing is added here.
   */
  adoptTeam(input: Omit<Issue, 'key' | 'number' | 'rank' | 'revisions' | 'worktrees' | 'proof' | 'updatedAt'>): Issue {
    if (this.issues.some((i) => i.id === input.id)) return this.need(input.id);
    // On this repo's own board here (a teammate's boards are theirs).
    const { board: _theirs, ...task } = input as typeof input & { board?: string };
    const boardId = input.projectId;
    const project = this.projectFor(boardId);
    const number = project.next;
    const issue: Issue = { ...task, key: `${project.prefix}-${number}`, number, rank: this.lastRank(input.status), revisions: [], worktrees: [], proof: [], updatedAt: this.now(), ...(isOpen(input.status) ? {} : { closedAt: input.closedAt ?? this.now() }) };
    this.projects = { ...this.projects, [boardId]: { ...project, next: number + 1 } };
    this.issues = [...this.issues, issue];
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: this.autoTasks });
    this.deps.store.dispatch({ type: 'board_issue', issue, origin: 'team' });
    this.save();
    return issue;
  }

  /**
   * A teammate's change to a task, as the team settled it: the fields that won, activity entries to
   * add (and entries its author took back, a coalesced line), and who wrote the brief sections
   * (they're kept as revisions, so Restore This works on what came from a teammate too).
   */
  applyTeam(ref: string, patch: Partial<Pick<Issue, 'title' | 'status' | 'priority' | 'labels' | 'estimate' | 'due' | 'assignee' | 'parent' | 'blockedBy' | 'related' | 'github'>> & { readonly brief?: Partial<Record<BriefSection, string>> }, add: readonly Activity[], drop: readonly string[], by: Actor): Issue {
    const issue = this.need(ref);
    const { brief: briefPatch, ...fields } = patch;
    const next: Record<string, unknown> = { ...fields, ...(fields.assignee ? { assignee: personIn(fields.assignee) } : {}) };
    if (fields.status && fields.status !== issue.status) {
      next.rank = this.lastRank(fields.status);
      if (issue.needsChecks) next.needsChecks = undefined;
    }
    if (briefPatch) {
      const brief = { ...issue.brief } as Record<BriefSection, string>;
      const revisions = [...issue.revisions];
      for (const [section, text] of Object.entries(briefPatch) as Array<[BriefSection, string]>) {
        const before = issue.brief[section] ?? '';
        if (before === text) continue;
        revisions.push({ id: short('r'), at: this.now(), by, section, before, after: text, reason: 'from a teammate' });
        if (text) brief[section] = text;
        else delete brief[section];
      }
      next.brief = brief;
      next.revisions = keepRevisions(revisions);
    }
    const gone = new Set(drop);
    const kept = gone.size ? issue.activity.filter((a) => !gone.has(a.id)) : issue.activity;
    const known = new Set(kept.map((a) => a.id));
    const activity = [...kept, ...add.filter((a) => !known.has(a.id))].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    return this.change({ ...issue, activity: [] }, next as Partial<Issue>, activity, true, false, 'team');
  }

  // ------------------------------------------------------------------ settings

  setAutoTasks(on: boolean): void {
    this.autoTasks = on;
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: on });
    this.save();
  }

  /** Keys start with this from now on (tasks keep the keys they have). */
  setPrefix(projectId: string, prefix: string): void {
    const clean = this.freePrefix(prefix, projectId);
    const project = this.projectFor(projectId);
    this.projects = { ...this.projects, [projectId]: { ...project, prefix: clean } };
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: this.autoTasks });
    this.save();
  }

  /** A label added to a project's set (after the built-in ones): its name, icon and color. */
  createLabel(projectId: string, input: { readonly name: string; readonly icon: LabelIcon; readonly color: LabelColor; readonly hint?: string }): LabelDef {
    const name = cleanLabelName(input.name);
    if (!LABEL_NAME.test(name)) throw new Error('A label is one or two short words (letters, digits and dashes)');
    if (labelsFor(this.state(), projectId).some((l) => l.name === name)) throw new Error(`There’s a label called ${name} already`);
    const project = this.projectFor(projectId);
    const own = project.labels ?? [];
    if (own.length >= MAX_CUSTOM_LABELS) throw new Error(`A project has ${MAX_CUSTOM_LABELS} labels of its own at most: a few that mean something`);
    const hint = input.hint ? oneLine(input.hint, 80) : '';
    const label: LabelDef = { name, icon: input.icon, color: input.color, ...(hint ? { hint } : {}) };
    this.projects = { ...this.projects, [projectId]: { ...project, labels: [...own, label] } };
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: this.autoTasks });
    this.save();
    return label;
  }

  /** A project's own label out of its set (tasks that have it keep it, shown plainly, until someone removes it). */
  removeLabel(projectId: string, name: string): void {
    const project = this.projects[projectId];
    const own = project?.labels ?? [];
    if (!project || !own.some((l) => l.name === name)) throw new Error('Only a label the project added can be removed');
    this.projects = { ...this.projects, [projectId]: { ...project, labels: own.filter((l) => l.name !== name) } };
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: this.autoTasks });
    this.save();
  }

  /**
   * What the project is, for Claude writing its tasks (empty: none). Yours is newer than what's
   * here, always (a teammate's clock may run ahead). From a teammate (`from`), it's kept only if
   * it's newer than what's here (by time, then text); false when it wasn't kept or changed nothing.
   */
  setContext(projectId: string, text: string, by: string, from?: { readonly at: number }): boolean {
    const clean = text.replace(/\r\n/g, '\n').trim().slice(0, MAX_PROJECT_CONTEXT);
    const project = this.projectFor(projectId);
    const had = project.context;
    if ((had?.text ?? '') === clean && (!from || !had || had.at >= from.at)) return false;
    if (from && had && (had.at > from.at || (had.at === from.at && had.text >= clean))) return false;
    const at = from ? from.at : Math.max(Date.now(), (had?.at ?? 0) + 1);
    // Emptied, it stays (with no text) so an older copy from a teammate doesn't bring it back.
    this.projects = { ...this.projects, [projectId]: { ...project, context: { text: clean, by: oneLine(by, 80), at } } };
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: this.autoTasks });
    this.save();
    return true;
  }

  // ------------------------------------------------------------------ boards (many to many with repos)

  /** A board of its own covering a few repos → its id. */
  createBoard(input: NewBoard): string {
    const name = oneLine(input.name, MAX_BOARD_NAME);
    if (!name) throw new Error('A board needs a name');
    const repos = this.cleanRepos(input.repos);
    if (!repos.length) throw new Error('A board covers one repo at least');
    const prefix = input.prefix ? this.freePrefix(input.prefix) : prefixFor(name, this.takenPrefixes());
    const id = short('board');
    this.meta({ ...this.projects, [id]: { prefix, next: 1, name, repos } });
    return id;
  }

  /**
   * Rename a board (a repo's board: empty goes back to the repo's name) or change the repos it
   * covers. Tasks stay where they are: a repo taken off keeps the tasks running in it on the board.
   */
  editBoard(boardId: string, patch: { readonly name?: string; readonly repos?: readonly string[] }): void {
    const own = isOwnBoard(boardId);
    const board = this.projectFor(boardId);
    let next: BoardProject = board;
    if (patch.name !== undefined) {
      const name = oneLine(patch.name, MAX_BOARD_NAME);
      if (!name && own) throw new Error('A board needs a name');
      const { name: _old, ...rest } = next;
      next = name && name !== this.deps.projectName(boardId) ? { ...rest, name } : rest;
    }
    if (patch.repos) {
      const repos = this.cleanRepos(patch.repos).filter((r) => r !== boardId);
      if (own && !repos.length) throw new Error('A board covers one repo at least');
      const { repos: _old, ...rest } = next;
      next = repos.length ? { ...rest, repos } : rest;
    }
    if (next !== board) this.meta({ ...this.projects, [boardId]: next });
  }

  /**
   * A board of its own, gone: it's a view over a few repos, so its tasks (archived ones too) go home
   * to the board of the repo they run in, keys kept. A sub-task follows its top task, so families
   * stay on one board (that board covers the sub-task's repo from then on). Returns how many moved.
   */
  removeBoard(boardId: string, by: Actor): number {
    const gone = this.projects[boardId];
    if (!isOwnBoard(boardId) || !gone) throw new Error('Only a board you made can be removed');
    const on = this.issues.filter((i) => boardOf(i) === boardId);
    const byId = new Map(on.map((i) => [i.id, i]));
    const top = (issue: Issue): Issue => {
      let at = issue;
      for (let hops = 0; at.parent && byId.has(at.parent) && hops < on.length; hops++) at = byId.get(at.parent)!;
      return at;
    };
    const { [boardId]: _gone, ...rest } = this.projects;
    let projects: Record<string, BoardProject> = rest;
    const homes = on.map((issue) => {
      const home = top(issue).projectId;
      const known = projects[home] ?? (this.deps.projectName(home) !== undefined ? this.projectFor(home) : undefined);
      if (known) projects = { ...projects, [home]: this.covering(known, home, issue.projectId) };
      return { issue, home };
    });
    this.meta(projects);
    const at = this.now();
    for (const { issue, home } of homes) {
      const name = this.deps.projectName(home) ?? 'its repo';
      this.change(issue, { board: home === issue.projectId ? undefined : home }, [this.entry(by, 'project', `moved this to ${name}’s board (${gone.name ?? 'its board'} was deleted)`, undefined, at)], false);
    }
    return on.length;
  }

  /** Write anything waiting now (on the way out). */
  flush(): void {
    // A board.json it couldn't read nor move aside is never written over.
    if (this.readOnly) return;
    try {
      this.file?.flush();
    } catch {
      // A full disk or a permission problem: the next change tries again.
    }
  }

  // ------------------------------------------------------------------ inside

  /** A board's settings (a repo's board is made on first use, its prefix from the repo's name). */
  private projectFor(boardId: string): BoardProject {
    const known = this.projects[boardId];
    if (known) return known;
    const name = isOwnBoard(boardId) ? undefined : this.deps.projectName(boardId);
    if (!name) throw new Error(isOwnBoard(boardId) ? 'That board isn’t here' : 'That project isn’t here');
    return { prefix: prefixFor(name, this.takenPrefixes()), next: 1 };
  }

  /** A repo tasks can run in: one that's here (or that has a board here already). */
  private needRepo(projectId: string): void {
    if (isOwnBoard(projectId) || (!this.projects[projectId] && !this.deps.projectName(projectId))) throw new Error('That project isn’t here');
  }

  /** A board's settings, covering a repo too (a task runs in it now). */
  private covering(board: BoardProject, boardId: string, projectId: string): BoardProject {
    if (reposOf({ projects: { [boardId]: board } }, boardId).includes(projectId) || (board.repos?.length ?? 0) >= MAX_REPOS) return board;
    return { ...board, repos: [...(board.repos ?? []), projectId] };
  }

  /** Repos as a board keeps them: ones that are here, once each. */
  private cleanRepos(repos: readonly string[]): string[] {
    return [...new Set(repos)].filter((r) => !isOwnBoard(r) && (this.deps.projectName(r) !== undefined || this.projects[r] !== undefined)).slice(0, MAX_REPOS);
  }

  /** Prefixes in use: every board's, and every key's (old keys keep theirs). */
  private takenPrefixes(): Set<string> {
    return new Set([...Object.values(this.projects).map((p) => p.prefix), ...this.issues.map((i) => i.key.replace(/-\d+$/, ''))]);
  }

  /** A prefix as keys write it, free for this board: no other board has it, and no other board's tasks still use it. */
  private freePrefix(prefix: string, boardId?: string): string {
    const clean = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (clean.length < 2) throw new Error('A prefix is 2 to 6 letters or digits');
    if (Object.entries(this.projects).some(([id, p]) => id !== boardId && p.prefix === clean) || this.issues.some((i) => boardOf(i) !== boardId && i.key.startsWith(`${clean}-`))) throw new Error(`Another board's keys already start with ${clean}`);
    return clean;
  }

  /** Boards changed: every screen hears, and it's saved. */
  private meta(projects: Record<string, BoardProject>): void {
    this.projects = projects;
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: this.autoTasks });
    this.save();
  }

  /**
   * The labels a change may set: Claude (and a plan Claude wrote) only picks from the project's
   * set, keeping any the task had already; people pick from the set on screen, and sync brings
   * the tracker's own.
   */
  private allowedLabels(projectId: string, wanted: readonly string[], had: readonly string[], by: Actor, origin?: Issue['origin']): string[] {
    const labels = cleanLabels(wanted);
    if (by.kind !== 'claude' && origin !== 'plan' && origin !== 'claude') return labels;
    const set = new Set([...labelsFor(this.state(), projectId).map((l) => l.name), ...had]);
    return labels.filter((l) => set.has(l));
  }

  private entry(by: Actor, kind: ActivityKind, text: string, body?: string, at = this.now(), assignee?: Assignee | null, change?: { readonly was: string; readonly now: string }): Activity {
    return { id: short('a'), at, by, kind, text, ...(body ? { body } : {}), ...(assignee !== undefined ? { assignee } : {}), ...(change ?? {}) };
  }

  /** Replace a task with changes and activity (`replaceLast`: instead of its last line), tell every screen, and save. */
  private change(issue: Issue, patch: Partial<{ -readonly [K in keyof Issue]: Issue[K] }>, activity: readonly Activity[], touch = true, replaceLast = false, origin?: 'team'): Issue {
    const at = this.now();
    const merged: Record<string, unknown> = { ...issue, ...patch };
    // undefined in a patch removes the field (no "key": undefined in the file).
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k];
    const status = (patch.status ?? issue.status) as IssueStatus;
    if (patch.status) {
      if (isOpen(status)) delete merged.closedAt;
      else merged.closedAt = at;
    }
    if (patch.title !== undefined && issue.autoTitle && !('autoTitle' in patch)) delete merged.autoTitle;
    const next = { ...(merged as unknown as Issue), activity: [...(replaceLast ? issue.activity.slice(0, -1) : issue.activity), ...activity].slice(-KEEP_ACTIVITY), updatedAt: touch ? at : issue.updatedAt };
    this.issues = this.issues.map((i) => (i.id === issue.id ? next : i));
    this.deps.store.dispatch({ type: 'board_issue', issue: next, ...(origin ? { origin } : {}) });
    this.save();
    if (status === 'done' && issue.status !== 'done') this.doneWithParent(next);
    // Its parent follows its sub-tasks: this one moved, or moved to another parent.
    const moved = status !== issue.status;
    if (issue.parent && (moved || next.parent !== issue.parent)) this.rollUp(issue.parent);
    if (next.parent && next.parent !== issue.parent) this.rollUp(next.parent);
    return next;
  }

  /** A task's sub-tasks moved: it goes where they've got to (see rollUpTo), and its own parent with it, in turn. */
  private rollUp(id: string): void {
    if (this.cascading) return;
    const parent = this.issues.find((i) => i.id === id);
    // A plan's pilot moves its tasks; a canceled task stays put. A plan's own epics (made by it, no
    // task of it) follow their tasks all the way, Merged into Plan included.
    const planEpic = parent?.origin === 'plan' && !parent.plan;
    if (!parent || parent.plan || parent.status === 'canceled' || (parent.status === 'in_plan' && !planEpic)) return;
    const step = rollUpTo(parent, this.issues.filter((i) => i.parent === id && i.status !== 'canceled'));
    if (!step) return;
    // Its own work shipped (a merge made it Done): sub-tasks still open are later work, they don't reopen it.
    if (parent.status === 'done' && step.to !== 'done' && (this.merging || parent.pr?.state === 'MERGED')) return;
    this.change(parent, { status: step.to, rank: this.lastRank(step.to), needsChecks: undefined, mergedHeld: undefined, ...(step.to === 'done' ? { worktreeGone: undefined } : {}) }, [
      this.entry({ kind: 'beluga' }, 'status', `${step.why}: ${statusText(STATUS_INFO[parent.status].label, STATUS_INFO[step.to].label)}`),
    ]);
  }

  /**
   * A task reached Done: its sub-tasks still open go with it (theirs with them, in turn). By a merge,
   * only the ones under way with no worktree of their own: one filed for later stays, and one a
   * worktree does or carries follows that worktree.
   */
  private doneWithParent(parent: Issue): void {
    const beluga: Actor = { kind: 'beluga' };
    const goes = (kid: Issue): boolean => !this.merging || ((kid.status === 'in_progress' || kid.status === 'in_review') && !kid.worktrees.length && !kid.carriedBy);
    this.cascading++;
    try {
      for (const kid of this.issues.filter((i) => i.parent === parent.id && isOpen(i.status) && goes(i))) {
        // Shipped by its parent's merge with a criterion open: held In Review like its own merge (see landed).
        const held = this.merging > 0 && unexplained(kid.brief.acceptance).length > 0 ? this.landed(kid) : undefined;
        if (held) this.change(kid, { ...held.patch, worktreeGone: undefined }, held.notes);
        else this.change(kid, { status: 'done', rank: this.lastRank('done'), needsChecks: undefined, mergedHeld: undefined, worktreeGone: undefined }, [this.entry(beluga, 'status', `done with its parent ${parent.key}: ${statusText(STATUS_INFO[kid.status].label, STATUS_INFO.done.label)}`)]);
      }
    } finally {
      this.cascading--;
    }
  }

  /** A rank after every task in a status (across projects: the board's columns mix them). */
  private lastRank(status: IssueStatus): number {
    const ranks = this.issues.filter((i) => i.status === status).map((i) => i.rank);
    return rankBetween(ranks.length ? Math.max(...ranks) : undefined, undefined);
  }

  /** Every task in a status spread out again, 1000 apart, keeping their order. */
  private respace(status: IssueStatus, skip: string): void {
    const column = this.issues.filter((i) => i.status === status && i.id !== skip).sort(byRank);
    column.forEach((issue, n) => this.change(issue, { rank: (n + 1) * 1000 }, [], false));
  }

  /** Whether `id` waits (directly or through others) on `target`. */
  private waitsOn(id: string, target: string, seen = new Set<string>()): boolean {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const issue = this.issues.find((i) => i.id === id);
    return Boolean(issue?.blockedBy.some((b) => this.waitsOn(b, target, seen)));
  }

  /** Whether `ancestor` is above `id` in the sub-task tree. */
  private isAncestor(ancestor: string, id: string): boolean {
    let at = this.issues.find((i) => i.id === id)?.parent;
    for (let hops = 0; at && hops <= this.issues.length; hops++) {
      if (at === ancestor) return true;
      at = this.issues.find((i) => i.id === at)?.parent;
    }
    return false;
  }

  private load(): void {
    if (!this.deps.dir || !this.file) return;
    const file = path.join(this.deps.dir, 'board.json');
    const saved = this.file.read();
    if (!saved) return;
    // Renamed only when it has old names: walking all of a big board for nothing took ~50 ms on every start (BLG-942).
    const raw = saved.oldNames ? renamedActors(saved.raw) : saved.raw;
    const parsed = BoardShape.safeParse(raw);
    if (!parsed.success) {
      // Never written over: kept aside (a newer Beluga's board, or a damaged file), and this one starts fresh.
      this.setAside(file, 'unreadable');
      return;
    }
    this.autoTasks = parsed.data.worktreeTasks;
    this.projects = parsed.data.projects;
    const dropped: unknown[] = [];
    this.issues = parsed.data.issues.flatMap((item) => {
      const r = SavedIssue.safeParse(item);
      if (!r.success) dropped.push(item);
      if (!r.success) return [];
      // A draft cut short by a restart: the first line stays the title.
      const { drafting: _, ...issue } = r.data as unknown as Issue;
      return [(issue.assignee ? { ...issue, assignee: personOf(issue.assignee as AnyAssignee) } : issue) as Issue];
    });
    // Tasks that don't read any more are kept beside it, not lost.
    if (dropped.length) {
      try {
        writeJson(path.join(this.deps.dir, `board.dropped-${this.now()}.json`), dropped);
      } catch {
        // Nowhere to keep them: the board goes on without them.
      }
    }
  }

  private setAside(file: string, why: string): void {
    try {
      const suffix = `${why}-${this.now()}`;
      if (existsSync(file)) renameSync(file, `${file}.${suffix}`);
      // Its journal goes with it: it can't be read without it.
      this.file?.setAside(suffix);
    } catch {
      // Can't move it: don't write over it either.
      this.readOnly = true;
    }
  }

  private save(): void {
    if (!this.readOnly) this.file?.changed();
  }
}

/** The last KEEP_REVISIONS versions of each section (a busy section doesn't push out another's history). */
function keepRevisions(revisions: readonly BriefRevision[]): BriefRevision[] {
  const seen = new Map<string, number>();
  const kept: BriefRevision[] = [];
  for (let i = revisions.length - 1; i >= 0; i--) {
    const r = revisions[i]!;
    const n = seen.get(r.section) ?? 0;
    if (n >= KEEP_REVISIONS) continue;
    seen.set(r.section, n + 1);
    kept.push(r);
  }
  return kept.reverse();
}

/** The worktree whose pull request and merge move this task: the one doing it now, or one carrying it. */
const followsWorktree = (issue: Issue, workspaceId: string): boolean => issue.worktrees.at(-1) === workspaceId || issue.carriedBy === workspaceId;
/** Whether merging this worktree's work finishes the task: the one doing it, or one it carries that's still under way there. */
const shipsWith = (issue: Issue, workspaceId: string): boolean => issue.worktrees.at(-1) === workspaceId || (issue.carriedBy === workspaceId && (issue.status === 'in_progress' || issue.status === 'in_review'));

function sameAssignee(a: Assignee | undefined, b: Assignee | undefined): boolean {
  return !a || !b ? a === b : a.id === b.id;
}
