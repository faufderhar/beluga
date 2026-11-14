import { type BoardState, type Issue, issueById } from '../board/model.js';
import { type Autonomy, type Combining, type MilestoneAgent, type MilestoneRun, type Plan, type PlanBody, type PlanMerge, type PlanMilestone, type PlanTask, type TaskWatch, autonomyOf, milestoneDeps, openMilestones, shownBody } from './model.js';
import { type RunInfo, type TaskPulse, type WaitingMessage, messageState, pulseOf, pulseWords } from './watchdog.js';

/**
 * Where a plan stands, worked out from the plan and the board (and what Claude is doing right
 * now): each task's state, each milestone's, what can start, and the one thing the plan waits
 * for. The scheduler (pilot.ts) acts on this; screens draw it. Pure and browser-safe.
 */

export type TaskState =
  /** Not approved yet: only in the draft. */
  | 'draft'
  /** In a milestone that hasn't started. */
  | 'later'
  /** Waits on tasks that aren't finished. */
  | 'blocked'
  /** Can start now. */
  | 'ready'
  /** Claude is working on it in its worktree. */
  | 'running'
  /** Claude asked something there and waits for an answer. */
  | 'asking'
  /** In progress, but nobody is working on it right now (its Claude stopped without finishing). */
  | 'idle'
  /** Its Claude stopped again soon after Beluga woke it: it waits for you (see watchdog.ts). */
  | 'stalled'
  | 'review'
  /** Its milestone passed: merged into the plan's branch, waiting for the plan's PR. */
  | 'planned'
  | 'done'
  | 'canceled'
  /** Its board task was deleted. */
  | 'missing';

export const FINISHED: ReadonlySet<TaskState> = new Set(['review', 'planned', 'done', 'canceled', 'missing']);
const ACTIVE: ReadonlySet<TaskState> = new Set(['running', 'asking', 'idle', 'stalled']);

export interface TaskView {
  readonly task: PlanTask;
  readonly milestoneId: string;
  readonly issue?: Issue;
  readonly state: TaskState;
  /** The worktree doing it (workspace id). */
  readonly worktree?: string;
  /** Tasks of the plan it still waits on (ids). */
  readonly waitsOn: readonly string[];
  /** Why it can't start yet, in words. */
  readonly why?: string;
  /** The branch it starts from: the one task it builds on that's in review (not merged yet), else the plan's branch. */
  readonly base?: string;
  /** Builds on several tasks in review: their branches, combined into its start (in its order of blockers). */
  readonly bases?: readonly string[];
  /** Its start is being combined from `bases` right now (or stopped at a conflict). */
  readonly combining?: Combining;
  /** What Claude is doing there now. */
  readonly step?: string;
  /** Assigned to you: it never starts by itself. */
  readonly forYou: boolean;
  /** Started: how it's doing right now (working on a step, in a long command, stopped, waiting for you). */
  readonly pulse?: TaskPulse;
  /** It stalled: the wake, or why it waits for you. */
  readonly watch?: TaskWatch;
  /** Messages waiting for its Claude (the head Claude's, yours): the card offers Steer Now. */
  readonly waiting?: readonly WaitingMessage[];
  /** Handed to its milestone's Claude (`worktree`), not started yet: it does it after the ones before it. */
  readonly queued?: boolean;
}

export type MilestoneState = 'draft' | 'later' | 'running' | 'checking' | 'gate' | 'failed' | 'merging' | 'passed';

export interface MilestoneView {
  readonly milestone: PlanMilestone;
  readonly index: number;
  readonly state: MilestoneState;
  readonly tasks: readonly TaskView[];
  readonly finished: number;
  readonly total: number;
  readonly autonomy: Autonomy;
  readonly run: MilestoneRun;
  /** Milestones it waits on (ids: what it says, or inferred from its tasks' blockers). */
  readonly dependsOn: readonly string[];
  /** Passed, and its tasks' branches are being merged into the plan's branch (or a conflict there is being fixed). */
  readonly merging?: PlanMerge;
  /** Its one Claude, while its worktree is there (see pilot.ts). */
  readonly agent?: MilestoneAgent;
  /**
   * That Claude at work right now (a turn under way, or asking you): what it's doing, even between
   * tasks (wrapping one up, about to start the next), when no task card says so.
   */
  readonly agentNow?: TaskPulse;
}

/** The one thing a plan waits for (the page's main button). */
export type NextStep =
  | { readonly kind: 'approve' }
  | { readonly kind: 'review_changes' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'start'; readonly tasks: readonly TaskView[] }
  | { readonly kind: 'pass'; readonly milestone: MilestoneView }
  | { readonly kind: 'checking'; readonly milestone: MilestoneView }
  | { readonly kind: 'failed'; readonly milestone: MilestoneView }
  /** A passed milestone merging into the plan's branch; `text`: “Fixing a merge conflict in KLD-9”. */
  | { readonly kind: 'merging'; readonly milestone: MilestoneView; readonly text: string }
  /** Every milestone passed: the plan's branch waits to reach main (Open PR, or merge it here). */
  | { readonly kind: 'ship'; readonly branch: string; readonly pr?: Plan['pr'] }
  | { readonly kind: 'answer'; readonly tasks: readonly TaskView[] }
  /** Tasks that stopped again after a wake: Resume them, or open their chat. */
  | { readonly kind: 'stalled'; readonly tasks: readonly TaskView[] }
  /** `note`: the latest stall and wake (“KLD-36 stopped, woke it at 11:13”). */
  | { readonly kind: 'working'; readonly tasks: readonly TaskView[]; readonly note?: string }
  | { readonly kind: 'waiting'; readonly why: string }
  | { readonly kind: 'done' };

export interface PlanView {
  readonly plan: Plan;
  readonly body?: PlanBody;
  readonly milestones: readonly MilestoneView[];
  /** Milestones being worked on side by side: not passed, and what they build on has passed. */
  readonly open: readonly MilestoneView[];
  /** The first of them (once approved). */
  readonly current?: MilestoneView;
  /** Tasks that can start now (in order, across open milestones), and those in progress. */
  readonly ready: readonly TaskView[];
  readonly active: readonly TaskView[];
  readonly next: NextStep;
  readonly done: number;
  readonly total: number;
}

/** What's happening in a conversation right now (from the store's log, questions and approvals). */
export interface Live {
  readonly busy: (channel: string) => boolean;
  readonly asking: (channel: string) => boolean;
  /** The step Claude is on there. */
  readonly step?: (channel: string) => string | undefined;
  /** Its latest run there (the heartbeat): not a message still waiting behind it. */
  readonly run?: (channel: string) => RunInfo | undefined;
  /** Messages waiting there for Claude, oldest first. */
  readonly waiting?: (channel: string) => readonly WaitingMessage[];
}

export const NOBODY_LIVE: Live = { busy: () => false, asking: () => false };

function taskState(board: BoardState, issue: Issue | undefined, live: Live): { readonly state: TaskState; readonly worktree?: string; readonly step?: string } {
  if (!issue) return { state: 'missing' };
  const worktree = issue.worktrees.at(-1);
  switch (issue.status) {
    case 'done':
      return { state: 'done', ...(worktree ? { worktree } : {}) };
    case 'canceled':
      return { state: 'canceled' };
    case 'in_review':
      return { state: 'review', ...(worktree ? { worktree } : {}) };
    case 'in_plan':
      return { state: 'planned', ...(worktree ? { worktree } : {}) };
    case 'in_progress': {
      if (!worktree || issue.worktreeGone) return { state: 'idle', ...(worktree ? { worktree } : {}) };
      const channel = `ws:${worktree}`;
      if (live.asking(channel)) return { state: 'asking', worktree };
      if (live.busy(channel)) {
        const step = live.step?.(channel);
        return { state: 'running', worktree, ...(step ? { step } : {}) };
      }
      return { state: 'idle', worktree };
    }
    default:
      void board;
      return { state: 'ready' };
  }
}

/** What a task being combined shows: “Combining KLD-9 and KLD-27 …”, or the conflict being fixed. */
function combiningStep(c: Combining): string {
  const names = c.from.length > 1 ? `${c.from.slice(0, -1).join(', ')} and ${c.from.at(-1)}` : (c.from[0] ?? 'its branches');
  if (!c.conflict) return `Combining ${names} …`;
  if (c.conflict.stuck) return `Combining ${names}: fix the conflict in ${c.conflict.files.slice(0, 3).join(', ')} (in ${c.conflict.dir}): it starts once no markers are left`;
  const files = c.conflict.files.slice(0, 3).join(', ') + (c.conflict.files.length > 3 ? ` and ${c.conflict.files.length - 3} more` : '');
  return `Combining ${names}: the agent is fixing a conflict in ${files}`;
}

/** What a milestone merging into the plan's branch shows. */
function mergingText(m: PlanMerge, title: string, branch: string | undefined): string {
  const c = m.conflict;
  const what = c?.key ?? c?.merging ?? '';
  if (!c) return `Merging “${title}” into ${branch ?? 'the plan’s branch'} …`;
  if (c.stuck) return `Fix the merge conflict in ${what} (${c.files.slice(0, 3).join(', ')}, in ${c.dir}): it merges once no markers are left`;
  return `Fixing a merge conflict in ${what}`;
}

/** A milestone's Claude right now, only while it's at work or asking (between turns it says nothing: its tasks do). */
function agentPulse(live: Live, agent: MilestoneAgent): TaskPulse | undefined {
  const channel = `ws:${agent.worktree}`;
  const asking = live.asking(channel);
  if (!asking && !live.busy(channel)) return undefined;
  const run = live.run?.(channel);
  const pulse = pulseOf(run, asking, undefined);
  // Busy with no turn of its own to read yet (a message just sent): working, timed from its last word (else from its start).
  return pulse.kind === 'working' || pulse.kind === 'command' || pulse.kind === 'waiting' ? pulse : { kind: 'working', since: run?.lastAt ?? agent.at };
}

/**
 * A milestone's Claude right now, in words: “Working on BLG-12”, or “Working between tasks”
 * (wrapping one up, starting the next: no card shows that), with its step and how long (`now`: 0
 * leaves the time out). Nothing while it isn't at work. `onCard`: a task card says it too.
 */
export function agentNowWords(m: Pick<MilestoneView, 'agentNow' | 'agent' | 'tasks'>, now: number): { readonly label: string; readonly asking: boolean; readonly sub?: string; readonly onCard: boolean } | undefined {
  if (!m.agentNow || !m.agent) return undefined;
  const worktree = m.agent.worktree;
  const on = m.tasks.find((t) => t.worktree === worktree && (t.state === 'running' || t.state === 'asking'));
  const key = on ? (on.issue?.key ?? `“${on.task.title}”`) : undefined;
  if (m.agentNow.kind === 'waiting') return { label: key ? `Asked you about ${key}` : 'Asked you something', asking: true, onCard: Boolean(on) };
  const step = now ? pulseWords(m.agentNow, now).sub : m.agentNow.kind === 'working' || m.agentNow.kind === 'command' ? m.agentNow.step : undefined;
  return { label: key ? `Working on ${key}` : 'Working between tasks', asking: false, ...(step ? { sub: step } : {}), onCard: Boolean(on) };
}

/** A plan where it stands. */
/**
 * A plan that adopted a branch after some milestones passed (an existing plan/<slug>): their tasks
 * still In Review, which Tidy Up would merge into the branch and clear away. Offered once, never
 * done by itself (empty once you've answered).
 */
export function tidyOffer(view: PlanView): readonly TaskView[] {
  const plan = view.plan;
  if (!plan.branch || plan.caughtUp) return [];
  return view.milestones.filter((m) => m.run.passedAt && !plan.merging?.[m.milestone.id]).flatMap((m) => m.tasks.filter((t) => t.state === 'review' && t.issue?.branch && t.issue.worktrees.length));
}

export function planView(plan: Plan, board: BoardState, live: Live = NOBODY_LIVE): PlanView {
  // A draft (or a plan never approved) is drawn as it's written: nothing runs yet.
  if (!plan.body) {
    const body = shownBody(plan);
    const milestones: MilestoneView[] = (body?.milestones ?? []).map((m, index) => ({
      milestone: m,
      index,
      state: 'draft',
      tasks: m.tasks.map((task) => ({ task, milestoneId: m.id, state: 'draft' as const, waitsOn: task.blockedBy, forYou: task.assignee === 'me' })),
      finished: 0,
      total: m.tasks.length,
      autonomy: autonomyOf(plan, m),
      run: {},
      dependsOn: milestoneDeps(body, m),
    }));
    const total = milestones.reduce((n, m) => n + m.total, 0);
    return { plan, ...(body ? { body } : {}), milestones, open: [], ready: [], active: [], next: { kind: 'approve' }, done: 0, total };
  }

  const body = plan.body;
  const views = new Map<string, TaskView>();
  const openIds = new Set(openMilestones(plan));
  const milestoneTitle = new Map(body.milestones.map((m) => [m.id, m.title]));

  // Pass one: each task's own state from its board task.
  const base = new Map<string, { readonly state: TaskState; readonly worktree?: string; readonly step?: string; readonly issue?: Issue }>();
  for (const m of body.milestones) {
    for (const t of m.tasks) {
      const issue = t.issueId ? issueById(board, t.issueId) : undefined;
      base.set(t.id, { ...taskState(board, issue, live), ...(issue ? { issue } : {}) });
    }
  }
  const finished = (id: string): boolean => FINISHED.has(base.get(id)?.state ?? 'missing');
  const merged = (id: string): boolean => {
    const s = base.get(id)?.state;
    return s === 'planned' || s === 'done' || s === 'canceled' || s === 'missing';
  };
  const titleOf = new Map(body.milestones.flatMap((m) => m.tasks.map((t) => [t.id, t.title] as const)));

  // Pass two: what can start.
  body.milestones.forEach((m) => {
    for (const t of m.tasks) {
      const own = base.get(t.id)!;
      const waitsOn = t.blockedBy.filter((b) => !finished(b));
      // Yours in the plan, or given to someone on the board (Claude's tasks are no one's).
      const forYou = t.assignee === 'me' || own.issue?.assignee !== undefined;
      let state = own.state;
      let why: string | undefined;
      let from: string | undefined;
      let froms: readonly string[] | undefined;
      let step = own.step;
      let combining: Combining | undefined;
      if (state === 'ready') {
        // Board blockers from outside the plan count too.
        const outside = (own.issue?.blockedBy ?? []).map((id) => issueById(board, id)).filter((i): i is Issue => Boolean(i && i.status !== 'done' && i.status !== 'canceled' && i.status !== 'in_review' && !body.milestones.some((x) => x.tasks.some((y) => y.issueId === i.id))));
        const unmerged = t.blockedBy.filter((b) => finished(b) && !merged(b));
        if (!openIds.has(m.id) && !plan.runs[m.id]?.passedAt) {
          state = 'later';
          const waits = milestoneDeps(body, m).filter((d) => !plan.runs[d]?.passedAt);
          why = waits.length ? `Starts after “${waits.map((d) => milestoneTitle.get(d) ?? d).join('” and “')}”` : 'Starts with its milestone';
        } else if (waitsOn.length || outside.length) {
          state = 'blocked';
          why = `Waits on ${[...waitsOn.map((b) => `“${titleOf.get(b) ?? b}”`), ...outside.map((i) => i.key)].join(', ')}`;
        } else if (unmerged.length > 1) {
          // Several unmerged branches: it starts from them combined (the pilot makes that base).
          froms = unmerged.flatMap((b) => base.get(b)?.issue?.branch ?? []);
          if (froms.length < 2) [from, froms] = [froms[0], undefined];
        } else if (unmerged.length === 1) {
          from = base.get(unmerged[0]!)?.issue?.branch;
        }
        // Nothing unmerged to build on: the plan's branch as it is now (earlier milestones merged in).
        if (state === 'ready' && !from && !froms && plan.branch) from = plan.branch;
        // Being combined right now: shown as under way, never as waiting in silence.
        combining = state === 'ready' ? plan.combining?.[t.id] : undefined;
        if (combining) {
          // A conflict nobody could fix yet waits for you (it says where); otherwise it's under way.
          state = combining.conflict?.stuck ? 'blocked' : 'running';
          if (combining.conflict?.stuck) why = combiningStep(combining);
          else step = combiningStep(combining);
        }
      }
      // Handed to the milestone's Claude (its worktree linked), not begun: it's next in that worktree.
      const agent = plan.runs[m.id]?.agent;
      const queued = state === 'ready' && !combining && Boolean(agent && own.issue && !own.issue.worktreeGone && own.issue.worktrees.at(-1) === agent.worktree);
      const watch = plan.watch?.[t.id];
      if (state === 'idle' && watch?.needsYou) state = 'stalled';
      const started = (state === 'running' && !combining) || state === 'asking' || state === 'idle' || state === 'stalled';
      const pulse = started && own.worktree ? pulseOf(live.run?.(`ws:${own.worktree}`), state === 'asking', watch) : undefined;
      const waiting = started && own.worktree ? live.waiting?.(`ws:${own.worktree}`) : undefined;
      views.set(t.id, {
        task: t,
        milestoneId: m.id,
        ...(own.issue ? { issue: own.issue } : {}),
        state,
        ...(own.worktree ? { worktree: own.worktree } : queued ? { worktree: agent!.worktree } : {}),
        waitsOn,
        ...(why ? { why } : {}),
        ...(from ? { base: from } : {}),
        ...(froms ? { bases: froms } : {}),
        ...(combining ? { combining } : {}),
        ...(step ? { step } : {}),
        forYou,
        ...(pulse ? { pulse } : {}),
        ...(watch && started ? { watch } : {}),
        ...(waiting?.length ? { waiting } : {}),
        ...(queued ? { queued } : {}),
      });
    }
  });

  const milestones: MilestoneView[] = body.milestones.map((m, index) => {
    const tasks = m.tasks.map((t) => views.get(t.id)!);
    const counted = tasks.filter((t) => t.state !== 'canceled' && t.state !== 'missing');
    const done = counted.filter((t) => FINISHED.has(t.state)).length;
    const run = plan.runs[m.id] ?? {};
    const autonomy = autonomyOf(plan, m);
    const merging = plan.merging?.[m.id];
    // Its Claude's worktree is there while a task of it still links it (archived or deleted: gone).
    const agent = run.agent && tasks.some((t) => t.issue && t.issue.worktrees.at(-1) === run.agent!.worktree && !t.issue.worktreeGone) ? run.agent : undefined;
    let state: MilestoneState;
    if (merging && !merging.catchUp) state = 'merging';
    else if (run.passedAt) state = 'passed';
    else if (!openIds.has(m.id)) state = 'later';
    else if (done < counted.length) state = 'running';
    else if (run.check && run.checkAsked !== undefined && run.check.at >= run.checkAsked) state = run.check.verdict === 'fail' ? 'failed' : 'gate';
    else if (run.checkAsked !== undefined) state = 'checking';
    else state = 'gate';
    const agentNow = agent && state !== 'passed' ? agentPulse(live, agent) : undefined;
    return { milestone: m, index, state, tasks, finished: done, total: counted.length, autonomy, run, dependsOn: milestoneDeps(body, m), ...(merging ? { merging } : {}), ...(agent ? { agent } : {}), ...(agentNow ? { agentNow } : {}) };
  });

  const open = milestones.filter((m) => openIds.has(m.milestone.id));
  const current = open[0];
  const all = milestones.flatMap((m) => m.tasks);
  const ready = open.flatMap((m) => m.tasks).filter((t) => t.state === 'ready');
  const active = all.filter((t) => ACTIVE.has(t.state));
  const counted = all.filter((t) => t.state !== 'canceled' && t.state !== 'missing');
  const view = { plan, body, milestones, open, ...(current ? { current } : {}), ready, active, done: counted.filter((t) => FINISHED.has(t.state)).length, total: counted.length };
  return { ...view, next: nextStep(plan, view) };
}

function nextStep(plan: Plan, v: Omit<PlanView, 'next'>): NextStep {
  if (plan.status === 'done') {
    if (plan.draft) return { kind: 'review_changes' };
    // Its work is on the plan's branch, not in main yet.
    if (plan.branch && !plan.shipped && v.milestones.some((m) => m.tasks.some((t) => t.state === 'planned'))) return { kind: 'ship', branch: plan.branch, ...(plan.pr ? { pr: plan.pr } : {}) };
    return { kind: 'done' };
  }
  if (plan.draft) return { kind: 'review_changes' };
  if (plan.paused) return { kind: 'resume' };
  if (!v.open.length) return { kind: 'done' };
  const asking = v.active.filter((t) => t.state === 'asking');
  if (asking.length) return { kind: 'answer', tasks: asking };
  const stalled = v.active.filter((t) => t.state === 'stalled');
  if (stalled.length) return { kind: 'stalled', tasks: stalled };
  // Milestones running side by side: what's yours to do in any of them comes first.
  const failed = v.open.find((m) => m.state === 'failed');
  if (failed) return { kind: 'failed', milestone: failed };
  const merging = v.open.find((m) => m.state === 'merging');
  if (merging?.merging) return { kind: 'merging', milestone: merging, text: mergingText(merging.merging, merging.milestone.title, plan.branch) };
  // Yours to pass only once there's something to go on: Claude's check came back (or there's
  // nothing to check). While the head Claude checks, on every mode, the plan waits on Claude.
  // On Autopilot only once its merge failed: Autopilot won't pass it again, so Pass Again is yours.
  const yoursToPass = v.open.find((m) => m.state === 'gate' && (m.run.check || !m.milestone.criteria.length) && (m.run.mergeFailed || !(m.autonomy === 'autopilot' && m.milestone.criteria.length)));
  if (yoursToPass) return { kind: 'pass', milestone: yoursToPass };
  const autonomyOfTask = new Map(v.open.map((m) => [m.milestone.id, m.autonomy]));
  // Tasks for you, or (step by step) every task, wait for your click.
  const yours = v.ready.filter((t) => !t.queued && (t.forYou || autonomyOfTask.get(t.milestoneId) === 'step'));
  if (yours.length && v.active.length < plan.maxParallel) return { kind: 'start', tasks: yours };
  const checking = v.open.find((m) => m.state === 'checking' || (m.state === 'gate' && m.milestone.criteria.length && !m.run.check));
  if (checking) return { kind: 'checking', milestone: checking };
  const running = v.active.filter((t) => t.state === 'running');
  const note = v.active.flatMap((t) => (t.watch ? [t.watch] : [])).sort((a, b) => b.at - a.at)[0]?.line;
  if (v.active.length) return { kind: 'working', tasks: running.length ? running : v.active, ...(note ? { note } : {}) };
  if (v.ready.length) return { kind: 'working', tasks: [] };
  const blocked = v.open.flatMap((m) => m.tasks).find((t) => t.state === 'blocked');
  return { kind: 'waiting', why: blocked?.why ?? 'Waiting on its tasks' };
}

/**
 * Tasks the scheduler may start now, across every open milestone, within the plan's limit (none
 * when paused or a draft; none of a milestone at a gate or run step by step). `skip`: board tasks
 * not to start (failed before); `starting`: how many are being started right now (they count
 * against the limit, which is the whole plan's).
 */
export function startable(view: PlanView, skip: ReadonlySet<string> = new Set(), starting = 0): readonly TaskView[] {
  const { plan } = view;
  if (plan.paused || plan.status !== 'active' || plan.draft) return [];
  const auto = new Set(view.open.filter((m) => m.state === 'running' && m.autonomy !== 'step').map((m) => m.milestone.id));
  const room = Math.max(0, plan.maxParallel - view.active.length - starting);
  return view.ready.filter((t) => auto.has(t.milestoneId) && !t.forYou && !t.queued && !(t.issue && skip.has(t.issue.id))).slice(0, room);
}

/** A milestone's tasks in the order its Claude does them: what a task builds on comes first (else the plan's order). */
export function taskOrder(m: Pick<MilestoneView, 'milestone' | 'tasks'>): readonly TaskView[] {
  const byId = new Map(m.tasks.map((t) => [t.task.id, t]));
  return waves(m.milestone).flatMap((w) => w.flatMap((t) => byId.get(t.id) ?? []));
}

/** What a milestone's Claude does (or did): its tasks that aren't the user's, canceled or gone. */
export function agentTasks(m: Pick<MilestoneView, 'milestone' | 'tasks'>): readonly TaskView[] {
  return taskOrder(m).filter((t) => !t.forYou && t.issue && t.state !== 'canceled' && t.state !== 'missing');
}

/** Milestones whose Claude is at work (its worktree is there and it has unfinished tasks): each counts as one against the plan's limit. */
export function agentsAtWork(view: PlanView): readonly MilestoneView[] {
  return view.open.filter((m) => m.agent && agentTasks(m).some((t) => !FINISHED.has(t.state)));
}

/**
 * Tasks only you can do (assigned to you), ready now in an open milestone: a milestone's Claude
 * skips them, and what builds on them waits. The hook for asking you (see PilotDeps.forYou).
 */
export function waitingOnYou(view: PlanView): readonly TaskView[] {
  if (view.plan.paused || view.plan.status !== 'active' || view.plan.draft) return [];
  return view.ready.filter((t) => t.forYou);
}

/** Tasks running side by side right now that touch the same files (a likely conflict), by pairs. */
export function overlaps(view: PlanView): ReadonlyArray<readonly [TaskView, TaskView, readonly string[]]> {
  const busy = view.active;
  const out: Array<readonly [TaskView, TaskView, readonly string[]]> = [];
  for (let i = 0; i < busy.length; i++) {
    for (let j = i + 1; j < busy.length; j++) {
      const a = busy[i]!;
      const b = busy[j]!;
      const shared = (a.task.touches ?? []).filter((x) => (b.task.touches ?? []).some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
      if (shared.length) out.push([a, b, shared]);
    }
  }
  return out;
}

/** Topological waves inside a milestone: tasks in the same wave can run side by side. */
export function waves(milestone: PlanMilestone): ReadonlyArray<readonly PlanTask[]> {
  const inside = new Map(milestone.tasks.map((t) => [t.id, t]));
  const level = new Map<string, number>();
  const depth = (t: PlanTask, seen: Set<string>): number => {
    const known = level.get(t.id);
    if (known !== undefined) return known;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const d = Math.max(-1, ...t.blockedBy.flatMap((b) => (inside.has(b) ? [depth(inside.get(b)!, seen)] : []))) + 1;
    level.set(t.id, d);
    return d;
  };
  for (const t of milestone.tasks) depth(t, new Set());
  const out: PlanTask[][] = [];
  for (const t of milestone.tasks) (out[level.get(t.id) ?? 0] ??= []).push(t);
  return out.filter(Boolean);
}

const NOTHING_WAITING: readonly WaitingMessage[] = [];

/** Who's working in a conversation now, read from the shared state. */
export function liveFrom(state: {
  readonly log: ReadonlyArray<{ readonly type: string; readonly channel: string; readonly status?: string; readonly steps?: readonly string[]; readonly requestId?: string; readonly ts: number; readonly text?: string; readonly prompt?: string; readonly lastAt?: number; readonly stepAt?: number; readonly progress?: string; readonly between?: 'thinking' | 'writing'; readonly betweenAt?: number; readonly subagents?: ReadonlyArray<{ readonly status: string; readonly kind?: string }> }>;
  readonly questions: ReadonlyArray<{ readonly channel: string }>;
  readonly approvals: ReadonlyArray<{ readonly channel?: string }>;
}): Live {
  type Item = (typeof state.log)[number];
  const last = new Map<string, Item>();
  /** The newest run in each conversation (the one Claude did something in last) that isn't a message still waiting behind it. */
  const runs = new Map<string, Item>();
  const heard = (l: Item): number => Math.max(l.ts, l.lastAt ?? 0);
  const waiting = new Map<string, WaitingMessage[]>();
  for (const l of state.log) {
    if (l.type !== 'agent') continue;
    last.set(l.channel, l);
    const m = messageState({ status: l.status ?? '', ...(l.text !== undefined ? { text: l.text } : {}), ...(l.steps ? { steps: l.steps } : {}) });
    if (m === 'queued' || m === 'in_turn') {
      const list = waiting.get(l.channel) ?? [];
      list.push({ requestId: l.requestId ?? '', prompt: l.prompt ?? '', queued: m === 'queued' });
      waiting.set(l.channel, list);
    } else if (heard(l) >= heard(runs.get(l.channel) ?? l)) runs.set(l.channel, l);
  }
  const made = new Map<string, RunInfo | undefined>();
  const asking = new Set([...state.questions.map((q) => q.channel), ...state.approvals.flatMap((a) => (a.channel ? [a.channel] : []))]);
  const RUNNING = new Set(['queued', 'awaiting_approval', 'started', 'answered']);
  return {
    busy: (channel) => RUNNING.has(last.get(channel)?.status ?? ''),
    asking: (channel) => asking.has(channel),
    step: (channel) => (runs.get(channel) ?? last.get(channel))?.steps?.at(-1),
    // The same answer for the same log (screens read these as snapshots).
    run: (channel) => {
      if (made.has(channel)) return made.get(channel);
      const l = runs.get(channel) ?? last.get(channel);
      made.set(channel, l ? runInfo(l) : undefined);
      return made.get(channel);
    },
    waiting: (channel) => waiting.get(channel) ?? NOTHING_WAITING,
  };
  function runInfo(l: Item): RunInfo {
    const step = l.steps?.at(-1);
    const command = [...(l.steps ?? [])].reverse().find((s) => s.startsWith('Bash '));
    return {
      requestId: l.requestId ?? '',
      status: l.status ?? '',
      ts: l.ts,
      lastAt: l.lastAt ?? l.ts,
      text: l.text ?? '',
      ...(step ? { step } : {}),
      ...(l.stepAt !== undefined ? { stepAt: l.stepAt } : {}),
      ...(l.progress ? { progress: l.progress } : {}),
      ...(command ? { command } : {}),
      ...(l.between ? { between: l.between, ...(l.betweenAt !== undefined ? { betweenAt: l.betweenAt } : {}) } : {}),
      ...(l.subagents?.some((sub) => sub.status === 'running' && sub.kind !== 'background') ? { subOpen: true } : {}),
    };
  }
}
