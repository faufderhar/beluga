import type { AgentRef } from '../../protocol.js';
import type { Actor, IssuePr, Priority } from '../board/model.js';

/**
 * Plans: a goal cut into milestones, each with tasks and the criteria that say it's passed.
 * Claude writes a plan in a conversation (its home); until you approve it, the plan is only a
 * draft there and never touches Tasks. Approving puts its tasks on the board, and the plan then
 * runs its milestones (side by side where none builds on another), as far on its own as its
 * autonomy allows.
 * Browser-safe: the Mac app runs it. See docs/tasks-and-plans.md.
 */

export const AUTONOMIES = ['step', 'gated', 'autopilot'] as const;
export type Autonomy = (typeof AUTONOMIES)[number];

/**
 * What each autonomy is called everywhere (the Mac app, Claude's prompt): `label` its name,
 * `summary` the one sentence a choice of it shows, `hint` the longer how-it-runs.
 */
export const AUTONOMY_INFO: Readonly<Record<Autonomy, { readonly label: string; readonly summary: string; readonly hint: string }>> = {
  step: { label: 'Step by Step', summary: 'You start each task', hint: 'Your agent lines up what can start; you start each task' },
  gated: { label: 'Check-ins', summary: 'Runs, then waits for you at each milestone', hint: 'Tasks start by themselves; each milestone waits for you to pass it' },
  autopilot: { label: 'Autopilot', summary: 'Runs to the end, stops only if something fails', hint: 'Milestone to milestone on its own: your agent checks each one; it stops only when something fails' },
};

/** When a plan runs its e2e and full test suites: once per milestone at its check, or only at the end. */
export const TESTS_AT = ['milestone', 'end'] as const;
export type TestsAt = (typeof TESTS_AT)[number];

export const TESTS_AT_INFO: Readonly<Record<TestsAt, { readonly label: string; readonly hint: string }>> = {
  milestone: { label: 'Each Milestone', hint: 'Tasks run typecheck and the tests they touched; each milestone’s check runs the full suites once' },
  end: { label: 'Only at the End', hint: 'Milestone checks read the code and diffs; the full suites run once, in the final step' },
};

/** A new plan's autonomy. */
export const DEFAULT_AUTONOMY: Autonomy = 'gated';

/** One task of a plan, before and after it's on the board. */
export interface PlanTask {
  /** Stable inside the plan ("auth-api"): Claude names tasks by it, and it survives re-planning. */
  readonly id: string;
  readonly title: string;
  readonly goal?: string;
  readonly context?: string;
  /** Done means all of these are true. */
  readonly acceptance: readonly string[];
  /** Tasks of this plan that must be finished first (ids). */
  readonly blockedBy: readonly string[];
  /** A sub-task's parent (an id in the same milestone). */
  readonly parent?: string;
  readonly priority?: Priority;
  readonly estimate?: number;
  readonly labels?: readonly string[];
  /** Files or areas it changes: tasks that run side by side shouldn't share them. */
  readonly touches?: readonly string[];
  /** Who works on it: your Claude (the default) or you. */
  readonly assignee?: 'claude' | 'me';
  /** Yours (assignee "me"): what you're asked when it's ready, in the plan's conversation (see decisions.ts). */
  readonly decision?: PlanDecision;
  /** Its task on the board, once the plan is approved. */
  readonly issueId?: string;
}

/** A plan task that's yours, as a choice: the question, the options (pick one, or several), and always your own words. */
export interface PlanDecision {
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  readonly multi?: boolean;
}

export interface PlanMilestone {
  readonly id: string;
  readonly title: string;
  readonly goal?: string;
  /** Pass criteria: what must be true to call the milestone done (checked by Claude, passed by you or Claude). */
  readonly criteria: readonly string[];
  readonly tasks: readonly PlanTask[];
  /** This milestone's own autonomy (else the plan's). */
  readonly autonomy?: Autonomy;
  /**
   * Earlier milestones it builds on (ids): it opens once they've passed. Left out, it's inferred
   * from its tasks' blockers in other milestones; empty, it runs alongside from the start.
   */
  readonly dependsOn?: readonly string[];
}

/**
 * Something the plan has decided ("one app, your own client"): the plan's own, so superseding one
 * is explicit, and the tasks still written the old way can be found (BLG-772).
 */
export interface Decided {
  readonly id: string;
  readonly text: string;
  /** Words that mark text following it ("New Window"): once it's superseded, tasks still using them are listed. */
  readonly terms?: readonly string[];
  /** Words it retires (an old name: "machine", "Auto"): tasks still using them are listed. */
  readonly retires?: readonly string[];
  /** The decision it replaced (an id). */
  readonly supersedes?: string;
  /** Replaced by a later decision (its id): kept for the record, no longer in force. */
  readonly supersededBy?: string;
}

/** What a plan says: the part Claude writes and you approve. */
export interface PlanBody {
  readonly title: string;
  readonly goal: string;
  readonly milestones: readonly PlanMilestone[];
  /** What it has decided along the way, in the order decided (superseded ones kept, marked). */
  readonly decisions?: readonly Decided[];
}

/** One thing a draft's reviewer found (see draft-review.ts). */
export interface ReviewFinding {
  readonly kind: 'contradiction' | 'duplicate' | 'stale' | 'order' | 'other';
  readonly text: string;
  /** The plan's task (or milestone) ids it's about. */
  readonly ids?: readonly string[];
}

export const FINDING_KINDS: readonly ReviewFinding['kind'][] = ['contradiction', 'duplicate', 'stale', 'order', 'other'];

/**
 * A fresh agent's read of the draft, when you ask for it (Verify, Then Approve: see draft-review.ts):
 * for one revision of it. `reviewing` while it reads; `done` with what it found (none: it reads
 * well); `failed` when it ended without a verdict (Approve Plan is offered as before).
 */
export interface DraftReview {
  /** The draftRev it read. */
  readonly rev: number;
  readonly at: number;
  readonly state: 'reviewing' | 'done' | 'failed';
  readonly findings: readonly ReviewFinding[];
  /** Its conversation (a workspace id), kept across rounds: it remembers what it found before. */
  readonly chat?: string;
  /** Fix was sent to the plan's agent for this revision. */
  readonly fixAsked?: boolean;
  /** Approve the plan once it reads well (Verify, Then Approve). */
  readonly thenApprove?: boolean;
}

/** Claude's check of a milestone's pass criteria. */
export interface GateCheck {
  readonly at: number;
  readonly by: Actor;
  readonly verdict: 'pass' | 'fail';
  readonly notes: string;
}

/** How a milestone is going (by milestone id). */
export interface MilestoneRun {
  readonly passedAt?: number;
  readonly passedBy?: Actor;
  /** Claude's latest check of its criteria. */
  readonly check?: GateCheck;
  /** When the head Claude was asked to check it (asked once per round). */
  readonly checkAsked?: number;
  /** The one Claude doing its tasks, in one worktree (see pilot.ts). */
  readonly agent?: MilestoneAgent;
  /**
   * The conversation that checks it (a workspace id): a Claude of its own, not the head's, so the
   * plan's conversation stays free while it checks and milestones are checked side by side.
   */
  readonly checker?: string;
  /** Passing it couldn't merge its tasks into the plan's branch (not a conflict: a dirty checkout, no git identity): why, until it's passed again. */
  readonly mergeFailed?: { readonly at: number; readonly reason: string };
  /**
   * The plan moved here from another computer (BLG-806) with this milestone under way: its next
   * agent starts from the branch its agent there left (its work so far), not from the plan's.
   */
  readonly resumeFrom?: string;
}

/** Where a plan went, or came from, when it moved between your computers (BLG-806). */
export interface PlanMove {
  /** The computer's device id (none: this Mac, as your app names it). */
  readonly id?: string;
  readonly name: string;
  readonly at: number;
  /** The plan's id there. */
  readonly planId?: string;
}

/**
 * A milestone's own Claude: one worktree that does the milestone's tasks one after another (in
 * the order they build on each other), keeping what it learned. Each task links the worktree, and
 * its Claude moves each one along on the board (In Progress, then In Review with its proof).
 */
export interface MilestoneAgent {
  /** The worktree (workspace id) and its branch. */
  readonly worktree: string;
  readonly branch?: string;
  readonly at: number;
  /** Plan task ids handed to it so far (more come when a check adds fix tasks). */
  readonly tasks: readonly string[];
}

/** A task that builds on several unmerged tasks: their branches are being combined into its start. */
export interface Combining {
  readonly at: number;
  /** The tasks it builds on (their keys, e.g. KLD-9). */
  readonly from: readonly string[];
  /** It stopped at a conflict, left in a hidden worktree for the head Claude to fix. */
  readonly conflict?: {
    readonly at: number;
    readonly dir: string;
    readonly merging: string;
    readonly files: readonly string[];
    /** Claude was asked and it's still there: it waits for you. */
    readonly stuck?: boolean;
  };
}

/** Main merged into the plan's branch (its PR conflicts with main): in the hidden worktree, a conflict there fixed by the plan's Claude. */
export interface PlanMainMerge {
  readonly at: number;
  /** What was merged in ("origin/main"). */
  readonly main: string;
  readonly conflict?: {
    readonly at: number;
    readonly dir: string;
    readonly files: readonly string[];
    /** Claude was asked and it's still there: it waits for you. */
    readonly stuck?: boolean;
  };
}

/** The plan's pull request as GitHub last showed it: what stands in the way of merging it too. */
export interface PlanPr extends IssuePr {
  /** GitHub says it conflicts with main. */
  readonly conflicts?: boolean;
  /** Auto-merge is on: GitHub merges it once its checks and reviews pass. */
  readonly autoMerge?: boolean;
  /** Behind main (main needs merging in first), or blocked by main's rules. */
  readonly mergeState?: 'behind' | 'blocked';
}

/**
 * A passed milestone's task branches being merged (--no-ff) into the plan's branch, in a hidden
 * worktree. The milestone counts as passed once that's done; a conflict goes to the head Claude.
 */
export interface PlanMerge {
  readonly at: number;
  /** Who passed it. */
  readonly by: Actor;
  /** It had passed before the plan had a branch (catching up): it isn't passed again. */
  readonly catchUp?: boolean;
  readonly conflict?: {
    readonly at: number;
    readonly dir: string;
    /** The branch that conflicted, and its task's key. */
    readonly merging: string;
    readonly key?: string;
    readonly files: readonly string[];
    /** Claude was asked and it's still there: it waits for you. */
    readonly stuck?: boolean;
  };
}

/**
 * A started task whose Claude stopped without finishing (see watchdog.ts): the latest stall, and
 * what Beluga did about it. Woken once; stalling again soon after, it waits for you.
 */
export interface TaskWatch {
  /** When it was last seen stalled, and why (“it ended its turn without handing off”). */
  readonly at: number;
  readonly reason: string;
  /** The run it stalled on (its request id): one run is one stall. */
  readonly run?: string;
  /** When Beluga woke it (or you resumed it). */
  readonly wokeAt?: number;
  /** It stalled again soon after a wake: it waits for you (Resume, or Open Chat). */
  readonly needsYou?: boolean;
  /** What it said last when it came to wait for you (often what it needs from you), clipped. */
  readonly said?: string;
  /** The one line it's shown with: “KLD-36 stopped, woke it at 11:13”. */
  readonly line: string;
  /** Stopped by your usage limit: when it goes on by itself (see shared/run-failure.ts). */
  readonly limitUntil?: number;
  /** The run it was resumed from after the limit reset (so it's resumed once). */
  readonly resumed?: string;
}

/** The plan reached main: through its pull request, or merged here. */
export interface PlanShipped {
  readonly at: number;
  readonly how: 'pr' | 'local';
  readonly number?: number;
}

/**
 * What a plan's activity records. `started`/`finished`: a task began / came back for review;
 * `gate`: Claude was asked to check a milestone, `checked`: its check passed (`failed`: it didn't);
 * `merged`: a milestone's work went into the plan's branch; `autonomy`: the run mode changed.
 */
export type PlanEventKind = 'created' | 'drafted' | 'approved' | 'changed' | 'started' | 'finished' | 'gate' | 'checked' | 'merged' | 'passed' | 'failed' | 'autonomy' | 'paused' | 'resumed' | 'done' | 'note' | 'problem';

export interface PlanEvent {
  readonly id: string;
  readonly at: number;
  readonly by: Actor;
  readonly kind: PlanEventKind;
  readonly text: string;
}

export type PlanStatus = 'draft' | 'active' | 'done';

export interface Plan {
  readonly id: string;
  readonly projectId: string;
  /** The conversation it's planned and run from (`ws:<id>`): its head Claude. */
  readonly home: string;
  readonly status: PlanStatus;
  /** What was approved (its tasks are on the board). */
  readonly body?: PlanBody;
  /** Claude's (and your) working copy, not on the board: a new plan, or changes to an approved one. */
  readonly draft?: PlanBody;
  /** Bumped by every change to the draft (screens and Claude see it moved). */
  readonly draftRev: number;
  readonly autonomy: Autonomy;
  /** How many of its tasks may run at once. */
  readonly maxParallel: number;
  /** When the e2e and full test suites run (tasks only run typecheck and the tests they touched). */
  readonly testsAt: TestsAt;
  /** The agent (and model) its milestones and tasks are worked on by (BLG-497); none: your default. A task's own agent beats it. */
  readonly agent?: AgentRef;
  readonly paused: boolean;
  readonly runs: Readonly<Record<string, MilestoneRun>>;
  /** Tasks whose start is being combined from several branches (by plan task id). */
  readonly combining?: Readonly<Record<string, Combining>>;
  /** Started tasks that stalled, and the wake or the stop that followed (by plan task id). */
  readonly watch?: Readonly<Record<string, TaskWatch>>;
  /** Its branch (plan/<slug>, from main): every task starts from it, passed milestones merge into it, and it ends as one PR. */
  readonly branch?: string;
  /** Passed milestones being merged into the branch (by milestone id). */
  readonly merging?: Readonly<Record<string, PlanMerge>>;
  /** Main being merged into the plan's branch (its PR conflicted with main), or stopped at a conflict for Claude to fix. */
  readonly mainMerge?: PlanMainMerge;
  /** The branch's pull request into main, as last seen. */
  readonly pr?: PlanPr;
  readonly shipped?: PlanShipped;
  /** Plans that ran before they had a branch were caught up once (passed milestones merged into one). */
  readonly caughtUp?: boolean;
  /** Its shape on the board: an epic for the plan, one under it per milestone (see epics.ts). */
  readonly epics?: PlanEpics;
  /** Beluga moving its stalled milestones along (see the pilot's rescue), by milestone id: kept, so a restart doesn't start over. */
  readonly rescue?: Readonly<Record<string, PlanRescue>>;
  /** It moved to another computer (BLG-806): this copy is the record of it, paused, off the lists; the plan runs there. */
  readonly movedTo?: PlanMove;
  /** It came here from another computer. */
  readonly movedFrom?: PlanMove;
  /** The first draft's review by a fresh agent, when you asked for one (see draft-review.ts). */
  readonly review?: DraftReview;
  readonly activity: readonly PlanEvent[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly approvedAt?: number;
  readonly doneAt?: number;
}

/**
 * A plan with nothing running and nothing waiting on you is stalled: Beluga moves it along, a step
 * further each time the same thing stays stuck (send it on, a fresh Claude, the head Claude decides),
 * and only then tells you, saying what it tried.
 */
export interface PlanRescue {
  /** How far the milestone had got (see milestoneMark): moving on from there starts the ladder over. */
  readonly sig: string;
  /** What it's stuck on now (a check, stopped tasks, idle work…): a new kind starts its ladder over. */
  readonly kind?: string;
  /** How many steps up the ladder it has gone for that kind. */
  readonly tries: number;
  /** Steps taken in all, across kinds: past a few, it's yours (no going round in circles). */
  readonly total?: number;
  readonly at: number;
  /** What was tried, in words (shown when it's left to you). */
  readonly tried: readonly string[];
  /** Left to you: nothing more is tried until something moves. */
  readonly yours?: boolean;
}

/** A plan's epics on the board (task ids): the plan's own, and each milestone's (by milestone id). */
export interface PlanEpics {
  readonly plan: string;
  readonly milestones: Readonly<Record<string, string>>;
}

export interface PlansState {
  /** Plans run (the Mac app's daemon); off elsewhere. */
  readonly enabled: boolean;
  readonly plans: readonly Plan[];
  /** Your planning style: how you like plans cut (added to Claude's planning instructions). */
  readonly style: string;
}

export interface PlansSlice {
  readonly plans: PlansState;
}

export const KEEP_PLAN_ACTIVITY = 200;
/** A line in the plan's feed (`Plans.note`), at most: what's longer is cut. */
export const NOTE_MAX = 300;
export const DEFAULT_PARALLEL = 3;
export const MAX_PARALLEL = 8;

export const NO_PLANS: PlansState = { enabled: false, plans: [], style: '' };
export const initialPlans: PlansSlice = { plans: NO_PLANS };

export type PlansAction =
  | { type: 'plans_init'; state: PlansState }
  | { type: 'plan_put'; plan: Plan }
  | { type: 'plan_remove'; id: string }
  | { type: 'plans_style'; style: string }
  | { type: 'plans_off' };

export const PLANS_ACTIONS: ReadonlySet<string> = new Set(['plans_init', 'plan_put', 'plan_remove', 'plans_style', 'plans_off']);

export function reducePlans(state: PlansSlice, action: PlansAction): PlansSlice {
  switch (action.type) {
    case 'plans_init':
      return { plans: action.state };
    case 'plan_put': {
      const list = state.plans.plans;
      const at = list.findIndex((p) => p.id === action.plan.id);
      return { plans: { ...state.plans, plans: at >= 0 ? list.map((p, n) => (n === at ? action.plan : p)) : [...list, action.plan] } };
    }
    case 'plan_remove':
      return { plans: { ...state.plans, plans: state.plans.plans.filter((p) => p.id !== action.id) } };
    case 'plans_style':
      return { plans: { ...state.plans, style: action.style } };
    case 'plans_off':
      return { plans: NO_PLANS };
    default:
      return state;
  }
}

// ---- for screens and Claude

export const planById = (state: PlansState, id: string): Plan | undefined => state.plans.find((p) => p.id === id);

/** The plan a conversation is the home of (the newest, when several were). A plan that moved away has no home here any more. */
export const planForHome = (state: PlansState, channel: string): Plan | undefined => [...state.plans].reverse().find((p) => p.home === channel && !p.movedTo);

/** The plans that run here (one that moved to another computer is only its record). */
export const plansHere = (state: PlansState): readonly Plan[] => state.plans.filter((p) => !p.movedTo);

/** The plan a board task stands for as an epic: the plan's own, or one of its milestones' (see epics.ts). */
export function planEpicOf(state: PlansState, issueId: string): { readonly plan: Plan; readonly milestone?: PlanMilestone } | undefined {
  for (const plan of state.plans) {
    if (!plan.epics) continue;
    if (plan.epics.plan === issueId) return { plan };
    const id = Object.entries(plan.epics.milestones).find(([, epic]) => epic === issueId)?.[0];
    const milestone = id ? shownBody(plan)?.milestones.find((m) => m.id === id) : undefined;
    if (milestone) return { plan, milestone };
  }
  return undefined;
}

/** The plan and milestone a conversation checks (see MilestoneRun.checker). */
export function checkerOf(state: PlansState, channel: string): { readonly plan: Plan; readonly milestone: string } | undefined {
  if (!channel.startsWith('ws:')) return undefined;
  const id = channel.slice(3);
  for (const plan of state.plans) for (const [milestone, run] of Object.entries(plan.runs ?? {})) if (run?.checker === id) return { plan, milestone };
  return undefined;
}

/** The draft plan a conversation reviews (see DraftReview.chat). */
export function reviewerOf(state: PlansState, channel: string): Plan | undefined {
  if (!channel.startsWith('ws:')) return undefined;
  const id = channel.slice(3);
  return state.plans.find((p) => p.review?.chat === id);
}

/**
 * Where the review of a first draft stands, for the draft as it is now: `off` (no first draft to
 * review: approved, or nothing in it yet), `none` (not verified: only when you ask), `reviewing`,
 * `findings` (Fix, or Approve Anyway), `clean`, or `failed` (it didn't finish).
 */
export type ReviewState = 'off' | 'none' | 'reviewing' | 'findings' | 'clean' | 'failed';

export function reviewState(plan: Plan): ReviewState {
  if (plan.body || plan.status !== 'draft' || !plan.draft?.milestones.length) return 'off';
  const r = plan.review;
  if (!r || r.rev !== plan.draftRev) return 'none';
  if (r.state === 'reviewing') return 'reviewing';
  if (r.state === 'failed') return 'failed';
  return r.findings.length ? 'findings' : 'clean';
}

/** The decisions in force (not superseded). */
export const activeDecisions = (body: PlanBody | undefined): readonly Decided[] => (body?.decisions ?? []).filter((d) => !d.supersededBy);

/**
 * The conversation is a live plan's own (its head Claude plans and runs it there): it has no
 * Act/Plan modes, so plan mode is never switched there (Claude asking to approve a plan of its own
 * would stall the plan).
 */
export const isPlanHome = (state: PlansState, channel: string): boolean => {
  const plan = planForHome(state, channel);
  return Boolean(plan && plan.status !== 'done');
};

/** What a screen shows of a plan: the draft while there is one, else what was approved. */
export const shownBody = (plan: Plan): PlanBody | undefined => plan.draft ?? plan.body;

export const planTitle = (plan: Plan): string => shownBody(plan)?.title || 'New plan';

/** Every task of a body, with the milestone it's in. */
export function allTasks(body: PlanBody | undefined): Array<{ readonly task: PlanTask; readonly milestone: PlanMilestone; readonly index: number }> {
  return (body?.milestones ?? []).flatMap((milestone, index) => milestone.tasks.map((task) => ({ task, milestone, index })));
}

export const taskById = (body: PlanBody | undefined, id: string): PlanTask | undefined => allTasks(body).find((t) => t.task.id === id)?.task;

/** The plan task a board task came from. */
export function planTaskOfIssue(state: PlansState, issueId: string): { readonly plan: Plan; readonly task: PlanTask; readonly milestone: PlanMilestone } | undefined {
  for (const plan of state.plans) {
    const hit = allTasks(plan.body).find((t) => t.task.issueId === issueId);
    if (hit) return { plan, task: hit.task, milestone: hit.milestone };
  }
  return undefined;
}

/** A milestone's own autonomy, else its plan's. */
export const autonomyOf = (plan: Plan, milestone: PlanMilestone | undefined): Autonomy => milestone?.autonomy ?? plan.autonomy;

/**
 * The milestones a milestone waits on (ids): what it says, else the milestones its tasks' blockers
 * are in (none: it runs alongside the others).
 */
export function milestoneDeps(body: PlanBody | undefined, milestone: PlanMilestone): readonly string[] {
  const ids = new Set((body?.milestones ?? []).map((m) => m.id));
  if (milestone.dependsOn) return milestone.dependsOn.filter((d) => d !== milestone.id && ids.has(d));
  const home = new Map(allTasks(body).map((t) => [t.task.id, t.milestone.id]));
  const out = new Set<string>();
  for (const t of milestone.tasks) {
    for (const b of t.blockedBy) {
      const m = home.get(b);
      if (m && m !== milestone.id) out.add(m);
    }
  }
  return (body?.milestones ?? []).map((m) => m.id).filter((id) => out.has(id));
}

/** Milestones being worked on now: not passed, and every one they wait on has passed (ids, in order). */
export function openMilestones(plan: Plan): readonly string[] {
  const body = plan.body;
  if (!body || plan.status === 'done') return [];
  const passed = (id: string): boolean => Boolean(plan.runs[id]?.passedAt);
  return body.milestones.filter((m) => !passed(m.id) && milestoneDeps(body, m).every(passed)).map((m) => m.id);
}

/**
 * The branch a plan's work collects on: a plan/<name> its text names (one kept by hand before),
 * else plan/ and its title up to a colon ("Beluga polish round: menus…" → plan/beluga-polish-round).
 */
export function planBranchName(plan: Plan): string {
  const body = plan.body ?? plan.draft;
  const named = /\bplan\/[A-Za-z0-9][\w.-]*[A-Za-z0-9]/.exec([body?.goal ?? '', ...(body?.milestones ?? []).flatMap((m) => [m.goal ?? '', ...m.criteria])].join('\n'))?.[0];
  if (named) return named;
  const title = (body?.title ?? '').split(':')[0]!;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `plan/${slug || plan.id.replace(/^pl_/, '').slice(0, 8)}`;
}

/** How a draft differs from what was approved: tasks added, changed and removed (by id). */
export interface PlanDiff {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly milestones: number;
}

export function diffBodies(before: PlanBody | undefined, after: PlanBody | undefined): PlanDiff {
  const old = new Map(allTasks(before).map((t) => [t.task.id, t]));
  const now = new Map(allTasks(after).map((t) => [t.task.id, t]));
  const added = [...now.keys()].filter((id) => !old.has(id));
  const removed = [...old.keys()].filter((id) => !now.has(id));
  const changed = [...now.keys()].filter((id) => {
    const a = old.get(id);
    const b = now.get(id)!;
    return a && (a.milestone.id !== b.milestone.id || taskSignature(a.task) !== taskSignature(b.task));
  });
  const ms = (b: PlanBody | undefined): string => (b?.milestones ?? []).map((m) => `${m.id}\0${m.title}\0${m.goal ?? ''}\0${m.criteria.join('\0')}\0${m.dependsOn?.join(',') ?? '-'}`).join('\n');
  const milestones = ms(before) === ms(after) ? 0 : Math.max(1, Math.abs((after?.milestones.length ?? 0) - (before?.milestones.length ?? 0)));
  return { added, changed, removed, milestones };
}

/** What makes a task different, without what the board gave it. */
export function taskSignature(t: PlanTask): string {
  const { issueId: _i, ...rest } = t;
  return JSON.stringify(rest);
}

export const isEmptyDiff = (d: PlanDiff): boolean => !d.added.length && !d.changed.length && !d.removed.length && !d.milestones;
