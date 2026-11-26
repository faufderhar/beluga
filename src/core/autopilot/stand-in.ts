import type { ClaudeAnswer } from '../../protocol.js';
import { type Plan, planTitle, shownBody } from '../plans/model.js';
import { liveFrom } from '../plans/progress.js';
import type { Approval, Store } from '../store.js';
import type { PendingQuestion } from '../collab-store.js';
import {
  type StandInDecision,
  STAND_IN_SYSTEM,
  answeredLine,
  choreOf,
  approvalPrompt,
  autopilotIn,
  planPrompt,
  questionPrompt,
  readApproval,
  readPlan,
  readQuestion,
  standInContext,
  standsInFor,
  yoursWhy,
} from './model.js';

export interface AutopilotDeps {
  readonly store: Store;
  readonly selfId: () => string;
  /**
   * Ask the stand-in agent (a side call: the plan's planner, else your default agent) → its reply.
   * Throws on trouble: autopilot goes on with a safe answer of its own and says why.
   */
  readonly ask: (req: { readonly prompt: string; readonly system: string; readonly plan?: Plan }) => Promise<string>;
  /** Answer a card the way your click does (QuestionBroker.answer): Claude's questions, plans, a plan's decisions. */
  readonly answerQuestion: (qid: string, answer: ClaudeAnswer) => void;
  /** Allow or decline your own agent's approval (AgentHost.answerApproval). */
  readonly answerApproval: (id: string, answer: 'yes' | 'no') => void;
  /** Approve a plan's draft (PlansWork.approve). */
  readonly approvePlan?: (planId: string) => void;
  /** Tell a plan's head agent what to change in its draft (queued, not echoed as yours). */
  readonly tell?: (channel: string, text: string) => void;
  readonly delayMs?: number;
}

/** How many answers the stand-in works out at once. */
const MAX_AT_ONCE = 4;
/** Cards remembered as handled (the oldest forgotten past this: long gone by then). */
const KEEP_HANDLED = 2_000;
/** A draft settles this long (its agent idle) before the stand-in reads it. */
const DRAFT_QUIET_MS = 4_000;

type Job = { readonly key: string; readonly channel: string; readonly run: () => Promise<void> };

/**
 * Full Autopilot's stand-in at work (BLG-981): whenever something of your own agent's waits on you in
 * a conversation on Full Autopilot (a question, a plan to approve, a plan's decision, a tool or chain
 * approval, a plan's first draft), a stand-in agent decides it for you and Beluga answers it the way
 * your click would, leaving a line in the chat with what it chose and why. What is always yours (a
 * secret, a friend's request, an outside agent's ask) still waits, and the chat says so once.
 * Turned off while the stand-in thinks: its answer is dropped and the card stays for you.
 */
export class AutopilotStandIn {
  private readonly done = new Set<string>();
  private readonly told = new Set<string>();
  private readonly queue: Job[] = [];
  private running = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly off: () => void;
  /** When each draft (plan:rev) was first seen quiet. */
  private readonly quietSince = new Map<string, number>();

  constructor(private readonly deps: AutopilotDeps) {
    this.off = deps.store.onAction((a) => {
      if (a.type === 'question_add' || a.type === 'approval_add' || a.type === 'autopilot' || a.type === 'plan_put' || a.type === 'agent_event') this.soon();
    });
    this.soon();
  }

  stop(): void {
    this.stopped = true;
    this.off();
    clearTimeout(this.timer);
    this.queue.length = 0;
  }

  private soon(wait = this.deps.delayMs ?? 300): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.look();
    }, wait);
    this.timer.unref?.();
  }

  /** What waits on you in a conversation on Full Autopilot: each one queued once. */
  look(): void {
    if (this.stopped) return;
    const state = this.deps.store.getState();
    const self = this.deps.selfId();
    for (const q of state.questions) {
      const on = q.owner === self ? autopilotIn(state, q.channel) : undefined;
      if (!on) continue;
      const chore = choreOf(on.plan, q.qid);
      if (chore) this.yoursToDo(q, chore.title);
      else this.add(`q:${q.qid}`, q.channel, () => this.question(q, on.plan));
    }
    for (const a of state.approvals) {
      const on = autopilotIn(state, a.channel);
      if (!on || !a.channel) continue;
      if (standsInFor(a, self)) this.add(`a:${a.id}`, a.channel, () => this.approval(a, on.plan));
      else this.waitsOnYou(a);
    }
    let again = false;
    for (const plan of state.plans.plans) again = this.draft(plan) || again;
    this.pump();
    if (again) this.soon(DRAFT_QUIET_MS);
  }

  private add(key: string, channel: string, run: () => Promise<void>): void {
    if (this.done.has(key)) return;
    this.done.add(key);
    if (this.done.size > KEEP_HANDLED) this.done.delete(this.done.values().next().value as string);
    this.queue.push({ key, channel, run });
  }

  private pump(): void {
    while (!this.stopped && this.running < MAX_AT_ONCE && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void job
        .run()
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  /** The stand-in's reply, or why it couldn't give one. */
  private async decide(prompt: string, plan: Plan | undefined): Promise<{ readonly raw?: string; readonly trouble?: string }> {
    try {
      return { raw: await this.deps.ask({ prompt, system: STAND_IN_SYSTEM, ...(plan ? { plan } : {}) }) };
    } catch (err) {
      return { trouble: err instanceof Error ? err.message : String(err) };
    }
  }

  private say(channel: string, d: StandInDecision<unknown>, trouble?: string): void {
    this.deps.store.dispatch({ type: 'system', channel, text: answeredLine(d, trouble), level: trouble ? 'warn' : 'info' });
  }

  /** Still worth answering: the conversation is still on Full Autopilot and the card still waits. */
  private still(channel: string, waiting: () => boolean): boolean {
    return !this.stopped && Boolean(autopilotIn(this.deps.store.getState(), channel)) && waiting();
  }

  private async question(q: PendingQuestion, plan: Plan | undefined): Promise<void> {
    const context = standInContext(this.deps.store.getState(), q.channel, plan);
    const prompt = q.question.kind === 'plan' ? planPrompt(context, q.question.plan) : questionPrompt(context, q.question);
    const { raw, trouble } = await this.decide(prompt, plan);
    if (!this.still(q.channel, () => this.deps.store.getState().questions.some((x) => x.qid === q.qid))) return;
    const d = q.question.kind === 'plan' ? readPlan(raw) : readQuestion(raw, q.question);
    this.deps.answerQuestion(q.qid, d.answer);
    this.say(q.channel, d, trouble);
  }

  private async approval(a: Approval, plan: Plan | undefined): Promise<void> {
    const channel = a.channel!;
    const { raw, trouble } = await this.decide(approvalPrompt(standInContext(this.deps.store.getState(), channel, plan), a), plan);
    if (!this.still(channel, () => this.deps.store.getState().approvals.some((x) => x.id === a.id))) return;
    const d = readApproval(raw, a);
    this.deps.answerApproval(a.id, d.answer);
    this.say(channel, d, trouble);
  }

  /** Once per card: a plan task only you can do waits for you, and the chat says so. */
  private yoursToDo(q: PendingQuestion, title: string): void {
    if (this.told.has(q.qid)) return;
    this.told.add(q.qid);
    this.deps.store.dispatch({ type: 'system', channel: q.channel, text: `Autopilot is waiting on you for “${title}”: a task only you can do is yours to finish.`, level: 'warn' });
  }

  /** Once per card: what autopilot leaves to you, and why. */
  private waitsOnYou(a: Approval): void {
    if (this.told.has(a.id)) return;
    this.told.add(a.id);
    this.deps.store.dispatch({ type: 'system', channel: a.channel!, text: `Autopilot is waiting on you for “${a.title}”: ${yoursWhy(a)}.`, level: 'warn' });
  }

  /**
   * A first draft of a plan on Full Autopilot, written and settled (its agent idle, nothing asked):
   * the stand-in approves it or tells the planner what to change. → whether to look again (a draft still settling).
   */
  private draft(plan: Plan): boolean {
    if (!plan.fullAuto || plan.status !== 'draft' || plan.body || plan.movedTo || !this.deps.approvePlan) return false;
    if (!plan.draft?.milestones.length) return false;
    const key = `d:${plan.id}:${plan.draftRev}`;
    if (this.done.has(key)) return false;
    const state = this.deps.store.getState();
    const busy = liveFrom(state).busy(plan.home) || state.questions.some((q) => q.channel === plan.home) || plan.review?.state === 'reviewing';
    if (busy) {
      this.quietSince.delete(key);
      return true;
    }
    const since = this.quietSince.get(key) ?? Date.now();
    this.quietSince.set(key, since);
    if (Date.now() - since < DRAFT_QUIET_MS) return true;
    this.quietSince.delete(key);
    this.add(key, plan.home, () => this.approveDraft(plan.id, plan.draftRev));
    return false;
  }

  private async approveDraft(planId: string, rev: number): Promise<void> {
    const at = (): Plan | undefined => this.deps.store.getState().plans.plans.find((p) => p.id === planId);
    const plan = at();
    if (!plan) return;
    const { raw, trouble } = await this.decide(planPrompt(standInContext(this.deps.store.getState(), plan.home, plan), draftText(plan)), plan);
    const now = at();
    if (!now || now.draftRev !== rev || now.body || !this.still(now.home, () => Boolean(now.fullAuto))) return;
    const d = readPlan(raw);
    if (d.answer.kind === 'plan' && !d.answer.approve) {
      this.deps.tell?.(now.home, `The user’s stand-in (Full Autopilot) read the draft and wants changes before approving it: ${d.answer.feedback}`);
      this.say(now.home, d, trouble);
      return;
    }
    try {
      this.deps.approvePlan!(planId);
      this.say(now.home, { ...d, said: `approved “${planTitle(now)}”` }, trouble);
    } catch (err) {
      this.deps.store.dispatch({ type: 'system', channel: now.home, text: `Autopilot couldn’t approve the plan: ${err instanceof Error ? err.message : String(err)}`, level: 'warn' });
    }
  }
}

/** A draft as the stand-in reads it: its milestones, criteria and tasks. */
function draftText(plan: Plan): string {
  const body = shownBody(plan);
  if (!body) return '';
  return [
    `# ${body.title}`,
    body.goal,
    ...body.milestones.map((m) => [`## ${m.title}`, m.goal ?? '', m.criteria.length ? `Passes when: ${m.criteria.join('; ')}` : '', ...m.tasks.map((t) => `- ${t.title}${t.assignee === 'me' ? ' (the user’s)' : ''}`)].filter(Boolean).join('\n')),
  ].join('\n\n');
}
