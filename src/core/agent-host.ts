import { actingVia, asActingAgent } from './acting-agent.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { AgentBackend, AgentPlace, AgentRunInput, BoardTools, FollowUp, LiveStatus, MacTools, RunProcess, Steer, TerminalLaunch, TerminalSink } from '../agent/types.js';
import { ALWAYS_ASK_YOU, writesCode } from '../agent/policy.js';
import { type AgentRef, type BodyInput, type BodyOf, CLAUDE_AGENT, MAX_TEXT, type MessageVia } from '../protocol.js';
import type { People } from './people.js';
import type { QuestionBroker } from './questions.js';
import type { ShareService } from './shares.js';
import type { DotenvAccess } from './env-vars.js';
import { type Approval, type Store, peerName, viaName, viaRequester } from './store.js';
import { type ExternalLookup, externalRequester, isExternalRequester, requesterTrust, type RequesterTrust, trustOf, type TrustLevel } from './trust.js';
import type { WorkspaceController } from './workspace-controller.js';
import type { WorkspaceSharing } from './workspace-sharing.js';
import { StepBook, importedKey, runKey } from './step-book.js';
import { Compactor } from './compactor.js';
import { BtwDesk } from './btw.js';
import { SCRATCH_DIR, ensureScratch } from '../workspaces/scratch.js';
import { withSentFiles } from './sent-files.js';
import { sentFolder } from '../shared/scratch-dir.js';
import { isImportedItem } from '../agent/transcript.js';
import { PHONE_LOOK_TOOLS } from '../agent/phone-tools.js';
import type { StepPage, StepRecord } from '../shared/steps.js';
import { READS_AFTER_STEP, STEERED_IN, STOPPING_FOR, TAKEN_BACK } from '../shared/claude-notices.js';
import { span } from '../shared/clock.js';
import { TERM_BUSY } from '../shared/terminal-keys.js';
import { RunFailedError, decodeFailure } from '../shared/run-failure.js';
import { e2eLockedIn, keepsRunning, mayLeaveProcesses } from '../workspaces/test-procs.js';
import { belugaEnvBoth } from './beluga-env.js';
import { planForHome } from './plans/model.js';
import { findIssue } from './board/model.js';
import { explainTaskMentions } from '../shared/task-refs.js';
import { explainWorktreeRefs } from '../shared/worktree-refs.js';
import { ASSISTANT_TITLE, isAssistant } from '../shared/assistant.js';
import { type SlotWait, clampParallelRuns } from '../shared/run-slots.js';
import { fallbackFor } from '../shared/runtime-fallbacks.js';
import { agentForAsk } from './gateway/serve.js';
import { fromMachine } from './client-context.js';
import { buildPreviewAppend } from '../agent/preview-prompt.js';
import { experimentOn } from '../shared/experiments.js';

/** How an external agent's message goes in, and what happened to it. */
export type ExternalSendMode = 'auto' | 'queue' | 'steer' | 'restart';
export type ExternalDelivery = 'started' | 'queued' | 'steered' | 'restarted' | 'denied' | 'not_interruptible';
/** What an external agent's interrupt did. `not_yours`: the run is someone else's and goes on. */
export type ExternalInterrupt = 'stopped' | 'no_active_run' | 'not_yours';

export interface AgentHostDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly send: (body: BodyInput, opts?: { to?: string; keep?: boolean }) => boolean;
  readonly agent?: () => AgentBackend | undefined;
  /** Which agent this Mac runs (named on its run events; default: Claude). */
  /** The agent that runs in `channel` (its place's pick, else your default; BLG-448). */
  readonly agentRef?: (channel?: string) => AgentRef;
  /** The agents your card lists: a friend's room ask may name one of those (BLG-520). */
  readonly agents?: () => readonly AgentRef[];
  /** Whether this Mac runs that agent now (unset: only your default). */
  readonly runsAgent?: (agent: AgentRef) => boolean;
  /** The backend for one of your agents' runtimes (unset: your default's for every run). */
  readonly backendFor?: (runtime: string) => AgentBackend | undefined;
  readonly shares: ShareService;
  readonly sharing: WorkspaceSharing;
  readonly people: People;
  readonly questions: QuestionBroker;
  readonly workspaces?: WorkspaceController;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  readonly system: (text: string, level?: 'info' | 'warn' | 'error') => void;
  readonly approvalTimeoutMs: () => number;
  readonly refreshUsage: () => Promise<void>;
  /** People invited by link to edit: their Claude edits files in that folder without asking (commands still ask). */
  readonly canEditIn?: (peerId: string, channel: string) => boolean;
  /** Your environment variables for a run there (see env-vars.ts). */
  readonly envFor?: (channel: string, dir?: string) => Record<string, string>;
  /** Whether your own Claude may read .env files there without asking, and remembering when you said always (env-vars.ts). */
  readonly dotenvAccess?: DotenvAccess;
  /** Stop the test runs a worktree's Claude started and left behind (see workspaces/test-procs.ts). */
  readonly stopTests?: (dir: string) => Promise<unknown>;
  /** A short worktree name for a task (a small model names it). */
  readonly nameTask?: (prompt: string) => Promise<string>;
  /** Where the details of Claude's steps are kept (default: in memory only). */
  readonly steps?: StepBook;
  /** Guests invited into one project only (not the whole room). */
  readonly isGuest?: (peerId: string) => boolean;
  /** The task board for a run in this conversation (your own runs): its tools and the task's brief. */
  readonly board?: (channel: string, from: string, opts: { readonly plan: boolean; readonly friend?: import('./board/work.js').BoardFriend }) => import('./board/work.js').RunBoard | undefined;
  /** The Sentinel chat (core/sentinel/chat.ts, your own runs): where its Claude runs, its own folder and session. */
  readonly sentinelChat?: (channel: string, from: string) => AgentPlace | undefined;
  /** What a tool that always asks you (policy ALWAYS_ASK_YOU: deleting a sentinel or a dashboard) says on its card, in words. */
  readonly confirmTool?: (toolName: string, input: Record<string, unknown>) => { readonly title: string; readonly detail: string } | undefined;
  /** Sentinels (your own runs): their tools, and a sentinel run's brief in its Claude step's conversation (core/sentinel). */
  readonly sentinel?: (channel: string, from: string) => { readonly tools: import('../agent/types.js').SentinelTools; readonly dashboard?: import('../agent/types.js').DashboardTools; readonly brief: string; readonly inRun: boolean } | undefined;
  /** A plan's home conversation (your own runs): its plan tools and what Claude is told about the plan (core/plans). */
  readonly plans?: (channel: string, from: string) => { readonly tools?: import('../agent/types.js').PlanTools; readonly brief?: string; readonly checker?: boolean } | undefined;
  /** Child threads (core/threads): their tools, bound to this chat. Your own runs only, with the flag on (see runAgent). */
  readonly threads?: (channel: string) => import('../agent/types.js').ThreadTools | undefined;
  /** "Your Mac" (core/assistant), your own runs in its conversation: where it runs, its tools, what Claude is told. */
  readonly assistant?: (channel: string, from: string) => { readonly place: AgentPlace; readonly tools: MacTools; readonly brief: string } | undefined;
  /** Your own agent asked in a friend's worktree (your "@claude" there): where it runs here, and what it's told about theirs. */
  readonly guestRun?: (channel: string, from: string) => { readonly place: AgentPlace; readonly brief: string } | undefined;
  /** Your phone (core/phone, BLG-150), your own runs: tools to act on it, saving screenshots in `scratchDir`. `env` lets Bash use adb/scrcpy (BLG-174). */
  /** The notes of calls you were in (core/calls, BLG-715), as tools for your own runs. */
  readonly callNotes?: () => import('../agent/types.js').CallNotesTools | undefined;
  readonly phone?: (scratchDir?: string) => { readonly tools: import('../agent/types.js').PhoneTools; readonly brief: string; readonly env?: Record<string, string> } | undefined;
  /** How freely Claude may use the phone now (off · ask · use · full), for the owner-approval gate. */
  /** Your own worktree runs: the project's setup, and Claude's tool to correct it (core/workbench). */
  readonly setup?: (channel: string) => import('../agent/types.js').SetupTools | undefined;
  readonly phoneUse?: () => 'off' | 'ask' | 'use' | 'full';
  /** The agent's own terminal is driving this conversation now (BLG-534): the chat waits until you take over. */
  readonly terminalDriving?: (channel: string) => boolean;
}

/** File tools an Edit guest may use without asking, and the input naming their file. */
const GUEST_FILE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
  LS: ['path'],
};

/** The real location of `target`, or of its nearest existing parent (a file about to be written). */
function realOrParent(target: string): string {
  let dir = target;
  for (;;) {
    try {
      return path.join(realpathSync(dir), path.relative(dir, target));
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return target;
      dir = up;
    }
  }
}

/**
 * An Edit guest's tool call that may run without asking: a file tool whose file (after following
 * symlinks) is inside `cwd`. Shell commands, the web, room tools and everything else ask you:
 * a command can reach anywhere, whatever its arguments look like.
 */
export function toolInside(toolName: string, input: Record<string, unknown>, cwd: string): boolean {
  const fields = GUEST_FILE_TOOLS[toolName];
  if (!fields) return false;
  const root = realOrParent(path.resolve(cwd));
  const raw = fields.map((f) => input[f]).find((v) => typeof v === 'string' && v);
  if (typeof input.pattern === 'string' && /(^|\/)\.\.(\/|$)/.test(input.pattern)) return false;
  const target = realOrParent(path.resolve(cwd, typeof raw === 'string' ? raw : '.'));
  return target === root || target.startsWith(root + path.sep);
}

const MAX_PENDING_APPROVALS = 20;

/** How you answered an approval. 'project': always, for this project (a secret's approvals only). */
export type ApprovalAnswer = 'yes' | 'no' | 'always' | 'project';
/** Tools that only read the file they name (a secret's approval says "read", not "change"). */
const READS_FILE = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const MAX_APPROVALS_PER_PERSON = 3;
const SEEN_REQUESTS = 1000;
/** Requests still going whose agent label is kept: more than this can't be going at once. */
const REQUEST_VIA_KEPT = 500;
const CONTEXT_LINES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Requests one person may have waiting for your Claude at once. */
const MAX_QUEUED_PER_PERSON = 10;

/** A message waiting in a conversation. `askTo`: who gets Claude's questions. `compact`: not a message but compacting the conversation (Compact now, /compact). */
interface Waiting {
  from: string;
  body: BodyOf<'agent_request'>;
  urgent?: boolean;
  askTo?: string;
  compact?: boolean;
}

/** The queue for one conversation (the room, or a workspace). */
interface Lane {
  readonly channel: string;
  waiting: Waiting[];
  pumping: boolean;
  current?: AbortController;
  /** The request the current run is for (with its controller: a compaction after it isn't it). */
  currentRequest?: { readonly id: string; readonly controller: AbortController };
  interruptedBy?: string;
  /** Why the current run was stopped for a newer message, when there's more to say (see rush). */
  interruptNote?: string;
  /** Set while you stop the current run here (see stopRun), so it says who stopped it. */
  stopping?: boolean;
  /** Who started the current run. */
  runFrom?: string;
  /** The external agent that asked for the current run, which is yours (see agentOf). */
  runAgent?: string;
  /** The current run has the plan's tools (BLG-773): one started before the conversation had a plan never takes your messages in. */
  runPlanTools?: boolean;
  /** Set while the run has answered but waits on background agents: messages go straight in. */
  followUps?: (followUp: FollowUp) => boolean;
  /** Set while a run of Claude's works here: your urgent messages steer it (see steer). */
  steer?: Steer;
  /** Set while a steer interrupts the current run: the next steer waits for it (see rush). */
  interrupting?: Promise<void>;
  /** Your messages steered into the running turn that Claude hasn't read yet, by request (Send now: see steerNow; Cancel: see cancelSteer). */
  steered?: Map<string, { readonly followUp: FollowUp; readonly item: Waiting }>;
  /**
   * The last run failed (a usage limit, a crash): what waits here stays waiting, in order, until
   * you go on (Continue, or any message of yours) or Beluga resumes it (see shared/run-failure.ts).
   */
  held?: boolean;
  /** The slot wait its first message's card shows now ("requestId running/limit"), so it's said once (see pump). */
  slotNoted?: string;
  /** Where what you send the current run goes (see withSentFiles): your own run with a scratch folder only. */
  sent?: SentPlace;
}

/** A conversation's folder and, from its root, the folder copies of what you send it go in. */
interface SentPlace {
  readonly root: string;
  readonly rel: string;
}

/** A tool running at least this long: a steer interrupts it instead of waiting for Claude's next step. */
const STEER_WAIT_MS = 20_000;
/** A run silent this long with no tool running (stuck in a step): a steer interrupts it. */
const STEER_QUIET_MS = 60_000;
/** A run silent this long with no tool running (and not thinking): dead; a steer starts a fresh turn instead. */
const DEAD_RUN_MS = 5 * 60_000;
/**
 * A stopped run that hasn't ended after this long has its Claude Code killed. Stopped for a newer
 * message (a steer or a dead run), it's then left behind so that message can start.
 */
const ABORT_GRACE_MS = 5_000;
/** How long a run whose Claude Code exited gets to end on its own (its error, with stderr) before it's closed out. */
export const EXIT_GRACE_MS = 3_000;
/** How long quitting waits for stopped runs to end before the last save (see abort). */
const QUIT_SETTLE_MS = 2_000;
/** Said when a run that wouldn't take an interrupt was stopped for your message. */
/** A message in a conversation its terminal is driving (BLG-534). */
export const TERMINAL_DRIVING = 'The terminal is driving this conversation: type there, or Take over to talk here.';
const STOPPED_FOR_YOU = 'Your agent didn’t stop when asked, so its run was stopped for your message';
/** Said when an agent that can't read a message mid-turn (OpenCode) had its turn stopped to read yours. */
const STOPPED_TO_READ = 'Stopped to read your message';


/**
 * How a steer reaches Claude now, from what its run is doing: into the running turn when Claude
 * will soon be at its next step; interrupt the turn when a tool has run long (a test suite) or
 * the run went quiet; a fresh turn when the run looks dead. No status (an older backend): steer.
 */
export function planSteer(status: LiveStatus | undefined, now: number): { kind: 'steer' } | { kind: 'interrupt' | 'restart'; note: string } {
  if (!status) return { kind: 'steer' };
  if (status.alive === false) return { kind: 'restart', note: 'The agent’s run had ended without finishing: started over with your message' };
  if (status.between) return { kind: 'steer' };
  if (status.tool) {
    const ran = now - status.tool.since;
    return ran < STEER_WAIT_MS ? { kind: 'steer' } : { kind: 'interrupt', note: `Interrupted: ${status.tool.label} (${span(ran)}) to read your message` };
  }
  const quiet = now - status.lastEventAt;
  // Thinking is Claude at work (its process still runs): interrupted, never taken for dead.
  if (quiet >= DEAD_RUN_MS && !status.thinking) return { kind: 'restart', note: `The agent had gone quiet for ${span(quiet)}: stopped to start over with your message` };
  if (quiet >= STEER_QUIET_MS) return { kind: 'interrupt', note: `Interrupted: the agent was ${status.thinking ? 'thinking' : 'quiet'} for ${span(quiet)}; reading your message` };
  return { kind: 'steer' };
}

/** A place without its questions-only rule (a plan's own conversation: see runAgent). */
function withoutAskOnly<T extends { readonly askOnly?: unknown }>(place: T): T {
  const { askOnly: _askOnly, ...rest } = place;
  return rest as T;
}


const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Your Claude serving requests (yours and other people's): who may use it, the queue, the
 * approvals you're asked for, running it in the right place with the right model, and
 * reporting what it does to everyone who should see it.
 */
export class AgentHost {
  private externalLookup: ExternalLookup = () => undefined;
  /** Waiting cards for an external agent's tool call (external/launch.ts), not for a step of its run. */
  private readonly callCards = new Set<string>();
  /** The conversation whose run started last: only a fallback, each run's tools post to their own (agent-bridge.ts). */
  currentChannel = 'room';
  private readonly approvals = new Map<string, (answer: ApprovalAnswer) => void>();
  private readonly alwaysTools = new Set<string>();
  /** "person:project" pairs you said Always to (this session). */
  private readonly alwaysProjects = new Set<string>();
  /**
   * One queue per conversation: each workspace's Claude works on its own, at the same time as
   * the others, while messages within one conversation run in order (urgent ones jump the line).
   */
  private readonly lanes = new Map<string, Lane>();
  /** Worktrees whose Claude ran something that may have started test processes since they were last stopped. */
  private readonly testRuns = new Set<string>();
  /** Runs holding one of the slots for working at once (prefs.parallelRuns; see pump). */
  private running = 0;
  /** klaud is quitting (see abort): nothing waiting starts. */
  private quitting = false;
  /** Approvals waiting per person, so one person can't crowd out everyone else's. */
  private readonly approvalsBy = new Map<string, number>();
  private readonly seenRequests: string[] = [];
  /** Requests your app made from another computer, driving this one (BLG-803): their runs are told so. */
  private readonly remoteRequests = new Set<string>();
  /** Requests already given to Claude under their own id (a retry gets a fresh one: ids are unique in its transcript). */
  private readonly promptIds = new Set<string>();
  /** Tool approvals waiting → the conversation whose run asked for them. */
  private readonly toolApprovals = new Map<string, string>();
  /**
   * Room asks that named an agent (BLG-520), by request id: the one that runs (its events name it),
   * and, until the first event has said it, why it isn't the one named.
   */
  private readonly named = new Map<string, { readonly agent: AgentRef; fallback?: string }>();
  /** The agent behind a friend's request (`<from>:<request id>`), until its final event: every event of it says so. */
  private readonly requestVia = new Map<string, MessageVia>();
  /** Turns in friends' chats waiting for their answer (runChat), by request id. */
  private readonly chatWaiters = new Map<string, { resolve: (text: string) => void; reject: (err: Error) => void }>();
  /** Waiting for a conversation's current run to end (see idle). */
  private readonly idleWaiters = new Map<string, Array<() => void>>();
  /** Final agent events that could not be sent while disconnected. */
  private outbox: Array<{ body: BodyInput; opts: { to?: string; keep?: boolean } }> = [];

  /** Every step of your Claude's runs in detail, for the screens on this computer (see step-book.ts). */
  readonly steps: StepBook;
  /** Compacting conversations, by hand or when they're nearly full (see compactor.ts). */
  private readonly compactor: Compactor;
  /** Side questions (/btw), answered beside conversations (see btw.ts). */
  readonly btw: BtwDesk;

  constructor(private readonly deps: AgentHostDeps) {
    this.steps = deps.steps ?? new StepBook();
    this.compactor = new Compactor({
      store: deps.store,
      agent: () => this.agent,
      place: (channel) => this.deps.workspaces?.place(channel),
      emit: (requestId, kind, text, channel) => this.emitAgent(requestId, this.selfId, kind, text, channel),
      requesterName: () => peerName(this.store.getState(), this.selfId),
      modelFor: (place) => this.modelFor(place?.model, place?.agent, place?.effort),
    });
    this.btw = new BtwDesk({
      store: deps.store,
      agent: () => this.agent,
      place: (channel) => {
        const at = this.deps.workspaces?.btwPlace(channel);
        // Settings' model is Claude's: a conversation on another agent uses its own.
        const model = at && this.modelFor(at.model, this.deps.workspaces?.agentIn(channel)).model;
        return at && { ...at, ...(model ? { model } : {}) };
      },
    });
  }

  /**
   * Compact a conversation: Claude summarizes what matters and continues from there (the chat
   * stays). Waits for Claude's current turn there to end first; once is enough when asked twice.
   */
  compact(channel: string, instructions = ''): void {
    if (!this.agent) return this.toast('No agent is running on this computer', 'warn');
    const cant = this.noCompact(channel);
    if (cant) return this.toast(cant, 'warn');
    const lane = this.lane(channel);
    if (lane.waiting.some((w) => w.compact)) return;
    const body: BodyOf<'agent_request'> = { kind: 'agent_request', requestId: `compact-${randomUUID()}`, prompt: instructions.slice(0, 2000), viaAgent: false, channel, urgent: false, plan: false };
    lane.waiting.push({ from: this.selfId, body, compact: true });
    if (lane.current) this.toast('Your agent compacts this conversation when it finishes what it’s doing');
    void this.pump(lane);
  }

  /** Why this conversation's runtime can't be compacted by Beluga (Codex compacts itself); undefined when it can. */
  private noCompact(channel: string): string | undefined {
    if (this.deps.terminalDriving?.(channel)) return TERMINAL_DRIVING;
    return fallbackFor(this.deps.agentRef?.(channel).runtime, 'compact');
  }

  /** A conversation starts over (its chat was cleared fresh): forget how full it was. */
  forgetContext(channel: string): void {
    this.compactor.forget(channel);
  }

  /** Compact in the conversation's queue, as its current run (so a new message waits for it). */
  private async runCompaction(lane: Lane, auto: boolean, instructions = ''): Promise<void> {
    const controller = new AbortController();
    lane.current = controller;
    lane.runFrom = this.selfId;
    try {
      await this.compactor.run(lane.channel, auto ? 'auto' : 'manual', controller.signal, instructions);
    } finally {
      if (lane.current === controller) {
        lane.current = undefined;
        lane.runFrom = undefined;
      }
      lane.stopping = undefined;
      lane.interruptedBy = undefined;
      if (!lane.current) this.wakeIdle(lane.channel);
    }
  }

  /** Nothing runs in this conversation any more: let whoever waited for that go on. */
  private wakeIdle(channel: string): void {
    const waiters = this.idleWaiters.get(channel) ?? [];
    this.idleWaiters.delete(channel);
    for (const resolve of waiters) resolve();
  }

  /**
   * The steps of a Claude card in a conversation, light. Only for your own Claude's work (runs
   * on this computer, or turns imported from your Claude Code transcripts): someone else's
   * Claude keeps its details on their computer.
   */
  stepsFor(channel: string, itemId: string, after?: number): StepPage {
    const key = this.stepKey(channel, itemId);
    return key ? this.steps.page(key, after) : { steps: [], version: 0, missing: true };
  }

  /** One step of a Claude card, with its input, output or thinking. */
  stepFor(channel: string, itemId: string, stepId: string): StepRecord | undefined {
    const key = this.stepKey(channel, itemId);
    return key ? this.steps.get(key, stepId) : undefined;
  }

  /** Keep the steps of turns imported from a Claude Code transcript (by session, then chat item). */
  keepImported(sessionId: string, steps: Readonly<Record<string, readonly StepRecord[]>>): void {
    for (const [itemId, records] of Object.entries(steps)) if (records.length) this.steps.putAll(importedKey(sessionId, itemId), records);
  }

  /** Keep the steps of the agent's terminal turns (BLG-534), by each card's request id (its own id). */
  keepTerminalSteps(steps: Readonly<Record<string, readonly StepRecord[]>>): void {
    for (const [requestId, records] of Object.entries(steps)) if (records.length) this.steps.putAll(runKey(requestId), records);
  }

  private stepKey(channel: string, itemId: string): string | undefined {
    const log = this.store.getState().log;
    const item = log.find((l) => l.id === itemId && l.channel === channel);
    if (!item || item.type !== 'agent' || item.owner !== this.selfId) return undefined;
    // A turn imported from Claude Code: the conversation's note says which transcript it came from.
    if (isImportedItem(item.id)) {
      const note = [...log].reverse().find((l) => l.channel === channel && l.id.startsWith('import-'));
      if (note) return importedKey(note.id.slice('import-'.length), item.id);
    }
    return runKey(item.requestId);
  }

  private get store(): Store {
    return this.deps.store;
  }

  private get selfId(): string {
    return this.deps.selfId();
  }

  private get agent(): AgentBackend | undefined {
    return this.deps.agent?.();
  }

  private get approvalTimeoutMs(): number {
    return this.deps.approvalTimeoutMs();
  }

  private send(body: BodyInput, opts: { to?: string; keep?: boolean } = {}): boolean {
    return this.deps.send(body, opts);
  }

  private toast(text: string, level?: 'info' | 'success' | 'warn' | 'error'): void {
    this.deps.toast(text, level);
  }

  private system(text: string, level?: 'info' | 'warn' | 'error'): void {
    this.deps.system(text, level);
  }

  /** Resolves once nothing runs in this conversation (right away when nothing does). */
  idle(channel: string): Promise<void> {
    if (!this.lanes.get(channel)?.current) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.set(channel, [...(this.idleWaiters.get(channel) ?? []), resolve]));
  }

  /** Whether a run of your Claude is under way in this conversation: its Claude Code process is there. */
  runningIn(channel: string): boolean {
    return Boolean(this.lanes.get(channel)?.current);
  }

  /**
   * Beluga takes over a stalled conversation (a plan's watchdog waking its Claude): the current run
   * stops, and your messages waiting there come out of the queue to go with the wake (returned in
   * order). Quiet: no toast. Resolves once nothing runs there.
   *
   * Stopped the way a steer stops a run (see runAgent's gone): a run that won't end has its Claude
   * Code killed after the grace, so no Claude is left working in the folder beside the wake. A
   * steer still interrupting lands first, and a message steered into the run but not read comes
   * back in line before the queue is taken: none is lost, and nothing else starts in between.
   */
  async takeOver(channel: string): Promise<string[]> {
    const lane = this.lanes.get(channel);
    if (!lane) return [];
    while (lane.interrupting) await lane.interrupting;
    lane.held = true;
    const run = lane.current;
    if (run && !run.signal.aborted) {
      lane.interruptedBy = 'watchdog';
      lane.interruptNote = 'Stopped by Beluga to wake the agent';
      run.abort();
    }
    await this.idle(channel);
    const mine = lane.waiting.filter((w) => w.from === this.selfId && !w.compact);
    lane.waiting = lane.waiting.filter((w) => !mine.includes(w));
    lane.held = undefined;
    for (const { from, body } of mine) this.emitAgent(body.requestId, from, 'done', 'Sent along with Beluga’s wake-up', body.channel);
    // Someone else's request waiting here goes on as before.
    void this.pump(lane);
    return mine.map((w) => w.body.prompt);
  }

  /**
   * Claude in a main folder (questions only) was asked for a change: carry the conversation into
   * a new worktree and go on there. Your own requests move right away (you asked for the change);
   * anyone else's ask you first. Returns what Claude is told.
   */
  private async moveToWorktree(from: string, requesterName: string, channel: string, task: string, finished: Promise<void>, via?: MessageVia): Promise<string> {
    const ctl = this.deps.workspaces;
    const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
    if (!ctl || !id) return "Couldn't continue in a worktree from here. Tell the user to click Continue in a New Worktree.";
    if (from !== this.selfId) {
      const answer = await this.ask('request', `${requesterName}'s request wants to continue in a new worktree`, task, from, channel);
      if (answer === 'no') return 'The owner of this computer declined moving to a new worktree. Stay read-only here and say so.';
    }
    const carryOn = (): ReturnType<typeof ctl.continueInWorktree> => ctl.continueInWorktree(id, (p) => this.deps.nameTask?.(p) ?? Promise.resolve('worktree'), { task, after: finished });
    // An external agent's run goes on there under its own grant and label: you on another screen.
    const ws = await (via ? asActingAgent(via, carryOn) : carryOn());
    if (!ws) return "Couldn't create the worktree (Beluga showed the user why). Don't change anything here; tell the user briefly.";
    return `Done: this chat is becoming the worktree "${ws.name}" (branch ${ws.branch}, from ${ws.base}); once this turn ends you continue the task there automatically. Do not do the work now; end your turn with one short line.`;
  }

  /**
   * Stop whatever is running (when Beluga quits): nothing new starts, and it resolves once those
   * runs have ended (their ends sent), or after `waitMs` for one that won't.
   */
  async abort(waitMs = QUIT_SETTLE_MS): Promise<void> {
    this.quitting = true;
    const busy = [...this.lanes.values()].filter((l) => l.current);
    for (const lane of busy) lane.current?.abort();
    if (!busy.length) return;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)));
    await Promise.race([Promise.all(busy.map((l) => this.idle(l.channel))), late]);
    clearTimeout(timer);
  }

  private lane(channel: string): Lane {
    let lane = this.lanes.get(channel);
    if (!lane) {
      lane = { channel, waiting: [], pumping: false };
      this.lanes.set(channel, lane);
    }
    return lane;
  }

  /** Send the final results that couldn't go out while you were disconnected. */
  flushOutbox(): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const item of queued) this.send(item.body, item.opts);
  }

  /** Run your Claude for someone else in one of your workspaces (they were invited to work there). */
  runFor(from: string, channel: string, prompt: string, plan = false, requestId: string = randomUUID()): void {
    const via = from === this.selfId ? actingVia() : undefined;
    const body: BodyOf<'agent_request'> = { kind: 'agent_request', requestId, prompt: prompt.slice(0, MAX_TEXT), viaAgent: false, channel, urgent: false, plan, ...(via ? { via } : {}) };
    this.deps.questions.track(body.requestId, this.selfId, channel);
    void this.onAgentRequest(from, body);
  }

  /**
   * Your own Claude takes a turn in a friends' chat (`dm:`/`group:`, BLG-207), with its tools (it
   * works in Your Mac's folder: see assistant.forChat), and the answer comes back here for the chat.
   * It goes in that chat's lane like any run of yours; a stop or a failure is an error.
   */
  runChat(channel: string, prompt: string): Promise<string> {
    const requestId = randomUUID();
    const body: BodyOf<'agent_request'> = { kind: 'agent_request', requestId, prompt: prompt.slice(0, MAX_TEXT), viaAgent: false, channel, urgent: false, plan: false };
    this.deps.questions.track(requestId, this.selfId, channel);
    const answer = new Promise<string>((resolve, reject) => this.chatWaiters.set(requestId, { resolve, reject }));
    void this.onAgentRequest(this.selfId, body);
    return answer;
  }

  /**
   * Run your Claude in one of your conversations with text that came from someone else (e.g. a
   * handoff note). Their trust level decides what it may do without asking you; its questions
   * come to you.
   */
  runOnBehalf(from: string, channel: string, prompt: string): void {
    const body: BodyOf<'agent_request'> = { kind: 'agent_request', requestId: randomUUID(), prompt: prompt.slice(0, MAX_TEXT), viaAgent: true, channel, urgent: false, plan: false };
    this.deps.questions.track(body.requestId, this.selfId, channel);
    if (this.trustIn(from).level === 'blocked') return;
    this.enqueue(from, body, this.selfId);
  }

  answerApproval(answer: ApprovalAnswer, id?: string): boolean {
    const target = id ?? this.store.getState().approvals[0]?.id;
    const resolve = target ? this.approvals.get(target) : undefined;
    if (!target || !resolve) return false;
    this.approvals.delete(target);
    this.store.dispatch({ type: 'approval_remove', id: target });
    resolve(answer);
    return true;
  }

  stopAgent(): void {
    const lanes = [...this.lanes.values()];
    if (!lanes.some((l) => l.current || l.waiting.length)) {
      this.toast('Your agent is not running anything');
      return;
    }
    for (const id of [...this.toolApprovals.keys()]) this.answerApproval('no', id);
    this.deps.questions.cancelAll();
    for (const lane of lanes) {
      const cancelled = lane.waiting;
      lane.waiting = [];
      lane.current?.abort();
      for (const { from, body, compact } of cancelled) if (!compact) this.emitAgent(body.requestId, from, 'error', 'Cancelled by owner', body.channel);
    }
    this.toast('Stopping your agent everywhere (queued requests cancelled)', 'warn');
  }

  /**
   * A conversation's worktree is going (deleted or archived): everything your Claude has there
   * ends, quietly, whoever asked for it. Its run stops (its approvals denied, its questions
   * skipped) and what waits there is dropped, saying `why`. Resolves once nothing runs there, so
   * no card lands in a conversation that's gone and no Claude works in a folder that's gone.
   */
  endIn(channel: string, why: string): Promise<void> {
    const lane = this.lanes.get(channel);
    if (!lane || (!lane.current && !lane.waiting.length)) return Promise.resolve();
    for (const [id, at] of [...this.toolApprovals]) if (at === channel) this.answerApproval('no', id);
    this.deps.questions.cancelChannel(channel);
    const dropped = lane.waiting;
    lane.waiting = [];
    for (const { from, body, compact } of dropped) if (!compact) this.emitAgent(body.requestId, from, 'error', why, body.channel);
    if (lane.current) {
      lane.interruptedBy = 'beluga';
      lane.interruptNote = why;
      lane.current.abort();
    }
    return this.idle(channel);
  }

  /**
   * Stop your Claude in one conversation only. Its current run there stops (whoever asked for
   * it), and that run's waiting tool approvals are denied and its questions skipped. Your own
   * messages still waiting there come out of the queue: their prompts are returned in queue order
   * so the screen can put them back in the message box (Claude goes quiet, nothing typed is lost).
   * Other people's requests there keep their places and run next; other conversations carry on.
   * `threads`: how many child threads this Stop also stopped (see stopChat), so the toast says so.
   * `quiet`: no toast (an agent stopped its thread; nobody pressed anything).
   */
  stopRun(channel: string, opts: { readonly quiet?: boolean; readonly threads?: number } = {}): { stopped: boolean; returned: string[] } {
    const lane = this.lanes.get(channel);
    const mine = lane?.waiting.filter((w) => w.from === this.selfId) ?? [];
    const threads = opts.threads ? `${opts.threads} thread${opts.threads === 1 ? '' : 's'}` : '';
    if (!lane || (!lane.current && !mine.length)) {
      if (threads) this.toast(`Stopped ${threads}`, 'success');
      else if (!opts.quiet) this.toast([...this.lanes.values()].some((l) => l.current || l.waiting.length) ? "Your agent isn't working here" : 'Your agent is not running anything');
      return { stopped: Boolean(threads), returned: [] };
    }
    for (const [id, at] of [...this.toolApprovals]) if (at === channel) this.answerApproval('no', id);
    this.deps.questions.cancelChannel(channel);
    lane.waiting = lane.waiting.filter((w) => w.from !== this.selfId);
    for (const { from, body, compact } of mine) if (!compact) this.emitAgent(body.requestId, from, 'error', 'Taken out of the queue when you stopped your agent', body.channel);
    if (lane.current) {
      lane.stopping = true;
      lane.current.abort();
    }
    const n = mine.filter((w) => !w.compact).length;
    const back = n ? ` · ${n} queued message${n === 1 ? '' : 's'} back in the box` : '';
    if (!opts.quiet) this.toast(`Stopped your agent here${threads ? ` and ${threads}` : ''}${back}`, 'success');
    return { stopped: true, returned: mine.filter((w) => !w.compact).map((w) => w.body.prompt) };
  }

  /**
   * Send one of your waiting requests now (Steer): it always does something you can see (see
   * rush). False, with a toast saying why, when it isn't yours or isn't waiting any more.
   * `interrupt`: Beluga's own urgent messages (a plan's head) stop a long step to be read; yours never do.
   */
  promote(requestId: string, { interrupt = false }: { interrupt?: boolean } = {}): boolean {
    for (const lane of this.lanes.values()) {
      const i = lane.waiting.findIndex((w) => w.body.requestId === requestId);
      if (i < 0) continue;
      if (lane.waiting[i]!.from !== this.selfId) {
        this.toast("Only the person who sent a message can steer it", 'warn');
        return false;
      }
      const [item] = lane.waiting.splice(i, 1);
      // Your go-ahead: a queue held after a failed run goes on (see Lane.held).
      lane.held = undefined;
      this.rush(lane, item!, interrupt);
      return true;
    }
    this.toast('That message isn’t waiting any more', 'warn');
    return false;
  }

  /**
   * Send one of your waiting messages next, never interrupting (Send Now, beside Steer Now): into
   * the running turn when it can take it (read at Claude's next step), else first in line, after
   * your other urgent ones, with the run left to finish. False, with a toast saying why, when it
   * isn't yours or isn't waiting any more.
   */
  sendNext(requestId: string): boolean {
    for (const lane of this.lanes.values()) {
      const i = lane.waiting.findIndex((w) => w.body.requestId === requestId);
      if (i < 0) continue;
      const item = lane.waiting[i]!;
      if (item.from !== this.selfId) {
        this.toast('Only the person who sent a message can send it now', 'warn');
        return false;
      }
      lane.waiting.splice(i, 1);
      // Your go-ahead: a queue held after a failed run goes on (see Lane.held).
      lane.held = undefined;
      const { from, body } = item;
      const live = lane.current && !lane.current.signal.aborted && !lane.interrupting;
      const steer = live && lane.steer && lane.runFrom === from && !body.plan && !body.project && !item.compact && !this.missesPlanTools(lane, from, body.channel) ? lane.steer : undefined;
      if (steer && this.steerIn(lane, item, steer)) return true;
      const at = lane.waiting.findIndex((w) => !w.urgent);
      lane.waiting.splice(at === -1 ? lane.waiting.length : at, 0, { ...item, urgent: true });
      this.store.dispatch({ type: 'queue_order', owner: this.selfId, ids: lane.waiting.filter((w) => w.from === this.selfId && !w.compact).map((w) => w.body.requestId) });
      void this.pump(lane);
      return true;
    }
    this.toast('That message isn’t waiting any more', 'warn');
    return false;
  }

  /**
   * Your message, now (a queued one you steer, or one sent with ⌥↩): into the running turn, read
   * at Claude's next step, however long the step it's on runs. It never stops the turn by itself
   * (Send now on the message does, and Cancel takes it back), so steering again while one waits
   * just adds to it. `interrupt` (Beluga's own urgent messages): a tool running long or Claude
   * gone quiet has its turn interrupted, the message answered next. An agent that can't take a
   * message mid-turn has its turn stopped for it. No run to steer, or a dead one: the message
   * goes first in line and the current run stops, so a fresh turn starts with it. The card says
   * which; nothing is lost when a step fails (it goes back in line).
   */
  private rush(lane: Lane, item: Waiting, interrupt = false): void {
    // Another steer is interrupting the run: this one goes after it, so they're answered in the order you sent them.
    if (lane.interrupting) {
      void lane.interrupting.then(() => this.rush(lane, item, interrupt));
      return;
    }
    const { from, body } = item;
    const live = lane.current && !lane.current.signal.aborted;
    const steer = live && lane.steer && lane.runFrom === from && !body.plan && !body.project && !item.compact && !this.missesPlanTools(lane, from, body.channel) ? lane.steer : undefined;
    const plan = steer ? planSteer(steer.status?.(), Date.now()) : undefined;
    const emit = (event: BodyOf<'agent_event'>['event'], text = ''): void => this.emitAgent(body.requestId, from, event, text, body.channel);
    const into = plan?.kind === 'steer' || (plan?.kind === 'interrupt' && !interrupt);
    if (steer && into && this.steerIn(lane, item, steer)) return;
    // An agent that can't take a message into its running turn (OpenCode: one prompt at a time) stops the turn for it instead.
    const note = plan?.kind === 'interrupt' && interrupt ? plan.note : into && steer?.interrupt && !steer.status?.().between ? STOPPED_TO_READ : undefined;
    if (steer?.interrupt && note) {
      const run = lane.current;
      const followUp = this.followUp(lane, item);
      // Sent, not read yet: Claude's step is being stopped for it (its turn starts once it is).
      emit('text', STOPPING_FOR);
      const interrupting: Promise<void> = steer
        .interrupt(followUp, note)
        .catch(() => false)
        .then((ok) => {
          if (lane.interrupting === interrupting) lane.interrupting = undefined;
          if (ok) return;
          // Claude answered meanwhile and waits between turns: the message starts its turn now.
          if (lane.current === run && steer.status?.().between && steer(followUp)) return;
          // Still mid-turn: stopped for it (and said so). Ended already: it just goes first.
          this.jump(lane, item, run && lane.current === run && !run.signal.aborted ? STOPPED_FOR_YOU : undefined, run);
        });
      lane.interrupting = interrupting;
      return;
    }
    this.jump(lane, item, plan?.kind === 'restart' ? plan.note : undefined, lane.current);
  }

  /**
   * First in line (after your other urgent messages), with `run` (the conversation's current run)
   * stopped so it starts at once, continuing the same conversation.
   */
  private jump(lane: Lane, item: Waiting, note: string | undefined, run: AbortController | undefined): void {
    const at = lane.waiting.findIndex((w) => !w.urgent);
    lane.waiting.splice(at === -1 ? lane.waiting.length : at, 0, { ...item, urgent: true });
    // Back in line: its card says so (it may have said started).
    if (!item.compact) this.emitAgent(item.body.requestId, item.from, 'queued', item.body.prompt, item.body.channel);
    if (run && lane.current === run && !run.signal.aborted) {
      lane.interruptedBy = item.body.requestId;
      lane.interruptNote = note;
      run.abort();
    }
    if (note) this.toast(note, 'warn');
    void this.pump(lane);
  }
  /**
   * Move one of your waiting requests to `index` among your others in its conversation (friends'
   * requests keep their places). The log follows, so every screen shows the new order.
   */
  reorderQueued(requestId: string, index: number): boolean {
    for (const lane of this.lanes.values()) {
      const isMine = (w: Lane['waiting'][number]): boolean => w.from === this.selfId && !w.urgent && !w.compact;
      const mine = lane.waiting.filter(isMine);
      const from = mine.findIndex((w) => w.body.requestId === requestId);
      if (from < 0) continue;
      const to = Math.max(0, Math.min(index, mine.length - 1));
      const moved = mine.filter((_, i) => i !== from);
      const order = [...moved.slice(0, to), mine[from]!, ...moved.slice(to)];
      let k = 0;
      lane.waiting = lane.waiting.map((w) => (isMine(w) ? order[k++]! : w));
      this.store.dispatch({ type: 'queue_order', owner: this.selfId, ids: order.map((w) => w.body.requestId) });
      return true;
    }
    return false;
  }

  /**
   * Beluga no longer needs one of its requests (a milestone check you passed past): taken out of
   * the queue, or its run stopped, quietly (no toast; the run says `note`). → whether it was there.
   */
  cancelRun(requestId: string, note = 'Stopped by Beluga: no longer needed'): boolean {
    if (this.cancelQueued(requestId)) return true;
    for (const lane of this.lanes.values()) {
      const run = lane.currentRequest;
      if (run?.id !== requestId || lane.current !== run.controller || run.controller.signal.aborted) continue;
      lane.interruptedBy = 'beluga';
      lane.interruptNote = note;
      run.controller.abort();
      return true;
    }
    return false;
  }

  /** Drop one of your waiting requests before it starts. */
  cancelQueued(requestId: string): boolean {
    for (const lane of this.lanes.values()) {
      const i = lane.waiting.findIndex((w) => w.body.requestId === requestId && w.from === this.selfId);
      if (i < 0) continue;
      const [item] = lane.waiting.splice(i, 1);
      this.emitAgent(requestId, item!.from, 'error', 'Cancelled before it started', item!.body.channel);
      return true;
    }
    return false;
  }

  private emitAgent(requestId: string, requester: string, event: BodyOf<'agent_event'>['event'], text = '', channel = 'room', slotWait?: SlotWait): void {
    const final = event === 'done' || event === 'error' || event === 'denied';
    // A turn in a friends' chat (runChat): its answer goes back for the chat.
    const waiter = final ? this.chatWaiters.get(requestId) : undefined;
    if (waiter) {
      this.chatWaiters.delete(requestId);
      if (event === 'done') waiter.resolve(text);
      else waiter.reject(new Error(text || 'It stopped'));
    }
    const named = this.named.get(requestId);
    const fallback = named?.fallback;
    if (named) named.fallback = undefined;
    if (named && final) this.named.delete(requestId);
    const asked = `${requester}:${requestId}`;
    const via = this.requestVia.get(asked) ?? this.viaOf(requester);
    if (final) this.requestVia.delete(asked);
    const body: BodyInput = { kind: 'agent_event', requestId, requester, event, text: text.slice(0, 60_000), channel, ...(slotWait ? { slotWait } : {}), agent: named?.agent ?? this.deps.agentRef?.(channel) ?? CLAUDE_AGENT, ...(fallback ? { fallback } : {}), ...(via ? { via } : {}) };
    // Workspace conversations are private: events go to you and the people you invited, never to the room.
    const targets = channel === 'room' ? [{ keep: final }] : [this.selfId, ...this.agentRecipients(channel)].map((to) => ({ to }));
    for (const opts of targets) if (!this.send(body, opts) && final) this.outbox = [...this.outbox, { body, opts }].slice(-50);
  }

  /**
   * Who hears your agent's turn in a workspace. Your own agent in a friend's worktree shared over the
   * network tells only its owner, who passes it on (the others there aren't your links).
   */
  private agentRecipients(channel: string): string[] {
    const shared = this.deps.sharing.sharedFor(channel);
    return shared?.via === 'mesh' ? [shared.owner] : this.deps.sharing.recipients(channel);
  }

  /** A request off the wire. `ext:` is no peer's name: an external agent comes only through runExternal. */
  async onAgentRequest(from: string, body: BodyOf<'agent_request'>): Promise<void> {
    if (isExternalRequester(from)) return;
    return this.acceptRequest(from, body);
  }

  /** Who stands behind each `ext:` requester. */
  setExternalAgents(lookup: ExternalLookup): void {
    this.externalLookup = lookup;
  }

  /**
   * Run your agent in one of your conversations, as your own run, for an external agent: you steering
   * from another UI. `via` names the agent; its grant's level decides what asks you at each step. Its
   * questions come to you. The tool that called this decided the launch.
   * A steer goes only into this agent's own run: approvals in a run are judged for its requester.
   * → how the message went in. It runs to here without waiting, so the answer is what happened.
   */
  runExternal(requester: string, channel: string, prompt: string, opts: { readonly requestId?: string; readonly mode?: ExternalSendMode } = {}): ExternalDelivery {
    const requestId = opts.requestId ?? randomUUID();
    const via = this.viaOf(requester);
    const body: BodyOf<'agent_request'> = { kind: 'agent_request', requestId, prompt: prompt.slice(0, MAX_TEXT), viaAgent: false, channel, urgent: false, plan: false, ...(via ? { via } : {}) };
    // A restart skips acceptRequest, and its events must still name the agent on a friend's copy.
    if (via) this.keepRequestVia(`${this.selfId}:${requestId}`, via);
    this.deps.questions.track(requestId, this.selfId, channel);
    const lane = this.lane(channel);
    // As full as yours: the same queue limit as any message of yours.
    const queued = [...this.lanes.values()].reduce((n, l) => n + l.waiting.filter((w) => w.from === this.selfId).length, 0);
    if (!this.agent || this.trustIn(requester).level === 'blocked' || queued >= MAX_QUEUED_PER_PERSON) {
      void this.acceptRequest(this.selfId, body);
      return 'denied';
    }
    const item: Waiting = { from: this.selfId, body };
    const run = lane.current && !lane.current.signal.aborted ? lane.current : undefined;
    if (opts.mode === 'restart' && run) {
      if (lane.runAgent !== requester) return 'not_interruptible';
      this.declineRunCards(lane, requester);
      this.jump(lane, item, undefined, run);
      return 'restarted';
    }
    if (opts.mode === 'steer' && run && lane.steer && lane.runAgent === requester && this.steerIn(lane, item, lane.steer)) return 'steered';
    void this.acceptRequest(this.selfId, body, opts.mode === 'queue');
    if (lane.steered?.has(requestId)) return 'steered';
    return lane.waiting.some((w) => w.body.requestId === requestId) ? 'queued' : 'started';
  }

  /** Whether this agent's restart may go in: nothing runs here, or what runs is its own. */
  mayRestartExternal(requester: string, channel: string): boolean {
    const lane = this.lanes.get(channel);
    return !lane?.current || lane.current.signal.aborted || lane.runAgent === requester;
  }

  /**
   * An external agent stops its own work in one conversation: its queued messages, and the current
   * run when it asked for that run (that run's waiting cards are declined, its questions skipped).
   * It never stops someone else's run or touches their cards and questions: `not_yours`.
   */
  interruptExternal(requester: string, channel: string): ExternalInterrupt {
    const lane = this.lanes.get(channel);
    const mine = lane?.waiting.filter((w) => this.agentOf(w.from, w.body) === requester) ?? [];
    if (!lane || (!lane.current && !mine.length)) return 'no_active_run';
    lane.waiting = lane.waiting.filter((w) => this.agentOf(w.from, w.body) !== requester);
    for (const { from, body } of mine) this.emitAgent(body.requestId, from, 'error', 'Taken out of the queue', body.channel);
    if (!lane.current) return 'stopped';
    if (lane.runAgent !== requester) return 'not_yours';
    if (lane.current.signal.aborted) return 'stopped';
    this.declineRunCards(lane, requester);
    lane.interruptedBy = requester;
    lane.interruptNote = `Interrupted by ${this.nameOf(requester)}`;
    lane.current.abort();
    return 'stopped';
  }

  /**
   * The cards and questions of this agent's run in this lane, as it stops. The only `no` an agent's
   * call can cause. Its call cards about this chat aren't the run's: a person still answers those.
   */
  private declineRunCards(lane: Lane, requester: string): void {
    for (const a of this.store.getState().approvals) if (a.peer === requester && a.channel === lane.channel && !this.callCards.has(a.id)) this.answerApproval('no', a.id);
    this.deps.questions.cancelChannel(lane.channel);
  }

  /** Where this external agent has a run going now. */
  externalRunChannels(requester: string): readonly string[] {
    return [...this.lanes.values()].filter((l) => l.runAgent === requester && l.current && !l.current.signal.aborted).map((l) => l.channel);
  }

  /**
   * A person stops an external agent: every run it asked for ends (its questions skipped, the kill
   * limit as for any stop), and what it queued and has waiting goes: each card with this agent as
   * its peer, and no other, so another agent's card or yours about the same chat stays. Stopping an
   * agent is not stopping the chat (stopRun is). → whether there was anything to stop.
   */
  stopExternal(requester: string): boolean {
    let stopped = false;
    for (const lane of this.lanes.values()) {
      const queued = lane.waiting.filter((w) => this.agentOf(w.from, w.body) === requester);
      lane.waiting = lane.waiting.filter((w) => this.agentOf(w.from, w.body) !== requester);
      for (const { from, body } of queued) this.emitAgent(body.requestId, from, 'error', 'Taken out of the queue when you stopped this agent', body.channel);
      stopped ||= queued.length > 0;
      if (lane.runAgent !== requester || !lane.current || lane.current.signal.aborted) continue;
      this.deps.questions.cancelChannel(lane.channel);
      lane.stopping = true;
      lane.current.abort();
      stopped = true;
    }
    for (const a of this.store.getState().approvals) if (a.peer === requester) stopped = this.answerApproval('no', a.id) || stopped;
    return stopped;
  }

  private keepRequestVia(key: string, via: MessageVia): void {
    this.requestVia.set(key, { ...via, name: viaName(via) });
    if (this.requestVia.size > REQUEST_VIA_KEPT) this.requestVia.delete(this.requestVia.keys().next().value!);
  }

  private async acceptRequest(from: string, body: BodyOf<'agent_request'>, queueOnly = false): Promise<void> {
    // Drop replays of a request we've already seen.
    const key = `${from}:${body.requestId}`;
    if (this.seenRequests.includes(key)) return;
    // Asked from your app on another computer: noted now, while the request is its (a queued run starts later).
    if (from === this.selfId && fromMachine()) this.remoteRequests.add(body.requestId);
    this.seenRequests.push(key);
    if (this.seenRequests.length > SEEN_REQUESTS) this.seenRequests.shift();
    this.pickNamed(from, body);
    if (body.via) this.keepRequestVia(key, body.via);
    if (!this.agent) {
      this.emitAgent(body.requestId, from, 'denied', 'No agent is running on this machine.', body.channel);
      return;
    }
    if (body.project && body.channel === 'room' && !this.projectRoot(body.project)) {
      this.emitAgent(body.requestId, from, 'denied', `There is no project called ${body.project} on this computer.`, body.channel);
      return;
    }
    const external = this.agentOf(from, body);
    if (external && this.trustIn(external).level === 'blocked') {
      this.emitAgent(body.requestId, from, 'denied', 'This external agent has no live grant.', body.channel);
      return;
    }
    const inWorkspace = body.channel !== 'room' && from !== this.selfId;
    if (inWorkspace && (this.deps.sharing.sharedFor(body.channel) || !this.deps.sharing.canPost(from, body.channel))) {
      this.emitAgent(body.requestId, from, 'denied', "That workspace isn't shared with you.", body.channel);
      return;
    }
    // Inviting someone to contribute to a workspace is your yes to their requests there
    // (each risky step still asks you, unless you fully trust them).
    const allowed = Boolean(external) || (inWorkspace ? this.store.getState().policy !== 'deny' : await this.authorizeRequest(from, body));
    if (!allowed) {
      this.emitAgent(body.requestId, from, 'denied', 'Request declined by the machine owner.', body.channel);
      return;
    }
    this.enqueue(from, body, undefined, queueOnly);
  }

  /**
   * A room ask that named an agent ("@codex", "@bob:codex", BLG-520): yours runs any agent this Mac
   * runs; a friend's, one your card lists that runs here (agentForAsk), else your default with why.
   * A project's ask keeps the project's agent.
   */
  private pickNamed(from: string, body: BodyOf<'agent_request'>): void {
    if (!body.agent || body.channel !== 'room' || body.project) return;
    const mine = this.deps.agentRef?.(body.channel) ?? CLAUDE_AGENT;
    const runs = this.deps.runsAgent;
    const own = from === this.selfId && body.agent.runtime !== mine.runtime && runs?.(body.agent);
    const picked = own ? { agent: body.agent } : agentForAsk(body.agent, mine, this.deps.agents?.() ?? [], runs);
    if (picked.agent.runtime === mine.runtime && !picked.note) return;
    this.named.set(body.requestId, { agent: picked.agent, ...(picked.note ? { fallback: picked.note } : {}) });
    if (this.named.size > 200) this.named.delete(this.named.keys().next().value!);
  }

  /**
   * Queue a request. Normal requests wait their turn (and say so); urgent ones from you reach
   * Claude now (see rush).
   */
  private enqueue(from: string, body: BodyOf<'agent_request'>, askTo?: string, queueOnly = false): void {
    const lane = this.lane(body.channel);
    if (from === this.selfId) lane.held = undefined;
    if (!queueOnly && this.sendFollowUp(lane, from, body)) return;
    const urgent = body.urgent && from === this.selfId;
    if (urgent) return this.rush(lane, { from, body });
    const queued = [...this.lanes.values()].reduce((n, l) => n + l.waiting.filter((w) => w.from === from).length, 0);
    if (queued >= MAX_QUEUED_PER_PERSON) {
      this.emitAgent(body.requestId, from, 'denied', 'Too many requests waiting; try again when the current ones finish.', body.channel);
      return;
    }
    lane.waiting.push({ from, body, ...(askTo ? { askTo } : {}) });
    // The prompt goes with it, so the queue can show (and you can edit) what's waiting.
    if (lane.current || lane.waiting.length > 1) this.emitAgent(body.requestId, from, 'queued', body.prompt, body.channel);
    void this.pump(lane);
  }

  /**
   * While the current run only waits on its background agents, send a message from the same
   * person straight into it instead of queueing behind it (or interrupting and killing them).
   * Someone else's message still queues: approvals in that run are judged for its requester.
   */
  /**
   * The conversation became a plan's home after its current run started (Plan with Tasks, chosen
   * while the agent worked: BLG-773). That run has no plan tools, and a run's tools are fixed when it
   * starts, so your message must start a run of its own (with them) instead of joining this one.
   */
  private missesPlanTools(lane: Lane, from: string, channel: string): boolean {
    if (!lane.current || lane.runPlanTools || from !== this.selfId) return false;
    return Boolean(this.deps.plans?.(channel, from)?.tools);
  }

  private sendFollowUp(lane: Lane, from: string, body: BodyOf<'agent_request'>): boolean {
    // A request for one of your projects runs in that project's folder, so it never joins a run elsewhere.
    if (!lane.followUps || lane.runFrom !== from || lane.runAgent !== this.agentOf(from, body) || body.plan || body.project || this.missesPlanTools(lane, from, body.channel)) return false;
    // Claude went on working (a background job reported back): it isn't between turns, so the
    // message goes into the turn it's on, read at its next step, like a steer (urgent: see rush).
    const steer = lane.steer;
    if (steer?.status && !steer.status().between) return !body.urgent && this.steerIn(lane, { from, body }, steer);
    const emit =(event: BodyOf<'agent_event'>['event'], text = ''): void => this.emitAgent(body.requestId, from, event, text, body.channel);
    const sent = lane.followUps({
      prompt: this.promptOf(body, lane.sent),
      ...this.promptIdOf(body),
      requesterName: this.requesterOf(from, body),
      viaAgent: body.viaAgent,
      model: this.modelNow(body.channel),
      context: this.recentChat(body.channel),
      onEvent: (kind, text) => emit(kind, text),
      onStep: (record) => this.steps.put(runKey(body.requestId), record),
      // Sent close behind another, Claude Code may answer both in one turn.
      onFolded: () => emit('done', STEERED_IN),
      onDone: (final) => {
        this.steps.flush(runKey(body.requestId));
        emit('done', final || '(done)');
      },
      onError: (reason) => emit('error', reason),
    });
    if (sent) emit('started');
    return sent;
  }

  /**
   * A message of yours steered into the run working in this conversation (see rush). Taken in
   * mid-turn, it gets no card of its own (the turn's answer covers it; a card it already had as
   * a queued message says so); else it's answered in a turn of its own. Only your own messages
   * into your own run: approvals are judged for its requester.
   */
  private followUp(lane: Lane, item: Waiting): FollowUp {
    const { from, body } = item;
    const emit = (event: BodyOf<'agent_event'>['event'], text = ''): void => this.emitAgent(body.requestId, from, event, text, body.channel);
    let read = false;
    const settled = (): void => void lane.steered?.delete(body.requestId);
    return {
      prompt: this.promptOf(body, lane.sent),
      ...this.promptIdOf(body),
      requesterName: this.requesterOf(from, body),
      viaAgent: body.viaAgent,
      model: this.modelNow(body.channel),
      // The conversation is the run's own: what's said in the chat it has already.
      context: [],
      onEvent: (kind, text) => {
        read = true;
        emit(kind, text);
      },
      onStep: (record) => this.steps.put(runKey(body.requestId), record),
      onStart: () => {
        read = true;
        settled();
        emit('started');
      },
      // Read: the message's card says so (it was "sent, not read yet" till now: see steerIn).
      onFolded: () => {
        read = true;
        settled();
        emit('done', STEERED_IN);
      },
      onDone: (final) => {
        settled();
        this.steps.flush(runKey(body.requestId));
        emit('done', final || '(done)');
      },
      onError: (reason) => {
        settled();
        // The run ended before Claude read it (and you didn't stop it): it goes back in line, first.
        if (read || lane.stopping) return emit('error', reason);
        this.jump(lane, item, 'The agent’s run ended before it read your message: it runs next', undefined);
      },
    };
  }

  /**
   * Into the running turn, read at Claude's next step. Its card is a note until then (sent, not
   * read yet: the chat shows that on your message, with Send now), and says so once Claude read it.
   */
  private steerIn(lane: Lane, item: Waiting, steer: Steer): boolean {
    const followUp = this.followUp(lane, item);
    if (!steer(followUp)) return false;
    (lane.steered ??= new Map()).set(item.body.requestId, { followUp, item });
    this.emitAgent(item.body.requestId, item.from, 'text', READS_AFTER_STEP, item.body.channel);
    return true;
  }

  /**
   * Send now (BLG-54): a message of yours steered into the running turn, that Claude hasn't read
   * yet, is answered at once. The step Claude is on stops (Claude Code's interrupt, as Stop does)
   * and the conversation goes on from your message, nothing lost. When Claude can't be
   * interrupted the run is stopped and your message runs next. False, with a toast, when it isn't
   * waiting any more.
   */
  async steerNow(requestId: string): Promise<boolean> {
    const lane = [...this.lanes.values()].find((l) => l.steered?.has(requestId));
    const followUp = lane?.steered?.get(requestId)?.followUp;
    if (!lane || !followUp) {
      this.toast('Your agent has read that message already', 'info');
      return false;
    }
    const steer = lane.steer;
    const run = lane.current;
    const tool = steer?.status?.().tool;
    const note = tool ? `Interrupted: ${tool.label} to read your message` : 'Interrupted to read your message';
    // Sent, not read yet: Claude's step is being stopped for it.
    this.emitAgent(requestId, this.selfId, 'text', STOPPING_FOR, lane.channel);
    if (steer?.force && (await steer.force(followUp, note).catch(() => false))) return true;
    // Read meanwhile (its turn started, or Claude took it in): nothing to do.
    if (!lane.steered?.has(requestId)) return true;
    // Claude couldn't be interrupted: its run stops, and your message (never read) runs next, first in line.
    if (run && lane.current === run && !run.signal.aborted) {
      lane.interruptedBy = requestId;
      lane.interruptNote = STOPPED_FOR_YOU;
      run.abort();
      return true;
    }
    // No run to stop: it still waits for Claude's next step.
    this.emitAgent(requestId, this.selfId, 'text', READS_AFTER_STEP, lane.channel);
    this.toast('Your agent couldn’t be stopped: it reads your message at its next step', 'warn');
    return false;
  }

  /**
   * Cancel a message of yours steered into the running turn that Claude hasn't read yet: it's
   * taken back (never read nor answered) and its card says so. → its words, for the screen to put
   * back in the box. Not cancelled, with a toast saying why, when Claude read it already or its
   * agent can't take a message back.
   */
  async cancelSteer(requestId: string): Promise<{ cancelled: boolean; prompt?: string }> {
    const lane = [...this.lanes.values()].find((l) => l.steered?.has(requestId));
    const entry = lane?.steered?.get(requestId);
    const cancel = lane?.steer?.cancel;
    if (!lane || !entry) {
      this.toast('Your agent has read that message already', 'info');
      return { cancelled: false };
    }
    if (!cancel) {
      this.toast('This agent can’t take a message back once it’s sent', 'warn');
      return { cancelled: false };
    }
    const taken = await cancel(entry.followUp).catch((err: unknown) => {
      this.toast(`Couldn’t take it back: ${errorText(err)}`, 'warn');
      return undefined;
    });
    if (taken === undefined) return { cancelled: false };
    if (!taken || !lane.steered?.has(requestId)) {
      this.toast('Your agent is reading that message already', 'info');
      return { cancelled: false };
    }
    lane.steered.delete(requestId);
    const { from, body } = entry.item;
    this.emitAgent(requestId, from, 'error', TAKEN_BACK, body.channel);
    return { cancelled: true, prompt: body.prompt };
  }

  private async pump(lane: Lane): Promise<void> {
    if (lane.pumping) return;
    lane.pumping = true;
    try {
      // Nearly full (after the last run, or before the next message): compact first, between turns.
      for (;;) {
        const auto = this.compactor.due(lane.channel) && !this.noCompact(lane.channel);
        if (this.quitting) break;
        const head = auto || lane.held ? undefined : lane.waiting[0];
        if (!auto && !head) break;
        // A plan's own conversation (its head Claude, the orchestrator) never waits for a slot behind
        // the task runs it started: you can always talk to it, and stop or redirect them from there.
        // Nor does a message you steer: you asked for it now.
        const free = this.isPlanHome(lane.channel) || Boolean(head?.urgent);
        if (!free && this.running >= this.slotLimit()) {
          // It stays in line meanwhile (so you can still steer, edit or drop it), and its card says why it waits.
          if (head && !head.compact) this.noteSlotWait(lane, head);
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        lane.slotNoted = undefined;
        const next = head ? lane.waiting.shift() : undefined;
        let holds = !free;
        if (holds) this.running++;
        // A run that answered and only waits on its background agents gives its slot back (see runAgent).
        const release = (): void => {
          if (holds) this.running--;
          holds = false;
        };
        try {
          if (!next || next.compact) await this.runCompaction(lane, auto, next?.body.prompt);
          else await this.runAgent(next.from, next.body, lane, next.askTo, release).catch((err: unknown) => this.system(`Agent run failed: ${errorText(err)}`, 'error'));
        } finally {
          release();
        }
      }
    } finally {
      lane.pumping = false;
    }
  }

  /** How many conversations your Claude may work in at once (Settings › Claude). */
  private slotLimit(): number {
    return clampParallelRuns(this.store.getState().prefs.parallelRuns);
  }

  /** A message waiting for a free Claude: its card says so (once, and again when the count changes). */
  private noteSlotWait(lane: Lane, item: Waiting): void {
    const slotWait = { running: this.running, limit: this.slotLimit() };
    const key = `${item.body.requestId} ${slotWait.running}/${slotWait.limit}`;
    if (lane.slotNoted === key) return;
    lane.slotNoted = key;
    this.emitAgent(item.body.requestId, item.from, 'queued', item.body.prompt, item.body.channel, slotWait);
  }

  /** A running (or drafting) plan's own conversation: its head Claude. */
  private isPlanHome(channel: string): boolean {
    const plan = planForHome(this.store.getState().plans, channel);
    return Boolean(plan && plan.status !== 'done');
  }

  /** The main folder of one of your projects, by name. */
  private projectRoot(name: string): string | undefined {
    return this.deps.workspaces?.manager.list.find((p) => p.root && p.name === name)?.root;
  }

  /**
   * What a friend's run may do with your board (BLG-701), by how much you trust them: Full trust
   * uses it freely, like you; Trusted reads freely and asks you before a change; Ask me each time
   * asks for every look too. Blocked, or a guest invited by link: no board.
   */
  private boardAccess(from: string): 'free' | 'writes' | 'all' | undefined {
    if (this.deps.isGuest?.(from)) return undefined;
    const level = trustOf(this.store.getState(), from);
    return level === 'full' ? 'free' : level === 'trusted' ? 'writes' : level === 'ask' ? 'all' : undefined;
  }

  private async authorizeRequest(from: string, body: BodyOf<'agent_request'>): Promise<boolean> {
    if (from === this.selfId) return true;
    const state = this.store.getState();
    const { level, reach: reachLevel } = this.trustIn(from);
    if (level === 'blocked') return false;
    const name = peerName(state, from);
    // A project isn't a shared folder: working in one asks you unless you fully trust them.
    if (body.project && body.channel === 'room') {
      const scope = `${from}:${body.project}`;
      if (level === 'full' || this.alwaysProjects.has(scope)) return true;
      this.emitAgent(body.requestId, from, 'awaiting_approval', `Waiting for ${state.self?.name ?? 'owner'} to approve`, body.channel);
      const answer = await this.ask('request', `${name}${body.viaAgent ? "'s agent" : ''}${viaLabel(body.via)} wants your agent to work in ${body.project} (Always: for ${body.project}, until Beluga quits)`, body.prompt, from);
      if (answer === 'always') this.alwaysProjects.add(scope);
      return answer !== 'no';
    }
    if (level === 'trusted' || level === 'full') return true;
    this.emitAgent(body.requestId, from, 'awaiting_approval', `Waiting for ${state.self?.name ?? 'owner'} to approve`, body.channel);
    const reach = reachLevel === 'full' ? 'whole computer' : 'shared folders; anything else asks you';
    const answer = await this.ask('request', `${name}${body.viaAgent ? "'s agent" : ''}${viaLabel(body.via)} wants your agent to run this (${reach})`, body.prompt, from, body.channel);
    if (answer === 'always') this.deps.people.setTrust(from, 'trusted');
    return answer !== 'no';
  }

  /** Ask you to approve something; `peer` is who it's for (each person can have a few waiting at most). */
  ask(kind: 'request' | 'tool', title: string, detail: string, peer?: string, channel = 'room', meta: { task?: string; once?: boolean; asker?: string; call?: boolean; signal?: AbortSignal } = {}): Promise<'yes' | 'no' | 'always'> {
    // Only a secret offers "for this project": anywhere else it's a plain yes. `once` offers no Always: one that comes anyway is a yes.
    return this.pose(kind, title, detail, peer, channel, meta).then((answer) => (answer === 'project' || (meta.once && answer === 'always') ? 'yes' : answer));
  }

  private pose(kind: Approval['kind'], title: string, detail: string, peer?: string, channel = 'room', meta: { task?: string; project?: string; once?: boolean; asker?: string; call?: boolean; signal?: AbortSignal } = {}): Promise<ApprovalAnswer> {
    if (this.approvals.size >= MAX_PENDING_APPROVALS) return Promise.resolve('no');
    if (peer && peer !== this.selfId && (this.approvalsBy.get(peer) ?? 0) >= MAX_APPROVALS_PER_PERSON) return Promise.resolve('no');
    if (peer) this.approvalsBy.set(peer, (this.approvalsBy.get(peer) ?? 0) + 1);
    const id = randomUUID();
    if (kind !== 'request') this.toolApprovals.set(id, channel);
    if (meta.call) this.callCards.add(id);
    return new Promise((resolve) => {
      // Nobody should be stuck waiting forever on an approval you didn't see.
      const expiry = setTimeout(() => {
        if (this.answerApproval('no', id)) this.toast(`An approval expired after ${Math.round(this.approvalTimeoutMs / 60_000)} min without an answer`, 'warn');
      }, this.approvalTimeoutMs);
      expiry.unref();
      meta.signal?.addEventListener('abort', () => this.answerApproval('no', id), { once: true });
      this.approvals.set(id, (answer) => {
        clearTimeout(expiry);
        this.toolApprovals.delete(id);
        this.callCards.delete(id);
        if (peer) this.approvalsBy.set(peer, Math.max(0, (this.approvalsBy.get(peer) ?? 1) - 1));
        resolve(answer);
      });
      this.store.dispatch({ type: 'approval_add', approval: { id, kind, title, detail, askedAt: Date.now(), timeoutMs: this.approvalTimeoutMs, ...(peer && peer !== this.selfId ? { peer } : {}), ...(meta.task ? { task: meta.task } : {}), ...(meta.project ? { project: meta.project } : {}), ...(meta.once ? { once: true } : {}), ...(meta.asker ? { asker: meta.asker } : {}), ...(channel !== 'room' ? { channel } : {}) } });
    });
  }

  /** `release`: gives back this run's slot for working at once, when it only waits on background agents. */
  private async runAgent(from: string, body: BodyOf<'agent_request'>, lane: Lane, askTo = from, release?: () => void): Promise<void> {
    // The agent's own terminal has this conversation (BLG-534): two at once would split it in two.
    if (this.deps.terminalDriving?.(body.channel)) return this.emitAgent(body.requestId, from, 'error', TERMINAL_DRIVING, body.channel);
    // A room ask that named another of your agents (BLG-520) runs on that one's backend, with its model.
    const named = this.named.get(body.requestId)?.agent;
    const other = named && named.runtime !== (this.deps.agentRef?.(body.channel) ?? CLAUDE_AGENT).runtime ? this.deps.backendFor?.(named.runtime) : undefined;
    const agent = other ?? (this.agent as AgentBackend);
    const controller = new AbortController();
    lane.current = controller;
    lane.currentRequest = { id: body.requestId, controller };
    lane.runFrom = from;
    const external = this.agentOf(from, body);
    lane.runAgent = external;
    const requesterName = this.requesterOf(from, body);
    /** Below full, an external agent's run has your tools and its cards, and not what only you may hand out. */
    const yours = from === this.selfId && (!external || this.trustIn(external).level === 'full');
    const root = body.project && body.channel === 'room' ? this.projectRoot(body.project) : undefined;
    // A friend's request in your project gets a fresh conversation in its main folder: questions only.
    // "Your Mac": its own folder and session, and its tools (your runs only: nobody else can write there).
    const mac = root ? undefined : this.deps.assistant?.(body.channel, from);
    // The Sentinel chat: its own folder and session (your runs only).
    const sentinelChat = root || mac ? undefined : this.deps.sentinelChat?.(body.channel, from);
    // A friend's worktree, your own agent asked there: it works here and reads theirs from afar.
    const guest = root || mac || sentinelChat ? undefined : this.deps.guestRun?.(body.channel, from);
    const place = root ? { cwd: root, additionalDirectories: [], autoEdit: false, onSession: () => undefined, askOnly: { project: body.project ?? '' } } : (mac?.place ?? sentinelChat ?? guest?.place ?? this.deps.workspaces?.place(body.channel));
    let markFinished: () => void = () => undefined;
    /** Claude Code's process for this run (see gone), and whether the run is over. */
    let proc: RunProcess | undefined;
    let ended = false;
    const finished = new Promise<void>((resolve) => (markFinished = resolve));
    // In a main folder, a change request carries the conversation into a new worktree.
    const move = place?.askOnly && !place.syncMain && !place.askOnly.stays && body.channel !== 'room' ? (task: string) => this.moveToWorktree(from, requesterName, body.channel, task, finished, external ? body.via : undefined) : undefined;
    if (body.channel !== 'room' && !place) {
      const why = isAssistant(body.channel)
        ? `${ASSISTANT_TITLE}’s assistant needs the Beluga app.`
        : /^(dm|group):/.test(body.channel)
          ? 'Your agent acts in chats only in the Beluga app, and only when you ask it.'
        : this.deps.workspaces?.inChannel(body.channel)?.kind === 'main'
          ? 'The main folder has no conversation of its own: start a new chat in the project.'
          : 'That workspace is archived or missing.';
      this.emitAgent(body.requestId, from, 'error', why, body.channel);
      if (lane.current === controller) {
        lane.current = undefined;
        lane.runAgent = undefined;
      }
      return;
    }
    // A worktree's run: what it starts carries BELUGA_WORKTREE (and the old KLAUD_WORKTREE), so test runs it leaves behind can be stopped.
    const worktree = place && place.autoEdit && !place.askOnly ? place.cwd : undefined;
    // Asked from your app on another computer (BLG-803): the run hears so (run-instructions.ts), and what it starts.
    // BROWSER=none (BLG-838): tools that open a browser themselves (create-react-app, vite --open) don't, here where nobody is.
    const remote = this.remoteRequests.has(body.requestId);
    const tag: Record<string, string> = { ...(worktree ? belugaEnvBoth('WORKTREE', worktree) : {}), ...(remote ? { BELUGA_REMOTE_CLIENT: '1', BROWSER: 'none' } : {}) };
    /** What this run kept running on purpose (see keepsRunning), noted in the conversation when it ends. */
    const kept = new Set<string>();
    this.currentChannel = body.channel;
    this.emitAgent(body.requestId, from, 'started', '', body.channel);
    try {
      // A workspace (not a main folder, where nothing may change) gets its scratch folder.
      const scratch = place && !place.askOnly && this.store.getState().prefs.scratchFolder && (await ensureScratch(place.cwd)) ? SCRATCH_DIR : undefined;
      // What you send it (images, files) is copied into its scratch folder, this message and the ones that join this run.
      lane.sent = scratch && place && from === this.selfId ? { root: place.cwd, rel: sentFolder(body.channel, this.ownFolder(body.channel)) } : undefined;
      // Your phone (core/phone): your own runs can drive it; a screenshot lands in this run's scratch.
      const phone = from === this.selfId ? this.deps.phone?.(scratch && place ? path.join(place.cwd, scratch) : undefined) : undefined;
      // Calls you were in (BLG-715): your own runs look up what was said, a page at a time.
      const callNotes = from === this.selfId ? this.deps.callNotes?.() : undefined;
      // Live previews (Settings › Experimental): your own runs in a project's folder learn to show what they build.
      const previewBrief = from === this.selfId && place && experimentOn(this.store.getState().prefs.experiments, 'previews') ? buildPreviewAppend() : undefined;
      // A plan's home conversation (a main folder's chat, often): the plan's tools.
      const plans = from !== this.selfId || place?.syncMain ? undefined : this.deps.plans?.(body.channel, from);
      // Syncing main never gets them, so it never counts as missing them.
      lane.runPlanTools = Boolean(plans?.tools || place?.syncMain);
      // Your own runs get the board: a run doing a task gets it, and the tools to keep it true. A main
      // folder's chat too (BLG-626): the board is Beluga's, not a file there, so the folder stays read-only.
      // A plan's own conversation too, for tasks outside the plan. Not while syncing main, nor in a
      // milestone's checker (it has only plan_get and plan_gate).
      const planFirst = body.plan && !plans?.tools;
      // Sentinels (your own runs): a sentinel run's Claude step gets its brief, and the task tools (it makes tasks).
      const sentinel = from === this.selfId && !place?.syncMain ? this.deps.sentinel?.(body.channel, from) : undefined;
      const noBoard = place?.syncMain || (place?.askOnly && plans?.checker && !sentinel?.inRun);
      // A friend's run gets its repo's board too, as their trust allows (BLG-701; see boardAccess).
      const friendBoard = from === this.selfId ? undefined : this.boardAccess(from);
      const board = noBoard || (from !== this.selfId && !friendBoard) ? undefined : this.deps.board?.(body.channel, from, { plan: planFirst && from === this.selfId, ...(friendBoard ? { friend: { id: from, name: requesterName } } : {}) });
      // Child threads: your own runs in your own chats, with the flag on. A dialogue's turn comes through runDialogueTurn and never gets them.
      // Not an external agent's run: a thread would run as you, without its grant, label or Stop.
      const threads = from === this.selfId && !external && this.store.getState().prefs.agentThreads && !root && !place?.syncMain && !sentinelChat && !sentinel?.inRun ? this.deps.threads?.(body.channel) : undefined;
      // A run stopped but not ending (wedged, or never started: no Claude Code yet) has its Claude
      // Code killed after a moment (at once when it's gone already), then is left behind so what
      // comes next in the conversation starts (BLG-402): never while its Claude Code could still
      // work in this folder.
      const gone = new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => {
            const timer = setTimeout(() => {
              if (ended) return;
              void (proc?.kill() ?? Promise.resolve()).then(() => !ended && reject(new Error('aborted')));
            }, proc && !proc.alive() ? 0 : ABORT_GRACE_MS);
            timer.unref();
          },
          { once: true },
        ),
      );
      gone.catch(() => undefined);
      // Claude Code exited and the run didn't end with it (no result, no error): closed out after a
      // moment, so it never shows as running with nothing behind it.
      let lost: (err: Error) => void = () => undefined;
      const exited = new Promise<never>((_, reject) => (lost = reject));
      exited.catch(() => undefined);
      const watch = (p: RunProcess): void => {
        void p.exited?.then(() => {
          const timer = setTimeout(() => {
            if (!ended && proc === p) lost(new RunFailedError({ kind: 'crash', detail: 'Claude Code exited without ending its turn.' }));
          }, EXIT_GRACE_MS);
          timer.unref();
        });
      };
      // The plan's head Claude orchestrates: it may change things where it runs (your approvals and
      // Beluga's secrets rules still apply), not only read like other main-folder chats.
      const runPlace = plans?.tools && place?.askOnly && !place.syncMain ? withoutAskOnly(place) : place;
      const final = await Promise.race([gone, exited, agent.run({
        ...(scratch ? { scratchDir: scratch } : {}),
        ...(board?.tools ? { board: board.tools } : {}),
        ...(board?.brief ? { taskBrief: board.brief } : {}),
        ...(board?.needsDefinition && board.planApproved ? { planTask: { needsDefinition: board.needsDefinition, approved: board.planApproved } } : {}),
        ...(plans?.tools ? { planTools: plans.tools } : {}),
        ...(plans?.brief ? { planBrief: plans.brief } : {}),
        ...(threads ? { threadTools: threads } : {}),
        ...(mac ? { macTools: mac.tools, macBrief: mac.brief } : {}),
        ...(guest ? { sharedBrief: guest.brief } : {}),
        ...(phone ? { phoneTools: phone.tools, phoneBrief: phone.brief } : {}),
        ...(callNotes ? { callNotesTools: callNotes } : {}),
        ...(previewBrief ? { previewBrief } : {}),
        ...(sentinel ? { sentinelTools: sentinel.tools, sentinelBrief: sentinel.brief, ...(sentinel.dashboard ? { dashboardTools: sentinel.dashboard } : {}) } : {}),
        prompt: this.promptOf(body, lane.sent),
        ...this.promptIdOf(body),
        requesterName,
        viaAgent: body.viaAgent,
        context: this.recentChat(body.channel),
        ...(runPlace ? { place: runPlace } : {}),
        channel: body.channel,
        scope: external ? this.trustIn(external).reach : from === this.selfId ? 'full' : this.trustIn(from).reach,
        ...(from !== this.selfId && this.deps.isGuest?.(from) ? { guest: true } : {}),
        ...(board?.tools && friendBoard && friendBoard !== 'free' ? { boardAsks: friendBoard } : {}),
        signal: controller.signal,
        onEvent: (kind, text) => {
          this.compactor.observe(body.channel, kind, text);
          this.emitAgent(body.requestId, from, kind, text, body.channel);
        },
        onStep: (record) => {
          if (worktree && record.tool === 'Bash' && mayLeaveProcesses(record.input?.command, record.input?.run_in_background)) {
            this.testRuns.add(worktree);
            if (keepsRunning(record.input?.command)) kept.add(String(record.input?.command).slice(0, 120));
          }
          this.steps.put(runKey(body.requestId), record);
        },
        // Another Claude asked: give it the answer now rather than after every background agent.
        ...(body.viaAgent && from !== this.selfId ? { onAnswered: (text: string) => this.emitAgent(body.requestId, from, 'answered', text, body.channel) } : {}),
        onFileTouched: (abs) => this.announceAgentFocus(abs),
        canUseTool: (toolName, input) => this.authorizeTool(external ?? from, requesterName, toolName, input, body.channel, place?.cwd),
        // Only your own Claude may ask for a .env file; for anyone else it stays refused.
        ...(yours ? { canUseSecret: (toolName: string, input: Record<string, unknown>) => this.authorizeSecret(toolName, input, body.channel, place?.cwd, external) } : {}),
        // "My agent asks before commands": a runtime that doesn't ask per command on its own (Codex) asks for each.
        ...(from === this.selfId && this.store.getState().prefs.selfApproval === 'ask' ? { askBeforeCommands: true } : {}),
        ...(external ? this.externalRunGates(external) : {}),
        askUser: (question) => this.deps.questions.ask(askTo, body.requestId, body.channel, question),
        plan: body.plan,
        // A plan's conversation plans; it doesn't move to a worktree.
        ...(move && !plans?.tools ? { continueInWorktree: move } : {}),
        // Your own Claude in a worktree keeps the project's setup true for the next one.
        ...(worktree && from === this.selfId && body.channel.startsWith('ws:') ? (({ setup }) => (setup ? { setup } : {}))({ setup: this.deps.setup?.(body.channel) }) : {}),
        onProcess: (p) => {
          proc = p;
          watch(p);
        },
        onSteer: (steer) => {
          if (lane.current === controller) lane.steer = steer;
        },
        onFollowUps: (send) => {
          if (lane.current !== controller) return;
          lane.followUps = send;
          if (send) release?.();
          // Anything that queued up behind this run from the same person can go in now.
          if (send) lane.waiting = lane.waiting.filter((w) => !this.sendFollowUp(lane, w.from, w.body));
        },
        ...this.modelFor(place?.model, place?.agent ?? named, place?.effort),
        // Your MCP servers (your logins: Figma, Linear…) are for runs you asked for, never a friend's.
        ...(yours ? { ownerMcp: true } : {}),
        // Your own flags for `claude` and `codex` (Settings › Agents), never on a friend's run or an agent's below full.
        ...(yours ? this.launchArgs() : {}),
        // Your variables can hold secrets: only runs you asked for get them, never a friend's.
        // Your own runs also get adb on PATH (and ANDROID_SERIAL) when a phone is set up, so Bash can drive it (BLG-174).
        ...(yours && (this.deps.envFor || phone?.env) ? { env: { ...this.deps.envFor?.(body.channel, place?.cwd), ...(phone?.env ?? {}), ...tag } } : worktree || remote ? { env: tag } : {}),
        ...this.compactor.threshold(),
      })]);
      if (controller.signal.aborted) throw new Error('aborted');
      this.emitAgent(body.requestId, from, 'done', final || '(done)', body.channel);
    } catch (err) {
      const stopped = lane.stopping ? (from === this.selfId ? 'Stopped by you' : 'Stopped by owner') : undefined;
      const reason = stopped ?? (lane.interruptedBy ? (lane.interruptNote ?? 'Interrupted by a newer message') : controller.signal.aborted ? 'Stopped by owner' : errorText(err));
      lane.interruptedBy = undefined;
      lane.interruptNote = undefined;
      lane.stopping = undefined;
      // Failed on its own (not stopped): what queued behind it waits for Continue, not to fail the same way.
      const failure = decodeFailure(reason);
      if (failure && failure.kind !== 'stopped' && lane.waiting.some((w) => !w.compact)) lane.held = true;
      this.emitAgent(body.requestId, from, 'error', reason, body.channel);
    } finally {
      ended = true;
      this.remoteRequests.delete(body.requestId);
      if (lane.current === controller) {
        lane.current = undefined;
        lane.runAgent = undefined;
        lane.followUps = undefined;
        lane.steer = undefined;
        lane.runFrom = undefined;
        lane.runPlanTools = undefined;
      }
      lane.interruptedBy = undefined; // never carry an interrupt label into the next run
      lane.interruptNote = undefined;
      lane.stopping = undefined;
      markFinished();
      this.compactor.ran(body.channel);
      this.steps.flush(runKey(body.requestId));
      // Claude stopped: no test run (an e2e's daemon, vite, browser) it started outlives it.
      // Only when it may have started any (ps over every process is slow on a busy Mac).
      // Except a server kept on purpose: a command marked KLAUD_KEEP=1 (stopTests spares it, never a test run).
      // Words in the message ("keep going") never spare anything: Claude marks what you asked to keep.
      if (worktree && !lane.current && (this.testRuns.delete(worktree) || e2eLockedIn(worktree))) void this.deps.stopTests?.(worktree).catch(() => undefined);
      if (kept.size) this.store.dispatch({ type: 'system', channel: body.channel, level: 'info', text: `Left running on purpose: ${[...kept].join('; ')}. Archiving the worktree stops it.` });
      if (!lane.current) this.wakeIdle(body.channel);
      void this.deps.refreshUsage();
      // Only this folder's git status: a run ending elsewhere changed nothing in the others.
      if (body.channel !== 'room' && place) void this.deps.workspaces?.refreshWorkspace(place.cwd).catch(() => undefined);
    }
  }

  /**
   * What the agent's own terminal on a conversation is given (BLG-534): what your own run there
   * would get (its folder and session, the task and its tools, your phone, your variables, the
   * worktree's tag), less what's only for a turn. Launched on the conversation's runtime.
   */
  async terminalLaunch(channel: string, sink: TerminalSink, prompt = ''): Promise<TerminalLaunch> {
    const agent = this.agent as AgentBackend;
    if (!agent.terminal) throw new Error('This agent has no terminal of its own in Beluga.');
    if (this.runningIn(channel)) throw new Error(TERM_BUSY);
    const place = this.deps.workspaces?.place(channel);
    if (!place) throw new Error('That conversation is archived or its folder is gone.');
    const requesterName = peerName(this.store.getState(), this.selfId);
    const worktree = place.autoEdit && !place.askOnly ? place.cwd : undefined;
    const tag: Record<string, string> = worktree ? belugaEnvBoth('WORKTREE', worktree) : {};
    const scratch = !place.askOnly && this.store.getState().prefs.scratchFolder && (await ensureScratch(place.cwd)) ? SCRATCH_DIR : undefined;
    const phone = this.deps.phone?.(scratch ? path.join(place.cwd, scratch) : undefined);
    const board = this.deps.board?.(channel, this.selfId, { plan: false });
    const setup = worktree && channel.startsWith('ws:') ? this.deps.setup?.(channel) : undefined;
    const requestId = `term-${randomUUID()}`;
    this.deps.questions.track(requestId, this.selfId, channel);
    return agent.terminal(
      {
        terminal: true,
        prompt,
        requesterName,
        viaAgent: false,
        context: [],
        place,
        channel,
        scope: 'full',
        signal: new AbortController().signal,
        onEvent: () => undefined,
        onFileTouched: (abs) => this.announceAgentFocus(abs),
        canUseTool: (toolName, input) => this.authorizeTool(this.selfId, requesterName, toolName, input, channel, place.cwd),
        canUseSecret: (toolName, input) => this.authorizeSecret(toolName, input, channel, place.cwd),
        askUser: (question) => this.deps.questions.ask(this.selfId, requestId, channel, question),
        ...(scratch ? { scratchDir: scratch } : {}),
        ...(board?.tools ? { board: board.tools } : {}),
        ...(board?.brief ? { taskBrief: board.brief } : {}),
        ...(phone ? { phoneTools: phone.tools, phoneBrief: phone.brief } : {}),
        ...(setup ? { setup } : {}),
        ...this.modelFor(place.model, place.agent, place.effort),
        ownerMcp: true,
        ...this.launchArgs(),
        env: { ...this.deps.envFor?.(channel, place.cwd), ...(phone?.env ?? {}), ...tag },
      },
      sink,
    );
  }

  /**
   * One turn of a chaired dialogue (core/dialogues) between your own agents: an ordinary run on
   * `backend` (the participant's runtime) with what the chair decided (its prompt, brief,
   * end_dialogue tool, talk mode's read-only vetTool), your approvals for the rest. Not in a lane:
   * the chair runs its turns one after another itself. Its answer and the tokens it spent.
   */
  async runDialogueTurn(channel: string, backend: AgentBackend, input: Pick<AgentRunInput, 'prompt' | 'signal' | 'vetTool' | 'dialogue' | 'env'> & { readonly scope?: AgentRunInput['scope'] }, opts: { readonly place?: AgentPlace; readonly defaultModel?: boolean } = {}): Promise<{ text: string; tokens: number }> {
    const requestId = randomUUID();
    const requesterName = peerName(this.store.getState(), this.selfId);
    this.deps.questions.track(requestId, this.selfId, channel);
    let tokens = 0;
    const text = await backend.run({
      requesterName,
      viaAgent: false,
      context: [],
      ...input,
      scope: input.scope ?? 'full',
      channel,
      ...(opts.place ? { place: opts.place } : {}),
      onEvent: (kind, payload) => {
        if (kind === 'usage') tokens += usageTokens(payload);
      },
      onFileTouched: (abs) => this.announceAgentFocus(abs),
      canUseTool: (toolName, toolInput) => this.authorizeTool(this.selfId, requesterName, toolName, toolInput, channel, opts.place?.cwd),
      askUser: (question) => this.deps.questions.ask(this.selfId, requestId, channel, question),
      ...(opts.defaultModel ? this.modelFor(opts.place?.model, opts.place?.agent, opts.place?.effort) : {}),
    });
    return { text, tokens };
  }

  /** Your launch flags per runtime (Settings › Agents › Launch flags), when you set any. */
  private launchArgs(): Pick<AgentRunInput, 'launchArgs'> {
    const { claudeArgs, codexArgs } = this.store.getState().prefs;
    return claudeArgs.length || codexArgs.length ? { launchArgs: { claude: claudeArgs, codex: codexArgs } } : {};
  }

  /**
   * The model and effort for a run: the conversation's own pick, else its agent's (a project's own
   * agent, or yours), else Settings' model, which is Claude's: another runtime then takes its default.
   * The effort: the conversation's own (a Sentinel step's), else Settings'.
   */
  private modelFor(own: string | undefined, agent?: AgentRef, ownEffort?: AgentPlace['effort']): { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } {
    const prefs = this.store.getState().prefs;
    const model = own ?? agent?.model ?? (agent && agent.runtime !== CLAUDE_AGENT.runtime ? undefined : prefs.model);
    const effort = ownEffort ?? prefs.effort;
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }

  /**
   * The model a conversation uses now ('' for Claude Code's default), for a message into its live
   * run: picked after the run started (the chat's model picker), the run switches to it first.
   */
  private modelNow(channel: string): string {
    return this.modelFor(this.deps.workspaces?.inChannel(channel)?.model, this.deps.workspaces?.agentIn(channel)).model ?? '';
  }

  /** The requester's trust now: every check on a run reads it here, never from the people book. */
  private trustIn(requester: string): RequesterTrust {
    return requesterTrust(this.store.getState(), requester, this.externalLookup);
  }

  /** This external agent's level now: blocked when its grant has ended. */
  externalLevel(requester: string): TrustLevel {
    return this.trustIn(requester).level;
  }

  /** Who a message in this conversation really comes from, when its run is an external agent's. */
  viaIn(channel: string): MessageVia | undefined {
    // An agent's own place: what is done from there is its own, with or without a run.
    const from = isExternalRequester(channel) ? channel : this.lanes.get(channel)?.runAgent;
    return from ? this.viaOf(from) : undefined;
  }

  /** The external agent a request of yours is for. Only yours: a friend's `via` names an agent on their computer. */
  private agentOf(from: string, body: BodyOf<'agent_request'>): string | undefined {
    return from === this.selfId && body.via?.creationSource === 'mcp' && body.via.id ? externalRequester(body.via.id) : undefined;
  }

  private viaOf(requester: string): MessageVia | undefined {
    if (!isExternalRequester(requester)) return undefined;
    return { id: requester.slice(requester.indexOf(':') + 1), name: this.nameOf(requester), creationSource: 'mcp' };
  }

  /** Who a run is for, as its agent reads it. `from` alone decides what it may do. */
  private requesterOf(from: string, body: BodyOf<'agent_request'>): string {
    const external = this.agentOf(from, body);
    if (external) return this.nameOf(external);
    return body.via ? viaRequester(this.nameOf(from), body.via) : this.nameOf(from);
  }

  private nameOf(requester: string): string {
    if (isExternalRequester(requester)) return this.externalLookup(requester)?.name ?? 'An external agent';
    return peerName(this.store.getState(), requester);
  }

  /** What an external agent's level asks of your run: re-read at each step, so a revoke or a lower level counts at the next one. */
  private externalRunGates(requester: string): Pick<AgentRunInput, 'asOwner' | 'vetTool' | 'asksFirst' | 'askBeforeCommands'> {
    const { level } = this.trustIn(requester);
    return {
      asOwner: true,
      vetTool: () => (this.trustIn(requester).level === 'blocked' ? 'This external agent no longer has a grant.' : undefined),
      asksFirst: (toolName) => {
        const now = this.trustIn(requester).level;
        return now === 'ask' || (now === 'trusted' && toolName.startsWith('mcp__beluga'));
      },
      ...(level === 'full' ? {} : { askBeforeCommands: true }),
    };
  }

  /** One step's card. An external agent's yes counts only if its grant still stands. */
  private async askTool(requester: string, title: string, detail: string, channel: string, meta: { once?: boolean } = {}): Promise<'yes' | 'no' | 'always'> {
    if (!isExternalRequester(requester)) return this.ask('tool', title, detail, requester, channel, meta);
    const answer = await this.ask('tool', title, detail, requester, channel, { ...meta, asker: this.nameOf(requester) });
    return this.trustIn(requester).level === 'blocked' ? 'no' : answer;
  }

  private async authorizeTool(requester: string, requesterName: string, toolName: string, input: Record<string, unknown>, channel = 'room', cwd?: string): Promise<boolean> {
    const state = this.store.getState();
    const external = isExternalRequester(requester);
    if (external && this.trustIn(requester).level === 'blocked') return false;
    // An external agent at full is you, steering from another UI: your rules, and cards you can tell apart.
    const asOwner = requester === this.selfId || (external && this.trustIn(requester).level === 'full');
    const wants = external ? `${requesterName}, your external agent, wants to` : `Your agent (working for ${requesterName}) wants to`;
    // Acting on your phone follows its own setting (Off · Ask · Use · Full), not the global one: at
    // 'ask' you're asked each time even if your Claude normally doesn't ask; looking never asks.
    if (asOwner && toolName.startsWith('mcp__beluga_phone__') && !PHONE_LOOK_TOOLS.includes(toolName)) {
      const use = this.deps.phoneUse?.() ?? 'off';
      if (use !== 'ask') return true; // 'off'/unreachable: the tool itself explains; 'use'/'full': just run
      const answer = await this.ask('tool', `Your agent wants to use your phone (${toolName.replace('mcp__beluga_phone__', '')})`, JSON.stringify(input).slice(0, 2000), requester, channel);
      return answer !== 'no';
    }
    // Deleting a sentinel or a dashboard asks you first, even when your Claude never asks otherwise: once, no Always.
    if (asOwner && ALWAYS_ASK_YOU.has(toolName)) {
      const words = this.deps.confirmTool?.(toolName, input);
      const answer = await this.ask('tool', words?.title ?? `Your agent wants to use ${toolName}`, words?.detail ?? JSON.stringify(input), requester, channel, { once: true });
      return answer !== 'no';
    }
    // Your own Claude doesn't nag you (unless you asked it to); fully trusted friends don't either.
    if (asOwner && state.prefs.selfApproval === 'never') return true;
    if (!asOwner && this.trustIn(requester).level === 'full') return true;
    // A file that runs code later (a git hook, npm scripts…; BLG-413): asked each time, once, whatever was allowed before.
    if (!asOwner && writesCode(toolName, input, cwd ?? process.cwd())) {
      const file = String(input.file_path ?? input.notebook_path);
      const answer = await this.askTool(requester, `${wants} change ${path.basename(file)}, a file that can run commands on your Mac`, file, channel, { once: true });
      return answer !== 'no';
    }
    // Invited by link to edit this project: as if you prompted, inside its folder (secrets were already refused).
    if (cwd && requester !== this.selfId && !external && this.deps.canEditIn?.(requester, channel) && toolInside(toolName, input, cwd)) return true;
    // "Always" is scoped to one requester and one tool, never global.
    const scope = `${requester}:${toolName}`;
    if (this.alwaysTools.has(scope)) return true;
    const detail = typeof input.command === 'string' ? input.command : JSON.stringify(input);
    const answer = await this.askTool(requester, `${wants} use ${toolName}`, detail, channel);
    if (answer === 'always') this.alwaysTools.add(scope);
    return answer !== 'no';
  }

  /**
   * Your own Claude wants a .env file: you're asked every time (even if your Claude never asks you
   * otherwise), unless you said always, for this project or everywhere.
   */
  private async authorizeSecret(toolName: string, input: Record<string, unknown>, channel = 'room', cwd?: string, external?: string): Promise<boolean> {
    const access = this.deps.dotenvAccess;
    if (access?.allowed(cwd)) return true;
    const project = access?.project(cwd);
    const command = typeof input.command === 'string' ? input.command : undefined;
    const file = ['file_path', 'notebook_path', 'path'].map((k) => input[k]).find((v): v is string => typeof v === 'string');
    const verb = command ? 'run a command that reads' : READS_FILE.has(toolName) ? 'read' : 'change';
    const what = command ? 'a .env file' : path.basename(file ?? '.env');
    const answer = await this.pose('secret', `Your agent wants to ${verb} ${what}${project ? ` in ${project}` : ''}`, command ?? file ?? '', external, channel, project ? { project } : {});
    if (answer === 'project' && project) access?.allow(cwd, 'project');
    if (answer === 'always') access?.allow(cwd, 'everywhere');
    return answer !== 'no';
  }

  private announceAgentFocus(absPath: string): void {
    const hit = this.deps.shares.locate(absPath);
    if (hit) this.send({ kind: 'focus', owner: this.selfId, share: hit.share, path: hit.path, actor: 'agent' }, this.deps.shares.isPrivate(hit.share) ? { to: this.selfId } : {});
  }

  /**
   * The id a request's prompt gets in Claude's transcript: the request's own (a UUID, the one its
   * message in the chat keeps), so editing the message can cut the session there. Only the first time.
   */
  private promptIdOf(body: BodyOf<'agent_request'>): { promptId?: string } {
    if (!UUID.test(body.requestId) || this.promptIds.has(body.requestId)) return {};
    this.promptIds.add(body.requestId);
    if (this.promptIds.size > 2000) this.promptIds.delete(this.promptIds.values().next().value!);
    return { promptId: body.requestId };
  }

  /**
   * The words Claude reads: each "@BLG-24" this board has says it's a task, and which ("@BLG-24 (task: Fix the login)"),
   * and each pasted "worktree:wt-…" which worktree it is and where (BLG-878).
   * `sent`: what the message sends (images, files) is copied there, and the words say where.
   */
  private promptOf(body: BodyOf<'agent_request'>, sent?: SentPlace): string {
    const { board, projects } = this.store.getState();
    const tasked = board.issues.length ? explainTaskMentions(body.prompt, (key) => findIssue(board, key)) : body.prompt;
    const mentioned = explainWorktreeRefs(tasked, (id) => {
      const project = projects.find((p) => p.workspaces.some((w) => w.id === id));
      const w = project?.workspaces.find((x) => x.id === id);
      return w && { name: w.name, project: project?.name, branch: w.branch, path: w.path, archived: w.archived };
    });
    const prompt = sent ? withSentFiles(mentioned, this.selfId, sent.root, sent.rel) : mentioned;
    // The first run after a quiet switch (BLG-592) takes the recent conversation along; the chat and the queue keep only the message.
    return this.deps.workspaces?.withCarry?.(body.channel, prompt, body.requestId) ?? prompt;
  }

  /** A worktree's own conversation, the only one in its folder (others share theirs: Your Mac's chats, a chat in a folder). */
  private ownFolder(channel: string): boolean {
    return this.deps.workspaces?.inChannel?.(channel)?.kind === 'worktree';
  }

  private recentChat(channel = 'room'): string[] {
    const state = this.store.getState();
    return state.log
      .filter((l) => l.type === 'chat' && l.channel === channel)
      .slice(-CONTEXT_LINES)
      .map((l) => (l.type === 'chat' ? `${l.name}: ${l.text}`.slice(0, 1000) : ''));
  }
}

/** A run's 'usage' event → the tokens it spent (input and output; cache reads are not new work). */
export function usageTokens(payload: string): number {
  try {
    const u = JSON.parse(payload) as { input?: unknown; output?: unknown };
    return (typeof u.input === 'number' ? u.input : 0) + (typeof u.output === 'number' ? u.output : 0);
  } catch {
    return 0;
  }
}

/** The agent behind a request, as its card says it. */
const viaLabel = (via: MessageVia | undefined): string => (via ? ` (via ${viaName(via)})` : '');
