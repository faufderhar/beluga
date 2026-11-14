import type { Issue } from '../board/model.js';
import { unexplained } from '../board/criteria.js';
import type { Store } from '../store.js';
import { NOTE_MAX, type Plan, type TaskWatch } from './model.js';
import type { Plans } from './plans.js';
import type { PlanView, TaskView } from './progress.js';
import { ASK_YOU } from './prompt.js';
import { READS_AFTER_STEP, STOPPING_FOR } from '../../shared/claude-notices.js';
import { hhmm, span } from '../../shared/clock.js';
import { plainLine } from '../../companion/strip.js';
import { LIMIT_MARGIN_MS, LIMIT_UNKNOWN_MS, autoContinueFor } from '../../shared/auto-continue.js';
import { CONTINUE_PROMPT, CRASH_RETRY_MS, type RunFailure, decodeFailure, failureText, resetWords } from '../../shared/run-failure.js';

/**
 * The watchdog: a plan's started task never sits "working" while nothing happens. Each task has a
 * heartbeat (its Claude's last run in its worktree: when it last took a step, whether a turn runs,
 * whether the Claude Code process is still there). A task whose Claude stopped without finishing
 * (its turn ended or its process went, and it isn't In Review or asking you) is woken once, with
 * where it was and the messages that waited for it; stalling again within half an hour, it waits
 * for you, with the reason. A turn with no new step for 20 minutes counts as stopped, unless it's
 * inside a command that runs long (tests, a build, waiting on someone).
 *
 * A run that ended on your usage limit isn't a stall: the task shows "Paused · usage limit", and
 * once the limit resets Beluga resumes the head Claude, then each such task, one at a time within
 * the plan's task limit. A run that crashed is retried once after 30s; crashing again, it waits
 * for you (see shared/run-failure.ts).
 *
 * The pure parts (a run's pulse, its words) are browser-safe: the Mac app draws them.
 */

/** No new step for this long (outside a long command): the turn is stalled. */
export const STALL_MS = 20 * 60_000;
/** Inside a long command, nothing new for this long: stalled too (a command that hangs). */
export const COMMAND_LIMIT_MS = 2 * 60 * 60_000;
/** Stalling again this soon after a wake: it waits for you instead. */
export const REPEAT_MS = 30 * 60_000;
/** A wake's run gets this long to start before it counts as not having worked. */
export const WAKE_GRACE_MS = 3 * 60_000;
/** A started task with no run of Claude's in sight for this long (since Beluga looked) is stopped. */
export const NO_RUN_MS = 2 * 60_000;
/** A command shows as "Running a long command" once it has run this long. */
const LONG_SHOWN_MS = 60_000;
/** A message the head Claude steered in, unread this long: delivered again (interrupting, or a fresh turn). */
export const STEER_UNREAD_MS = 2 * 60_000;
/** Deliveries of one steered message after the first, before it's left to you. */
const STEER_RETRIES = 2;

/** Resuming a moment after the reset, so the first message isn't refused again (a usage limit with no known reset: 30 min after it stopped). */
export { LIMIT_MARGIN_MS };

/** Steps that may take long without anything new: commands, and waiting on other people or Claudes. */
const LONG_STEP = /^(Bash|BashOutput|Monitor|KillShell|wait_for|ask_agent|ask_person|run_on|run_on_peer|mcp__(?:beluga|klaud)_\w+__wait\w*)\b/;
/** Runs you stopped yourself: shown as stopped, never woken behind your back. */
const BY_YOU = /stopped by owner|cancelled by owner|taken out of the queue/i;
const TURN = new Set(['queued', 'awaiting_approval', 'started', 'answered']);

/** A conversation's latest run of Claude's, as the shared log has it. */
export interface RunInfo {
  readonly requestId: string;
  readonly status: string;
  readonly ts: number;
  /** When Claude last did something in it (its heartbeat). */
  readonly lastAt: number;
  /** When the step it's on began, and that step (“Bash npm test”). */
  readonly stepAt?: number;
  readonly step?: string;
  /** What Claude said last (or why the run ended). */
  readonly text: string;
  /** How far the step it's on has got, from its output ("137/215"). */
  readonly progress?: string;
  /** The last command it ran (a step watching a command's output names it). */
  readonly command?: string;
  /** Past its step: thinking or writing, and since when (see the log item's `between`). */
  readonly between?: 'thinking' | 'writing';
  readonly betweenAt?: number;
  /** A sub-agent it launched (not one in the background) still runs: the step it's on isn't over. */
  readonly subOpen?: boolean;
}

/** A message waiting for a conversation's Claude (in its queue, or in the running turn for its next step). */
export interface WaitingMessage {
  readonly requestId: string;
  readonly prompt: string;
  /** Still in the queue: Steer Now sends it at once. False: in the running turn, read at Claude's next step. */
  readonly queued: boolean;
}

/**
 * A message of yours (or your head Claude's) as the log has it: in the queue, in the running turn
 * for Claude's next step, its turn just started (nothing done yet), or read (Claude acted on it, or it ended).
 */
export function messageState(item: { readonly status: string; readonly text?: string; readonly steps?: readonly string[] } | undefined): 'unsent' | 'queued' | 'in_turn' | 'started' | 'read' {
  if (!item) return 'unsent';
  if (item.status === 'queued') return 'queued';
  if (item.status === 'started' && !item.steps?.length) return item.text === READS_AFTER_STEP || item.text === STOPPING_FOR ? 'in_turn' : item.text ? 'read' : 'started';
  return 'read';
}

/** Waiting messages as a card says them: “1 message waiting”, and the one Steer Now sends (the first still in the queue). */
export function waitingWords(list: readonly WaitingMessage[]): { readonly text: string; readonly steer?: string } {
  const queued = list.find((w) => w.queued);
  return { text: `${list.length} ${list.length === 1 ? 'message' : 'messages'} waiting`, ...(queued ? { steer: queued.requestId } : {}) };
}

/** A step as a card says it: "Running npx playwright test", "Watching npx playwright test". */
export function stepWords(step: string, command?: string): string {
  const run = /^Bash (.+)$/.exec(step)?.[1];
  if (run) return `Running ${run}`;
  if (/^(BashOutput|Monitor)\b/.test(step)) return command ? `Watching ${/^Bash (.+)$/.exec(command)?.[1] ?? command}` : 'Watching a command';
  return step;
}

/** How a started task is doing right now, as its card says it. */
export type TaskPulse =
  | { readonly kind: 'working'; readonly step?: string; readonly since: number; readonly progress?: string }
  | { readonly kind: 'command'; readonly step: string; readonly since: number; readonly progress?: string }
  | { readonly kind: 'stopped'; readonly reason: string; readonly crashed?: boolean }
  | { readonly kind: 'paused'; readonly until: number }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'needs_you'; readonly reason: string };

const isTurn = (run: RunInfo | undefined): boolean => Boolean(run && TURN.has(run.status));
const isLongStep = (step: string | undefined): boolean => Boolean(step && LONG_STEP.test(step));

/** How a run that failed ended, when the runner said (a usage limit, a crash). */
const failureOf = (run: RunInfo | undefined): RunFailure | undefined => (run?.status === 'error' ? decodeFailure(run.text) : undefined);

/** When a run stopped by your usage limit may go on (the reset, or a guess when it's unknown). */
const limitUntil = (run: RunInfo, f: RunFailure): number => f.resetsAt ?? run.lastAt + LIMIT_UNKNOWN_MS;

/** Why a run that's over ended, in words. */
function endedWhy(run: RunInfo | undefined): string {
  if (!run) return 'no agent is working on it';
  const failure = failureOf(run);
  if (failure && failure.kind !== 'stopped') return failureText(run.text).split('\n')[0]!;
  if (run.status === 'error') return BY_YOU.test(run.text) ? 'you stopped it' : `its run failed: ${run.text.replace(/\s+/g, ' ').slice(0, 120)}`;
  if (run.status === 'denied') return 'its run was declined';
  if (run.status === 'interrupted') return 'Beluga stopped while it ran';
  return 'it ended its turn without handing off';
}

/** A started task's pulse, from its last run (what screens can know: not whether the process is there). */
export function pulseOf(run: RunInfo | undefined, asking: boolean, watch: TaskWatch | undefined): TaskPulse {
  if (asking) return { kind: 'waiting' };
  if (isTurn(run)) {
    const r = run!;
    // Past its step (thinking, or writing): that, not the step it did before.
    if (r.between) return { kind: 'working', step: r.between === 'writing' ? 'Writing' : 'Thinking', since: r.betweenAt ?? r.lastAt };
    const step = r.step ? stepWords(r.step, r.command) : undefined;
    if (step === undefined || r.stepAt === undefined) return { kind: 'working', since: r.lastAt };
    const progress = r.progress ? { progress: r.progress } : {};
    // Still in its step: the last thing it did, or a count from its output, or a sub-agent at work. Otherwise (a peer on an
    // older Claude Code says nothing when a step's tools return) the step is named, timed from when it last did something.
    if (r.stepAt < r.lastAt && !r.progress && !r.subOpen) return { kind: 'working', step, since: r.lastAt };
    if (isLongStep(r.step)) return { kind: 'command', step, since: r.stepAt, ...progress };
    return { kind: 'working', step, since: r.stepAt, ...progress };
  }
  if (watch?.needsYou) return { kind: 'needs_you', reason: watch.reason };
  // Stopped by your usage limit or a crash: never "working", and said as such.
  const failure = failureOf(run);
  if (failure?.kind === 'usage_limit') return { kind: 'paused', until: limitUntil(run!, failure) };
  if (failure?.kind === 'crash') return { kind: 'stopped', reason: endedWhy(run), crashed: true };
  return { kind: 'stopped', reason: watch && watch.run === run?.requestId ? watch.reason : endedWhy(run) };
}

const nowLine = (step: string, progress: string | undefined, ms: number): string => [step, progress, span(ms)].filter(Boolean).join(' · ');

/** A pulse in words: the card's label, and the line under it. */
export function pulseWords(p: TaskPulse, now: number): { readonly label: string; readonly sub?: string; readonly tone: 'claude' | 'warn' } {
  switch (p.kind) {
    case 'working':
      return { label: 'Working', sub: nowLine(p.step ?? 'Thinking', p.progress, now - p.since), tone: 'claude' };
    case 'command':
      // Busy, not dead: the command, how far it got, and for how long ("Running npx playwright test · 137/215 · 12m").
      return { label: now - p.since >= LONG_SHOWN_MS ? 'Running a long command' : 'Working', sub: nowLine(p.step, p.progress, now - p.since), tone: 'claude' };
    case 'stopped':
      return p.crashed ? { label: 'Stopped · Claude Code crashed', sub: p.reason, tone: 'warn' } : { label: 'Stopped without finishing', sub: p.reason, tone: 'warn' };
    case 'paused':
      return { label: 'Paused · usage limit', sub: now < p.until ? `Resumes at ${resetWords(p.until, now)}` : 'Resuming', tone: 'warn' };
    case 'waiting':
      return { label: 'Waiting for you', sub: 'The agent asked you something', tone: 'warn' };
    case 'needs_you':
      return { label: 'Needs you', sub: `Stopped twice: ${p.reason}`, tone: 'warn' };
  }
}

/**
 * Has this task's Claude stalled, and why? `alive`: whether its Claude Code process is still
 * there (the agent runner knows; undefined: can't tell). `seenAt`: when Beluga first saw it with
 * no run at all. `talkedAt`: when you last wrote in its chat (a turn ending then is you talking
 * with it: shown as stopped, not woken).
 */
export function assess(input: { readonly run?: RunInfo; readonly asking: boolean; readonly alive?: boolean; readonly now: number; readonly seenAt?: number; readonly talkedAt?: number }): { readonly stall?: string; readonly woken: boolean; readonly limitUntil?: number } {
  const { run, asking, alive, now } = input;
  // Asking you: it waits for you, that's not a stall.
  if (asking) return { woken: false };
  if (!run) {
    const quiet = input.seenAt !== undefined && now - input.seenAt >= NO_RUN_MS;
    return quiet ? { stall: 'no agent is working on it', woken: true } : { woken: false };
  }
  if (isTurn(run)) {
    if (run.status === 'queued' || run.status === 'awaiting_approval') return { woken: false };
    if (alive === false) return { stall: 'its Claude Code process ended mid-turn', woken: true };
    const pulse = pulseOf(run, false, undefined);
    const quiet = now - run.lastAt;
    if (pulse.kind === 'command') return quiet >= COMMAND_LIMIT_MS ? { stall: `${run.step} ran ${span(quiet)} with nothing new`, woken: true } : { woken: false };
    return quiet >= STALL_MS ? { stall: `no new step for ${span(quiet)}`, woken: true } : { woken: false };
  }
  // Its turn is over but its process is still there: background work it waits on.
  if (alive === true) return now - run.lastAt >= COMMAND_LIMIT_MS ? { stall: `nothing new in the background for ${span(now - run.lastAt)}`, woken: true } : { woken: false };
  const why = endedWhy(run);
  const failure = failureOf(run);
  // Your usage limit: it waits for the reset (see TaskWatchdog.step), not woken as a stall.
  if (failure?.kind === 'usage_limit') return { stall: why, woken: false, limitUntil: limitUntil(run, failure) };
  // Claude Code crashed: retried once, 30s after.
  if (failure?.kind === 'crash') return now - run.lastAt >= CRASH_RETRY_MS ? { stall: why, woken: true } : { woken: false };
  // You stopped it, or you're talking with it: shown as stopped, and yours to go on with.
  const yours = why === 'you stopped it' || (input.talkedAt !== undefined && now - input.talkedAt < REPEAT_MS);
  return { stall: why, woken: !yours };
}

/**
 * What a stopped Claude said last: its words in one line, at most 300 characters, without code
 * (none: undefined). Every place shows it as it is (the plan, its feed, the notification, the phone).
 */
export function saidLast(run: Pick<RunInfo, 'text'> | undefined): string | undefined {
  const said = run ? plainLine(run.text, 300) : '';
  return said || undefined;
}

/**
 * The feed's line for a task that waits for you: what to do first, then what it said, cut to fit
 * the feed's line (NOTE_MAX) so the ask is never what's lost.
 */
export function waitsNote(line: string, said: string): string {
  const head = `${line}: do what it asks (or answer in its chat), then Resume it. It said: “`;
  const room = NOTE_MAX - head.length - 1;
  const quote = said.length > room ? `${said.slice(0, Math.max(0, room - 1)).trimEnd()}…` : said;
  return `${head}${quote}”`;
}

/** What a woken Claude is told: where it was, what isn't true yet, and what waited for it. */
export function wakePrompt(issue: Issue, reason: string, run: RunInfo | undefined, waited: readonly string[], milestone = false): string {
  const open = unexplained(issue.brief.acceptance).map((c) => c.text);
  const said = run?.text.replace(/\s+/g, ' ').trim();
  return [
    `You stopped before handing off ${issue.key} “${issue.title}” (${reason}). Here is where you were:`,
    ...(run?.step ? [`- Your last step: ${run.step}`] : []),
    ...(said ? [`- The last thing you said: “${said.length > 400 ? `${said.slice(0, 400)}…` : said}”`] : []),
    open.length ? `- Not true yet: ${open.map((c) => `“${c}”`).join('; ')}` : '- Check the acceptance criteria in the task’s brief.',
    ...(waited.length ? ['', 'Messages that waited for you while you were stopped:', ...waited.map((w) => `---\n${w.trim()}`), '---'] : []),
    '',
    'Go on from there until every acceptance criterion is true; then commit, rewrite the handoff and call task_update with status in_review.',
    ASK_YOU,
    ...(milestone ? ['Then go on with the next task of your milestone (your instructions list them in order), without stopping.'] : []),
  ].join('\n');
}

/** What a task's Claude is told when a message the head Claude steered in is sent again in a fresh turn. */
function steerAgainPrompt(text: string, waited: readonly string[]): string {
  const others = waited.filter((w) => w.trim() !== text.trim());
  return [
    'An urgent message from the head of the plan waited more than 2 minutes without you reading it. Read it now and act on it before going on:',
    '',
    text.trim(),
    ...(others.length ? ['', 'Other messages that waited for you:', ...others.map((w) => `---\n${w.trim()}`), '---'] : []),
  ].join('\n');
}

/** A message the head Claude steered into a task, watched until its Claude reads it. */
interface Steered {
  readonly planId: string;
  readonly taskId: string;
  readonly key: string;
  readonly channel: string;
  /** The message as Claude is given it. */
  readonly prompt: string;
  requestId: string;
  /** When it was (last) sent. */
  at: number;
  /** Sent on with Steer Now (it left the queue). */
  promoted: boolean;
  retries: number;
}

export interface WatchdogDeps {
  readonly store: Store;
  readonly plans: Plans;
  /** Ask your Claude in a conversation; returns the request's id (to follow it), when it can. */
  readonly askClaude: (prompt: string, channel: string, echo: boolean) => string | void;
  /** Steer a waiting message in now (AgentHost.promote: interrupts a long command or a dead run). */
  readonly promote?: (requestId: string) => boolean;
  readonly system: (channel: string, text: string) => void;
  /** Whether a run of Claude's is under way in a conversation (its process is there). */
  readonly alive?: (channel: string) => boolean;
  /**
   * Stop whatever runs in a conversation, and resolve once nothing does with the messages that
   * waited there (taken out of its queue, in order) so the wake carries them.
   */
  readonly takeOver?: (channel: string) => Promise<readonly string[]>;
  readonly now?: () => number;
}

export class TaskWatchdog {
  /** Conversations seen with no run of Claude's yet: since when. */
  private readonly noRun = new Map<string, number>();
  /** Tasks being woken right now (by plan task id). */
  private readonly waking = new Set<string>();
  /** Messages the head Claude steered in, until their Claude reads them (by request id). */
  private readonly steered = new Map<string, Steered>();
  /** Head Claude runs sent on after a limit or a crash (by request id), and plans whose head was retried after a crash. */
  private readonly homeResumed = new Set<string>();
  private readonly homeCrashed = new Set<string>();

  constructor(private readonly deps: WatchdogDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * The head Claude steers a message into a task (sent already, as `requestId`, into its queue):
   * it goes in at once (Steer Now) and is watched until that task's Claude reads it.
   */
  steer(plan: Plan, t: TaskView, channel: string, requestId: string, prompt: string): void {
    const s: Steered = { planId: plan.id, taskId: t.task.id, key: t.issue?.key ?? t.task.title, channel, prompt, requestId, at: this.now(), promoted: false, retries: 0 };
    this.steered.set(requestId, s);
    this.follow(s, this.now());
  }

  /** Has a steered message been read? Sent on while it waits; unread after 2 minutes, delivered again, and said in the plan's feed. */
  private follow(s: Steered, now: number): void {
    const item = this.deps.store.getState().log.find((l): l is Extract<typeof l, { type: 'agent' }> => l.type === 'agent' && l.requestId === s.requestId);
    const state = messageState(item);
    if (state === 'read') {
      this.steered.delete(s.requestId);
      return;
    }
    // In the queue (it got there after a run started): Steer Now, through the agent host's own path.
    if (state === 'queued' && !s.promoted) {
      s.promoted = true;
      this.deps.promote?.(s.requestId);
      return;
    }
    if (now - s.at < STEER_UNREAD_MS || this.waking.has(s.taskId)) return;
    const waitedFor = span(now - s.at);
    if (s.retries >= STEER_RETRIES) {
      this.steered.delete(s.requestId);
      this.deps.plans.note(s.planId, 'problem', `${s.key} still hasn't read the plan head's message after ${waitedFor}: open its chat`, { kind: 'beluga' });
      return;
    }
    s.retries += 1;
    s.at = now;
    // Still in the queue: steered again (it interrupts what runs). Else a fresh turn with it.
    if (state === 'queued' && this.deps.promote?.(s.requestId)) {
      this.deps.plans.note(s.planId, 'note', `${s.key} hadn't read the plan head's message in ${waitedFor}: interrupted it again`, { kind: 'beluga' });
      return;
    }
    this.steered.delete(s.requestId);
    // Taken into the turn but never read: sent again and steered in the agent host's one way (planSteer):
    // a long command or a quiet turn is interrupted, a dead run restarted; what queued there keeps its place.
    if (this.deps.promote) {
      const id = this.deps.askClaude(steerAgainPrompt(s.prompt, []), s.channel, false);
      this.deps.plans.note(s.planId, 'note', `${s.key} hadn't read the plan head's message in ${waitedFor}: steered it in again`, { kind: 'beluga' });
      // Followed like the first one: Steer Now once it queues, sent again if still unread.
      if (id) this.track({ ...s, requestId: id, at: now, promoted: false });
      return;
    }
    this.deps.plans.note(s.planId, 'note', `${s.key} hadn't read the plan head's message in ${waitedFor}: started a fresh turn with it`, { kind: 'beluga' });
    this.waking.add(s.taskId);
    void (async () => {
      const waited = this.deps.takeOver ? await this.deps.takeOver(s.channel).catch(() => []) : [];
      this.deps.system(s.channel, 'Beluga restarted the agent: an urgent message from the plan’s agent waited 2 minutes unread.');
      const id = this.deps.askClaude(steerAgainPrompt(s.prompt, waited), s.channel, false);
      if (id) this.track({ ...s, requestId: id, at: this.now(), promoted: false });
    })().finally(() => this.waking.delete(s.taskId));
  }

  private track(s: Steered): Steered {
    this.steered.set(s.requestId, s);
    return s;
  }

  /** Look at every started task of a plan: wake what stopped, or ask you. */
  step(plan: Plan, view: PlanView, runOf: (channel: string) => RunInfo | undefined): void {
    const now = this.now();
    // Steered messages first: they're followed even while the plan is paused.
    for (const s of [...this.steered.values()]) {
      if (s.planId !== plan.id) continue;
      const t = view.milestones.flatMap((m) => m.tasks).find((x) => x.task.id === s.taskId);
      // Finished, or gone: nobody to tell any more.
      if (!t || !t.worktree || `ws:${t.worktree}` !== s.channel || !(t.state === 'running' || t.state === 'idle' || t.state === 'asking' || t.state === 'stalled')) this.steered.delete(s.requestId);
      else this.follow(s, now);
    }
    const tasks = view.milestones.flatMap((m) => m.tasks);
    if (!plan.paused && plan.status === 'active') this.resumeHome(plan, runOf(plan.home), now);
    // Tasks paused by your usage limit go on one at a time, within the plan's task limit.
    let room = plan.maxParallel - tasks.filter((t) => t.state === 'running' || this.waking.has(t.task.id)).length;
    // A milestone's one Claude does several tasks in one conversation: it's looked at (and woken) once.
    const looked = new Set<string>();
    for (const t of tasks) {
      const w = plan.watch?.[t.task.id];
      const started = t.state === 'running' || t.state === 'idle' || t.state === 'asking' || t.state === 'stalled';
      // Finished (or not started): nothing to watch any more.
      if (!started || !t.issue || !t.worktree || t.issue.worktreeGone || t.combining) {
        if (w && !started) this.deps.plans.setWatch(plan.id, t.task.id, undefined);
        continue;
      }
      // Paused: shown as it is, nobody woken.
      if (plan.paused || plan.status !== 'active' || this.waking.has(t.task.id)) continue;
      const channel = `ws:${t.worktree}`;
      if (looked.has(channel)) continue;
      looked.add(channel);
      const run = runOf(channel);
      if (run) this.noRun.delete(channel);
      else if (!this.noRun.has(channel)) this.noRun.set(channel, now);
      const alive = this.deps.alive?.(channel);
      const talkedAt = this.talkedAt(channel);
      const { stall, woken, limitUntil: until } = assess({ run, asking: t.state === 'asking', ...(alive !== undefined ? { alive } : {}), now, ...(this.noRun.has(channel) ? { seenAt: this.noRun.get(channel)! } : {}), ...(talkedAt !== undefined ? { talkedAt } : {}) });
      if (until !== undefined && run) {
        if (w?.resumed === run.requestId) continue; // resumed already; its run is on its way
        // Continuing on its own is off (Settings, this chat, or this session): it waits for you. Its line follows the switch.
        const off = !this.limitResumes(channel, until);
        if (off || now < until + LIMIT_MARGIN_MS || room <= 0) {
          const line = `${t.issue.key} paused: usage limit · ${off ? 'continuing on its own is off' : `resumes at ${resetWords(until, now)}`}`;
          if (w?.run !== run.requestId || w.limitUntil !== until || w.line !== line) this.deps.plans.setWatch(plan.id, t.task.id, { at: now, reason: stall!, run: run.requestId, limitUntil: until, line });
          continue;
        }
        room--;
        this.wake(plan, t, t.issue, channel, stall!, run, `Usage is back: resumed ${t.issue.key} at ${hhmm(now)}`, { counts: false });
        continue;
      }
      if (!stall || !woken || w?.needsYou) continue;
      // The wake is on its way (its run hasn't started yet).
      if (w?.wokeAt !== undefined && w.run === run?.requestId && now - w.wokeAt < WAKE_GRACE_MS) continue;
      const key = t.issue.key;
      if (w?.wokeAt !== undefined && now - w.wokeAt < REPEAT_MS) {
        const line = `${key} stopped again: ${stall}. It waits for you`;
        // What it said last: often what it waits on you for, so that's what you're shown.
        const said = saidLast(run);
        this.deps.plans.setWatch(plan.id, t.task.id, { at: now, reason: stall, ...(run ? { run: run.requestId } : {}), wokeAt: w.wokeAt, needsYou: true, line, ...(said ? { said } : {}) });
        this.deps.plans.note(plan.id, 'problem', said ? waitsNote(line, said) : `${line} (woken at ${hhmm(w.wokeAt)}): Resume it, or open its chat.`, { kind: 'beluga' });
        continue;
      }
      this.wake(plan, t, t.issue, channel, stall, run, `${key} stopped, woke it at ${hhmm(now)}`);
    }
  }

  /** When a person last wrote in a conversation (Beluga's own prompts aren't shown as messages). */
  private talkedAt(channel: string): number | undefined {
    const log = this.deps.store.getState().log;
    for (let i = log.length - 1; i >= 0; i--) {
      const l = log[i]!;
      if (l.type === 'chat' && l.channel === channel && !l.byAgent) return l.ts;
    }
    return undefined;
  }

  /** You resume a task that waits for you (or one that stopped): woken now, with what it missed. */
  resume(plan: Plan, t: TaskView, runOf: (channel: string) => RunInfo | undefined, by: 'you' | 'beluga' = 'you'): string {
    if (!t.issue || !t.worktree || t.issue.worktreeGone) throw new Error('That task hasn’t started');
    if (t.state === 'running') throw new Error(`${t.issue.key} is working already`);
    if (this.waking.has(t.task.id)) return `${t.issue.key} is being woken`;
    const channel = `ws:${t.worktree}`;
    const run = runOf(channel);
    const reason = plan.watch?.[t.task.id]?.reason ?? endedWhy(run);
    this.wake(plan, t, t.issue, channel, reason, run, `${by === 'you' ? 'You resumed' : 'Beluga woke'} ${t.issue.key} at ${hhmm(this.now())}`);
    return `Resumed ${t.issue.key}`;
  }

  /**
   * The plan's head Claude stopped by your usage limit: sent on once it resets (once per run). A
   * crash of its is retried once, 30s after.
   */
  private resumeHome(plan: Plan, run: RunInfo | undefined, now: number): void {
    const failure = failureOf(run);
    // A run of its that didn't crash: a later crash is retried again.
    if (run && !failure && run.status !== 'error') this.homeCrashed.delete(plan.id);
    if (!run || !failure || this.homeResumed.has(run.requestId)) return;
    const retry = failure.kind === 'crash' && now - run.lastAt >= CRASH_RETRY_MS && !this.homeCrashed.has(plan.id);
    const back = failure.kind === 'usage_limit' && now >= limitUntil(run, failure) + LIMIT_MARGIN_MS && this.limitResumes(plan.home, limitUntil(run, failure));
    if (!retry && !back) return;
    this.homeResumed.add(run.requestId);
    if (retry) this.homeCrashed.add(plan.id);
    this.deps.plans.note(plan.id, 'note', back ? `Usage is back: resumed the plan’s agent at ${hhmm(now)}` : `The plan’s agent crashed (${endedWhy(run)}): retried at ${hhmm(now)}`, { kind: 'beluga' });
    this.deps.askClaude(CONTINUE_PROMPT, plan.home, false);
  }

  /** Whether a run stopped by your usage limit (reset at `until`) goes on by itself: Settings, the chat and this session say (shared/auto-continue.ts). */
  private limitResumes(channel: string, until: number): boolean {
    return autoContinueFor(this.deps.store.getState().prefs, channel, until + LIMIT_MARGIN_MS).kind === 'scheduled';
  }

  private wake(plan: Plan, t: TaskView, issue: Issue, channel: string, reason: string, run: RunInfo | undefined, line: string, { counts = true }: { counts?: boolean } = {}): void {
    const now = this.now();
    this.waking.add(t.task.id);
    // A resume after your usage limit isn't a wake: stopping again soon after doesn't make it wait for you.
    this.deps.plans.setWatch(plan.id, t.task.id, counts ? { at: now, reason, ...(run ? { run: run.requestId } : {}), wokeAt: now, line } : { at: now, reason, ...(run ? { run: run.requestId, resumed: run.requestId } : {}), line });
    this.deps.plans.note(plan.id, 'note', `${line} (${reason})`, { kind: 'beluga' });
    void (async () => {
      const waited = this.deps.takeOver ? await this.deps.takeOver(channel).catch(() => []) : [];
      this.deps.system(channel, `Beluga woke the agent: it stopped before handing off (${reason}).`);
      const milestone = Object.values(plan.runs).some((r) => r?.agent?.worktree === t.worktree);
      this.deps.askClaude(wakePrompt(issue, reason, run, waited, milestone), channel, false);
    })().finally(() => this.waking.delete(t.task.id));
  }
}
