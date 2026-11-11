import type { PlanTools } from '../../agent/types.js';
import type { AgentRef } from '../../protocol.js';
import { agentName } from '../../shared/agent-label.js';
import type { Actor, ExternalActor, Issue } from '../board/model.js';
import type { BoardWork } from '../board/work.js';
import type { CombineResult } from '../../workspaces/git.js';
import type { Intent } from '../intents.js';
import type { LogItem, Store } from '../store.js';
import type { WorkspaceController } from '../workspace-controller.js';
import { ApplyError, applyDraft } from './apply.js';
import { coherenceWarnings, warningsText } from './coherence.js';
import { DraftReviewer } from './draft-review.js';
import { dropEpics, syncEpics } from './epics.js';
import type { BodyInput, PlanOp, TaskInput } from './edit.js';
import { type Autonomy, type Plan, type TestsAt, activeDecisions, allTasks, checkerOf, planForHome, planTaskOfIssue, planTitle, reviewerOf } from './model.js';
import { PlanMover } from './move-work.js';
import { issueForWorkspace } from '../board/model.js';
import { type PilotDeps, PlanPilot } from './pilot.js';
import { liveFrom } from './progress.js';
import { type PlanGit, planGitOf } from './plan-git.js';
import { type Plans, UNTITLED } from './plans.js';
import { checkFailedPrompt, checkerBrief, describePlan, headBrief, milestoneNote, planningBrief, reviewerBrief, sizeWords, workerNote } from './prompt.js';

/**
 * Plans at work: making a plan (its own conversation, in the project's main folder where Claude
 * only reads), approving it onto the board, running it (the pilot), and what Claude gets: the
 * plan's tools in its home conversation, and the plan a task belongs to in that task's worktree.
 */

export interface PlansWorkDeps {
  readonly store: Store;
  readonly plans: Plans;
  readonly board: BoardWork;
  readonly controller?: WorkspaceController;
  /** Ask your Claude in a conversation; returns the request's id, when it can (to follow a steered message). */
  readonly askClaude: (prompt: string, channel: string, echo: boolean) => string | void;
  /** Steer a waiting message in now: the agent host's Steer Now (AgentHost.promote). */
  readonly promote?: (requestId: string) => boolean;
  /** Stop your Claude in one conversation (its queued messages too): the agent host's Stop. */
  readonly stopRun?: (channel: string) => void;
  readonly intend: (intent: Intent) => void;
  /** Combining a task's start from several branches (default: the project's folder, through the controller). */
  readonly combine?: (projectId: string, key: string, branches: readonly string[], into?: string) => Promise<CombineResult>;
  /** The plan's branch and pull request (default: the project's folder, through the controller; null: none). */
  readonly git?: PlanGit | null;
  /** The agent runner's run state, and taking over a stalled conversation (see watchdog.ts). */
  readonly alive?: (channel: string) => boolean;
  readonly takeOver?: (channel: string) => Promise<readonly string[]>;
  readonly now?: () => number;
  /** A short name for a new plan from its goal (a quick model call; undefined when there's none). */
  readonly titlePlan?: (goal: string) => Promise<string | undefined>;
  readonly delayMs?: number;
  /** One Claude per milestone (default), or a worktree per task: see PlanPilot. */
  readonly workers?: 'milestone' | 'task';
  /** Stop a request of Beluga's that's no longer needed (AgentHost.cancelRun). */
  readonly cancel?: (requestId: string) => void;
  /** Tasks only you can do came up: see PilotDeps.forYou. */
  readonly forYou?: PilotDeps['forYou'];
  /** How long a plan may sit quiet before Beluga moves it along: see PilotDeps.rescueMs. */
  readonly rescueMs?: number;
}

const WS = 'ws:';

export class PlansWork {
  readonly plans: Plans;
  readonly pilot: PlanPilot;
  /** Moving a plan to another computer of yours (BLG-806): this daemon's part. */
  readonly mover: PlanMover;
  /** A fresh agent's read of each first draft, before Approve Plan (see draft-review.ts). */
  readonly reviewer: DraftReviewer;

  constructor(private readonly deps: PlansWorkDeps) {
    this.plans = deps.plans;
    this.reviewer = new DraftReviewer({
      store: deps.store,
      plans: deps.plans,
      askClaude: deps.askClaude,
      // On the plan's agent, like its checkers; a conversation of its own, folded into the plan.
      ...(deps.controller
        ? {
            reviewChat: async (plan: Plan) => {
              const ws = await deps.controller!.newChat(plan.projectId, `Review: ${planTitle(plan)}`.slice(0, 40), undefined, { quiet: true });
              if (ws && plan.agent) deps.controller!.manager.setAgent(ws.id, plan.agent);
              return ws?.id;
            },
            chatAgent: (chat: string, plan: Plan) => {
              if (plan.agent) deps.controller!.manager.setAgent(chat, plan.agent);
            },
          }
        : {}),
      // Verify, Then Approve: you asked for it, so it's approved as you.
      approve: (id: string) => void this.approve(id),
      ...(deps.alive ? { alive: deps.alive } : {}),
      ...(deps.cancel ? { cancel: deps.cancel } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.delayMs !== undefined ? { delayMs: deps.delayMs } : {}),
    });
    const git = deps.git === null ? undefined : (deps.git ?? (deps.controller?.manager ? planGitOf(deps.controller) : undefined));
    this.pilot = new PlanPilot({
      store: deps.store,
      plans: deps.plans,
      work: deps.board,
      askClaude: deps.askClaude,
      system: (channel, text) => deps.store.dispatch({ type: 'system', channel, text, level: 'info' }),
      ...(deps.combine ? { combine: deps.combine } : deps.controller ? { combine: (projectId, key, branches, into) => deps.controller!.manager.combineBase(projectId, key, branches, into) } : {}),
      ...(git ? { git } : {}),
      ...(deps.controller ? { allowFixup: (channel, dir) => deps.controller!.allowFixup?.(channel, dir) } : {}),
      // Each milestone's check: a conversation of its own in the project (folded into the plan), archived once it passed.
      ...(deps.controller
        ? {
            // On the plan's agent (BLG-503), like its workers; none picked: the project's.
            checkerChat: async (plan, milestone) => {
              const ws = await deps.controller!.newChat(plan.projectId, `Check: ${milestone.title}`.slice(0, 40), undefined, { quiet: true });
              if (ws && plan.agent) deps.controller!.manager.setAgent(ws.id, plan.agent);
              return ws?.id;
            },
            retireChat: (id) => void deps.controller!.archive(id, false, { quiet: true }).catch(() => undefined),
          }
        : {}),
      ...(deps.alive ? { alive: deps.alive } : {}),
      ...(deps.takeOver ? { takeOver: deps.takeOver } : {}),
      ...(deps.promote ? { promote: deps.promote } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.delayMs !== undefined ? { delayMs: deps.delayMs } : {}),
      ...(deps.workers ? { workers: deps.workers } : {}),
      ...(deps.cancel ? { cancel: deps.cancel } : {}),
      ...(deps.forYou ? { forYou: deps.forYou } : {}),
      ...(deps.rescueMs !== undefined ? { rescueMs: deps.rescueMs } : {}),
      structure: (plan) => this.structure(plan.id),
    });
    this.mover = new PlanMover({
      store: deps.store,
      plans: deps.plans,
      board: deps.board.board,
      ...(deps.controller ? { controller: deps.controller } : {}),
      view: (plan) => this.pilot.view(plan),
      busy: (channel) => liveFrom(deps.store.getState()).busy(channel),
      settle: (id) => {
        this.structure(id);
        this.pilot.schedule();
      },
      me: () => this.me(),
      ...(deps.now ? { now: deps.now } : {}),
    });
    // A task of a plan: its worktree's Claude knows the plan and what runs beside it.
    deps.board.setBriefExtra((issue) => this.workerBrief(issue));
    // A milestone's worktree: its one Claude gets the milestone (its tasks in order, where each stands).
    deps.board.setRunBrief((channel) => this.milestoneBrief(channel));
  }

  stop(): void {
    this.pilot.stop();
    this.reviewer.stop();
    this.plans.flush();
  }

  private me = (): Actor => this.deps.board.me();
  private claude = (): Actor => this.deps.board.myClaude();

  // ------------------------------------------------------------------ for you (the API)

  /**
   * A new plan with Claude: a conversation of its own in the project's main folder (Claude reads
   * the code there and changes nothing), and the plan's page. Claude starts planning from `goal`.
   */
  /** `quiet`: started from elsewhere (Your Mac), so the Mac's window stays where it is. */
  async create(input: { readonly projectId: string; readonly goal: string; readonly autonomy?: Autonomy; readonly testsAt?: TestsAt; readonly agent?: AgentRef }, opts: { readonly quiet?: boolean } = {}): Promise<Plan> {
    const controller = this.deps.controller;
    if (!controller) throw new Error('Plans need a project folder');
    const goal = input.goal.trim();
    if (!goal) throw new Error('Say what the plan is for');
    const chat = await controller.newChat(input.projectId, UNTITLED, undefined, { quiet: true });
    if (!chat) throw new Error('Couldn’t start the plan’s conversation');
    const home = `${WS}${chat.id}`;
    const plan = this.plans.create({ projectId: input.projectId, home, goal, ...(input.autonomy ? { autonomy: input.autonomy } : {}), ...(input.testsAt ? { testsAt: input.testsAt } : {}), ...(input.agent ? { agent: input.agent } : {}) }, this.me());
    if (!opts.quiet) this.deps.intend({ type: 'navigate', view: { kind: 'plan', id: plan.id } });
    this.deps.askClaude(goal, home, true);
    // Named in a moment by a quick model (your message is never its name); Claude's plan_write names it after that.
    void this.deps
      .titlePlan?.(goal)
      .then((title) => {
        const named = title ? this.plans.autoTitle(plan.id, title) : undefined;
        if (named) this.nameHome(named, UNTITLED);
      })
      .catch(() => undefined);
    return plan;
  }

  /**
   * A plan an external agent starts: a draft and its own conversation, and no run of your agent. The
   * agent writes the draft with plan_write, and you approve it.
   */
  async createForAgent(projectId: string, goal: string, agent: ExternalActor): Promise<Plan> {
    const chat = await this.deps.controller?.newChat(projectId, UNTITLED, undefined, { quiet: true });
    if (!chat) throw new Error('Couldn’t start the plan’s conversation');
    this.deps.controller?.manager.setStartedBy(chat.id, agent);
    return this.plans.create({ projectId, home: `${WS}${chat.id}`, goal: goal.trim() }, this.deps.board.agentActor(agent));
  }

  /** A plan's own conversation goes by the plan's name (in the sidebar too), unless you renamed it. */
  private nameHome(plan: Plan, was: string): void {
    const title = planTitle(plan);
    if (title === was || !plan.home.startsWith(WS)) return;
    const ws = this.deps.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === plan.home.slice(WS.length));
    if (ws?.kind === 'chat' && (ws.name === UNTITLED || ws.name === was.slice(0, 40))) void this.deps.controller?.renameChat(ws.id, title);
  }

  /** A plan's own conversation, made quietly (the demo's plan), with what was said there saved (as after a restart: it loads when it's opened). */
  async homeFor(projectId: string, title: string, said?: (channel: string) => readonly LogItem[]): Promise<string | undefined> {
    return this.savedChat(projectId, `Plan: ${title}`, said);
  }

  /** A milestone's checker conversation with what it said (the demo's passed milestone): its workspace id. */
  async checkerFor(projectId: string, title: string, said: (channel: string) => readonly LogItem[]): Promise<string | undefined> {
    return (await this.savedChat(projectId, `Check: ${title}`.slice(0, 40), said))?.slice(WS.length);
  }

  private async savedChat(projectId: string, name: string, said?: (channel: string) => readonly LogItem[]): Promise<string | undefined> {
    const chat = await this.deps.controller?.newChat(projectId, name, undefined, { quiet: true });
    if (!chat) return undefined;
    if (said) this.deps.controller?.manager.saveHistory(chat.id, said(`${WS}${chat.id}`));
    return `${WS}${chat.id}`;
  }

  /** Plan in the conversation you're in (the composer's Plan with Tasks): an empty draft, written from what you say next. */
  here(channel: string, autonomy?: Autonomy): Plan {
    const existing = planForHome(this.plans.state(), channel);
    if (existing && existing.status !== 'done') return existing;
    const ws = channel.startsWith(WS) ? this.deps.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === channel.slice(WS.length)) : undefined;
    const project = ws ? this.deps.store.getState().projects.find((p) => p.id === ws.projectId && p.root) : undefined;
    if (!ws || !project) throw new Error('Plans belong to a project: start one from a conversation in a project');
    return this.plans.create({ projectId: project.id, home: channel, ...(autonomy ? { autonomy } : {}) }, this.me());
  }

  /** Approve the draft: its tasks go on the board, and the plan runs (or carries on with the changes). */
  approve(id: string, by: Actor = this.me()): Plan {
    const plan = this.plans.need(id);
    let applied: ReturnType<typeof applyDraft>;
    try {
      applied = applyDraft(plan, this.deps.board.board, { by, me: this.deps.board.me() });
    } catch (err) {
      // What was made stays linked to the draft, so approving again doesn't make it twice.
      if (err instanceof ApplyError) this.plans.linkDraft(id, err.linked);
      throw err;
    }
    const { body, summary } = applied;
    const done = this.structure(this.plans.approved(id, body, by, summary).id);
    this.retireReview(done);
    this.syncHomeTask(done);
    this.deps.store.dispatch({ type: 'system', channel: plan.home, text: plan.body ? `Changes applied: ${summary}.` : `Plan approved: ${summary} are on the board now.`, level: 'info' });
    this.pilot.schedule();
    return done;
  }

  discard(id: string): Plan | undefined {
    const plan = this.plans.need(id);
    const next = this.plans.discard(id, this.me());
    if (!next) this.retireReview(plan);
    return next;
  }

  /** Fix: the draft's review findings go to the plan's agent (see draft-review.ts). */
  fixReview(id: string): Plan {
    return this.reviewer.fix(id);
  }

  /** Verify the draft with a fresh agent (`thenApprove`: approve it once it reads well). */
  verify(id: string, thenApprove = false): Promise<Plan> {
    return this.reviewer.verify(id, thenApprove);
  }

  /** A draft's reviewer is done with (the plan was approved, or thrown away): its conversation archived. */
  private retireReview(plan: Plan): void {
    const chat = plan.review?.chat;
    if (!chat) return;
    if (this.plans.get(plan.id)) this.plans.setReview(plan.id, undefined);
    void this.deps.controller?.archive(chat, false, { quiet: true }).catch(() => undefined);
  }

  /**
   * The plan home's own board task (a worktree doing a task, planning there): its goal and decisions
   * follow the plan's, so it never goes on describing a first draft (BLG-772). What its brief said
   * before stays in the brief's history.
   */
  private syncHomeTask(plan: Plan): void {
    if (!plan.home.startsWith(WS) || plan.status === 'done') return;
    const body = plan.body ?? plan.draft;
    if (!body) return;
    const board = this.deps.board.board;
    const issue = issueForWorkspace(board.state(), plan.home.slice(WS.length));
    if (!issue || issue.plan?.id === plan.id || issue.status === 'canceled' || issue.status === 'done') return;
    const by: Actor = { kind: 'beluga' };
    const reason = `kept in step with the plan “${body.title}”`;
    try {
      if (body.goal.trim()) board.editBrief(issue.id, 'goal', body.goal, by, { reason });
      const decided = activeDecisions(body);
      if (decided.length) board.editBrief(issue.id, 'decisions', [`From the plan “${body.title}” (its decisions live there; Beluga keeps this in step):`, ...decided.map((d) => `- ${d.text}`)].join('\n'), by, { reason });
    } catch {
      // The task went: nothing to keep in step.
    }
  }

  /** Your changes: an approved plan without waiting changes takes them at once (you're the one approving). */
  edit(id: string, ops: readonly PlanOp[]): Plan {
    const plan = this.plans.need(id);
    const retitle = ops.length === 1 && ops[0]!.op === 'retitle' && ops[0]!.goal === undefined && ops[0]!.title !== undefined;
    if (retitle) {
      const named = this.plans.retitle(id, ops[0]!.op === 'retitle' ? ops[0]!.title! : '', this.me());
      this.nameHome(named, planTitle(plan));
      return this.structure(named.id);
    }
    const direct = Boolean(plan.body) && !plan.draft;
    const next = this.plans.editDraft(id, ops, this.me());
    this.syncHomeTask(next);
    return direct && next.draft ? this.approve(id) : next;
  }

  setAutonomy(id: string, autonomy: Autonomy, milestone?: string): Plan {
    const plan = this.plans.setAutonomy(id, autonomy, this.me(), milestone);
    this.pilot.schedule();
    return plan;
  }

  setPaused(id: string, paused: boolean): Plan {
    const plan = this.plans.setPaused(id, paused, this.me());
    this.pilot.schedule();
    return plan;
  }

  setParallel(id: string, n: number): Plan {
    const plan = this.plans.setMaxParallel(id, n, this.me());
    this.pilot.schedule();
    return plan;
  }

  /** When the plan runs its test suites: each milestone's check, or only the final step. */
  setTestsAt(id: string, testsAt: TestsAt): Plan {
    return this.plans.setTestsAt(id, testsAt, this.me());
  }

  /**
   * Who works the plan's milestones and tasks (BLG-498): `agent`, or your default (null). Work that
   * starts from now on gets it; milestones and tasks already at work keep the agent they opened with
   * (switching mid-run would lose their sessions). A task's own agent still beats it. → in words.
   */
  setWorkAgent(id: string, agent: AgentRef | null): string {
    const plan = this.plans.setWorkAgent(id, agent ?? undefined, this.me());
    const who = agent ? agentName(agent, { model: true }) : 'your default agent';
    const busy = Object.values(plan.runs).filter((r) => r?.agent && !r.passedAt).length;
    return busy ? `${who} works what starts next; the ${busy === 1 ? 'milestone' : `${busy} milestones`} already at work keep${busy === 1 ? 's' : ''} ${busy === 1 ? 'its' : 'their'} agent` : `${who} works this plan’s milestones and tasks`;
  }

  pass(id: string, milestone: string): Plan {
    return this.pilot.pass(id, milestone, this.me());
  }

  /** “Tidy up N merged task worktrees?”: only Yes merges and clears them away (see PlanPilot.tidyUp). */
  tidyUp(id: string, yes: boolean): Plan {
    return this.pilot.tidyUp(id, yes, this.me());
  }

  /** Not yet: what's missing goes to the head Claude, which adds the work to the plan. */
  sendBack(id: string, milestone: string, note: string): Plan {
    const plan = this.plans.need(id);
    const m = plan.body?.milestones.find((x) => x.id === milestone);
    if (!m) throw new Error('That milestone isn’t in the approved plan');
    const text = note.trim();
    if (!text) throw new Error('Say what’s missing');
    this.plans.note(id, 'failed', `sent “${m.title}” back: ${text}`, this.me());
    this.deps.askClaude(`Milestone “${m.title}” isn't done yet: ${text}\n\nAdd the tasks that fix it to this milestone with plan_update (the user approves them), or tell me what you need.`, plan.home, true);
    return this.plans.need(id);
  }

  /** Ask the head Claude to check a milestone again. */
  recheck(id: string, milestone: string): Plan {
    this.pilot.recheck(id, milestone);
    return this.plans.need(id);
  }

  /** The plan's pull request (its branch → main), merging it on GitHub, or merging the branch here. */
  openPr(id: string): Promise<Plan> {
    return this.pilot.openPr(id);
  }

  mergePr(id: string, opts: { readonly auto?: boolean } = {}): Promise<Plan> {
    return this.pilot.mergePr(id, opts);
  }

  mergeLocal(id: string): Promise<Plan> {
    return this.pilot.mergeLocal(id);
  }

  /** A conflict Claude couldn't fix: asked again now. */
  retryConflicts(id: string): Plan {
    return this.pilot.retryConflicts(id);
  }

  /** Where its conflict waits to be fixed (undefined: none). */
  conflictDir(id: string): string | undefined {
    return this.pilot.conflictDir(id);
  }

  /** Its pull request conflicts with main: main merged into the plan's branch (a conflict goes to its Claude). */
  bringInMain(id: string): Promise<Plan> {
    return this.pilot.bringInMain(id);
  }

  /** `agent` (Start with…, BLG-506): who works it this once; none: the task's own, the plan's, or your default. */
  startTask(id: string, task: string, agent?: AgentRef): Promise<string> {
    return this.pilot.startNow(id, task, this.me(), agent);
  }

  /** Wake a task whose Claude stopped without finishing (Resume on its card). */
  resumeTask(id: string, task: string): string {
    return this.pilot.resume(id, task);
  }

  remove(id: string): void {
    const plan = this.plans.get(id);
    if (plan?.epics) dropEpics(plan, this.deps.board.board, { kind: 'beluga' });
    this.plans.remove(id);
  }

  /**
   * The plan's shape on the board (an epic for it, one per milestone, its tasks under them): made or
   * brought up to date. Never in the way: a board that can't take it leaves the plan as it is.
   */
  private structure(id: string): Plan {
    const plan = this.plans.need(id);
    if (!plan.body || plan.status === 'draft') return plan;
    try {
      const epics = syncEpics(plan, this.deps.board.board, { kind: 'beluga' });
      return epics ? this.plans.setEpics(id, epics) : plan;
    } catch (err) {
      this.plans.note(id, 'problem', `couldn’t show the plan as epics on the board: ${err instanceof Error ? err.message : String(err)}`, { kind: 'beluga' });
      return this.plans.need(id);
    }
  }

  setStyle(text: string): void {
    this.plans.setStyle(text);
  }

  // ------------------------------------------------------------------ for Claude

  /** A run in a plan's home conversation (yours): the plan's tools, and how to plan or run it. */
  forRun(channel: string, from: string): { readonly tools?: PlanTools; readonly brief?: string; readonly checker?: boolean } | undefined {
    const me = this.deps.board.me();
    if (me.kind !== 'person' || from !== me.id) return undefined;
    // A milestone's checker: its brief, and only plan_get and plan_gate.
    // A draft's reviewer: its brief, and only plan_get and plan_review.
    const reviewing = reviewerOf(this.plans.state(), channel);
    if (reviewing) return reviewing.status === 'draft' && reviewing.draft ? { tools: this.reviewerTools(reviewing.id), brief: reviewerBrief(reviewing), checker: true } : undefined;
    const checking = checkerOf(this.plans.state(), channel);
    if (checking) {
      if (checking.plan.status !== 'active' || !checking.plan.body || checking.plan.movedTo) return undefined;
      const view = this.pilot.view(checking.plan);
      const m = view.milestones.find((x) => x.milestone.id === checking.milestone);
      return m ? { tools: this.checkerTools(checking.plan.id, m.milestone.id), brief: checkerBrief(view, m), checker: true } : undefined;
    }
    const plan = planForHome(this.plans.state(), channel);
    if (!plan) return undefined;
    const board = this.deps.store.getState().board;
    const view = this.pilot.view(plan);
    const brief = plan.body ? headBrief(view) + planningBrief(plan, board, this.plans.planningStyle) : planningBrief(plan, board, this.plans.planningStyle);
    return { tools: this.toolsFor(plan.id), brief };
  }

  /** In a task's worktree: the plan it's part of. */
  private workerBrief(issue: Issue): string {
    const hit = planTaskOfIssue(this.plans.state(), issue.id);
    if (!hit || hit.plan.status !== 'active') return '';
    return workerNote(this.pilot.view(hit.plan), hit.task.id);
  }

  /** In a milestone's worktree (its one Claude): the milestone, and the task it's on (for the task tools). */
  private milestoneBrief(channel: string): { readonly brief: string; readonly current?: Issue } | undefined {
    if (!channel.startsWith(WS)) return undefined;
    const wsId = channel.slice(WS.length);
    for (const plan of this.plans.list()) {
      if (plan.status !== 'active' || !plan.body || plan.movedTo) continue;
      const id = Object.keys(plan.runs).find((k) => plan.runs[k]?.agent?.worktree === wsId);
      if (!id) continue;
      const view = this.pilot.view(plan);
      const m = view.milestones.find((x) => x.milestone.id === id);
      if (!m) return undefined;
      const mine = m.tasks.filter((t) => t.issue?.worktrees.includes(wsId));
      const current = mine.find((t) => t.state === 'running' || t.state === 'idle' || t.state === 'asking' || t.state === 'stalled') ?? mine.find((t) => t.state === 'ready');
      return { brief: milestoneNote(view, m, current), ...(current?.issue ? { current: current.issue } : {}) };
    }
    return undefined;
  }

  /** A task Claude says is an existing board task (its key): that task, adopted into the plan. */
  private adopt<T extends Partial<TaskInput> & { readonly issue?: string }>(t: T, planId: string): T {
    if (!t.issue) return t;
    const { issue: key, ...rest } = t;
    const issue = this.deps.board.board.get(key);
    const plan = this.plans.need(planId);
    if (!issue) throw new Error(`There's no task ${key} on the board`);
    if (issue.projectId !== plan.projectId) throw new Error(`${issue.key} belongs to another project`);
    if (issue.plan && issue.plan.id !== planId) throw new Error(`${issue.key} is already part of another plan`);
    return { ...rest, issueId: issue.id } as T;
  }

  /**
   * A milestone's checker: it reads the plan and records its verdict on that milestone, nothing more.
   * The verdict reaches the head Claude as one line; a failed one with the notes, to add the fix tasks.
   */
  private checkerTools(planId: string, milestoneId: string): PlanTools {
    const full = this.toolsFor(planId);
    const refuse = (): never => {
      throw new Error('You check this milestone: only plan_get and plan_gate are yours here');
    };
    return {
      only: ['plan_get', 'plan_gate'],
      get: full.get,
      write: refuse,
      update: refuse,
      start: async () => refuse(),
      message: refuse,
      gate: (milestone, verdict, notes) => {
        const plan = this.plans.need(planId);
        const m = plan.body?.milestones.find((x) => x.id === milestoneId);
        if (!m) throw new Error('That milestone isn’t in the approved plan any more: nothing to record');
        if (milestone !== m.id && milestone.toLowerCase() !== m.title.toLowerCase()) throw new Error(`You check “${m.title}” only (id ${m.id})`);
        const said = full.gate(m.id, verdict, notes);
        if (!said.startsWith('Recorded')) return said;
        const first = notes.trim().split('\n')[0]!.slice(0, 200);
        const auto = (m.autonomy ?? plan.autonomy) === 'autopilot';
        if (verdict === 'pass') {
          this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `“${m.title}” checked: it passes${auto ? ', and the plan moves on' : '. It’s yours to pass'}. ${first}`, level: 'info' });
          return `${said} Your check is done: end your turn.`;
        }
        this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `“${m.title}” didn’t pass its check: ${first}`, level: 'info' });
        this.deps.askClaude(checkFailedPrompt(m.title, notes, auto), plan.home, false);
        return 'Recorded as failed. The plan’s Claude adds the fix tasks from your notes. Your check is done: end your turn.';
      },
    };
  }

  /**
   * An external agent's tools on one plan. Its changes stay a draft for you, also on autopilot: an
   * agent never gets a plan approved. Its name goes in the plan's history.
   */
  toolsForAgent(planId: string, agent: ExternalActor): PlanTools {
    return { ...this.toolsFor(planId, this.deps.board.agentActor(agent)), only: ['plan_get', 'plan_write', 'plan_update', 'plan_start_task', 'plan_pause'] };
  }

  /** The chat of a plan's started task (its id, or its board key): the worktree it works in. */
  taskChat(planId: string, task: string): string | undefined {
    const hit = allTasks(this.plans.need(planId).body).find((t) => t.task.id === task || (t.task.issueId && this.deps.board.board.get(t.task.issueId)?.key === task.toUpperCase()));
    const issue = hit?.task.issueId ? this.deps.board.board.get(hit.task.issueId) : undefined;
    return issue && !issue.worktreeGone ? issue.worktrees.at(-1) : undefined;
  }

  /** A draft's reviewer: it reads the draft and records what it found, nothing more. */
  private reviewerTools(planId: string): PlanTools {
    const full = this.toolsFor(planId);
    const refuse = (): never => {
      throw new Error('You review this draft: only plan_get and plan_review are yours here');
    };
    return {
      only: ['plan_get', 'plan_review'],
      get: full.get,
      write: refuse,
      update: refuse,
      gate: refuse,
      start: async () => refuse(),
      message: refuse,
      review: (findings) => this.reviewer.record(planId, findings),
    };
  }

  private toolsFor(planId: string, external?: Actor): PlanTools {
    const by = (): Actor => external ?? this.claude();
    const plans = this.plans;
    const after = (change: () => Plan): string => {
      const before = plans.need(planId);
      const was = planTitle(before);
      const plan = change();
      this.nameHome(plan, was);
      this.syncHomeTask(plan);
      if (!plan.draft) return 'The plan is unchanged.';
      // What this change left behind, said next to "Saved" (BLG-772).
      const warn = (body: Plan['draft']): string => (body ? warningsText(coherenceWarnings(body, before.draft ?? before.body)) : '');
      // On autopilot, the head Claude's changes to a running plan apply at once.
      if (!external && plan.body && plan.autonomy === 'autopilot') {
        const applied = this.approve(plan.id, this.claude());
        return `Applied at once (the plan runs on autopilot): ${sizeWords(applied.body)}.${warn(applied.body)}`;
      }
      return (plan.body ? `Proposed (${sizeWords(plan.draft)}): the user reviews the changes and applies them.` : `Saved the draft (${sizeWords(plan.draft)}). The user reviews it and clicks Approve; nothing is on the board until then.`) + warn(plan.draft);
    };
    return {
      get: () => describePlan(this.pilot.view(plans.need(planId))),
      write: (body: BodyInput) => after(() => plans.writeDraft(planId, { ...body, milestones: body.milestones.map((m) => ({ ...m, tasks: (m.tasks ?? []).map((t) => this.adopt(t, planId)) })) }, by())),
      update: (ops: readonly PlanOp[], reason?: string) =>
        after(() =>
          plans.editDraft(
            planId,
            ops.map((o) => (o.op === 'add_task' ? { ...o, task: this.adopt(o.task, planId) } : o.op === 'update_task' ? { ...o, patch: this.adopt(o.patch, planId) } : o.op === 'add_milestone' ? { ...o, milestone: { ...o.milestone, tasks: (o.milestone.tasks ?? []).map((t) => this.adopt(t, planId)) } } : o)),
            by(),
            reason,
          ),
        ),
      gate: (milestone, verdict, notes) => {
        const plan = plans.need(planId);
        const m = plan.body?.milestones.find((x) => x.id === milestone || x.title.toLowerCase() === milestone.toLowerCase());
        if (!m) throw new Error(`There's no milestone "${milestone}" in the approved plan (milestones: ${(plan.body?.milestones ?? []).map((x) => x.id).join(', ')})`);
        // The user passed it while you checked: your verdict isn't needed any more.
        if (plan.runs[m.id]?.passedAt || (plan.merging?.[m.id] && !plan.merging[m.id]!.catchUp)) return 'The user already passed this milestone: nothing to record. Stop checking it and end your turn.';
        plans.recordCheck(planId, m.id, { by: this.claude(), verdict, notes });
        this.pilot.schedule();
        const auto = (m.autonomy ?? plan.autonomy) === 'autopilot';
        return verdict === 'pass' ? (auto ? 'Recorded: the milestone passes and the plan moves on.' : 'Recorded: the user passes the milestone.') : 'Recorded as failed. Add the fix tasks with plan_update.';
      },
      start: (task) => this.pilot.startNow(planId, task, by()),
      message: (task, text, mode = 'queue') => {
        const plan = plans.need(planId);
        const hit = allTasks(plan.body).find((t) => t.task.id === task || (t.task.issueId && this.deps.board.board.get(t.task.issueId)?.key === task.toUpperCase()));
        if (!hit?.task.issueId) throw new Error(`There's no task "${task}" on the board from this plan`);
        const issue = this.deps.board.board.need(hit.task.issueId);
        const w = issue.worktrees.at(-1);
        if (!w || issue.worktreeGone) throw new Error(`${issue.key} hasn't started: nothing to tell yet (start it, or change its brief)`);
        const steer = mode === 'steer';
        // Shown there as the plan's message, not as yours.
        this.deps.store.dispatch({ type: 'system', channel: `${WS}${w}`, text: `${steer ? 'Urgent, from' : 'From'} the plan’s agent: ${text.trim().slice(0, 2000)}`, level: 'info' });
        const prompt = `${steer ? 'An urgent message' : 'A message'} from the head of the plan “${plan.body?.title ?? ''}” (another agent coordinating the plan, not the user):\n\n${text.trim()}`;
        const id = this.deps.askClaude(prompt, `${WS}${w}`, false);
        if (!steer) return `Queued for the agent working on ${issue.key}: it reads it when its current turn ends (its card shows it waiting; use mode "steer" if it can't wait)`;
        // Steered: in now (interrupting a long command or a dead run), and followed until it's read.
        if (id) this.pilot.steer(planId, hit.task.id, id, prompt);
        return `Steered into ${issue.key}: its agent gets it now (a long command or a stuck turn is interrupted). If it isn't read within 2 minutes, Beluga delivers it again`;
      },
      stop: (task) => {
        const plan = plans.need(planId);
        const hit = allTasks(plan.body).find((t) => t.task.id === task || (t.task.issueId && this.deps.board.board.get(t.task.issueId)?.key === task.toUpperCase()));
        const issue = hit?.task.issueId ? this.deps.board.board.get(hit.task.issueId) : undefined;
        const w = issue?.worktrees.at(-1);
        if (!issue || !w || issue.worktreeGone) throw new Error(`There's no started task "${task}" in this plan`);
        if (!this.deps.stopRun) throw new Error('Stopping isn’t available here');
        this.deps.stopRun(`${WS}${w}`);
        this.deps.store.dispatch({ type: 'system', channel: `${WS}${w}`, text: 'Stopped by the plan’s agent.', level: 'info' });
        return `Stopped the agent working on ${issue.key}. It waits: tell it what to do with plan_message_task, or start it again from the plan`;
      },
      pause: (paused) => {
        plans.setPaused(planId, paused, external ?? this.me());
        this.pilot.schedule();
        return paused ? 'Paused: nothing new starts until the user (or you, when they ask) resumes it' : 'Resumed: ready tasks start again';
      },
    };
  }
}
