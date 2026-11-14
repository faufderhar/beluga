import { outsideActingAgent } from '../acting-agent.js';
import type { AgentRef } from '../../protocol.js';
import type { CombineResult } from '../../workspaces/git.js';
import type { Actor, BoardState, Issue } from '../board/model.js';
import type { BoardWork } from '../board/work.js';
import type { Action, Store } from '../store.js';
import { openMilestone } from './apply.js';
import { openMilestoneEpic } from './epics.js';
import { type Plan, type PlanMerge, type PlanMilestone, allTasks, openMilestones, planBranchName } from './model.js';
import type { PlanGit } from './plan-git.js';
import type { Plans } from './plans.js';
import { FINISHED, type MilestoneView, type PlanView, type TaskState, type TaskView, agentTasks, agentsAtWork, liveFrom, planView, startable, tidyOffer, waitingOnYou } from './progress.js';
import { checkFailedPrompt, checkNudgePrompt, checkPrompt, criteriaNeedCheck, fixupPrompt, mainFixupPrompt, mergeFixupPrompt, milestoneNextPrompt, milestonePrompt, recapPrompt, stuckPrompt } from './prompt.js';
import { TaskWatchdog } from './watchdog.js';
import { PLAN_PR_FAST_MS, PLAN_PR_FOCUS_FRESH_MS, planPrCadence } from './pr-cadence.js';
import { pace } from '../power-saver.js';

/**
 * The scheduler: runs approved plans as far as their autonomy allows. It starts what's ready
 * (never more than the plan's limit, never a blocked task, never twice), asks the head Claude to
 * check a milestone once its tasks are finished, passes it on autopilot when the check passed,
 * opens every milestone whose dependencies have passed (independent ones run side by side, each
 * with its own check and pass), and asks for a recap at the end. A task that builds on several
 * unmerged tasks starts from their branches combined (a conflict there goes to the head Claude). Claude can't get around it: starting
 * and passing go through here. It acts a moment after whatever changed (the board, a run, a plan).
 *
 * With git (`git`), the plan owns a branch, plan/<slug> from main: every task starts from it as it is
 * then, a passed milestone's task branches merge into it (its tasks go Merged into Plan, their worktrees are
 * archived and their branches deleted), and the plan ends as one pull request into main, which
 * moves every Merged into Plan task to Done when it merges. Plans that ran before this catch up once.
 *
 * A started task whose Claude stopped without finishing is woken once, and waits for you when it
 * stops again soon after (see watchdog.ts); time alone can stall a turn, so it looks every minute.
 *
 * One Claude per milestone (the default, `workers: 'milestone'`): an open milestone with work
 * ready gets one worktree and one Claude, which does its tasks one after another in the order
 * they build on each other, keeping its context (a worktree per task spent most of its time
 * finding its way around again). Every task links that worktree, and its Claude moves each one
 * along on the board itself (In Progress, its criteria, proof, In Review), so tasks still show
 * one by one. Its turn ending with tasks left, it's sent on (once per step: then it's yours);
 * tasks added later (a failed check's fixes) go to the same Claude. Tasks for you are never
 * its: they wait for you (see PilotDeps.forYou). Milestones still run side by side, the plan's
 * limit counting milestones at work. `workers: 'task'` is the older way: a worktree per task.
 */

export interface PilotDeps {
  readonly store: Store;
  readonly plans: Plans;
  readonly work: BoardWork;
  /** Ask your Claude in a conversation; `echo: false` doesn't show the prompt as your message. Returns the request's id, when it can. */
  readonly askClaude: (prompt: string, channel: string, echo: boolean) => string | void;
  /** Steer a waiting message in now (the agent host's Steer Now: interrupts a long command or a dead run). */
  readonly promote?: (requestId: string) => boolean;
  /** A quiet line in a conversation. */
  readonly system: (channel: string, text: string) => void;
  /** Combine unmerged branches into the start of a task (its key): see WorkspaceManager.combineBase. */
  readonly combine?: (projectId: string, key: string, branches: readonly string[], into?: string) => Promise<CombineResult>;
  /** The plan's branch, merges into it, clearing merged worktrees away, its pull request. */
  readonly git?: PlanGit;
  /** Let a plan's conversation edit a hidden worktree (a conflict to fix there), or no longer (undefined). */
  readonly allowFixup?: (channel: string, dir: string | undefined) => void;
  /** Whether a run of Claude's is under way in a conversation: its Claude Code process is there (the agent runner's run state). */
  readonly alive?: (channel: string) => boolean;
  /** Stop what runs in a conversation; resolves once nothing does, with the messages that waited there. */
  readonly takeOver?: (channel: string) => Promise<readonly string[]>;
  readonly now?: () => number;
  readonly delayMs?: number;
  /** A run's events re-check its plans at most this often (they stream all the time): default 1 s, or delayMs when that's given. */
  readonly eventMs?: number;
  /** Who does a milestone's tasks: one Claude for the whole milestone (default), or a worktree per task. */
  readonly workers?: 'milestone' | 'task';
  /** Beluga no longer needs a request of its own (a check you passed past): out of the queue, or its run stopped. */
  readonly cancel?: (requestId: string) => void;
  /**
   * A conversation of its own to check a milestone in (its workspace id), so the head Claude's stays
   * free and milestones are checked side by side. Without it, the head Claude checks (as before).
   */
  readonly checkerChat?: (plan: Plan, milestone: PlanMilestone) => Promise<string | undefined>;
  /** A checker's conversation is no longer needed (its milestone passed): archived, what was said kept. */
  readonly retireChat?: (workspaceId: string) => void;
  /**
   * Tasks only you can do came up (ready, in an open milestone), each once: the hook for asking you
   * (the plan's chat). A milestone's Claude skips them, and what builds on them waits.
   */
  readonly forYou?: (plan: Plan, tasks: readonly TaskView[]) => void;
  /** The plan's epics on the board, made or brought up to date (once a session here: approving keeps them true). */
  readonly structure?: (plan: Plan) => void;
  /** How long a plan may sit quiet with Claude's work left before Beluga moves it along (default RESCUE_MS). */
  readonly rescueMs?: number;
}

/** How many times the head Claude is asked to fix one task's combining conflict before it waits for you. */
const FIXUP_ASKS = 2;
/** A conflict left to you is looked at again this often (it starts once no markers are left). */
const STUCK_RETRY_MS = 30_000;
/** A check asked before a restart, with nothing running in its conversation this long after: it ended without a verdict. */
const CHECK_QUIET_MS = 60_000;
/** How often started tasks are looked at when nothing else happens (a turn can stall in silence). */
const HEARTBEAT_MS = 60_000;
/** Nothing of a plan running, and nothing of it yours, this long: Beluga moves it along (see rescue). */
export const RESCUE_MS = 3 * 60_000;
/** Steps Beluga takes for one stalled milestone, across kinds of stall, before it's yours. */
export const MAX_RESCUES = 6;


/** Why a milestone can't be merged yet: a task of it still being worked on (undefined: none). */
function stillWorking(m: MilestoneView): string | undefined {
  const words: Partial<Record<TaskState, string>> = { running: 'is running', asking: 'asks you something', idle: 'is still open', stalled: 'stopped without finishing' };
  // Handed to the milestone's Claude and not begun: its worktree is still in use too.
  const busy = m.tasks.filter((t) => t.issue && !t.issue.worktreeGone && (words[t.state] || t.queued));
  if (!busy.length) return undefined;
  const who = busy.map((t) => `${t.issue!.key} ${t.queued ? 'is next for its milestone’s agent' : words[t.state]}`).join(', ');
  return `“${m.milestone.title}” can’t be merged yet: ${who}. Merging retires each task’s worktree and branch, so only tasks In Review are merged: let them finish (or stop them), then pass it.`;
}

/** pass() said no because a task is still being worked on: Autopilot waits for it instead of reporting a problem. */
class StillWorkingError extends Error {}

/** What changes can move a plan along. */
const WAKES = new Set(['board_issue', 'board_remove', 'plan_put', 'agent_event', 'question_add', 'question_remove', 'approval_add', 'approval_remove', 'projects']);
const EVENT_MS = 1000;
/** A run that's under way (or waiting to be). */
const RUNNING = new Set(['queued', 'awaiting_approval', 'started', 'answered']);
const milestoneName = (plan: Plan, id: string): string => plan.body?.milestones.find((m) => m.id === id)?.title ?? id;
const WS_PREFIX = 'ws:';

/**
 * How far a plan has got: tasks finished out of how many, milestones passed, checks recorded. A
 * rescue goes up its ladder while this stays the same, and starts over once it moves (a nudge that
 * only stirs things, a woken task that stops again, doesn't count as moving).
 */
export function progressMark(view: PlanView): string {
  const passed = view.milestones.filter((m) => m.run.passedAt).length;
  const checks = view.milestones.reduce((n, m) => n + (m.run.check ? m.run.check.at : 0), 0);
  return `${view.done}/${view.total}:${passed}:${checks}`;
}

/** The plan's own ladder, when what it waits on is no one milestone's. */
const PLAN_UNIT = '_plan';

/** What a milestone is stuck on, when it's Claude's to move. */
export type StallKind = 'checking' | 'stalled' | 'working' | 'failed' | 'merging' | 'waiting';

/**
 * Whether an open milestone has Claude's work left to move (undefined: nothing, or it's yours: a
 * pass on Check-ins, a task for you, a step-by-step start).
 */
export function stallOf(view: PlanView, m: MilestoneView): StallKind | undefined {
  if (m.state === 'merging') return 'merging';
  if (m.state === 'failed') return m.autonomy === 'autopilot' ? 'failed' : undefined;
  if (m.tasks.some((t) => t.state === 'asking')) return undefined;
  if (m.tasks.some((t) => t.state === 'stalled')) return 'stalled';
  if (m.state === 'checking' || (m.state === 'gate' && m.milestone.criteria.length && !m.run.check)) return 'checking';
  if (m.state !== 'running' || m.autonomy === 'step') return undefined;
  const todo = agentTasks(m).filter((t) => !FINISHED.has(t.state));
  return todo.some((t) => t.state === 'ready' || t.state === 'idle' || t.state === 'running') ? 'working' : undefined;
}

/** How far one milestone has got: its tasks finished out of how many, its check, its merge, passed. */
export function milestoneMark(m: MilestoneView): string {
  const counted = m.tasks.filter((t) => t.state !== 'canceled' && t.state !== 'missing');
  return `${counted.filter((t) => FINISHED.has(t.state)).length}/${counted.length}:${m.run.check?.at ?? 0}:${m.merging?.conflict?.at ?? 0}:${m.run.passedAt ?? 0}`;
}

/** What a stalled milestone waits on, in words. */
export function stallWords(m: MilestoneView, kind: StallKind): string {
  const title = `“${m.milestone.title}”`;
  switch (kind) {
    case 'checking':
      return `the check of ${title}`;
    case 'failed':
      return `fix tasks for ${title}, whose check failed`;
    case 'merging':
      return `merging ${title} into the plan’s branch`;
    case 'stalled':
      return `${m.tasks.filter((t) => t.state === 'stalled').map((t) => t.issue?.key ?? t.task.title).join(', ')} in ${title}, whose Claude stopped`;
    default:
      return `the work of ${title} (nothing of it is running)`;
  }
}

/** What a stalled plan waits on, in words. */
export function waitsOnWords(view: PlanView): string {
  const n = view.next;
  const keys = (tasks: readonly TaskView[]): string => tasks.map((t) => t.issue?.key ?? t.task.title).join(', ') || 'its ready tasks';
  switch (n.kind) {
    case 'checking':
      return `the check of “${n.milestone.milestone.title}”`;
    case 'failed':
      return `fix tasks for “${n.milestone.milestone.title}”, whose check failed`;
    case 'merging':
      return `merging “${n.milestone.milestone.title}” into the plan’s branch`;
    case 'stalled':
      return `${keys(n.tasks)}, whose Claude stopped`;
    case 'working':
      return `${keys(n.tasks)} (nothing is running)`;
    case 'waiting':
      return n.why;
    default:
      return n.kind;
  }
}

/** The plans each conversation belongs to: a plan's home, and its tasks' worktrees. */
export function plansByChannel(plans: readonly Plan[], board: BoardState): Map<string, Set<string>> {
  const planOfIssue = new Map<string, string>();
  for (const plan of plans) for (const { task } of allTasks(plan.body)) if (task.issueId) planOfIssue.set(task.issueId, plan.id);
  const out = new Map<string, Set<string>>();
  const add = (channel: string, planId: string): void => void (out.get(channel) ?? out.set(channel, new Set()).get(channel)!).add(planId);
  for (const plan of plans) add(plan.home, plan.id);
  for (const plan of plans) for (const run of Object.values(plan.runs ?? {})) if (run?.checker) add(`${WS_PREFIX}${run.checker}`, plan.id);
  for (const issue of board.issues) {
    const planId = planOfIssue.get(issue.id);
    if (planId) for (const ws of issue.worktrees) add(`${WS_PREFIX}${ws}`, planId);
  }
  return out;
}

export class PlanPilot {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Board tasks being started now (a worktree takes a few seconds to make). */
  private readonly starting = new Set<string>();
  /** Board tasks that failed to start: not tried again by themselves (you can start them). */
  private readonly failed = new Set<string>();
  /** Started tasks whose Claude stopped without finishing: woken once, then yours. */
  private readonly watchdog: TaskWatchdog;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly recapped = new Set<string>();
  /** Milestones whose tasks were taken out of the Backlog (`plan:milestone`), once each. */
  private readonly opened = new Set<string>();
  /** Combining conflicts the head Claude was asked to fix, by board task: how often, and its conversation's last run before. */
  private readonly fixAsked = new Map<string, { readonly asks: number; readonly after?: string }>();
  /** When a conflict left to you was last looked at (by board task), and the timer to look again. */
  private readonly stuckTried = new Map<string, number>();
  private stuckTimer: ReturnType<typeof setTimeout> | undefined;
  /** Plans whose branch is being made, and those where that failed (they run without one). */
  private readonly branching = new Set<string>();
  private readonly noBranch = new Set<string>();
  /** Merges into a plan's branch under way (`plan:milestone`), one plan's at a time (its chain). */
  private readonly mergingNow = new Set<string>();
  private readonly mergeChain = new Map<string, Promise<void>>();
  /** Plans whose pull request is being merged now (a second click waits for the first). */
  private readonly prMerging = new Set<string>();
  private prTimer: ReturnType<typeof setInterval> | undefined;
  /** When each plan's PR was last looked at, and when Beluga last pushed its branch. */
  private readonly prChecked = new Map<string, number>();
  private readonly prPushed = new Map<string, number>();
  private prPolling = false;
  /** Each plan's tasks as last seen (by plan task id): a task that comes back finished is written down once. */
  private readonly seen = new Map<string, ReadonlyMap<string, TaskState>>();
  private readonly off: () => void;
  private stopped = false;
  /** What the next tick looks at: every plan, or only those whose conversations had run events. */
  private dueAll = false;
  private readonly duePlans = new Set<string>();
  private dueAt = 0;
  private lastTick = -Infinity;
  private channels?: { readonly plans: readonly Plan[]; readonly board: BoardState; readonly map: Map<string, Set<string>> };
  /** Milestones whose Claude is being started now (`plan:milestone`). */
  private readonly launching = new Set<string>();
  /**
   * What each milestone's Claude was last sent (`plan:milestone`): the tasks ready then, its
   * conversation's last run before, how often for those same tasks; `told`: it's been left to you.
   */
  private readonly sentOn = new Map<string, { readonly sig: string; readonly after?: string; readonly count: number; readonly told?: boolean }>();
  /** Milestones whose Claude got tasks since it was last sent on (they're new to it). */
  private readonly handed = new Set<string>();
  /** Tasks for you already passed to the forYou hook (`plan:task`). */
  private readonly toldYou = new Set<string>();
  /** The head Claude's check of a milestone under way (`plan:milestone` → its request). */
  private readonly checkRuns = new Map<string, string>();
  /** Checks whose conversation is being made now (`plan:milestone`). */
  private readonly askingCheck = new Set<string>();
  /** Check rounds (`plan:milestone:asked`) that ended without a verdict: asked once more, then left to you. */
  private readonly checkNudged = new Map<string, 'asked' | 'told'>();
  /** Milestones whose check moved from the head Claude to a checker this session (`plan:milestone`): once. */
  private readonly handedOver = new Set<string>();
  /** Since when each plan has had nothing running and nothing of it yours (see rescue). */
  private readonly quietSince = new Map<string, number>();
  /** Plans whose epics were made or caught up this session. */
  private readonly structured = new Set<string>();

  constructor(private readonly deps: PilotDeps) {
    this.watchdog = new TaskWatchdog({
      store: deps.store,
      plans: deps.plans,
      askClaude: deps.askClaude,
      system: deps.system,
      ...(deps.alive ? { alive: deps.alive } : {}),
      ...(deps.takeOver ? { takeOver: deps.takeOver } : {}),
      ...(deps.promote ? { promote: deps.promote } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.off = deps.store.onAction((a: Action) => {
      if (a.type === 'agent_event') this.onRunEvent(a.channel);
      else if (WAKES.has(a.type)) this.schedule();
    });
    this.schedule();
    this.heartbeat = setInterval(() => this.schedule(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    if (deps.git) {
      // Each tick looks only at the plans whose PR is due (see pr-cadence.ts).
      this.prTimer = setInterval(() => void this.pollPrs('tick'), PLAN_PR_FAST_MS);
      this.prTimer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    this.off();
    clearTimeout(this.timer);
    clearTimeout(this.stuckTimer);
    clearInterval(this.prTimer);
    clearInterval(this.heartbeat);
  }

  /** Look at every plan a moment from now. */
  schedule(): void {
    this.dueAll = true;
    this.arm(this.deps.delayMs ?? 300);
  }

  /** A run's event: its plans are looked at, at most once every eventMs (none, when it's no plan's). */
  private onRunEvent(channel: string | undefined): void {
    if (this.stopped) return;
    if (channel === undefined) this.dueAll = true;
    else {
      const ids = this.plansOf(channel);
      if (!ids?.size) return;
      for (const id of ids) this.duePlans.add(id);
    }
    const delay = this.deps.delayMs ?? 300;
    this.arm(Math.max(delay, this.lastTick + (this.deps.eventMs ?? this.deps.delayMs ?? EVENT_MS) - Date.now()));
  }

  private plansOf(channel: string): ReadonlySet<string> | undefined {
    const plans = this.deps.plans.list();
    const board = this.deps.store.getState().board;
    if (this.channels?.plans !== plans || this.channels.board !== board) this.channels = { plans, board, map: plansByChannel(plans, board) };
    return this.channels.map.get(channel);
  }

  /** Tick after `wait` (sooner if a tick is already due sooner). */
  private arm(wait: number): void {
    if (this.stopped) return;
    const at = Date.now() + wait;
    if (this.timer) {
      if (this.dueAt <= at) return;
      clearTimeout(this.timer);
    }
    this.dueAt = at;
    // Armed from an external agent's call too, and what it then starts isn't that agent's.
    this.timer = outsideActingAgent(() =>
      setTimeout(() => {
        this.timer = undefined;
        this.lastTick = Date.now();
        const only = this.dueAll ? undefined : new Set(this.duePlans);
        this.dueAll = false;
        this.duePlans.clear();
        this.tick(only);
      }, wait),
    );
    this.timer.unref?.();
  }

  /** A plan where it stands now. */
  view(plan: Plan): PlanView {
    const state = this.deps.store.getState();
    return planView(plan, state.board, liveFrom(state));
  }

  /** Move the plans along (only those in `only`, when given). */
  tick(only?: ReadonlySet<string>): void {
    for (const plan of this.deps.plans.list()) {
      if (only && !only.has(plan.id)) continue;
      // Moved to another computer (BLG-806): it runs there, this is only its record.
      if (plan.movedTo) continue;
      try {
        // Plans from before epics: their shape goes on the board once.
        if (plan.body && plan.status !== 'draft' && !this.structured.has(plan.id)) {
          this.structured.add(plan.id);
          this.deps.structure?.(plan);
        }
        // Its branch, catching up, merges: paused or done, they go on (nothing new starts).
        if (plan.body && plan.status !== 'draft') this.tend(plan);
        // Started tasks that stopped without finishing: woken once, then they wait for you.
        if (plan.body && plan.status === 'active') this.watch(this.deps.plans.need(plan.id));
        if (plan.status === 'active' && !plan.paused && !plan.draft) this.step(this.deps.plans.need(plan.id));
      } catch (err) {
        // Said once (a problem that stays would otherwise fill the history).
        const text = `couldn’t move the plan along: ${err instanceof Error ? err.message : String(err)}`;
        if (plan.activity.at(-1)?.text !== text) this.deps.plans.note(plan.id, 'problem', text, { kind: 'beluga' });
      }
    }
  }

  /**
   * Start one task now (you, or the head Claude when you asked it). `agent` (Start with…, BLG-506):
   * who works it this once, instead of the task's own agent or the plan's; a milestone whose agent
   * is already at work keeps that one.
   */
  async startNow(planId: string, taskId: string, by: Actor, agent?: AgentRef): Promise<string> {
    const plan = this.deps.plans.need(planId);
    if (plan.movedTo) throw new Error(`This plan moved to ${plan.movedTo.name}: it runs there now`);
    if (plan.status !== 'active' || !plan.body) throw new Error('The plan isn’t approved yet');
    if (plan.draft) throw new Error('Changes to the plan are waiting for approval: approve or discard them first');
    const view = this.view(plan);
    const t = view.milestones.flatMap((m) => m.tasks).find((x) => x.task.id === taskId || x.issue?.key === taskId.toUpperCase());
    if (!t) throw new Error(`There's no task "${taskId}" in this plan`);
    // Yours: it's a decision in the plan's conversation, never a worktree (see decisions.ts).
    if (t.forYou) throw new Error(`${t.issue?.key ?? t.task.id} “${t.task.title}” is the user’s: it’s answered in the plan’s conversation, not started in a worktree`);
    // Claude starts nothing on a paused plan, nor on one you run step by step (you do).
    const autonomy = view.milestones.find((m) => m.milestone.id === t.milestoneId)?.autonomy ?? plan.autonomy;
    if (by.kind === 'claude' && (plan.paused || autonomy === 'step')) throw new Error(plan.paused ? 'The plan is paused: the user resumes it' : 'This plan runs step by step: the user starts each task');
    // A combine that stopped at a conflict: Start tries it again (fixed since, or asks anew).
    if (t.combining && t.issue) {
      this.fixAsked.delete(t.issue.id);
      this.deps.plans.setCombining(plan.id, t.task.id, { ...t.combining, ...(t.combining.conflict ? { conflict: { ...t.combining.conflict, stuck: false } } : {}) });
    } else if (t.state !== 'ready') throw new Error(`“${t.task.title}” can’t start: ${t.why ?? t.state}`);
    if (this.byMilestone) return this.startInMilestone(plan, view, t, by, agent);
    if (view.active.length + this.startingIn(plan) >= plan.maxParallel) throw new Error(`${plan.maxParallel} tasks are already running (the plan’s limit)`);
    this.failed.delete(t.issue!.id);
    return this.start(plan, t, by, agent);
  }

  /** One milestone, one Claude (see the top): unless the plan says a worktree per task. */
  private get byMilestone(): boolean {
    return (this.deps.workers ?? 'milestone') === 'milestone';
  }

  /** Start a task of a milestone: its Claude gets it (started first if there's none yet). */
  private async startInMilestone(plan: Plan, view: PlanView, t: TaskView, by: Actor, agent?: AgentRef): Promise<string> {
    const m = view.milestones.find((x) => x.milestone.id === t.milestoneId)!;
    const key = `${plan.id}:${m.milestone.id}`;
    if (this.launching.has(key)) return `The agent for “${m.milestone.title}” is starting`;
    const issue = t.issue!;
    this.failed.delete(issue.id);
    if (m.agent) {
      const channel = `ws:${m.agent.worktree}`;
      this.hand(plan, m, [t]);
      this.deps.askClaude(milestoneNextPrompt(this.view(this.deps.plans.need(plan.id)), m, [t], m.autonomy === 'step' ? 'only' : 'new'), channel, false);
      this.sentOn.set(key, { sig: issue.id, ...this.after(channel), count: 1 });
      this.handed.delete(key);
      this.deps.plans.note(plan.id, 'started', `gave ${issue.key} “${t.task.title}” to the agent doing “${m.milestone.title}”`, by);
      // Started with another agent: the milestone's agent at work keeps it (one worktree, one agent).
      const keeps = agent ? ' (a milestone already at work keeps its agent)' : '';
      return `Gave ${issue.key} “${t.task.title}” to the agent doing “${m.milestone.title}”, in its worktree: it does it ${liveFrom(this.deps.store.getState()).busy(channel) ? 'once its current turn ends' : 'now'}${keeps}`;
    }
    if (agentsAtWork(view).length + this.launchingIn(plan) >= plan.maxParallel) throw new Error(`${plan.maxParallel} milestones are already at work (the plan’s limit)`);
    // A task of yours you start yourself: that one, for its Claude (it never takes yours on its own).
    return this.launch(plan, m.milestone.id, by, m.autonomy === 'step' || t.forYou ? [t.task.id] : undefined, agent);
  }

  /**
   * Pass a milestone. With a plan branch, its task branches are merged into it first (it passes once
   * they're in); then those that waited on it open (their tasks come out of the Backlog), or the plan is done.
   */
  pass(planId: string, milestoneId: string, by: Actor): Plan {
    const plan = this.deps.plans.need(planId);
    if (!plan.body?.milestones.some((m) => m.id === milestoneId)) throw new Error('That milestone isn’t in the approved plan');
    if (plan.runs[milestoneId]?.passedAt) return plan;
    if (plan.merging?.[milestoneId]) return plan;
    // Merging retires its tasks' worktrees and branches: never while a Claude still works in one.
    const m = this.deps.git && plan.branch ? this.view(plan).milestones.find((x) => x.milestone.id === milestoneId) : undefined;
    const busy = m ? stillWorking(m) : undefined;
    if (busy) throw new StillWorkingError(busy);
    // Passed past a check still under way: it's no longer needed, and nothing waits behind it.
    this.dropCheck(plan, milestoneId);
    if (!this.deps.git || !plan.branch) return this.passed(planId, milestoneId, by);
    // Said at once (the page shows it merging); the merge runs in the background, and it passes once it's in.
    this.deps.plans.setMergeFailed(planId, milestoneId, undefined);
    const next = this.deps.plans.setMerging(planId, milestoneId, { at: Date.now(), by });
    this.stepMerges(next);
    return next;
  }

  /**
   * The head Claude's check of a milestone that's being passed without it: its run is stopped (or
   * taken out of the queue), so what the plan asks next (a merge's fix-up, the next check, the
   * recap) doesn't wait behind a test run nobody needs. A verdict that comes late is ignored.
   */
  private dropCheck(plan: Plan, milestoneId: string): void {
    const key = `${plan.id}:${milestoneId}`;
    const id = this.checkRuns.get(key);
    this.checkRuns.delete(key);
    const run = plan.runs[milestoneId];
    if (!id || run?.checkAsked === undefined || (run.check && run.check.at >= run.checkAsked)) return;
    const item = this.deps.store.getState().log.find((l) => l.type === 'agent' && l.requestId === id);
    if (item?.type === 'agent' && !RUNNING.has(item.status)) return;
    this.deps.cancel?.(id);
    this.deps.plans.note(plan.id, 'note', `stopped the check of “${milestoneName(plan, milestoneId)}”: it was passed without it`, { kind: 'beluga' });
  }

  /** It passed (its work is in the plan's branch, or there's none): what waited on it opens. */
  private passed(planId: string, milestoneId: string, by: Actor): Plan {
    const before = this.deps.plans.need(planId);
    const passed = before.body?.milestones.find((m) => m.id === milestoneId);
    if (!passed) throw new Error('That milestone isn’t in the approved plan');
    const wasOpen = new Set(openMilestones(before));
    const after = this.deps.plans.pass(planId, milestoneId, by);
    // Its checker is done: archived (what it said is kept, and the plan still knows it).
    const checker = after.runs[milestoneId]?.checker;
    if (checker) this.deps.retireChat?.(checker);
    const next = openMilestones(after)
      .filter((id) => !wasOpen.has(id))
      .map((id) => after.body!.milestones.find((m) => m.id === id)!);
    for (const m of next) this.open(after, m.id);
    if (next.length) {
      this.deps.system(after.home, `“${passed.title}” passed. Next: ${next.map((m) => `“${m.title}”`).join(', ')}${next.length > 1 ? ', side by side' : ''}.`);
    } else if (after.status !== 'done') {
      this.deps.system(after.home, `“${passed.title}” passed.`);
    } else if (!this.recapped.has(after.id)) {
      // The last one: the head Claude writes the recap (and the plan offers its pull request).
      this.recapped.add(after.id);
      if (after.branch) this.deps.system(after.home, `Every milestone passed: ${after.branch} has all the plan’s work. Open its pull request into main, or merge it here, from the plan’s page.`);
      this.deps.askClaude(recapPrompt(this.view(after)), after.home, false);
    }
    this.schedule();
    return after;
  }

  /** A milestone's tasks come out of the Backlog (once a session: you can put one back). */
  private open(plan: Plan, milestoneId: string): void {
    const key = `${plan.id}:${milestoneId}`;
    if (this.opened.has(key)) return;
    this.opened.add(key);
    openMilestone(plan, milestoneId, this.deps.work.board, { kind: 'beluga' });
    openMilestoneEpic(plan, milestoneId, this.deps.work.board, { kind: 'beluga' });
  }

  private step(plan: Plan): void {
    // Tasks start from the plan's branch: none starts before it's there.
    if (this.deps.git && !plan.branch && !this.noBranch.has(plan.id)) return;
    const view = this.view(plan);
    this.noteFinished(plan, view);
    if (!view.open.length) return;
    // Every open milestone runs side by side; the limit on tasks (or milestones at work) at once is the whole plan's.
    for (const m of view.open) this.open(plan, m.milestone.id);
    if (this.byMilestone) this.stepAgents(plan, view);
    else {
      for (const t of startable(view, this.failed, this.startingIn(plan))) void this.start(plan, t, { kind: 'beluga' }).catch(() => undefined);
      this.stepCombining(plan, view);
    }
    this.tellYou(plan, view);
    for (const m of view.open) this.stepMilestone(plan, view, m);
    this.rescue(plan.id);
  }

  // ------------------------------------------------------------------ rescue: a plan never stalls quietly

  /**
   * The rule that keeps a plan going, milestone by milestone: an open milestone with Claude's work
   * left (tasks ready or stopped, a check, a merge, fix tasks on Autopilot) where nothing of it runs
   * and nothing of it waits on you is stalled. After a quiet spell Beluga moves it along, a step
   * further each time it stays stuck: send it on, then a fresh Claude, then the head Claude decides.
   * Only then is it left to you, saying what was tried. Each milestone has its own ladder (one stuck
   * behind another's check is still seen), kept on the plan so a restart goes on from there; it
   * starts over as soon as that milestone moves.
   */
  private rescue(planId: string): void {
    const plan = this.deps.plans.need(planId);
    const view = this.view(plan);
    const now = this.deps.now?.() ?? Date.now();
    const units: Array<{ readonly id: string; readonly m?: MilestoneView; readonly kind: StallKind }> = [];
    for (const m of view.open) {
      const kind = stallOf(view, m);
      if (kind) units.push({ id: m.milestone.id, m, kind });
    }
    // Nothing open is stuck, yet the plan waits on Claude's work (a blocker nobody moves).
    if (!units.length && view.next.kind === 'waiting' && !waitingOnYou(view).length && view.open.length) units.push({ id: PLAN_UNIT, kind: 'waiting' });
    let rescue = { ...(plan.rescue ?? {}) };
    // A milestone that moved (or isn't stuck any more) starts over.
    for (const [id, r] of Object.entries(rescue)) {
      const unit = units.find((u) => u.id === id);
      if (!unit || r.sig !== this.markOf(view, unit.m)) delete rescue[id];
    }
    for (const unit of units) {
      const key = `${plan.id}:${unit.id}`;
      if (this.unitAtWork(plan, view, unit.m, unit.kind)) {
        this.quietSince.delete(key);
        continue;
      }
      const was = rescue[unit.id];
      if (was?.yours) continue;
      const since = this.quietSince.get(key) ?? now;
      this.quietSince.set(key, since);
      if (now - since < (this.deps.rescueMs ?? RESCUE_MS)) continue;
      this.quietSince.delete(key);
      // Stuck on something else now (its check, after its work): that ladder starts at the bottom.
      const tries = was && was.kind === unit.kind ? was.tries : 0;
      const total = was?.total ?? was?.tries ?? 0;
      const tried = was?.tried ?? [];
      const what = unit.m ? stallWords(unit.m, unit.kind) : waitsOnWords(view);
      let did: string | undefined;
      try {
        did = total >= MAX_RESCUES ? undefined : this.rescueStep(plan, view, unit.m, unit.kind, tries, tried, what);
      } catch (err) {
        did = `tried to move it (${err instanceof Error ? err.message : String(err)})`;
      }
      const sig = this.markOf(view, unit.m);
      if (did) {
        rescue = { ...rescue, [unit.id]: { sig, kind: unit.kind, tries: tries + 1, total: total + 1, at: now, tried: [...tried, did].slice(-MAX_RESCUES) } };
        this.deps.plans.note(plan.id, 'note', `${what} went quiet: ${did}`, { kind: 'beluga' });
        continue;
      }
      rescue = { ...rescue, [unit.id]: { sig, kind: unit.kind, tries, total, at: now, tried, yours: true } };
      const text = `Stuck on ${what}. Beluga tried: ${tried.join('; ') || 'nothing it could'}. It needs you now: open the plan's conversation${unit.m ? ', or Pass Anyway' : ''}.`;
      this.deps.plans.note(plan.id, 'problem', text, { kind: 'beluga' });
      this.deps.system(plan.home, text);
    }
    this.deps.plans.setRescue(plan.id, Object.keys(rescue).length ? rescue : undefined);
  }

  /** How far a milestone (or, for the plan, every milestone) has got: see progressMark. */
  private markOf(view: PlanView, m: MilestoneView | undefined): string {
    return m ? milestoneMark(m) : progressMark(view);
  }

  /** Something of this stall runs, asks you, or is being done here right now. */
  private unitAtWork(plan: Plan, view: PlanView, m: MilestoneView | undefined, kind: StallKind): boolean {
    const state = this.deps.store.getState();
    const live = liveFrom(state);
    const channels = new Set<string>();
    if (m) {
      if (m.agent) channels.add(`${WS_PREFIX}${m.agent.worktree}`);
      if (m.run.checker) channels.add(`${WS_PREFIX}${m.run.checker}`);
      for (const t of m.tasks) for (const w of t.issue?.worktrees ?? []) channels.add(`${WS_PREFIX}${w}`);
      // The head Claude works on it for these (a merge's fix-up, fix tasks, its check before checkers).
      if (kind === 'merging' || kind === 'failed' || (kind === 'checking' && !m.run.checker)) channels.add(plan.home);
    } else {
      channels.add(plan.home);
      for (const x of view.open) if (x.agent) channels.add(`${WS_PREFIX}${x.agent.worktree}`);
    }
    for (const c of channels) if (live.busy(c) || live.asking(c) || this.deps.alive?.(c)) return true;
    const key = (id: string): string => `${plan.id}:${id}`;
    if (m) {
      const k = key(m.milestone.id);
      if (this.launching.has(k) || this.askingCheck.has(k) || this.mergingNow.has(k)) return true;
      if (m.tasks.some((t) => t.issue && this.starting.has(t.issue.id))) return true;
    }
    return this.branching.has(plan.id);
  }

  /** One step up the ladder for a stalled milestone → what was done, in words (undefined: nothing left to try). */
  private rescueStep(plan: Plan, view: PlanView, m: MilestoneView | undefined, kind: StallKind, tries: number, tried: readonly string[], what: string): string | undefined {
    const autopilot = (m?.autonomy ?? plan.autonomy) === 'autopilot';
    const head = (): string => {
      this.deps.askClaude(stuckPrompt(what, tried, autopilot), plan.home, false);
      return 'asked the plan’s Claude to decide';
    };
    if (!m) return tries <= 1 ? head() : undefined;
    const title = m.milestone.title;
    switch (kind) {
      case 'checking': {
        if (tries === 0) {
          this.deps.plans.newRound(plan.id, m.milestone.id);
          this.schedule();
          return `asked for the check of “${title}” again`;
        }
        if (tries === 1) {
          if (m.run.checker) {
            this.deps.retireChat?.(m.run.checker);
            this.deps.plans.setChecker(plan.id, m.milestone.id, undefined);
          }
          this.deps.plans.newRound(plan.id, m.milestone.id);
          this.schedule();
          return `gave the check of “${title}” to a fresh checker`;
        }
        return tries === 2 ? head() : undefined;
      }
      case 'stalled': {
        const stalled = m.tasks.filter((t) => t.state === 'stalled');
        const keys = stalled.map((t) => t.issue?.key ?? t.task.id).join(', ');
        if (tries === 0) {
          for (const t of stalled) this.resume(plan.id, t.task.id, 'beluga');
          return `woke ${keys}`;
        }
        if (tries === 1) {
          this.restartTasks(plan.id, stalled);
          return `stopped what was left of ${keys} and started it again`;
        }
        return tries === 2 ? head() : undefined;
      }
      case 'working': {
        if (tries <= 1) {
          const sent = this.kick(plan, view, m, tries === 1);
          if (sent) return sent;
        }
        return tries <= 2 ? head() : undefined;
      }
      case 'failed': {
        if (tries <= 1) {
          this.deps.askClaude(checkFailedPrompt(title, m.run.check?.notes ?? 'No notes.', true), plan.home, false);
          return `asked the plan’s Claude to add the fix tasks for “${title}”`;
        }
        if (tries === 2) {
          this.deps.plans.newRound(plan.id, m.milestone.id);
          this.schedule();
          return `asked for the check of “${title}” again`;
        }
        return undefined;
      }
      case 'merging': {
        const c = m.merging?.conflict;
        if (tries > 1) return undefined;
        if (!c) {
          this.stepMerges(plan);
          return `merged “${title}” again`;
        }
        this.deps.allowFixup?.(plan.home, c.dir);
        this.deps.askClaude(mergeFixupPrompt(title, plan.branch ?? planBranchName(plan), c.key ?? c.merging, c), plan.home, false);
        return `asked the plan’s Claude to fix the merge conflict in ${c.files.slice(0, 3).join(', ')}`;
      }
      default:
        return tries <= 1 ? head() : undefined;
    }
  }

  /**
   * A milestone's work that nothing runs: its Claude is sent on (fresh: what was left of its turn
   * is stopped first), or it gets one when it has none; failed starts are tried again.
   */
  private kick(plan: Plan, view: PlanView, m: MilestoneView, fresh: boolean): string | undefined {
    const todo = agentTasks(m).filter((t) => !FINISHED.has(t.state));
    for (const t of todo) if (t.issue) this.failed.delete(t.issue.id);
    const key = `${plan.id}:${m.milestone.id}`;
    this.sentOn.delete(key);
    const ready = todo.filter((t) => t.state === 'ready' || t.state === 'idle' || t.state === 'running');
    if (!ready.length) return undefined;
    if (!m.agent || !this.byMilestone) {
      this.schedule();
      return `started “${m.milestone.title}” again`;
    }
    const channel = `${WS_PREFIX}${m.agent.worktree}`;
    const send = (): void => {
      this.deps.askClaude(milestoneNextPrompt(view, m, ready, 'continue'), channel, false);
      // What it was sent now is what it has to answer (the pilot's own sending on waits for that).
      this.sentOn.set(key, { sig: ready.map((t) => t.issue!.id).join(','), ...this.after(channel), count: 1 });
    };
    if (fresh && this.deps.takeOver) void this.deps.takeOver(channel).then(send, send);
    else send();
    return `sent the Claude doing “${m.milestone.title}” on`;
  }

  /** Stalled tasks started over: what's left of their turn stopped, then woken. */
  private restartTasks(planId: string, tasks: readonly TaskView[]): void {
    const wake = (t: TaskView): void => {
      try {
        this.resume(planId, t.task.id, 'beluga');
      } catch {
        // Gone since: nothing to wake.
      }
    };
    for (const t of tasks) {
      const channel = t.worktree ? `${WS_PREFIX}${t.worktree}` : undefined;
      if (channel && this.deps.takeOver) void this.deps.takeOver(channel).then(() => wake(t), () => wake(t));
      else wake(t);
    }
  }

  /** Tasks only you can do that came up: to the hook, once each (a milestone's Claude never does them). */
  private tellYou(plan: Plan, view: PlanView): void {
    const fresh = waitingOnYou(view).filter((t) => !this.toldYou.has(`${plan.id}:${t.task.id}`));
    if (!fresh.length) return;
    for (const t of fresh) this.toldYou.add(`${plan.id}:${t.task.id}`);
    for (const t of fresh) this.deps.plans.note(plan.id, 'note', `${t.issue?.key ?? t.task.id} “${t.task.title}” waits for you: only you can do it${this.byMilestone ? ', so its milestone’s agent leaves it to you' : ''}`, { kind: 'beluga' });
    this.deps.forYou?.(plan, fresh);
  }

  // ------------------------------------------------------------------ one Claude per milestone

  /**
   * Each open milestone's one Claude: started once work is ready (within the plan's limit, never
   * on a step-by-step milestone by itself), given the tasks it doesn't have yet, and sent on when
   * its turn ended with tasks of it ready and none begun.
   */
  private stepAgents(plan: Plan, view: PlanView): void {
    let room = plan.maxParallel - agentsAtWork(view).length - this.launchingIn(plan);
    const live = liveFrom(this.deps.store.getState());
    for (const m of view.open) {
      const key = `${plan.id}:${m.milestone.id}`;
      if (m.state !== 'running' || this.launching.has(key)) continue;
      const todo = agentTasks(m).filter((t) => !FINISHED.has(t.state));
      const agent = m.agent;
      // Not begun anywhere (one already under way in a worktree of its own stays there).
      const unbegun = todo.filter((t) => t.state === 'ready' || t.state === 'blocked');
      if (!agent) {
        const ready = todo.some((t) => t.state === 'ready' && !this.failed.has(t.issue!.id));
        if (m.autonomy === 'step' || !ready || room <= 0) continue;
        room--;
        void this.launch(plan, m.milestone.id, { kind: 'beluga' }).catch(() => undefined);
        continue;
      }
      // Step by step: you hand it each task (Start).
      if (m.autonomy === 'step') continue;
      const fresh = unbegun.filter((t) => !t.issue!.worktrees.includes(agent.worktree));
      if (fresh.length) this.hand(plan, m, fresh);
      const channel = `ws:${agent.worktree}`;
      // At work, or a task of it started and stopped (the watchdog wakes that one).
      if (live.busy(channel) || this.deps.alive?.(channel) || m.tasks.some((t) => t.worktree === agent.worktree && (t.state === 'running' || t.state === 'asking' || t.state === 'idle' || t.state === 'stalled'))) continue;
      const ready = todo.filter((t) => t.state === 'ready');
      if (!ready.length) continue;
      const sig = ready.map((t) => t.issue!.id).join(',');
      const sent = this.sentOn.get(key);
      // Its run since it was last sent hasn't come and gone yet.
      if (sent && this.lastRun(channel) === sent.after) continue;
      if (sent?.sig === sig && sent.count >= 1) {
        if (!sent.told) {
          this.sentOn.set(key, { ...sent, told: true });
          this.deps.plans.note(plan.id, 'problem', `the agent doing “${m.milestone.title}” stopped again with ${ready.map((t) => t.issue!.key).join(', ')} not begun: open its chat, or Start one`, { kind: 'beluga' });
        }
        continue;
      }
      const fresher = this.handed.has(key);
      this.handed.delete(key);
      this.deps.askClaude(milestoneNextPrompt(view, m, ready, fresher ? 'new' : 'continue'), channel, false);
      this.sentOn.set(key, { sig, ...this.after(channel), count: sent?.sig === sig ? sent.count + 1 : 1 });
      this.deps.plans.note(plan.id, 'note', `sent the agent doing “${m.milestone.title}” on to ${ready[0]!.issue!.key} “${ready[0]!.task.title}”`, { kind: 'beluga' });
    }
  }

  /** Its conversation's last run now (what a reply has to come after). */
  private after(channel: string): { readonly after?: string } {
    const last = this.lastRun(channel);
    return last ? { after: last } : {};
  }

  /** Tasks go to a milestone's Claude: they link its worktree (and it's told when it's next sent on). */
  private hand(plan: Plan, m: MilestoneView, tasks: readonly TaskView[]): void {
    const agent = m.agent;
    if (!agent) return;
    const ws = this.deps.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === agent.worktree);
    for (const t of tasks) if (t.issue) this.deps.work.linkShared(t.issue.id, { id: agent.worktree, ...(agent.branch ? { branch: agent.branch } : {}), name: ws?.name ?? agent.worktree });
    const ids = [...new Set([...agent.tasks, ...tasks.map((t) => t.task.id)])];
    if (ids.length !== agent.tasks.length) {
      this.deps.plans.setAgent(plan.id, m.milestone.id, { ...agent, tasks: ids });
      this.handed.add(`${plan.id}:${m.milestone.id}`);
    }
  }

  /** Milestones of this plan whose Claude is being started right now. */
  private launchingIn(plan: Plan): number {
    return [...this.launching].filter((k) => k.startsWith(`${plan.id}:`)).length;
  }

  /**
   * A milestone's one Claude: one worktree for its tasks (`only`: just these, when you start them
   * one by one), from the plan's branch (or what its first task builds on), and its brief.
   */
  private async launch(plan: Plan, milestoneId: string, by: Actor, only?: readonly string[], pick?: AgentRef): Promise<string> {
    const key = `${plan.id}:${milestoneId}`;
    if (this.launching.has(key)) return 'Its agent is starting';
    this.launching.add(key);
    let ids: string[] = [];
    try {
      const view = this.view(this.deps.plans.need(plan.id));
      const m = view.milestones.find((x) => x.milestone.id === milestoneId);
      if (!m) throw new Error('That milestone isn’t in the approved plan');
      // Not begun anywhere: one already under way in a worktree of its own stays there.
      const tasks = only ? m.tasks.filter((t) => only.includes(t.task.id)) : agentTasks(m).filter((t) => (t.state === 'ready' || t.state === 'blocked') && !this.failed.has(t.issue!.id));
      const first = tasks.find((t) => t.state === 'ready');
      if (!first?.issue) throw new Error(`Nothing of “${m.milestone.title}” can start yet`);
      // The first ready task first (it goes In Progress); the rest in their order.
      const ordered = [first, ...tasks.filter((t) => t !== first)];
      ids = ordered.map((t) => t.issue!.id);
      // Moved here mid-milestone (BLG-806): from the branch its agent left on the other computer, its work so far.
      const resume = plan.runs[milestoneId]?.resumeFrom;
      const base = resume ?? (first.bases?.length ? plan.branch : first.base);
      // The agent you started it with (BLG-506), else the plan's (BLG-497); none: your default.
      const agent = pick ?? plan.agent;
      const ws = await this.deps.work.startShared(ids, `${first.issue.key} ${m.milestone.title}`, { quiet: true, ...(base ? { base } : {}), ...(agent ? { agent } : {}) });
      this.deps.plans.setAgent(plan.id, milestoneId, { worktree: ws.id, ...(ws.branch ? { branch: ws.branch } : {}), at: Date.now(), tasks: ordered.map((t) => t.task.id) });
      const fresh = this.deps.plans.resumed(plan.id, milestoneId);
      const keys = ordered.map((t) => t.issue!.key);
      const said = `started one agent for “${m.milestone.title}” (${keys.join(', ')}) in a new worktree${base ? ` from ${base}` : ''}`;
      this.deps.plans.note(plan.id, 'started', said, by);
      const now = this.view(fresh);
      const mv = now.milestones.find((x) => x.milestone.id === milestoneId)!;
      const channel = `ws:${ws.id}`;
      const after = this.after(channel);
      const all = new Map(mv.tasks.map((t) => [t.task.id, t]));
      this.deps.askClaude(milestonePrompt(now, mv, ordered.map((t) => all.get(t.task.id) ?? t), { only: Boolean(only) || mv.autonomy === 'step', ...(base ? { base } : {}) }), channel, false);
      this.sentOn.set(key, { sig: first.issue.id, ...after, count: 0 });
      this.handed.delete(key);
      return said.charAt(0).toUpperCase() + said.slice(1);
    } catch (err) {
      for (const id of ids) this.failed.add(id);
      const why = err instanceof Error ? err.message : String(err);
      this.deps.plans.note(plan.id, 'problem', `couldn’t start the agent for “${milestoneName(plan, milestoneId)}”: ${why}`, { kind: 'beluga' });
      throw err;
    } finally {
      this.launching.delete(key);
      this.schedule();
    }
  }

  /** One open milestone: a new round when work came back, its check when it's finished, its pass on autopilot. */
  private stepMilestone(plan: Plan, view: PlanView, m: MilestoneView): void {
    if (m.state === 'merging') return;
    // Work came back to a milestone that was being checked: the next check is a new one.
    if (m.state === 'running' && m.run.checkAsked !== undefined) this.deps.plans.newRound(plan.id, m.milestone.id);
    if (m.state !== 'gate' && m.state !== 'checking') return;
    // Nothing to check (no pass criteria, and its tasks' criteria are all settled): autopilot moves on, otherwise it's yours to pass.
    if (!m.milestone.criteria.length && !criteriaNeedCheck(view, m)) {
      if (m.autonomy === 'autopilot') this.autoPass(plan.id, m.milestone.id, { kind: 'beluga' });
      return;
    }
    if (m.run.checkAsked === undefined) {
      if (!this.deps.checkerChat) {
        // Asked first: if asking fails, the check isn't marked as asked (it's tried again).
        const id = this.deps.askClaude(checkPrompt(view, m), plan.home, false);
        if (id) this.checkRuns.set(`${plan.id}:${m.milestone.id}`, id);
        this.deps.plans.checkAsked(plan.id, m.milestone.id);
        this.deps.system(plan.home, `Every task of “${m.milestone.title}” is finished: the agent is checking its pass criteria.`);
        return;
      }
      const key = `${plan.id}:${m.milestone.id}`;
      if (this.askingCheck.has(key)) return;
      this.askingCheck.add(key);
      void this.askCheck(plan.id, m.milestone)
        .catch((err: unknown) => this.deps.plans.note(plan.id, 'problem', `couldn’t start the check of “${m.milestone.title}”: ${err instanceof Error ? err.message : String(err)}`, { kind: 'beluga' }))
        .finally(() => {
          this.askingCheck.delete(key);
          this.schedule();
        });
      return;
    }
    const check = m.run.check;
    if (m.autonomy === 'autopilot' && check?.verdict === 'pass' && check.at >= m.run.checkAsked) this.autoPass(plan.id, m.milestone.id, check.by);
    else if (m.state === 'checking') this.watchCheck(plan, m);
  }

  /**
   * A milestone's check, by a Claude of its own: a conversation made for it (once; later rounds go
   * to the same one, which remembers what failed before), folded into the plan. The head Claude's
   * conversation stays free for you, and milestones finishing together are checked side by side.
   * No conversation could be made: the head Claude checks, as before.
   */
  private async askCheck(planId: string, milestone: PlanMilestone): Promise<void> {
    const channel = (await this.checkerChannel(planId, milestone).catch(() => undefined)) ?? this.deps.plans.need(planId).home;
    const plan = this.deps.plans.need(planId);
    const run = plan.runs[milestone.id];
    // Passed (or asked) while its conversation was being made.
    if (run?.passedAt || run?.checkAsked !== undefined || plan.merging?.[milestone.id] || plan.status !== 'active') return;
    const view = this.view(plan);
    const m = view.milestones.find((x) => x.milestone.id === milestone.id);
    if (!m) return;
    const own = channel !== plan.home;
    const id = this.deps.askClaude(checkPrompt(view, m, { checker: own }), channel, false);
    if (id) this.checkRuns.set(`${plan.id}:${milestone.id}`, id);
    this.deps.plans.checkAsked(plan.id, milestone.id);
    this.deps.system(plan.home, own ? `Every task of “${milestone.title}” is finished: a Claude of its own is checking its pass criteria. You can keep talking here.` : `Every task of “${milestone.title}” is finished: Claude is checking its pass criteria.`);
  }

  /** The conversation that checks a milestone: the one it had (still there), or a new one. */
  private async checkerChannel(planId: string, milestone: PlanMilestone): Promise<string | undefined> {
    const was = this.deps.plans.need(planId).runs[milestone.id]?.checker;
    const ws = was ? this.deps.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === was) : undefined;
    if (ws && !ws.archived) return `${WS_PREFIX}${ws.id}`;
    const made = await this.deps.checkerChat?.(this.deps.plans.need(planId), milestone);
    if (!made) return undefined;
    this.deps.plans.setChecker(planId, milestone.id, made);
    return `${WS_PREFIX}${made}`;
  }

  /**
   * A check whose turn ended without a verdict would leave the plan waiting for good (on every mode,
   * Autopilot too): it's asked once more for its plan_gate, and if it ends without one again, the
   * plan says so and it's yours (open its conversation, or Check Again).
   */
  private watchCheck(plan: Plan, m: MilestoneView): void {
    const asked = m.run.checkAsked;
    if (asked === undefined) return;
    const key = `${plan.id}:${m.milestone.id}`;
    const round = `${key}:${asked}`;
    const channel = m.run.checker ? `${WS_PREFIX}${m.run.checker}` : plan.home;
    const state = this.deps.store.getState();
    const id = this.checkRuns.get(key);
    let ended: boolean;
    if (id) {
      const item = state.log.find((l) => l.type === 'agent' && l.requestId === id);
      ended = item?.type === 'agent' && !RUNNING.has(item.status);
    } else {
      // Asked before a restart: nothing has run there for a while.
      ended = !liveFrom(state).busy(channel) && (this.deps.now?.() ?? Date.now()) - asked > CHECK_QUIET_MS;
    }
    if (!ended) return;
    // A check the head Claude was running (from before checkers, or a restart): a checker of its own takes it, fresh.
    if (!m.run.checker && this.deps.checkerChat && !this.handedOver.has(key)) {
      this.handedOver.add(key);
      this.checkRuns.delete(key);
      this.deps.plans.newRound(plan.id, m.milestone.id);
      this.deps.plans.note(plan.id, 'note', `the check of “${m.milestone.title}” ended without a verdict: a checker of its own takes it from here`, { kind: 'beluga' });
      this.schedule();
      return;
    }
    const was = this.checkNudged.get(round);
    if (was === 'told') return;
    if (was === 'asked') {
      this.checkNudged.set(round, 'told');
      this.deps.plans.note(plan.id, 'problem', `the check of “${m.milestone.title}” ended twice without a verdict: open its conversation, or Check Again`, { kind: 'beluga' });
      return;
    }
    this.checkNudged.set(round, 'asked');
    const again = this.deps.askClaude(checkNudgePrompt(m.milestone.title), channel, false);
    if (again) this.checkRuns.set(key, again);
    else this.checkRuns.delete(key);
    this.deps.plans.note(plan.id, 'note', `the check of “${m.milestone.title}” ended without a verdict: asked for it again`, { kind: 'beluga' });
  }

  /** Autopilot's pass: a task still being worked on (see stillWorking) leaves it for the next look. */
  private autoPass(planId: string, milestoneId: string, by: Actor): void {
    // Its merge failed (not a conflict): passing again only fails again, so it's yours to fix and Pass Again.
    if (this.deps.plans.get(planId)?.runs[milestoneId]?.mergeFailed) return;
    try {
      this.pass(planId, milestoneId, by);
    } catch (err) {
      // Not merged under a working Claude: tried again once it's In Review.
      if (err instanceof StillWorkingError) return;
      // Anything else is a real problem: said once in the plan's activity, not swallowed.
      const text = `couldn’t pass the milestone on Autopilot: ${err instanceof Error ? err.message : String(err)}`;
      const plan = this.deps.plans.get(planId);
      if (plan && plan.activity.at(-1)?.text !== text) this.deps.plans.note(planId, 'problem', text, { kind: 'beluga' });
    }
  }

  /** Tasks that came back finished since the last look go in the plan's activity (what was there at the first look doesn't). */
  private noteFinished(plan: Plan, view: PlanView): void {
    const tasks = view.milestones.flatMap((m) => m.tasks);
    const before = this.seen.get(plan.id);
    this.seen.set(plan.id, new Map(tasks.map((t) => [t.task.id, t.state])));
    if (!before) return;
    for (const t of tasks) {
      const was = before.get(t.task.id);
      if (!t.issue || (t.state !== 'review' && t.state !== 'done') || !was || FINISHED.has(was)) continue;
      const by = [...t.issue.activity].reverse().find((a) => a.kind === 'status')?.by ?? { kind: 'beluga' };
      this.deps.plans.note(plan.id, 'finished', `finished ${t.issue.key} “${t.task.title}”`, by);
    }
  }

  /** Board tasks of this plan being started right now. */
  private startingIn(plan: Plan): number {
    const mine = new Set((plan.body?.milestones ?? []).flatMap((m) => m.tasks.flatMap((t) => (t.issueId ? [t.issueId] : []))));
    return [...this.starting].filter((id) => mine.has(id)).length;
  }

  /** Check a milestone again (a check that never came back, or work fixed since): the head Claude is asked anew. */
  recheck(planId: string, milestoneId: string): void {
    this.deps.plans.newRound(planId, milestoneId);
    this.schedule();
  }

  /**
   * Combines that are under way across a restart, or stopped at a conflict: tried again once the
   * head Claude's fix-up run is over (or right away after a restart); gone once the task started.
   */
  private stepCombining(plan: Plan, view: PlanView): void {
    const combining = plan.combining ?? {};
    const tasks = view.milestones.flatMap((m) => m.tasks);
    const busy = liveFrom(this.deps.store.getState()).busy(plan.home);
    const last = this.lastRun(plan.home);
    for (const id of Object.keys(combining)) {
      const t = tasks.find((x) => x.task.id === id);
      if (t?.issue && this.starting.has(t.issue.id)) continue;
      // Started (or gone, or no longer waiting on several branches): nothing left to combine.
      if (!t?.issue || !t.combining || !t.bases) {
        this.deps.plans.setCombining(plan.id, id, undefined);
        continue;
      }
      const c = t.combining.conflict;
      if (c?.stuck) {
        // Yours to fix: looked at again now and then, and it starts once it's fixed.
        const wait = (this.stuckTried.get(t.issue.id) ?? c.at) + STUCK_RETRY_MS - Date.now();
        if (wait > 0) {
          this.wakeIn(wait);
          continue;
        }
        this.stuckTried.set(t.issue.id, Date.now());
      }
      // Asked to fix it: tried again once its run came and went.
      const asked = this.fixAsked.get(t.issue.id);
      if (c && asked && (busy || last === asked.after)) continue;
      void this.start(plan, t, { kind: 'beluga' }).catch(() => undefined);
    }
  }

  private wakeIn(ms: number): void {
    if (this.stuckTimer || this.stopped) return;
    this.stuckTimer = setTimeout(() => {
      this.stuckTimer = undefined;
      this.schedule();
    }, ms);
    this.stuckTimer.unref?.();
  }

  /**
   * The branch a task that builds on several unmerged tasks starts from: theirs combined. A conflict
   * goes to the head Claude to fix in the hidden worktree (→ undefined: tried again after).
   */
  private async combinedBase(plan: Plan, t: TaskView, issue: Issue): Promise<string | undefined> {
    const bases = t.bases ?? [];
    const issues = this.deps.store.getState().board.issues;
    const from = bases.map((b) => issues.find((i) => i.branch === b && i.projectId === issue.projectId)?.key ?? b);
    const was = this.deps.plans.need(plan.id).combining?.[t.task.id];
    if (!was) {
      this.deps.plans.note(plan.id, 'started', `combining ${from.join(' and ')} for ${issue.key} “${t.task.title}”`, { kind: 'beluga' });
      this.deps.plans.setCombining(plan.id, t.task.id, { at: Date.now(), from });
    }
    const combine = this.deps.combine;
    let res: CombineResult;
    try {
      if (!combine) throw new Error('combining branches needs the project’s folder');
      res = await combine(plan.projectId, issue.key, bases, plan.branch);
    } catch (err) {
      this.deps.plans.setCombining(plan.id, t.task.id, undefined);
      this.deps.allowFixup?.(plan.home, undefined);
      throw new Error(`couldn’t combine ${from.join(' and ')}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) {
      if (was?.conflict) this.deps.allowFixup?.(plan.home, undefined);
      this.fixAsked.delete(issue.id);
      this.stuckTried.delete(issue.id);
      return res.branch;
    }
    const asks = this.fixAsked.get(issue.id)?.asks ?? 0;
    const stuck = asks >= FIXUP_ASKS;
    const conflict = { at: was?.conflict?.stuck && stuck ? was.conflict.at : Date.now(), dir: res.dir, merging: res.merging, files: res.files, ...(stuck ? { stuck } : {}) };
    this.deps.plans.setCombining(plan.id, t.task.id, { at: was?.at ?? Date.now(), from, conflict });
    this.deps.allowFixup?.(plan.home, res.dir);
    if (!stuck) {
      const after = this.lastRun(plan.home);
      this.fixAsked.set(issue.id, { asks: asks + 1, ...(after ? { after } : {}) });
      if (!asks) this.deps.plans.note(plan.id, 'problem', `combining ${from.join(' and ')} for ${issue.key}: ${res.merging} conflicts in ${res.files.join(', ')}; the agent is fixing it`, { kind: 'beluga' });
      this.deps.askClaude(fixupPrompt(issue.key, t.task.title, from, res), plan.home, false);
    } else if (!was?.conflict?.stuck) {
      this.deps.plans.note(plan.id, 'problem', `combining ${from.join(' and ')} for ${issue.key}: the conflict in ${res.files.join(', ')} is still there; fix it in ${res.dir} and ${issue.key} starts`, { kind: 'beluga' });
    }
    return undefined;
  }

  /** The latest run in a conversation (its request id). */
  private lastRun(channel: string): string | undefined {
    const log = this.deps.store.getState().log;
    for (let i = log.length - 1; i >= 0; i--) {
      const l = log[i]!;
      if (l.type === 'agent' && l.channel === channel) return l.requestId;
    }
    return undefined;
  }

  private async start(plan: Plan, t: TaskView, by: Actor, pick?: AgentRef): Promise<string> {
    const issue = t.issue;
    if (!issue) throw new Error('That task isn’t on the board');
    if (this.starting.has(issue.id)) return `${issue.key} is starting`;
    this.starting.add(issue.id);
    try {
      const base = t.bases?.length ? await this.combinedBase(plan, t, issue) : t.base;
      if (t.bases?.length && !base) return `${issue.key} builds on several tasks: combining their branches hit a conflict, and the agent is fixing it`;
      // The agent you started it with (BLG-506), else the task's own, else the plan's (BLG-497), else your default.
      const agent = pick ?? issue.agent ?? plan.agent;
      await this.deps.work.start(issue.id, { claude: true, quiet: true, ...(base ? { base } : {}), ...(agent ? { agent } : {}) });
      if (t.bases?.length) this.deps.plans.setCombining(plan.id, t.task.id, undefined);
      this.deps.plans.note(plan.id, 'started', `started ${issue.key} “${t.task.title}”${base ? ` from ${base}` : ''}`, by);
      return `Started ${issue.key} “${t.task.title}” in a new worktree${base ? ` from ${base}` : ''}`;
    } catch (err) {
      if (t.bases?.length && this.deps.plans.need(plan.id).combining?.[t.task.id]) this.deps.plans.setCombining(plan.id, t.task.id, undefined);
      this.failed.add(issue.id);
      const why = err instanceof Error ? err.message : String(err);
      this.deps.plans.note(plan.id, 'problem', `couldn’t start ${issue.key}: ${why}`, { kind: 'beluga' });
      throw err;
    } finally {
      this.starting.delete(issue.id);
      this.schedule();
    }
  }

  // ------------------------------------------------------------------ the plan's branch

  /** What goes on whether or not anything may start: its branch, catching up once, merges into it. */
  private tend(plan: Plan): void {
    if (!this.deps.git || this.noBranch.has(plan.id)) return;
    if (!plan.branch) {
      void this.makeBranch(plan);
      return;
    }
    // Catching up (merging and clearing away what passed before the branch) waits for your Yes: see tidyUp.
    this.stepMerges(this.deps.plans.need(plan.id));
    this.stepMainMerge(this.deps.plans.need(plan.id));
  }

  /** Main merging into the plan's branch, stopped at a conflict: tried again once the head Claude's fix-up came and went (or, stuck, every so often). */
  private stepMainMerge(plan: Plan): void {
    const c = plan.mainMerge?.conflict;
    const key = `main:${plan.id}`;
    if (!c || this.mergingNow.has(key) || plan.shipped) return;
    if (c.stuck) {
      const wait = (this.stuckTried.get(key) ?? c.at) + STUCK_RETRY_MS - Date.now();
      if (wait > 0) return void this.wakeIn(wait);
      this.stuckTried.set(key, Date.now());
    } else {
      const asked = this.fixAsked.get(key);
      if (asked && (liveFrom(this.deps.store.getState()).busy(plan.home) || this.lastRun(plan.home) === asked.after)) return;
    }
    void this.bringInMain(plan.id).catch(() => undefined);
  }

  /**
   * The plan's pull request conflicts with main: main is merged into the plan's branch (in its hidden
   * worktree), as a milestone is. A conflict goes to the plan's Claude to fix there, and is tried again
   * after; once it's in, the branch is pushed and the pull request can merge.
   */
  async bringInMain(planId: string): Promise<Plan> {
    const { git, plan, branch } = this.shippable(planId);
    const key = `main:${planId}`;
    if (this.mergingNow.has(key)) return plan;
    this.mergingNow.add(key);
    const beluga: Actor = { kind: 'beluga' };
    try {
      const main = plan.mainMerge?.main ?? (await git.mainRef(plan.projectId));
      if (!plan.mainMerge) this.deps.plans.setMainMerge(planId, { at: Date.now(), main });
      let res: CombineResult;
      try {
        res = await git.mergeInto(plan.projectId, branch, [main]);
      } catch (err) {
        this.deps.plans.setMainMerge(planId, undefined);
        throw new Error(`Couldn’t merge ${main} into ${branch}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`);
      }
      if (!res.ok) {
        const asks = this.fixAsked.get(key)?.asks ?? 0;
        const stuck = asks >= FIXUP_ASKS;
        const was = this.deps.plans.need(planId).mainMerge?.conflict;
        this.deps.plans.setMainMerge(planId, { at: plan.mainMerge?.at ?? Date.now(), main, conflict: { at: was?.stuck && stuck ? was.at : Date.now(), dir: res.dir, files: res.files, ...(stuck ? { stuck } : {}) } });
        this.deps.allowFixup?.(plan.home, res.dir);
        if (!stuck) {
          const after = this.lastRun(plan.home);
          this.fixAsked.set(key, { asks: asks + 1, ...(after ? { after } : {}) });
          if (!asks) this.deps.plans.note(planId, 'problem', `merging ${main} into ${branch}: it conflicts in ${res.files.join(', ')}; Claude is fixing it`, beluga);
          this.deps.askClaude(mainFixupPrompt(branch, main, plan.pr?.number, res), plan.home, false);
        } else if (!was?.stuck) {
          this.deps.plans.note(planId, 'problem', `merging ${main} into ${branch}: the conflict in ${res.files.join(', ')} is still there; fix it and it goes on`, beluga);
        }
        return this.deps.plans.need(planId);
      }
      if (plan.mainMerge?.conflict) this.deps.allowFixup?.(plan.home, undefined);
      this.fixAsked.delete(key);
      this.stuckTried.delete(key);
      this.deps.plans.setMainMerge(planId, undefined);
      this.deps.plans.note(planId, 'passed', `merged ${main} into ${branch}`, beluga);
      await git.push(plan.projectId, branch).catch((err: unknown) => {
        throw new Error(`Merged ${main} into ${branch}, but couldn’t push it: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`);
      });
      this.pushedPlan(planId);
      const pr = await git.findPr(plan.projectId, branch).catch(() => undefined);
      if (pr) this.prSeen(planId, pr);
      return this.deps.plans.need(planId);
    } finally {
      this.mergingNow.delete(key);
    }
  }

  /** plan/<slug> from main (one that's there already is the plan's, never made twice). */
  private async makeBranch(plan: Plan): Promise<void> {
    if (this.branching.has(plan.id)) return;
    this.branching.add(plan.id);
    const branch = planBranchName(plan);
    try {
      const { made } = await this.deps.git!.ensureBranch(plan.projectId, branch);
      this.deps.plans.setBranch(plan.id, branch, made);
    } catch (err) {
      // Without one the plan runs as before: tasks from main.
      this.noBranch.add(plan.id);
      this.deps.plans.note(plan.id, 'problem', `couldn’t make the plan’s branch ${branch}: ${err instanceof Error ? err.message : String(err)}; tasks start from main`, { kind: 'beluga' });
    } finally {
      this.branching.delete(plan.id);
      this.schedule();
    }
  }

  /**
   * Your answer to “Tidy up N merged task worktrees?” (see tidyOffer), asked once, never acted on by
   * itself (not on a restart either). Yes: each passed milestone whose tasks are still in review has
   * them merged into the branch (no second pass), then their worktrees archived and branches
   * deleted if merged; those already in main go to Done. No: nothing changes, and it isn't asked again.
   */
  tidyUp(planId: string, yes: boolean, by: Actor): Plan {
    const plan = this.deps.plans.need(planId);
    if (!plan.branch) throw new Error('The plan has no branch yet');
    if (yes) {
      const offer = new Set(tidyOffer(this.view(plan)).map((t) => t.milestoneId));
      for (const id of offer) this.deps.plans.setMerging(plan.id, id, { at: Date.now(), by, catchUp: true });
    }
    const next = this.deps.plans.setCaughtUp(plan.id);
    this.schedule();
    return next;
  }

  /** Merges waiting: started, or tried again once the head Claude's fix-up run came and went. */
  private stepMerges(plan: Plan): void {
    const busy = liveFrom(this.deps.store.getState()).busy(plan.home);
    const last = this.lastRun(plan.home);
    for (const [id, merge] of Object.entries(plan.merging ?? {})) {
      const key = `merge:${plan.id}:${id}`;
      if (this.mergingNow.has(key)) continue;
      const c = merge.conflict;
      if (c?.stuck) {
        const wait = (this.stuckTried.get(key) ?? c.at) + STUCK_RETRY_MS - Date.now();
        if (wait > 0) {
          this.wakeIn(wait);
          continue;
        }
        this.stuckTried.set(key, Date.now());
      }
      const asked = this.fixAsked.get(key);
      if (c && asked && (busy || last === asked.after)) continue;
      this.mergingNow.add(key);
      const prev = this.mergeChain.get(plan.id) ?? Promise.resolve();
      const run = prev
        .then(() => this.merge(plan.id, id))
        .catch(() => undefined)
        .finally(() => {
          this.mergingNow.delete(key);
          this.schedule();
        });
      this.mergeChain.set(plan.id, run);
    }
  }

  /** One milestone's task branches into the plan's branch; once they're in, it passes. */
  private async merge(planId: string, milestoneId: string): Promise<void> {
    const git = this.deps.git!;
    const plan = this.deps.plans.need(planId);
    const merge = plan.merging?.[milestoneId];
    const branch = plan.branch;
    if (!merge || !branch) return;
    const m = this.view(plan).milestones.find((x) => x.milestone.id === milestoneId);
    if (!m) {
      this.deps.plans.setMerging(planId, milestoneId, undefined);
      return;
    }
    const key = `merge:${planId}:${milestoneId}`;
    const beluga: Actor = { kind: 'beluga' };
    // A task started again since it was passed: its worktree isn't retired under its Claude.
    const busy = stillWorking(m);
    if (busy) {
      this.deps.plans.setMerging(planId, milestoneId, undefined);
      this.deps.plans.note(planId, 'problem', busy, beluga);
      return;
    }
    // Only tasks In Review (finished) are merged and retired.
    let tasks = m.tasks.filter((t) => t.issue?.branch && t.issue.worktrees.length && t.state === 'review');
    if (merge.catchUp) {
      const left: TaskView[] = [];
      for (const t of tasks) {
        if (await git.inMain(plan.projectId, t.issue!.branch!).catch(() => false)) this.deps.work.board.planMoved(t.issue!.id, 'done', 'its branch was already in main');
        else left.push(t);
      }
      tasks = left;
    }
    let res: CombineResult | undefined;
    if (tasks.length) {
      try {
        // A milestone's one Claude: its tasks share one branch, merged once.
        res = await git.mergeInto(plan.projectId, branch, [...new Set(tasks.map((t) => t.issue!.branch!))]);
      } catch (err) {
        // Not a conflict (a dirty checkout, no git identity): kept on the milestone (its gate says why), and you pass it again.
        const why = err instanceof Error ? err.message : String(err);
        this.deps.plans.setMerging(planId, milestoneId, undefined);
        this.deps.plans.setMergeFailed(planId, milestoneId, why.split('\n').find((l) => l.trim())?.trim().slice(0, 300) ?? 'git said no');
        this.deps.allowFixup?.(plan.home, undefined);
        this.deps.plans.note(planId, 'problem', `couldn’t merge “${m.milestone.title}” into ${branch}: ${why}`, beluga);
        return;
      }
    }
    if (res && !res.ok) {
      // One task's branch: its key; a milestone's one Claude (a branch for several): the branch.
      const on = tasks.filter((t) => t.issue!.branch === res.merging);
      const conflictKey = on.length === 1 ? on[0]!.issue!.key : res.merging;
      const asks = this.fixAsked.get(key)?.asks ?? 0;
      const stuck = asks >= FIXUP_ASKS;
      const was = merge.conflict;
      const conflict = { at: was?.stuck && stuck ? was.at : Date.now(), dir: res.dir, merging: res.merging, key: conflictKey, files: res.files, ...(stuck ? { stuck } : {}) };
      this.deps.plans.setMerging(planId, milestoneId, { ...merge, conflict });
      this.deps.allowFixup?.(plan.home, res.dir);
      if (!stuck) {
        const after = this.lastRun(plan.home);
        this.fixAsked.set(key, { asks: asks + 1, ...(after ? { after } : {}) });
        if (!asks) this.deps.plans.note(planId, 'problem', `merging “${m.milestone.title}” into ${branch}: ${conflictKey} conflicts in ${res.files.join(', ')}; the agent is fixing it`, beluga);
        this.deps.askClaude(mergeFixupPrompt(m.milestone.title, branch, conflictKey, res), plan.home, false);
      } else if (!was?.stuck) {
        this.deps.plans.note(planId, 'problem', `merging “${m.milestone.title}” into ${branch}: the conflict in ${res.files.join(', ')} is still there; fix it in ${res.dir} and the milestone passes`, beluga);
      }
      return;
    }
    // In: its tasks are Merged into Plan, the milestone passes, and their worktrees go.
    if (merge.conflict) this.deps.allowFixup?.(plan.home, undefined);
    this.fixAsked.delete(key);
    this.stuckTried.delete(key);
    for (const t of tasks) this.deps.work.board.planMoved(t.issue!.id, 'in_plan', `merged into ${branch}: “${m.milestone.title}” passed`);
    this.deps.plans.setMerging(planId, milestoneId, undefined);
    if (tasks.length) this.deps.plans.note(planId, 'passed', `merged ${tasks.map((t) => t.issue!.key).join(', ')} into ${branch}`, beluga);
    if (!merge.catchUp) this.passed(planId, milestoneId, merge.by);
    // Cleared away in the background: the next merge (another milestone passed) doesn't wait for archiving.
    void this.retireAll(plan, tasks, branch);
  }

  /** Merged tasks' worktrees archived and branches deleted (a shared one once). */
  private async retireAll(plan: Plan, tasks: readonly TaskView[], into: string): Promise<void> {
    const done = new Set<string>();
    for (const t of tasks) {
      const ws = t.issue!.worktreeGone ? undefined : t.issue!.worktrees.at(-1);
      const id = `${ws ?? ''}:${t.issue!.branch ?? ''}`;
      if (done.has(id)) continue;
      done.add(id);
      try {
        await this.deps.git!.retire(plan.projectId, ws, t.issue!.branch, into);
      } catch (err) {
        this.deps.plans.note(plan.id, 'problem', `couldn’t clear away ${t.issue!.key}’s worktree: ${err instanceof Error ? err.message : String(err)}`, { kind: 'beluga' });
      }
    }
  }

  // ------------------------------------------------------------------ the plan's pull request

  /**
   * Look at the plans' pull requests: merged → its tasks are Done. `now` (the default): every one;
   * `tick` (every few seconds): those due (see pr-cadence.ts, slower in Low Power mode); `focus`:
   * you came back to the window, so any not looked at in the last few seconds.
   */
  async pollPrs(reason: 'now' | 'tick' | 'focus' = 'now'): Promise<void> {
    const git = this.deps.git;
    if (!git || this.stopped || (reason !== 'now' && this.prPolling)) return;
    this.prPolling = true;
    try {
      for (const plan of this.deps.plans.list()) {
        if (!plan.branch || plan.shipped) continue;
        // Only once there's something to ship (or a PR to follow).
        const waiting = this.deps.store.getState().board.issues.some((i) => i.plan?.id === plan.id && i.status === 'in_plan');
        if (!waiting && !plan.pr) continue;
        const now = this.deps.now?.() ?? Date.now();
        if (reason !== 'now' && !this.prDue(plan, reason, now)) continue;
        this.prChecked.set(plan.id, now);
        try {
          const pr = await git.findPr(plan.projectId, plan.branch);
          if (pr) this.prSeen(plan.id, pr);
        } catch {
          // GitHub couldn't tell (offline): next time.
        }
      }
    } finally {
      this.prPolling = false;
    }
  }

  private prDue(plan: Plan, reason: 'tick' | 'focus', now: number): boolean {
    const since = now - (this.prChecked.get(plan.id) ?? -Infinity);
    if (reason === 'focus') return since >= PLAN_PR_FOCUS_FRESH_MS;
    const every = planPrCadence(plan, this.prPushed.get(plan.id), now);
    return every !== undefined && since >= pace(every, this.deps.store.getState().powerSaving);
  }

  /** Beluga pushed the plan's branch: its PR is looked at often for a while (GitHub catches up a little after). */
  private pushedPlan(planId: string): void {
    this.prPushed.set(planId, this.deps.now?.() ?? Date.now());
  }

  private prSeen(planId: string, pr: NonNullable<Plan['pr']>): void {
    const plan = this.deps.plans.setPr(planId, pr);
    if (pr.state === 'MERGED') this.ship(plan, 'pr', pr.number);
  }

  /** The plan's work reached main: every Merged into Plan task of it is Done at once. */
  private ship(plan: Plan, how: 'pr' | 'local', number?: number): void {
    const text = how === 'pr' ? `merged into main via #${number}` : 'merged into main here, with the plan';
    for (const i of this.deps.store.getState().board.issues) if (i.plan?.id === plan.id && i.status === 'in_plan') this.deps.work.board.planMoved(i.id, 'done', text);
    this.deps.plans.setShipped(plan.id, { at: Date.now(), how, ...(number !== undefined ? { number } : {}) });
    this.deps.system(plan.home, how === 'pr' ? `The plan’s pull request #${number} was merged: its tasks are Done.` : `${plan.branch} was merged into main here: the plan’s tasks are Done.`);
  }

  /** Open the plan's pull request (its branch → main). */
  async openPr(planId: string): Promise<Plan> {
    const { git, plan, branch } = this.shippable(planId);
    const view = this.view(plan);
    const body = [
      view.body?.goal ?? '',
      '',
      ...view.milestones.flatMap((m) => [`## ${m.milestone.title}`, ...m.tasks.filter((t) => t.issue && t.state !== 'canceled').map((t) => `- ${t.issue!.key} ${t.task.title}`), '']),
      `One pull request for the plan: each milestone was merged into \`${branch}\` when it passed.`,
    ].join('\n');
    const pr = await git.openPr(plan.projectId, branch, view.body?.title ?? branch, body.trim());
    this.pushedPlan(planId);
    this.prSeen(planId, pr);
    return this.deps.plans.need(planId);
  }

  /**
   * Merge the plan's pull request on GitHub, as a worktree's is: GitHub asked first (what's saved can
   * be minutes old), the branch pushed (nothing merged here is left out), then merged now or (auto)
   * once its checks and reviews pass. GitHub's no comes back in plain words.
   */
  async mergePr(planId: string, opts: { readonly auto?: boolean } = {}): Promise<Plan> {
    const { git, plan, branch } = this.shippable(planId);
    if (this.prMerging.has(planId)) throw new Error('The plan’s pull request is already being merged');
    this.prMerging.add(planId);
    try {
      const pr = (await git.findPr(plan.projectId, branch).catch(() => undefined)) ?? plan.pr;
      if (!pr) throw new Error('The plan has no pull request yet: open one first');
      if (pr !== plan.pr) this.prSeen(planId, pr);
      if (pr.state === 'MERGED') return this.deps.plans.need(planId);
      if (pr.state === 'CLOSED') throw new Error(`Pull request #${pr.number} was closed on GitHub: open it again first`);
      try {
        await git.push(plan.projectId, branch);
        this.pushedPlan(planId);
      } catch (err) {
        throw new Error(`Couldn’t push ${branch} to GitHub, so #${pr.number} isn’t merged (it would leave work out): ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`);
      }
      try {
        await git.mergePr(plan.projectId, pr.number, opts.auto ? { auto: true } : {});
      } catch (err) {
        // GitHub may know more now (a conflict, a review): shown on the page.
        const now = await git.findPr(plan.projectId, branch).catch(() => undefined);
        if (now) this.prSeen(planId, now);
        throw err;
      }
      const after = await git.findPr(plan.projectId, branch).catch(() => undefined);
      this.prSeen(planId, after ?? (opts.auto ? { ...pr, autoMerge: true } : { ...pr, state: 'MERGED' }));
      return this.deps.plans.need(planId);
    } finally {
      this.prMerging.delete(planId);
    }
  }

  /** A conflict Claude couldn't fix (it waits for you): Claude is asked again now, from a clean count. */
  retryConflicts(planId: string): Plan {
    const plan = this.deps.plans.need(planId);
    for (const [id, merge] of Object.entries(plan.merging ?? {})) {
      if (!merge.conflict) continue;
      const key = `merge:${planId}:${id}`;
      this.fixAsked.delete(key);
      this.stuckTried.delete(key);
      const { stuck: _s, ...conflict } = merge.conflict;
      this.deps.plans.setMerging(planId, id, { ...merge, conflict });
    }
    if (plan.mainMerge?.conflict) {
      const key = `main:${planId}`;
      this.fixAsked.delete(key);
      this.stuckTried.delete(key);
      const { stuck: _s, ...conflict } = plan.mainMerge.conflict;
      this.deps.plans.setMainMerge(planId, { ...plan.mainMerge, conflict });
    }
    this.schedule();
    return this.deps.plans.need(planId);
  }

  /** Where the plan's conflict waits to be fixed (a hidden worktree): undefined when there's none. */
  conflictDir(planId: string): string | undefined {
    const plan = this.deps.plans.need(planId);
    return plan.mainMerge?.conflict?.dir ?? Object.values(plan.merging ?? {}).find((m) => m.conflict)?.conflict?.dir ?? Object.values(plan.combining ?? {}).find((c) => c.conflict)?.conflict?.dir;
  }

  /** Merge the plan's branch into main here. */
  async mergeLocal(planId: string): Promise<Plan> {
    const { git, plan, branch } = this.shippable(planId);
    const res = await git.mergeLocal(plan.projectId, branch);
    if (!res.ok) {
      if (res.reason === 'wrong_branch') throw new Error(`The main folder is on ${res.current}, not ${res.expected}: switch it to ${res.expected} first`);
      if (res.reason === 'dirty') throw new Error(`The main folder has uncommitted changes (${res.files.slice(0, 3).join(', ')}): commit or stash them first`);
      throw new Error(`Merging ${branch} into main conflicts in ${res.files.slice(0, 3).join(', ')}: nothing was changed`);
    }
    this.ship(plan, 'local');
    return this.deps.plans.need(planId);
  }

  private shippable(planId: string): { readonly git: PlanGit; readonly plan: Plan; readonly branch: string } {
    const plan = this.deps.plans.need(planId);
    if (!this.deps.git || !plan.branch) throw new Error('This plan has no branch of its own');
    if (plan.shipped) throw new Error('The plan is in main already');
    return { git: this.deps.git, plan, branch: plan.branch };
  }

  /** Look at a plan's started tasks: wake what stopped without finishing, or ask you. */
  private watch(plan: Plan): void {
    const live = liveFrom(this.deps.store.getState());
    this.watchdog.step(plan, this.view(plan), (channel) => live.run?.(channel));
  }

  /** The head Claude steered a message into a task (sent as `requestId`): it goes in now, and is followed until read. */
  steer(planId: string, taskId: string, requestId: string, prompt: string): void {
    const plan = this.deps.plans.need(planId);
    const t = this.view(plan).milestones.flatMap((m) => m.tasks).find((x) => x.task.id === taskId);
    if (t?.worktree) this.watchdog.steer(plan, t, `ws:${t.worktree}`, requestId, prompt);
  }

  /** You resume a task whose Claude stopped (it waits for you): woken now, with what it missed. */
  resume(planId: string, taskId: string, by: 'you' | 'beluga' = 'you'): string {
    const plan = this.deps.plans.need(planId);
    const t = this.view(plan)
      .milestones.flatMap((m) => m.tasks)
      .find((x) => x.task.id === taskId || x.issue?.key === taskId.toUpperCase());
    if (!t) throw new Error(`There's no task "${taskId}" in this plan`);
    const live = liveFrom(this.deps.store.getState());
    return this.watchdog.resume(plan, t, (channel) => live.run?.(channel), by);
  }
}
