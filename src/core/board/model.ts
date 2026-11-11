/**
 * Tasks (the board) in the shared state: issues per project, with a status, a priority, who it's
 * for, sub-tasks and blockers, the worktree and pull request doing it, a living brief Claude and
 * people keep true (with its revisions), proof and an activity feed. The code says "board" and
 * "issue" (the gateway's "tasks" are tasks between Claudes); the window says Tasks.
 * Browser-safe: the Mac app runs it. See docs/tasks-and-plans.md.
 */

import type { AgentRef } from '../../protocol.js';
import type { LabelDef } from './labels.js';
import { agentLabel } from '../../shared/agent-label.js';

export const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'in_plan', 'done', 'canceled'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export type StatusTone = 'muted' | 'neutral' | 'claude' | 'info' | 'ok' | 'error';

export const STATUS_INFO: Readonly<Record<IssueStatus, { readonly label: string; readonly tone: StatusTone; readonly open: boolean }>> = {
  backlog: { label: 'Backlog', tone: 'muted', open: true },
  todo: { label: 'Ready', tone: 'neutral', open: true },
  in_progress: { label: 'In Progress', tone: 'claude', open: true },
  in_review: { label: 'In Review', tone: 'info', open: true },
  /** A plan's task whose milestone passed: merged into the plan's branch, waiting for the plan's PR. */
  in_plan: { label: 'Merged into Plan', tone: 'info', open: true },
  done: { label: 'Done', tone: 'ok', open: false },
  canceled: { label: 'Canceled', tone: 'muted', open: false },
};

export const isOpen = (status: IssueStatus): boolean => STATUS_INFO[status].open;

/** In the Archive: off the board and out of Claude's lists, until it's restored or deleted. */
export const isArchived = (issue: Pick<Issue, 'archivedAt'>): boolean => issue.archivedAt !== undefined;

/** Its work is finished (in review, merged into its plan, or shipped): nothing to start until it's reopened. */
export const isFinished = (status: IssueStatus): boolean => status === 'in_review' || status === 'in_plan' || status === 'done';

/** Linear's order: urgent first; "none" sorts last. */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_INFO: Readonly<Record<Priority, { readonly label: string; readonly rank: number }>> = {
  urgent: { label: 'Urgent', rank: 0 },
  high: { label: 'High', rank: 1 },
  medium: { label: 'Medium', rank: 2 },
  low: { label: 'Low', rank: 3 },
  none: { label: 'No priority', rank: 4 },
};

/** The brief's sections, in order: what later agents (and people) rely on. */
export const BRIEF_SECTIONS = ['goal', 'context', 'acceptance', 'decisions', 'questions', 'handoff'] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

export const SECTION_INFO: Readonly<Record<BriefSection, { readonly label: string; readonly hint: string }>> = {
  goal: { label: 'Goal', hint: 'What this task is for, in a sentence or two' },
  context: { label: 'Context', hint: 'What someone new needs to know: where the code is, how it works today' },
  acceptance: { label: 'Acceptance criteria', hint: 'A checklist: done means all of these are true' },
  decisions: { label: 'Decisions', hint: 'What was decided and why, newest last' },
  questions: { label: 'Open questions', hint: 'What is still unclear' },
  handoff: { label: 'Notes for the next agent', hint: 'Where things stand, and what to do next' },
};

export const ESTIMATES = [1, 2, 3, 5, 8] as const;

/**
 * Who did something: a person (you or a friend, by peer id), someone's Claude, or Beluga itself
 * (a worktree opened, a pull request merged). Peer ids, not "you": boards are shared later.
 */
export type Actor =
  | { readonly kind: 'person'; readonly id: string; readonly name: string }
  | {
      readonly kind: 'claude';
      readonly owner: string;
      readonly ownerName: string;
      /** Which agent it was (BLG-498: Codex, a local model…); left out on older entries: Claude, as before. */
      readonly agent?: AgentRef;
      /** An external agent did it, through its grant. It stays kind `claude`, so every rule that holds an agent back applies to it. */
      readonly external?: ExternalActor;
      /** Working for a friend who asked it (BLG-701): "Kayra's Claude, for Bran". */
      readonly for?: { readonly id: string; readonly name: string };
    }
  | { readonly kind: 'beluga' };

/** An external agent as the board and plans record it: its grant and its name. */
export interface ExternalActor {
  readonly id: string;
  readonly name: string;
}

/**
 * Saved boards and plans from before the rename say `{ kind: 'klaud' }` for Beluga itself: read them as
 * `{ kind: 'beluga' }`, wherever they sit (activity, proof, revisions…). Only an object that is exactly
 * that one key counts, so other `kind` fields are never touched. Returns a copy; the input stays as is.
 */
export function renamedActors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renamedActors);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  if (entries.length === 1 && entries[0]![0] === 'kind' && entries[0]![1] === 'klaud') return { kind: 'beluga' };
  return Object.fromEntries(entries.map(([k, v]) => [k, renamedActors(v)]));
}

/** Who a task is for: a person, never a Claude (BLG-278). Who works on it right now shows on its own. */
export type Assignee = { readonly kind: 'person'; readonly id: string; readonly name: string };

/** How older boards, older teammates and the activity history may still say it: someone's Claude. */
export type AnyAssignee = Assignee | { readonly kind: 'claude'; readonly owner: string; readonly ownerName: string };

/** A task given to someone's Claude (before BLG-278) is that person's. */
export const personOf = (a: AnyAssignee): Assignee => (a.kind === 'person' ? a : { kind: 'person', id: a.owner, name: a.ownerName });

export interface BriefRevision {
  readonly id: string;
  readonly at: number;
  readonly by: Actor;
  readonly section: BriefSection;
  readonly before: string;
  readonly after: string;
  /** Why (Claude says, people may). */
  readonly reason?: string;
}

export type ActivityKind = 'created' | 'title' | 'status' | 'priority' | 'assignee' | 'labels' | 'estimate' | 'due' | 'parent' | 'relation' | 'brief' | 'comment' | 'note' | 'worktree' | 'pr' | 'proof' | 'project' | 'plan' | 'link' | 'private';

export interface Activity {
  readonly id: string;
  readonly at: number;
  readonly by: Actor;
  readonly kind: ActivityKind;
  /** In words ("moved this to In Review", "opened PR #42"); a comment's or note's text is `body`. */
  readonly text: string;
  readonly body?: string;
  /** Who it was assigned to (screens say "you" from where they look; older entries may name a Claude). */
  readonly assignee?: AnyAssignee | null;
  /**
   * What the field was before this run of changes (quick changes to one field by one person
   * become one line: clicking through estimates leaves "estimated this at 5 points", once).
   */
  readonly was?: string;
  /** What it is now (in the same words as `was`). */
  readonly now?: string;
}

/** Something that shows the work: a screenshot, a page, a file, a graph, a result. */
export interface Proof {
  readonly id: string;
  readonly kind: 'image' | 'url' | 'file' | 'graph' | 'text';
  readonly title: string;
  /** A file on this Mac (image, file): Beluga's own copy of it, kept in ~/.beluga/proof (see proof-files.ts). */
  readonly path?: string;
  /** Where the file was attached from (a worktree's scratch folder, say), when `path` is the kept copy. */
  readonly from?: string;
  /** Its file is nowhere any more (deleted with its worktree before it could be kept): screens say so. */
  readonly gone?: boolean;
  /** Its task was archived: the full file was let go, and `path` is a small JPEG of it (images) or gone (files). */
  readonly thumb?: boolean;
  /** How big its file was, when it was let go on archiving. */
  readonly bytes?: number;
  readonly url?: string;
  /** An beluga-graph's JSON, or text. */
  readonly body?: string;
  /**
   * A file someone added for the work to use (dropped on the task, say): not proof that it works.
   * Listed under Files on its page and given to the Claude doing the task; kept like proof.
   */
  readonly context?: boolean;
  readonly at: number;
  readonly by: Actor;
}

/** A proof's file carried to another computer with its plan (BLG-806): its name and its bytes, base64. */
export interface CarriedFile {
  readonly name: string;
  readonly data: string;
}

/** A task's files (added for the work to use) and its proof (that shows the work), apart. */
export const taskFiles = (issue: Pick<Issue, 'proof'>): readonly Proof[] => issue.proof.filter((p) => p.context);
export const taskProof = (issue: Pick<Issue, 'proof'>): readonly Proof[] => issue.proof.filter((p) => !p.context);

/** The pull request a task's worktree opened (as the workbench last saw it). */
export interface IssuePr {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly title: string;
  readonly draft: boolean;
  readonly checks: 'passing' | 'failing' | 'pending' | 'none';
  readonly review?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
}

export interface Issue {
  readonly id: string;
  /** "BOB-12": its board's prefix and the task's number on it. */
  readonly key: string;
  readonly number: number;
  /** The repo (project) it runs in: Start makes its worktree there. */
  readonly projectId: string;
  /**
   * The board it's on, when that isn't its repo's own board (a board covering several repos, see
   * BoardProject.repos). Left out: its repo's board, as every task was before boards and repos split.
   */
  readonly board?: string;
  readonly title: string;
  /** The title came from a worktree's name and follows it until someone renames the task. */
  readonly autoTitle?: boolean;
  /** Made from a description: Claude is writing its title and goal (the first line stands in meanwhile). */
  readonly drafting?: boolean;
  readonly status: IssueStatus;
  readonly priority: Priority;
  readonly labels: readonly string[];
  readonly estimate?: number;
  /** YYYY-MM-DD. */
  readonly due?: string;
  readonly assignee?: Assignee;
  /** A sub-task's parent (its id). */
  readonly parent?: string;
  /** Tasks that must be done before this one can be (ids). "Blocks" is the other side of it. */
  readonly blockedBy: readonly string[];
  readonly related: readonly string[];
  /** Order inside a status (the board's columns, the list's groups): smaller first. */
  readonly rank: number;
  readonly brief: Readonly<Partial<Record<BriefSection, string>>>;
  readonly revisions: readonly BriefRevision[];
  /** Worktrees doing it (workspace ids), the current one last. */
  readonly worktrees: readonly string[];
  /**
   * Another worktree carries its work (Claude moved it along there, while doing a bigger task or a
   * list of asks): that worktree's pull request merging, or the worktree merging into main, makes it Done.
   */
  readonly carriedBy?: string;
  readonly branch?: string;
  readonly pr?: IssuePr;
  /** Its worktree went away (archived or deleted) before it was done: screens ask what's next. */
  readonly worktreeGone?: boolean;
  /** It was kept out of review: an acceptance criterion is neither ticked nor explained (see criteria.ts). */
  readonly needsChecks?: boolean;
  readonly proof: readonly Proof[];
  readonly activity: readonly Activity[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly createdBy: Actor;
  /** When it reached Done or Canceled. */
  readonly closedAt?: number;
  /** When it went to the Archive (off the board, its words kept, its proof files let go). */
  readonly archivedAt?: number;
  /** How it started: by hand, a worktree opening, Claude, an approved plan, brought over from another tracker (Linear), or made from a GitHub issue. */
  readonly origin: 'manual' | 'worktree' | 'claude' | 'plan' | 'sync' | 'github';
  /** The plan it's part of: the plan, its milestone and its task there (ids). */
  readonly plan?: IssuePlan;
  /** The same task in another tracker (Linear), kept in step by sync (core/board/sync). */
  readonly link?: IssueLink;
  /** The GitHub issue it's for (made from it in Issues): its pull request says "Fixes #n", so merging closes the issue. */
  readonly github?: IssueGitHub;
  /** The agent (and model) that works it when it starts (BLG-497): its worktree's own. None: your default agent. */
  readonly agent?: AgentRef;
  /**
   * Only you see it (BLG-501): it stays on this Mac, never reaching teammates on a team board or
   * another tracker (Linear), until Share with Team. A private task's sub-tasks are private too.
   */
  readonly private?: true;
  /** Keys it had on another computer before its plan moved here (BLG-806): they still open it. */
  readonly aliases?: readonly string[];
  /** Its plan moved to another computer (that computer's name): this is the record of it, in the Archive. */
  readonly movedTo?: string;
}

/**
 * Words asking for a task to stay yours ("just for me", "keep it private", "don't share"): New
 * Task makes it private from the start, before anything could reach the team (BLG-501).
 */
export const asksPrivate = (text: string): boolean => PRIVATE_ASK.test(text);
const PRIVATE_ASK = /(^\s*private\b|\bprivate (task|todo|to-do|note|one|board)s?\b|\b(make|keep|leave) (it|this|them|these)( tasks?)? (private|to myself|off the team)\b|\b(just|only) (for )?me\b|\bfor my eyes only\b|\bdon[’']?t share\b|\bnot for the team\b|\b(is|as|stays?) private\b)/i;

/** What Claude was last asked to do about a task's GitHub issue: find out why it happens (Investigate), or fix it. */
export type GitHubStep = 'investigate' | 'fix';

/** The GitHub issue a task is for (see core/issues). */
export interface IssueGitHub {
  /** "owner/repo". */
  readonly repo: string;
  /** Its host, when it isn't github.com (GitHub Enterprise). */
  readonly host?: string;
  readonly number: number;
  readonly url: string;
  readonly step?: GitHubStep;
  /** Claude was asked to investigate it (once is enough): what it found is worth showing, and posting. */
  readonly investigated?: boolean;
}

/** "#12", or "acme/api#12" when it's another repository's. */
export const githubRef = (gh: Pick<IssueGitHub, 'repo' | 'number'>, repo?: string): string => (repo && repo.toLowerCase() === gh.repo.toLowerCase() ? `#${gh.number}` : `${gh.repo}#${gh.number}`);

/** The task made from a GitHub issue (the newest one still on the board), if there is one. */
export function taskForGitHub(board: Pick<BoardState, 'issues'>, projectId: string, repo: string, number: number): Issue | undefined {
  const r = repo.toLowerCase();
  return board.issues.filter((i) => i.projectId === projectId && i.github?.number === number && i.github.repo.toLowerCase() === r && !isArchived(i)).sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** Trackers a project's board can sync with. */
export const SYNC_PROVIDERS = ['linear'] as const;
export type SyncProvider = (typeof SYNC_PROVIDERS)[number];

export const PROVIDER_INFO: Readonly<Record<SyncProvider, { readonly label: string }>> = {
  linear: { label: 'Linear' },
};

/** The fields sync keeps in step, each as a short fingerprint (see sync/fields.ts). */
export type SyncedPrints = Readonly<Record<string, string>>;

/** Where a task lives in another tracker, and what both sides looked like when they last agreed. */
export interface IssueLink {
  readonly provider: SyncProvider;
  /** The tracker's own id. */
  readonly id: string;
  /** What people call it there ("ENG-12"). */
  readonly key: string;
  readonly url: string;
  /** This side's fields at the last sync: a field that differs now was changed here. */
  readonly local: SyncedPrints;
  /** The tracker's fields at the last sync: one that differs there was changed there. */
  readonly remote: SyncedPrints;
}

/** A project's sync with another tracker, as screens see it (never its key). */
export interface ProjectSync {
  readonly provider: SyncProvider;
  /** The tracker's workspace and team ("Acme", "Engineering", "ENG"). */
  readonly workspace?: string;
  readonly team: string;
  readonly teamKey: string;
  /** Syncs by itself: every minute or so, and shortly after a change here. */
  readonly auto: boolean;
  readonly syncing?: boolean;
  readonly syncedAt?: number;
  /** Tasks linked to the tracker. */
  readonly linked: number;
  readonly error?: { readonly code: SyncErrorCode; readonly message: string; readonly at: number };
}

export type SyncErrorCode = 'auth' | 'offline' | 'rate_limited' | 'remote' | 'unknown';

export interface IssuePlan {
  readonly id: string;
  readonly milestone: string;
  readonly task: string;
}

/**
 * A board's settings. Every repo has a board of its own (keyed by the repo's project id); a board
 * can cover other repos too, and boards of their own (keyed `board_…`) cover only the repos they
 * name. Boards and repos are many to many: a task is on one board and runs in one repo.
 */
export interface BoardProject {
  /** "BOB": what keys start with. */
  readonly prefix: string;
  /** The next task's number. */
  readonly next: number;
  /** Labels people added to this project's set, after the built-in ones (see labels.ts). */
  readonly labels?: readonly LabelDef[];
  /** What the project is, for Claude writing its tasks (BLG-298): shared with its teammates. */
  readonly context?: ProjectContext;
  /** What it's called, when not its repo's name (a board of its own always has one). */
  readonly name?: string;
  /** The repos it covers (project ids): a repo's own board covers its repo first, then these. */
  readonly repos?: readonly string[];
}

/** A board of its own (made in Tasks, covering the repos it names), not one repo's. */
export const isOwnBoard = (boardId: string): boolean => boardId.startsWith('board_');

/** The board a task is on. */
export const boardOf = (issue: Pick<Issue, 'board' | 'projectId'>): string => issue.board ?? issue.projectId;

/** The repos a board covers (project ids), its own repo first. */
export function reposOf(board: Pick<BoardState, 'projects'>, boardId: string): readonly string[] {
  const more = board.projects[boardId]?.repos ?? [];
  return isOwnBoard(boardId) ? more : [boardId, ...more.filter((r) => r !== boardId)];
}

/**
 * Whether a board shows a task: every board shows the tasks on it, and a repo's own board also shows
 * every task that runs in its repo from another board (a shade back, saying which board it's on), so
 * nothing that runs in a repo goes missing from the repo's board.
 */
export const showsOn = (issue: Pick<Issue, 'board' | 'projectId'>, boardId: string): boolean => boardOf(issue) === boardId || (!isOwnBoard(boardId) && issue.projectId === boardId);

/** A task a board shows that's on another board (its repo's own board showing it, see `showsOn`). */
export const isVisiting = (issue: Pick<Issue, 'board' | 'projectId'>, boardId: string): boolean => boardOf(issue) !== boardId && showsOn(issue, boardId);

/** A board's name: its own, else its repo's (`repoName` finds a repo's name). */
export function boardName(board: Pick<BoardState, 'projects'>, boardId: string, repoName: (projectId: string) => string | undefined): string {
  return board.projects[boardId]?.name ?? repoName(boardId) ?? 'Board';
}

/**
 * A few paragraphs about a project: what the app is, who it's for, how the code is laid out, its
 * words. Claude reads it whenever it writes a task there, so a task makes sense without a look at
 * the whole codebase. The newest edit wins, here and on teammates' Macs.
 */
export interface ProjectContext {
  readonly text: string;
  /** Who wrote it last (their name), and when. */
  readonly by: string;
  readonly at: number;
}

/** How long a project's context may be: enough to say what it is, short enough to go in every prompt. */
export const MAX_PROJECT_CONTEXT = 6000;

export interface BoardState {
  /** The board runs (the Mac app's daemon); off elsewhere. */
  readonly enabled: boolean;
  readonly issues: readonly Issue[];
  readonly projects: Readonly<Record<string, BoardProject>>;
  /** Open a task for every new worktree (off by default: tasks come from plans). */
  readonly autoTasks: boolean;
  /** Projects synced with another tracker (by project id). */
  readonly sync?: Readonly<Record<string, ProjectSync>>;
}

export interface BoardSlice {
  readonly board: BoardState;
}

export const KEEP_ACTIVITY = 200;
/** Versions kept per brief section. */
export const KEEP_REVISIONS = 20;
export const KEEP_PROOF = 40;
/** Changes to one field by one person this close together are one change in the activity. */
export const COALESCE_MS = 2 * 60 * 1000;

export const NO_BOARD: BoardState = { enabled: false, issues: [], projects: {}, autoTasks: false };
export const initialBoard: BoardSlice = { board: NO_BOARD };

export type BoardAction =
  /** Everything at once (on start). */
  | { type: 'board_init'; state: BoardState }
  /** One task changed (same id: replaced) or was added; `origin: 'team'`: a teammate's, through the team's board. */
  | { type: 'board_issue'; issue: Issue; origin?: 'team' }
  | { type: 'board_remove'; id: string }
  | { type: 'board_meta'; projects: Readonly<Record<string, BoardProject>>; autoTasks: boolean }
  /** A project's sync changed (no `sync`: disconnected). */
  | { type: 'board_sync'; projectId: string; sync?: ProjectSync }
  | { type: 'board_off' };

export const BOARD_ACTIONS: ReadonlySet<string> = new Set(['board_init', 'board_issue', 'board_remove', 'board_meta', 'board_sync', 'board_off']);

export function reduceBoard(state: BoardSlice, action: BoardAction): BoardSlice {
  switch (action.type) {
    case 'board_init':
      return { board: { ...action.state, ...(state.board.sync ? { sync: state.board.sync } : {}) } };
    case 'board_sync': {
      const { [action.projectId]: _old, ...rest } = state.board.sync ?? {};
      return { board: { ...state.board, sync: action.sync ? { ...rest, [action.projectId]: action.sync } : rest } };
    }
    case 'board_issue': {
      const list = state.board.issues;
      const at = list.findIndex((i) => i.id === action.issue.id);
      return { board: { ...state.board, issues: at >= 0 ? list.map((i, n) => (n === at ? action.issue : i)) : [...list, action.issue] } };
    }
    case 'board_remove':
      return { board: { ...state.board, issues: state.board.issues.filter((i) => i.id !== action.id) } };
    case 'board_meta':
      return { board: { ...state.board, projects: action.projects, autoTasks: action.autoTasks } };
    case 'board_off':
      return { board: NO_BOARD };
    default:
      return state;
  }
}

// ---- for screens and Claude

/**
 * A project's key prefix from its name: a short first word of two ("bob-api" → "BOB"), else the
 * words' initials ("my-cool-app" → "MCA"), else one word's first letter and consonants ("landing" →
 * "LND"). Taken prefixes get a number ("BOB2").
 */
export function prefixFor(name: string, taken: ReadonlySet<string> = new Set()): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
  const [first = 'T'] = words;
  const consonants = (w: string): string => w[0] + w.slice(1).replace(/[AEIOU]/g, '');
  const base = words.length === 2 && first.length <= 4 ? first : words.length > 1 ? words.map((w) => w[0]).join('') : consonants(first);
  const short = base.slice(0, words.length > 1 ? 4 : 3).padEnd(2, 'X');
  if (!taken.has(short)) return short;
  for (let n = 2; n < 100; n++) if (!taken.has(`${short}${n}`)) return `${short}${n}`;
  return `${short}${taken.size}`;
}

/** A worktree's name as a task's title: "add-rate-limiting" → "Add rate limiting". */
export function titleFromName(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Untitled task';
}

export const issueById = (board: BoardState, id: string): Issue | undefined => board.issues.find((i) => i.id === id);

/** A task by its key ("BOB-12", any case) or its id; else a key it had on another computer (its plan moved here). */
export function findIssue(board: BoardState, ref: string): Issue | undefined {
  const k = ref.trim().toUpperCase();
  return board.issues.find((i) => i.key === k) ?? board.issues.find((i) => i.id === ref.trim()) ?? board.issues.find((i) => i.aliases?.includes(k) && !i.movedTo);
}

/** The task a workspace (worktree) is doing, if any. */
export const issueForWorkspace = (board: BoardState, workspaceId: string): Issue | undefined => board.issues.find((i) => i.worktrees.includes(workspaceId));

/**
 * The worktree doing a task right now: its own (the last one, unless it went away), else one that
 * carries its work (BLG-29). `live`: whether a workspace is still here and not archived.
 */
export function worktreeDoing(issue: Pick<Issue, 'worktrees' | 'worktreeGone' | 'carriedBy'>, live: (workspaceId: string) => boolean): string | undefined {
  const own = issue.worktrees.at(-1);
  if (own && !issue.worktreeGone && live(own)) return own;
  return issue.carriedBy && live(issue.carriedBy) ? issue.carriedBy : undefined;
}

/** Whether Start can start it: not finished (in review, merged into its plan, done) or canceled, and not in the Archive. */
export const isStartable = (issue: Pick<Issue, 'status' | 'archivedAt'>): boolean => isOpen(issue.status) && !isFinished(issue.status) && !isArchived(issue);

/** Where a task's work is: the worktree carrying it (Claude moved it along from there), else its own last one. */
export const worktreeOf = (issue: Issue): string | undefined => issue.carriedBy ?? issue.worktrees.at(-1);

/** The worktree does this task (it was made for it, or a milestone's shared one) or carries it. */
export const worksOn = (issue: Issue, workspaceId: string): boolean => issue.carriedBy === workspaceId || issue.worktrees.at(-1) === workspaceId;

/** Every task a worktree is linked to: the one it was made for, those it carries, a milestone's shared ones. */
export const issuesOfWorkspace = (board: BoardState, workspaceId: string): Issue[] => board.issues.filter((i) => !isArchived(i) && worksOn(i, workspaceId));

/** Tasks this one waits on that aren't finished. */
export const openBlockers = (board: BoardState, issue: Issue): Issue[] => issue.blockedBy.map((id) => issueById(board, id)).filter((i): i is Issue => Boolean(i && isOpen(i.status)));

/** Tasks waiting on this one. */
export const blocking = (board: BoardState, issue: Issue): Issue[] => board.issues.filter((i) => i.blockedBy.includes(issue.id));

export const childrenOf = (board: BoardState, issue: Issue): Issue[] => board.issues.filter((i) => i.parent === issue.id).sort(byRank);

/** The other repos an epic's unfinished sub-tasks run in: Start makes a worktree in each too (BLG-561). */
export const reposAlong = (board: BoardState, epic: Issue): string[] => [...new Set(childrenOf(board, epic).filter((k) => k.projectId !== epic.projectId && isStartable(k)).map((k) => k.projectId))];

/** An epic: a task with sub-tasks (worked out from the board, never stored). */
export const isEpic = (board: Pick<BoardState, 'issues'>, issue: Pick<Issue, 'id'>): boolean => board.issues.some((i) => i.parent === issue.id);

/** Sub-tasks done out of all of them (not counting canceled ones). */
export function progressOf(board: BoardState, issue: Issue): { readonly done: number; readonly total: number } {
  const kids = childrenOf(board, issue).filter((i) => i.status !== 'canceled');
  return { done: kids.filter((i) => i.status === 'done').length, total: kids.length };
}

export const byRank = (a: Issue, b: Issue): number => a.rank - b.rank || a.number - b.number;

/** List order: by status, then priority (urgent first), then rank. */
export function listOrder(a: Issue, b: Issue): number {
  return ISSUE_STATUSES.indexOf(a.status) - ISSUE_STATUSES.indexOf(b.status) || PRIORITY_INFO[a.priority].rank - PRIORITY_INFO[b.priority].rank || byRank(a, b);
}

/** A rank between two neighbours (dropping a card between them); the ends get room around them. */
export function rankBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1000;
  if (before === undefined) return after! - 1000;
  if (after === undefined) return before + 1000;
  return (before + after) / 2;
}

/** Whether a task is yours: assigned to you. */
export const isMine = (issue: Issue, selfId: string): boolean => issue.assignee?.id === selfId;

export interface IssueFilter {
  /** Every scope but `archived` leaves archived tasks out. */
  readonly scope?: 'mine' | 'active' | 'backlog' | 'all' | 'archived';
  /** On this board. */
  readonly boardId?: string;
  /** With `boardId` a repo's own board: also the tasks running in its repo from other boards (`showsOn`). */
  readonly visiting?: boolean;
  /** Running in one of these repos (project ids). */
  readonly repos?: readonly string[];
  readonly query?: string;
  readonly selfId?: string;
  /** Keep closed (Done, Canceled) tasks closed in the last this-many ms (the default: a week). */
  readonly closedWithin?: number;
  readonly now?: number;
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Words in the title, key, labels or brief, all of them (any order, any case). */
export function matches(issue: Issue, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [issue.key, issue.title, ...issue.labels, ...Object.values(issue.brief)].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The tasks a view shows (scope, board, repos, words), in list order. */
export function filterIssues(board: BoardState, f: IssueFilter = {}): Issue[] {
  const now = f.now ?? Date.now();
  const within = f.closedWithin ?? WEEK;
  return board.issues
    .filter((i) => (!f.boardId ? true : f.visiting ? showsOn(i, f.boardId) : boardOf(i) === f.boardId))
    .filter((i) => (f.repos ? f.repos.includes(i.projectId) : true))
    .filter((i) => (f.scope === 'archived') === isArchived(i))
    .filter((i) => {
      switch (f.scope ?? 'all') {
        case 'archived':
          return true;
        case 'mine':
          return Boolean(f.selfId && isMine(i, f.selfId)) && (isOpen(i.status) || now - (i.closedAt ?? i.updatedAt) < within);
        case 'active':
          return i.status === 'todo' || i.status === 'in_progress' || i.status === 'in_review' || i.status === 'in_plan';
        case 'backlog':
          return i.status === 'backlog';
        default:
          return isOpen(i.status) || now - (i.closedAt ?? i.updatedAt) < within;
      }
    })
    .filter((i) => (f.query ? matches(i, f.query) : true))
    .sort(listOrder);
}

/** Tasks grouped by status, every status present (empty groups too), in board order. */
export function byStatus(issues: readonly Issue[]): ReadonlyArray<{ readonly status: IssueStatus; readonly issues: readonly Issue[] }> {
  return ISSUE_STATUSES.map((status) => ({ status, issues: issues.filter((i) => i.status === status).sort((a, b) => PRIORITY_INFO[a.priority].rank - PRIORITY_INFO[b.priority].rank || byRank(a, b)) }));
}

/** Whose name to show for an actor, from where you look ("You", "Your Claude", "bob", "bob's Claude", "Beluga"). */
export function actorName(actor: Actor, selfId: string): string {
  switch (actor.kind) {
    case 'person':
      return actor.id === selfId ? 'You' : actor.name;
    case 'claude':
      return actor.external ? externalLabel(actor.external) : agentLabel(actor.agent, actor.ownerName, actor.owner === selfId, { capital: true }) + (actor.for ? `, for ${actor.for.id === selfId ? 'you' : actor.for.name}` : '');
    default:
      return 'Beluga';
  }
}

/** A client picks its own name: the word after it keeps "You" from reading as you. */
export const externalLabel = (agent: ExternalActor): string => `${agent.name} (agent)`;

export function assigneeName(assignee: AnyAssignee | undefined, selfId: string): string {
  if (!assignee) return 'No one';
  return assignee.kind === 'person' ? (assignee.id === selfId ? 'You' : assignee.name) : agentLabel(undefined, assignee.ownerName, assignee.owner === selfId, { capital: true });
}

/** An activity line in words from where you look ("assigned this to your Claude"). */
export function activityText(entry: Activity, selfId: string): string {
  if (entry.kind !== 'assignee' || entry.assignee === undefined) return entry.text;
  if (entry.assignee === null) return 'unassigned this';
  const name = assigneeName(entry.assignee, selfId);
  const mine = entry.assignee.kind === 'claude' && entry.assignee.owner === selfId;
  return `assigned this to ${name === 'You' ? 'you' : mine ? agentLabel(undefined, undefined, true) : name}`;
}

/** A label's color, the same everywhere (a few calm hues). */
export function labelHue(label: string): number {
  let h = 0;
  for (const c of label.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return [212, 152, 268, 28, 340, 190, 96][h % 7]!;
}
