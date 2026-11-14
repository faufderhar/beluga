import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AgentRef } from '../../protocol.js';
import { agentName } from '../../shared/agent-label.js';
import { JsonFile, readJson, writeJson } from '../../net/mesh/files.js';
import { type Actor, renamedActors } from '../board/model.js';
import type { Store } from '../store.js';
import { type BodyInput, type PlanOp, PlanError, applyOps, normalizeBody } from './edit.js';
import {
  AUTONOMIES,
  AUTONOMY_INFO,
  type Autonomy,
  type Combining,
  DEFAULT_AUTONOMY,
  type DraftReview,
  DEFAULT_PARALLEL,
  type GateCheck,
  KEEP_PLAN_ACTIVITY,
  MAX_PARALLEL,
  type MilestoneAgent,
  type MilestoneRun,
  type PlanEpics,
  type PlanRescue,
  type Plan,
  type PlanBody,
  type PlanEvent,
  type PlanEventKind,
  type PlanMainMerge,
  type PlanMerge,
  type PlanMove,
  type PlanPr,
  type PlanShipped,
  type PlansState,
  type TaskWatch,
  TESTS_AT,
  type TestsAt,
  diffBodies,
  NOTE_MAX,
  isEmptyDiff,
  planById,
} from './model.js';

/**
 * Plans, kept in ~/.beluga/plans.json (readable only by you) and mirrored into the shared state.
 * A draft stays here, with its conversation: nothing reaches the board until it's approved (see
 * apply.ts). Your planning style is ~/.beluga/planning.md. Without a folder (tests) it's memory only.
 */

export interface PlansDeps {
  readonly store: Store;
  readonly dir: string | null;
  readonly now?: () => number;
  readonly saveDelayMs?: number;
}

const MAX_STYLE = 8000;
/** A plan's name until it has one. */
export const UNTITLED = 'New plan';
/** A run of drafting by one author this close together is one line in the activity. */
const DRAFT_NOTE_MS = 3 * 60 * 1000;

const PlansFile = z.object({ version: z.literal(1), plans: z.array(z.unknown()).default([]) });

/** What a plan says, checked enough that screens can draw it (the rest kept as it was). */
const Body = z
  .object({
    title: z.string(),
    goal: z.string().default(''),
    milestones: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          criteria: z.array(z.string()).default([]),
          tasks: z.array(z.object({ id: z.string(), title: z.string(), acceptance: z.array(z.string()).default([]), blockedBy: z.array(z.string()).default([]) }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** A plan as saved: loosely checked (it's our own file), the rest filled in. */
const SavedPlan = z
  .object({
    id: z.string(),
    projectId: z.string(),
    home: z.string(),
    status: z.enum(['draft', 'active', 'done']),
    draftRev: z.number().default(0),
    autonomy: z.enum(AUTONOMIES).default('gated'),
    maxParallel: z.number().int().min(1).max(MAX_PARALLEL).catch(DEFAULT_PARALLEL),
    testsAt: z.enum(TESTS_AT).catch('milestone'),
    // Who works it (BLG-497): one that doesn't read is let go (your default works it).
    agent: AgentRef.optional().catch(undefined),
    body: Body.optional().catch(undefined),
    draft: Body.optional().catch(undefined),
    paused: z.boolean().default(false),
    runs: z.record(z.string(), z.unknown()).default({}),
    activity: z.array(z.unknown()).default([]),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .passthrough();

const short = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

export class Plans {
  private plans: Plan[] = [];
  private style = '';
  /** plans.json: large with many plans, so written in the background (BLG-942). */
  private readonly file: JsonFile | undefined;
  private readOnly = false;
  private readonly now: () => number;

  constructor(private readonly deps: PlansDeps) {
    this.now = deps.now ?? Date.now;
    this.file = deps.dir ? new JsonFile(path.join(deps.dir, 'plans.json'), () => ({ version: 1, plans: this.plans }), deps.saveDelayMs ?? 300) : undefined;
    this.load();
    deps.store.dispatch({ type: 'plans_init', state: this.state() });
  }

  state(): PlansState {
    return { enabled: true, plans: this.plans, style: this.style };
  }

  list = (): readonly Plan[] => this.plans;

  get = (id: string): Plan | undefined => planById(this.state(), id);

  need(id: string): Plan {
    const plan = this.get(id);
    if (!plan) throw new Error('That plan isn’t here any more');
    return plan;
  }

  get planningStyle(): string {
    return this.style;
  }

  // ------------------------------------------------------------------ drafting

  /** A new plan: an empty draft in its conversation (Claude writes it there). Your goal is never its title: a quick model names it (autoTitle), and Claude's plan_write after that. */
  create(input: { readonly projectId: string; readonly home: string; readonly title?: string; readonly goal?: string; readonly autonomy?: Autonomy; readonly testsAt?: TestsAt; readonly agent?: AgentRef }, by: Actor): Plan {
    const at = this.now();
    const title = (input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || UNTITLED;
    const plan: Plan = {
      id: short('pl'),
      projectId: input.projectId,
      home: input.home,
      status: 'draft',
      draft: { title, goal: input.goal?.trim().slice(0, 4000) ?? '', milestones: [] },
      draftRev: 1,
      autonomy: input.autonomy ?? DEFAULT_AUTONOMY,
      maxParallel: DEFAULT_PARALLEL,
      testsAt: input.testsAt ?? 'milestone',
      ...(input.agent ? { agent: input.agent } : {}),
      paused: false,
      runs: {},
      activity: [event(by, 'created', 'started this plan', at)],
      createdAt: at,
      updatedAt: at,
    };
    this.plans = [...this.plans, plan];
    this.publish(plan);
    return plan;
  }

  /** Claude's whole plan (the draft). Tasks it named before keep their board tasks. */
  writeDraft(id: string, input: BodyInput, by: Actor): Plan {
    const plan = this.need(id);
    const draft = normalizeBody(input, [plan.draft, plan.body]);
    return this.setDraft(plan, draft, by, plan.body ? 'proposed changes to the plan' : 'wrote the plan');
  }

  /** Changes to the draft (one is made from what was approved when there's none). */
  editDraft(id: string, ops: readonly PlanOp[], by: Actor, reason?: string): Plan {
    const plan = this.need(id);
    const base = plan.draft ?? plan.body;
    if (!base) throw new PlanError('This plan has nothing in it yet: write it whole first (plan_write)');
    const draft = applyOps(base, ops);
    const why = reason?.replace(/\s+/g, ' ').trim().slice(0, 200);
    return this.setDraft(plan, draft, by, why ? `changed the plan — ${why}` : plan.body ? 'proposed changes to the plan' : 'changed the plan');
  }

  private setDraft(plan: Plan, draft: PlanBody, by: Actor, text: string): Plan {
    // Back to exactly what was approved: no changes are waiting.
    const same = plan.body && isEmptyDiff(diffBodies(plan.body, draft)) && plan.body.title === draft.title && plan.body.goal === draft.goal && JSON.stringify(plan.body.decisions ?? []) === JSON.stringify(draft.decisions ?? []);
    const last = plan.activity.at(-1);
    const quick = last && last.kind === 'drafted' && sameActor(last.by, by) && this.now() - last.at < DRAFT_NOTE_MS;
    const activity = same ? [] : [event(by, 'drafted', text, this.now())];
    return this.change(plan, same ? { draft: undefined, draftRev: plan.draftRev + 1 } : { draft, draftRev: plan.draftRev + 1 }, activity, Boolean(quick && !same));
  }

  /** The title (and goal) change at once, approved plan or not (nothing to approve in a name). */
  retitle(id: string, title: string, by: Actor): Plan {
    const plan = this.need(id);
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) throw new PlanError('A plan needs a title');
    return this.change(plan, { ...(plan.draft ? { draft: { ...plan.draft, title: clean } } : {}), ...(plan.body ? { body: { ...plan.body, title: clean } } : {}) }, [event(by, 'note', `renamed the plan to “${clean}”`, this.now())]);
  }

  /** The quick name for a new plan: only while it has none (Claude's plan_write, or you, named it first otherwise). */
  autoTitle(id: string, title: string): Plan | undefined {
    const plan = this.get(id);
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!plan || !clean || plan.body || plan.draft?.title !== UNTITLED) return undefined;
    return this.change(plan, { draft: { ...plan.draft, title: clean } }, []);
  }

  /** Throw the draft away (a plan never approved goes with it). */
  discard(id: string, by: Actor): Plan | undefined {
    const plan = this.need(id);
    if (!plan.body) {
      this.remove(id);
      return undefined;
    }
    return this.change(plan, { draft: undefined, draftRev: plan.draftRev + 1 }, [event(by, 'note', 'threw away the proposed changes', this.now())]);
  }

  /** Board tasks made for draft tasks by an approval that failed partway: kept, so trying again uses them. */
  linkDraft(id: string, linked: ReadonlyMap<string, string>): Plan {
    const plan = this.need(id);
    if (!plan.draft || !linked.size) return plan;
    const draft = { ...plan.draft, milestones: plan.draft.milestones.map((m) => ({ ...m, tasks: m.tasks.map((t) => (linked.has(t.id) ? { ...t, issueId: linked.get(t.id)! } : t)) })) };
    return this.change(plan, { draft }, []);
  }

  /** The draft is on the board now (`body`: it, with each task's board task). */
  approved(id: string, body: PlanBody, by: Actor, summary: string): Plan {
    const plan = this.need(id);
    const first = !plan.body;
    const at = this.now();
    const open = body.milestones.some((m) => !plan.runs[m.id]?.passedAt);
    return this.change(plan, { body, draft: undefined, draftRev: plan.draftRev + 1, status: open ? 'active' : 'done', ...(first ? { approvedAt: at } : {}), ...(open ? { doneAt: undefined } : {}) }, [event(by, first ? 'approved' : 'changed', first ? `approved the plan: ${summary}` : `applied changes: ${summary}`, at)]);
  }

  // ------------------------------------------------------------------ running

  setAutonomy(id: string, autonomy: Autonomy, by: Actor, milestone?: string): Plan {
    const plan = this.need(id);
    if (milestone) {
      const patchBody = (b: PlanBody | undefined): PlanBody | undefined => (b ? { ...b, milestones: b.milestones.map((m) => (m.id === milestone ? { ...m, autonomy } : m)) } : b);
      return this.change(plan, { body: patchBody(plan.body), draft: patchBody(plan.draft) }, [event(by, 'autonomy', `set ${milestoneName(plan, milestone)} to ${AUTONOMY_INFO[autonomy].label}`, this.now())]);
    }
    if (autonomy === plan.autonomy && !(plan.body ?? plan.draft)?.milestones.some((m) => m.autonomy)) return plan;
    // A plan-wide choice wins over every milestone's own.
    const clear = (b: PlanBody | undefined): PlanBody | undefined => (b ? { ...b, milestones: b.milestones.map(({ autonomy: _a, ...m }) => m) } : b);
    return this.change(plan, { autonomy, body: clear(plan.body), draft: clear(plan.draft) }, [event(by, 'autonomy', `switched the plan to ${AUTONOMY_INFO[autonomy].label}`, this.now())]);
  }

  setPaused(id: string, paused: boolean, by: Actor, why?: string): Plan {
    const plan = this.need(id);
    if (plan.paused === paused) return plan;
    return this.change(plan, { paused }, [event(by, paused ? 'paused' : 'resumed', paused ? `paused the plan${why ? ` — ${why}` : ''}` : 'resumed the plan', this.now())]);
  }

  setMaxParallel(id: string, n: number, by: Actor): Plan {
    const plan = this.need(id);
    const max = Math.max(1, Math.min(MAX_PARALLEL, Math.round(n)));
    if (max === plan.maxParallel) return plan;
    return this.change(plan, { maxParallel: max }, [event(by, 'note', `lets ${max} ${max === 1 ? 'task' : 'tasks'} run at once`, this.now())]);
  }

  setTestsAt(id: string, testsAt: TestsAt, by: Actor): Plan {
    const plan = this.need(id);
    if (plan.testsAt === testsAt) return plan;
    return this.change(plan, { testsAt }, [event(by, 'note', testsAt === 'end' ? 'runs the test suites only at the end, in the final step' : 'runs the test suites once per milestone, at its check', this.now())]);
  }

  /**
   * The agent (and model) its milestones and tasks are worked on by from here on (BLG-498);
   * undefined: your default. Milestones and tasks already at work keep the agent they opened with.
   */
  setWorkAgent(id: string, agent: AgentRef | undefined, by: Actor): Plan {
    const plan = this.need(id);
    const was = plan.agent;
    if (was?.runtime === agent?.runtime && was?.model === agent?.model && was?.label === agent?.label) return plan;
    const text = agent ? `gave its work to ${agentName(agent, { model: true })} from here on` : 'gave its work to the default agent from here on';
    return this.change(plan, { agent: agent ? { runtime: agent.runtime, label: agent.label, ...(agent.model ? { model: agent.model } : {}) } : undefined }, [event(by, 'note', text, this.now())]);
  }

  /** The head Claude was asked to check a milestone (a new round of checking). */
  checkAsked(id: string, milestone: string): Plan {
    const plan = this.need(id);
    return this.change(plan, { runs: withRun(plan, milestone, { checkAsked: this.now() }) }, [event({ kind: 'beluga' }, 'gate', `${milestoneName(plan, milestone)}: every task is finished, the agent is checking its pass criteria`, this.now())]);
  }

  /**
   * Work came back to a milestone (a task reopened, fix tasks added, Check Again): its next check is
   * a new one. A merge that failed before goes too: the next pass (Autopilot's too) tries it afresh.
   */
  newRound(id: string, milestone: string): Plan {
    const plan = this.need(id);
    const run = plan.runs[milestone] ?? {};
    if (run.checkAsked === undefined && !run.mergeFailed) return plan;
    const { checkAsked: _c, check: _k, mergeFailed: _f, ...rest } = run;
    return this.change(plan, { runs: { ...plan.runs, [milestone]: rest } }, [], false);
  }

  recordCheck(id: string, milestone: string, check: Omit<GateCheck, 'at'>): Plan {
    const plan = this.need(id);
    if (!(plan.body?.milestones ?? []).some((m) => m.id === milestone)) throw new PlanError(`There's no milestone "${milestone}" in the approved plan`);
    if (plan.runs[milestone]?.passedAt) throw new PlanError('That milestone has already passed');
    const at = this.now();
    // Checked without being asked (the user asked in the conversation): it's this round's check.
    const asked = plan.runs[milestone]?.checkAsked ?? at;
    const notes = check.notes.trim().slice(0, 8000);
    return this.change(plan, { runs: withRun(plan, milestone, { check: { ...check, notes, at }, checkAsked: asked }) }, [event(check.by, check.verdict === 'pass' ? 'checked' : 'failed', `${check.verdict === 'pass' ? 'checked' : 'didn’t pass'} ${milestoneName(plan, milestone)}${notes ? `: ${notes.split('\n')[0]!.slice(0, 160)}` : ''}`, at)]);
  }

  pass(id: string, milestone: string, by: Actor): Plan {
    const plan = this.need(id);
    if (plan.runs[milestone]?.passedAt) return plan;
    const at = this.now();
    const { mergeFailed: _failed, ...run } = plan.runs[milestone] ?? {};
    const next = this.change(plan, { runs: { ...plan.runs, [milestone]: { ...run, passedAt: at, passedBy: by } } }, [event(by, 'passed', `passed ${milestoneName(plan, milestone)}`, at)]);
    const left = (next.body?.milestones ?? []).filter((m) => !next.runs[m.id]?.passedAt);
    return left.length ? next : this.change(next, { status: 'done', doneAt: at }, [event({ kind: 'beluga' }, 'done', 'every milestone passed: the plan is done', at)]);
  }

  /** Back to a milestone that passed (more work turned up). */
  reopen(id: string, milestone: string, by: Actor): Plan {
    const plan = this.need(id);
    const run = plan.runs[milestone];
    if (!run?.passedAt) return plan;
    const { passedAt: _p, passedBy: _b, check: _c, checkAsked: _a, ...rest } = run;
    return this.change(plan, { runs: { ...plan.runs, [milestone]: rest }, status: 'active', doneAt: undefined }, [event(by, 'note', `reopened ${milestoneName(plan, milestone)}`, this.now())]);
  }

  /** Passing a milestone couldn't merge it into the plan's branch (undefined: cleared, it's being passed again). */
  setMergeFailed(id: string, milestone: string, reason: string | undefined): Plan {
    const plan = this.need(id);
    const { mergeFailed: _was, ...rest } = plan.runs[milestone] ?? {};
    if (!reason && !_was) return plan;
    return this.change(plan, { runs: { ...plan.runs, [milestone]: reason ? { ...rest, mergeFailed: { at: this.now(), reason } } : rest } }, []);
  }

  /** A milestone's own Claude and the tasks handed to it (undefined: none, its worktree went). */
  setAgent(id: string, milestone: string, agent: MilestoneAgent | undefined): Plan {
    const plan = this.need(id);
    const { agent: _was, ...rest } = plan.runs[milestone] ?? {};
    return this.change(plan, { runs: { ...plan.runs, [milestone]: agent ? { ...rest, agent } : rest } }, []);
  }

  /** Beluga's rescue of a stalled plan (undefined: it's moving again). */
  setRescue(id: string, rescue: Readonly<Record<string, PlanRescue>> | undefined): Plan {
    const plan = this.need(id);
    if (JSON.stringify(plan.rescue) === JSON.stringify(rescue)) return plan;
    return this.change(plan, { rescue }, []);
  }

  /** The draft's review by a fresh agent (see draft-review.ts); undefined: none. */
  setReview(id: string, review: DraftReview | undefined): Plan {
    const plan = this.need(id);
    if (JSON.stringify(plan.review) === JSON.stringify(review)) return plan;
    return this.change(plan, { review }, []);
  }

  /** Its epics on the board (see epics.ts). */
  setEpics(id: string, epics: PlanEpics): Plan {
    const plan = this.need(id);
    if (JSON.stringify(plan.epics) === JSON.stringify(epics)) return plan;
    return this.change(plan, { epics }, []);
  }

  /** The conversation that checks a milestone (undefined: none, it was archived). */
  setChecker(id: string, milestone: string, checker: string | undefined): Plan {
    const plan = this.need(id);
    const { checker: _was, ...rest } = plan.runs[milestone] ?? {};
    return this.change(plan, { runs: { ...plan.runs, [milestone]: checker ? { ...rest, checker } : rest } }, []);
  }

  /** A task's start being combined from several branches (undefined: no longer). */
  setCombining(id: string, task: string, combining: Combining | undefined): Plan {
    const plan = this.need(id);
    const { [task]: _was, ...rest } = plan.combining ?? {};
    const next = combining ? { ...rest, [task]: combining } : rest;
    return this.change(plan, { combining: Object.keys(next).length ? next : undefined }, []);
  }

  /** A task's stall and what was done about it (undefined: it's fine again, or finished). */
  setWatch(id: string, task: string, watch: TaskWatch | undefined): Plan {
    const plan = this.need(id);
    const { [task]: was, ...rest } = plan.watch ?? {};
    if (!watch && !was) return plan;
    const next = watch ? { ...rest, [task]: watch } : rest;
    return this.change(plan, { watch: Object.keys(next).length ? next : undefined }, []);
  }

  /** The plan's branch is there (made from main, or one that was there already). */
  setBranch(id: string, branch: string, made: boolean): Plan {
    const plan = this.need(id);
    if (plan.branch === branch) return plan;
    return this.change(plan, { branch }, [event({ kind: 'beluga' }, 'note', made ? `made the plan’s branch ${branch} from main` : `collects the plan’s work on ${branch}`, this.now())]);
  }

  /** A passed milestone being merged into the plan's branch (undefined: no longer). */
  setMerging(id: string, milestone: string, merge: PlanMerge | undefined): Plan {
    const plan = this.need(id);
    const { [milestone]: _was, ...rest } = plan.merging ?? {};
    const next = merge ? { ...rest, [milestone]: merge } : rest;
    return this.change(plan, { merging: Object.keys(next).length ? next : undefined }, []);
  }

  /** Main being merged into the plan's branch (undefined: it's in, or nothing's under way). */
  setMainMerge(id: string, mainMerge: PlanMainMerge | undefined): Plan {
    const plan = this.need(id);
    if (!mainMerge && !plan.mainMerge) return plan;
    return this.change(plan, { mainMerge }, []);
  }

  /** The branch's pull request as last seen (what changed goes in the activity). */
  setPr(id: string, found: PlanPr): Plan {
    const plan = this.need(id);
    const before = plan.pr;
    // Only what the plan shows (GitHub's answer carries more, like each check run).
    const { number, url, state, title, draft, checks, review, conflicts, autoMerge, mergeState } = found;
    const pr: PlanPr = { number, url, state, title, draft, checks, ...(review ? { review } : {}), ...(conflicts ? { conflicts } : {}), ...(autoMerge ? { autoMerge } : {}), ...(mergeState ? { mergeState } : {}) };
    if (before && before.number === pr.number && before.state === pr.state && before.checks === pr.checks && before.review === pr.review && before.title === pr.title && before.draft === pr.draft && before.conflicts === pr.conflicts && before.autoMerge === pr.autoMerge && before.mergeState === pr.mergeState) return plan;
    const notes: PlanEvent[] = [];
    const at = this.now();
    if (!before || before.number !== pr.number) notes.push(event({ kind: 'beluga' }, 'note', `opened pull request #${pr.number}: ${plan.branch ?? 'the plan’s branch'} → main`, at));
    if (pr.state === 'CLOSED' && before?.state !== 'CLOSED') notes.push(event({ kind: 'beluga' }, 'problem', `pull request #${pr.number} was closed without merging: its tasks stay merged into the plan`, at));
    return this.change(plan, { pr }, notes);
  }

  setShipped(id: string, shipped: PlanShipped): Plan {
    const plan = this.need(id);
    if (plan.shipped) return plan;
    return this.change(plan, { shipped }, [event({ kind: 'beluga' }, 'done', shipped.how === 'pr' ? `merged into main via #${shipped.number}` : 'merged into main here', shipped.at)]);
  }

  setCaughtUp(id: string): Plan {
    const plan = this.need(id);
    return plan.caughtUp ? plan : this.change(plan, { caughtUp: true }, []);
  }

  note(id: string, kind: PlanEventKind, text: string, by: Actor): Plan {
    const plan = this.need(id);
    return this.change(plan, {}, [event(by, kind, text.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX), this.now())]);
  }

  /** A plan that moved here from another computer (BLG-806), as move.ts made it ready: in place of the record of an earlier move away. */
  adopt(plan: Plan): Plan {
    const there = this.get(plan.id);
    if (there && !there.movedTo) throw new PlanError('A plan with that id is here already');
    const next = { ...plan, updatedAt: this.now() };
    this.plans = [...this.plans.filter((p) => p.id !== plan.id), next];
    this.publish(next);
    return next;
  }

  /** It moved to another computer: this copy is its record from now on, paused, off the lists. */
  movedAway(id: string, to: PlanMove, by: Actor): Plan {
    const plan = this.need(id);
    return this.change(plan, { movedTo: to, paused: true }, [event(by, 'note', `moved the plan to ${to.name}: it runs there now`, to.at)]);
  }

  /** A moved milestone's next agent started from its branch: it isn't resumed from there again. */
  resumed(id: string, milestone: string): Plan {
    const plan = this.need(id);
    const { resumeFrom: was, ...rest } = plan.runs[milestone] ?? {};
    return was ? this.change(plan, { runs: { ...plan.runs, [milestone]: rest } }, []) : plan;
  }

  remove(id: string): void {
    this.plans = this.plans.filter((p) => p.id !== id);
    this.deps.store.dispatch({ type: 'plan_remove', id });
    this.save();
  }

  setStyle(text: string): void {
    this.style = text.trim().slice(0, MAX_STYLE);
    this.deps.store.dispatch({ type: 'plans_style', style: this.style });
    if (!this.deps.dir || this.readOnly) return;
    try {
      writeFileSync(path.join(this.deps.dir, 'planning.md'), this.style ? `${this.style}\n` : '', { mode: 0o600 });
    } catch {
      // Kept for this session.
    }
  }

  flush(): void {
    try {
      this.file?.flush();
    } catch {
      // The next change tries again.
    }
  }

  // ------------------------------------------------------------------ inside

  private change(plan: Plan, patch: Partial<{ -readonly [K in keyof Plan]: Plan[K] }>, activity: readonly PlanEvent[], replaceLast = false): Plan {
    const merged: Record<string, unknown> = { ...plan, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k];
    const kept = replaceLast ? plan.activity.slice(0, -1) : plan.activity;
    const next = { ...(merged as unknown as Plan), activity: [...kept, ...activity].slice(-KEEP_PLAN_ACTIVITY), updatedAt: this.now() };
    this.plans = this.plans.map((p) => (p.id === plan.id ? next : p));
    this.publish(next);
    return next;
  }

  private publish(plan: Plan): void {
    this.deps.store.dispatch({ type: 'plan_put', plan });
    this.save();
  }

  private load(): void {
    if (!this.deps.dir) return;
    const styleFile = path.join(this.deps.dir, 'planning.md');
    try {
      if (existsSync(styleFile)) this.style = readFileSync(styleFile, 'utf8').trim().slice(0, MAX_STYLE);
    } catch {
      // No style: Claude plans its own way.
    }
    const file = path.join(this.deps.dir, 'plans.json');
    if (!existsSync(file)) return;
    const parsed = PlansFile.safeParse(renamedActors(readJson(file)));
    if (!parsed.success) {
      try {
        renameSync(file, `${file}.unreadable-${this.now()}`);
      } catch {
        this.readOnly = true;
      }
      return;
    }
    const dropped: unknown[] = [];
    this.plans = parsed.data.plans.flatMap((item) => {
      const r = SavedPlan.safeParse(item);
      if (!r.success) dropped.push(item);
      return r.success ? [r.data as unknown as Plan] : [];
    });
    // Plans that don't read any more are kept beside it, not lost.
    if (dropped.length) {
      try {
        writeJson(path.join(this.deps.dir, `plans.dropped-${this.now()}.json`), dropped);
      } catch {
        // Nowhere to keep them.
      }
    }
  }

  private save(): void {
    if (!this.readOnly) this.file?.changed();
  }
}

function event(by: Actor, kind: PlanEventKind, text: string, at: number): PlanEvent {
  return { id: short('e'), at, by, kind, text };
}

function withRun(plan: Plan, milestone: string, patch: MilestoneRun): Record<string, MilestoneRun> {
  return { ...plan.runs, [milestone]: { ...(plan.runs[milestone] ?? {}), ...patch } };
}

function milestoneName(plan: Plan, id: string): string {
  const m = (plan.body ?? plan.draft)?.milestones.find((x) => x.id === id);
  return m ? `“${m.title}”` : 'a milestone';
}

const sameActor = (a: Actor, b: Actor): boolean => a.kind === b.kind && (a.kind === 'person' ? a.id === (b as typeof a).id : a.kind === 'claude' ? a.owner === (b as typeof a).owner && a.external?.id === (b as typeof a).external?.id : true);
