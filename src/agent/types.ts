import type { ChatAnswerRequest } from '../core/chat/claude-prompt.js';
import type { ScriptFix, SetupFix, WorkedOutScripts } from './setup-fixer.js';
import type { DraftContext, TaskDraft } from './task-drafter.js';
import type { AgentRef, ClaudeAnswer, ClaudeQuestion, FsEntry, PeerInfo, Usage } from '../protocol.js';
import type { UsageUpdate } from './usage.js';
import type { Effort } from '../shared/settings-schema.js';
import type { StepRecord } from '../shared/steps.js';
import type { ArgsRuntime } from '../shared/agent-args.js';

/** How far a request may reach on the owner's computer. */
export type AccessScope = 'folder' | 'full';

export interface AgentRunInput {
  readonly prompt: string;
  /** Instructions for the agent's own terminal (BLG-534), not a turn: visuals as tokens, no fences (agent/terminal-prompt.ts). */
  readonly terminal?: boolean;
  /** The prompt's id in Claude's transcript (a UUID: the request's own), so editing that message can cut the session there. */
  readonly promptId?: string;
  readonly requesterName: string;
  readonly viaAgent: boolean;
  readonly context: readonly string[];
  /** 'folder': only the shared folders. 'full': the whole computer (secrets still blocked). */
  readonly scope: AccessScope;
  /**
   * The runtime can't gate each tool call (agent/runtime/types.ts, safety rule): run sandboxed, so
   * nothing outside the run's folders, secrets included, is reachable. Never set for Claude.
   */
  readonly sandbox?: boolean;
  /** The request's first answer, as soon as it's there (the run may stay open for background agents). */
  readonly onAnswered?: (text: string) => void;
  /** Asked by a guest invited into one project: the room tools (other people, their files, the room chat) are off. */
  readonly guest?: boolean;
  /** A friend's run with the board (BLG-701): which board tools ask you first ('writes': changes; 'all': every one). */
  readonly boardAsks?: 'writes' | 'all';
  readonly signal: AbortSignal;
  readonly onEvent: (kind: 'text' | 'tool' | 'progress' | 'sub' | 'context' | 'compact' | 'usage', text: string) => void;
  /**
   * Each step in detail as it happens (the tool's input and output, thinking), for the screens on
   * this computer only: kept beside the chat, never sent anywhere (see core/step-book.ts).
   */
  readonly onStep?: (record: StepRecord) => void;
  /** Model for this run (an alias like "sonnet" or a full id); unset: the default. */
  readonly model?: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** At most this many turns (a friend's task, BLG-427); unset: no limit. */
  readonly maxTurns?: number;
  /** Your environment variables for this run, over Beluga's own (only for runs you asked for). */
  readonly env?: Readonly<Record<string, string>>;
  /** Your own runs: your own MCP servers from Claude Code (agent/owner-mcp.ts); never a friend's or a guest's. */
  readonly ownerMcp?: boolean;
  /** Auto-compact threshold (percent) for Claude Code's own compaction; unset: auto-compact is off. */
  readonly autoCompactAt?: number;
  /** A folder (relative to the run's folder, git-ignored) for screenshots and scratch output; the owner watches it live. */
  readonly scratchDir?: string;
  /** Where to run: a workspace folder with its own Claude conversation. Defaults to the room's folder. */
  readonly place?: AgentPlace;
  /** The conversation this run answers in: its room tools (send_chat, asks) post there. */
  readonly channel?: string;
  /** Called with absolute paths the agent wrote to, so the room can follow along. */
  readonly onFileTouched: (absPath: string) => void;
  /**
   * Checked before every tool call, before any other rule (a friend's task: what its owner's
   * capabilities and rules forbid). A reason: denied, whatever else would allow it.
   */
  readonly vetTool?: (toolName: string, input: Record<string, unknown>) => string | undefined;
  /** Ask the owner whether a non-preapproved tool may run. */
  readonly canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  /** An external agent asked for this run, and it is your own run: never a friend's limits or a friend's sandbox. */
  readonly asOwner?: boolean;
  /**
   * A run an external agent asked for: these tools ask you even where Beluga's policy would allow
   * them (its level decides which). Set only for such a run, which `askBeforeCommands` then also covers.
   */
  readonly asksFirst?: (toolName: string) => boolean;
  /**
   * Your own run, with "My agent asks before commands" on (Settings' selfApproval 'ask'): a runtime
   * that runs commands without asking Beluga first (Codex) asks for each one instead.
   */
  readonly askBeforeCommands?: boolean;
  /**
   * Your own run: your flags for the agent's command line, by runtime (Settings › Agents › Launch
   * flags; shared/agent-args.ts). Never set on a friend's or a guest's run.
   */
  readonly launchArgs?: Readonly<Partial<Record<ArgsRuntime, readonly string[]>>>;
  /**
   * Your own Claude wants a .env file (policy.ts 'secret'): ask you, even when nothing else would.
   * Without it (a friend's request, a task from outside) .env files are refused like every secret.
   */
  readonly canUseSecret?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  /** Ask the person who made the request: Claude's questions, or a plan to approve. */
  readonly askUser?: (question: ClaudeQuestion) => Promise<ClaudeAnswer>;
  /** Plan first (read-only investigation, then a plan to approve) instead of acting right away. */
  readonly plan?: boolean;
  /**
   * Called with a way to send more messages into this run once Claude has answered but its
   * background agents are still working (so they aren't cut off), and with undefined when that ends.
   */
  readonly onFollowUps?: (send: ((followUp: FollowUp) => boolean) | undefined) => void;
  /**
   * Called when the run starts with a way to steer it: a message sent in while Claude works,
   * which Claude Code takes in at its next step (between tool calls) without stopping the turn,
   * or answers in a turn of its own right after. Undefined once the run ends.
   */
  readonly onSteer?: (steer: Steer | undefined) => void;
  /** Called once Claude Code's process for this run is up: whether it still lives, and a way to end it for sure. */
  readonly onProcess?: (proc: RunProcess) => void;
  /**
   * In a project's main folder (ask-only): carry this conversation into a new worktree and do
   * `task` there (Claude's continue_in_worktree tool). Resolves with what to tell Claude.
   */
  readonly continueInWorktree?: (task: string) => Promise<string>;
  /** Your own runs in a worktree: the project's setup, and Claude's tool to correct it. */
  readonly setup?: SetupTools;
  /** A friend's task: the extra tools its owner allowed (the screen, device info). */
  readonly taskTools?: TaskTools;
  /** Your own runs: the task board (Claude reads and keeps tasks true; see core/board). */
  readonly board?: BoardTools;
  /** The task this run's worktree is doing (its brief), or a note that the board is there: added to the instructions. */
  readonly taskBrief?: string;
  /**
   * Plan mode with the board: whether the plan's task still has to be defined (task_define) before
   * the plan goes to you, and what to do when you approve it (its task goes on the board).
   */
  readonly planTask?: { readonly needsDefinition: () => boolean; readonly approved: () => void };
  /** A plan (Plans): its tools for this run (its home conversation), and what Claude is told about it. */
  readonly planTools?: PlanTools;
  readonly planBrief?: string;
  /** "Your Mac" (core/assistant): its tools (the screen, device info, starting work) and what Claude is told it is. */
  readonly macTools?: MacTools;
  readonly macBrief?: string;
  /** Asked in a friend's worktree (your "@claude" there): whose it is and how to read it from here. */
  readonly sharedBrief?: string;
  /** Your phone (core/phone): tools to act on your own paired phone, and what Claude is told about it. */
  readonly phoneTools?: PhoneTools;
  readonly phoneBrief?: string;
  /** Live previews are on (Settings › Experimental): what Claude is told about showing them. */
  readonly previewBrief?: string;
  /** Your own runs: sentinels (core/sentinel), and what Claude is told (a sentinel run's brief, or a short note). */
  readonly sentinelTools?: SentinelTools;
  readonly sentinelBrief?: string;
  /** Your own runs: dashboards and the numbers sentinels keep (server `beluga_dashboard`; sentinel_measure inside a run). */
  readonly dashboardTools?: DashboardTools;
  /** Your own runs: the notes of calls you were in (core/calls, BLG-715), to look up, never pasted in. */
  readonly callNotesTools?: CallNotesTools;
  /** Your own runs, when you turned agent threads on: tools to start and follow child threads (core/threads), bound to this run's chat. */
  readonly threadTools?: ThreadTools;
  /** A turn of a chaired dialogue (core/dialogues): its brief and end_dialogue tool. */
  readonly dialogue?: import('./dialogue-tools.js').DialogueTurnTools;
}

/** What Claude writes down about a piece of work: the task in its own words, never the request pasted in. */
export interface TaskDefinition {
  readonly title: string;
  readonly goal: string;
  readonly context?: string;
  readonly acceptance?: readonly string[];
  readonly decisions?: readonly string[];
  readonly questions?: readonly string[];
  readonly estimate?: 1 | 2 | 3 | 5 | 8;
  readonly priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  readonly labels?: readonly string[];
}

/** Sentinels as Claude's tools (agent/sentinel-tools.ts, server `beluga_sentinel`): each answers in words. */
export interface SentinelTools {
  /** Inside a sentinel run only: nothing to do this time, the run ends as skipped with the reason. */
  stop?(reason: string): string;
  list(): string;
  /**
   * A new sentinel from a draft (it starts paused; the answer links it as `sentinel:<id>`). One with a
   * source runs it once first (BLG-304): saved only when it works, answered with a preview.
   */
  create(draft: import('../core/sentinel/tool-draft.js').ToolDraft): string | Promise<string>;
  /** Runs one that's on (never a paused one). */
  run(ref: string): string;
  /** Test its sources once, paused or not, without turning it on; what they find is kept → a preview. */
  test(ref: string): Promise<string>;
  /** Run a view source once, read-only, to look before writing a sentinel's query (the schema, a try) → its first rows. */
  trySource(source: unknown, project?: string): Promise<string>;
  /** Pause-only: turning a sentinel on is the user's (the Mac or the phone), never Claude's. */
  pause(ref: string): string;
  /** The whole sentinel, as material. */
  get(ref: string): string;
  /** Change it (a change to what it can do pauses one that was on); a source it adds or changes runs once first. */
  update(ref: string, patch: import('../core/sentinel/tool-draft.js').ToolPatch): string | Promise<string>;
  /** Delete it (through your approval: never in ALWAYS_OK). */
  remove(ref: string): string;
  /** Its runs, newest first: id, when, how it ended, its line, whether its agent's chat is kept (BLG-577). */
  runs(ref: string): string;
  /** Delete some of its runs' chats, or the runs themselves (through your approval, always) → what was done. */
  deleteRuns(ref: string, which: { readonly runs?: readonly string[]; readonly state?: string; readonly before?: string }, what: 'chat' | 'run'): Promise<string>;
  /** This conversation changes that sentinel (sentinel.ask): its id. */
  readonly asking?: string;
}

/** A tile as Claude gives it (dashboard_add_tile): sentinels by id or name, a step by its id or name. */
export interface ToolTile {
  readonly kind: 'number' | 'series' | 'table' | 'output' | 'text' | 'divider';
  readonly width?: 1 | 2 | 3 | 4 | 6;
  readonly height?: 1 | 2;
  readonly title?: string;
  readonly sentinel?: string;
  readonly metric?: string;
  readonly metrics?: ReadonlyArray<{ readonly sentinel: string; readonly metric: string }>;
  readonly chart?: 'line' | 'area' | 'bar';
  /** An output tile's step (its id or name). */
  readonly step?: string;
  readonly show?: 'auto' | 'markdown' | 'tree' | 'table' | 'text';
  readonly text?: 'headline' | 'report';
  readonly compare?: 'previous' | 'day' | 'week' | 'month';
  /** A table's own columns: in order, renamed or hidden. */
  readonly columns?: ReadonlyArray<{ readonly key: string; readonly label?: string; readonly hidden?: boolean }>;
}

/** Dashboards and numbers as Claude's tools (agent/dashboard-tools.ts, server `beluga_dashboard`): each answers in words. */
export interface DashboardTools {
  /** Inside a sentinel run only: keep a number this run found. */
  measure?(name: string, value: number | string, unit?: string, label?: string): string;
  list(): string;
  create(name: string): string;
  /** Rename it, or change what every tile compares with. */
  update(dashboard: string, patch: { readonly name?: string; readonly compare?: ToolTile['compare'] }): string;
  /** Delete it (through your approval: never in ALWAYS_OK). */
  remove(dashboard: string): string;
  /** To an index among the others, or to a spot on the grid. */
  moveTile(dashboard: string, tileId: string, to: number | { readonly col: number; readonly row: number }): string;
  addTile(dashboard: string, tile: ToolTile): string;
  updateTile(dashboard: string, tileId: string, patch: Omit<Partial<ToolTile>, 'kind' | 'compare'> & { readonly compare?: ToolTile['compare'] | null }): string;
  removeTile(dashboard: string, tileId: string): string;
  metricList(): string;
  metricRead(sentinel: string, name: string, since?: string): string;
  /** This conversation builds that dashboard (Describe it): its id. */
  readonly building?: string;
}

/** A plan as Claude's tools (agent/plan-tools.ts, server `beluga_plan`): each answers in words. */
export interface PlanTools {
  /** Only these tools (their short names, like "plan_gate"): a milestone's checker gets plan_get and plan_gate. */
  readonly only?: readonly string[];
  get(): string;
  write(body: import('../core/plans/edit.js').BodyInput): string;
  update(ops: readonly import('../core/plans/edit.js').PlanOp[], reason?: string): string;
  gate(milestone: string, verdict: 'pass' | 'fail', notes: string): string;
  /** The draft's reviewer records what it found (see core/plans/draft-review.ts). */
  review?(findings: readonly import('../core/plans/model.js').ReviewFinding[]): string;
  start(task: string): Promise<string>;
  /** `queue` (default): read when its current turn ends. `steer`: now, interrupting a long command or a dead run. */
  message(task: string, text: string, mode?: 'queue' | 'steer'): string;
  /** Stop the Claude working on a started task (its queued messages too); it waits until it's told what to do. */
  stop?(task: string): string;
  /** Pause the plan (nothing new starts) or resume it. */
  pause?(paused: boolean): string;
}

/** Child threads as an agent's tools (agent/thread-tools.ts, server `beluga_threads`). Bound to the calling chat: no argument names it. */
export interface ThreadTools {
  start(input: ThreadStartInput): Promise<string>;
  status(input: { readonly id?: string; readonly waitSec?: number }): Promise<string>;
  message(input: { readonly id: string; readonly text: string; readonly mode?: 'queue' | 'steer' }): string;
  stop(input: { readonly id: string; readonly reason?: string }): string;
}

export interface ThreadStartInput {
  readonly task: string;
  readonly title?: string;
  readonly agent?: { readonly runtime: string; readonly model?: string; readonly effort?: Effort };
  readonly project?: string;
  readonly where?: 'worktree' | 'read';
  readonly base?: string;
  readonly plan?: boolean;
  readonly key?: string;
}

/**
 * The task board as Claude's tools (agent/board-tools.ts): each answers in words for Claude.
 * `key`: a task's key ("BOB-12"); left out, the task this run's worktree is doing.
 */
export interface BoardTools {
  /** The task this run's worktree is doing, if any. */
  readonly current?: string;
  /** Define the work this conversation is for (planning: once you approve the plan). */
  define(def: TaskDefinition): string;
  get(key?: string): string;
  list(filter: { readonly scope?: 'open' | 'mine' | 'all'; readonly project?: string; readonly query?: string }): string;
  create(input: {
    readonly title: string;
    readonly goal?: string;
    readonly context?: string;
    readonly acceptance?: string;
    readonly decisions?: string;
    readonly questions?: string;
    readonly estimate?: number;
    /** The repo it runs in (a project's name). */
    readonly project?: string;
    /** The board it goes on (its name or key prefix). */
    readonly board?: string;
    readonly parent?: string;
    readonly blockedBy?: readonly string[];
    readonly status?: 'backlog' | 'todo';
    readonly priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
    readonly labels?: readonly string[];
    /** Only the user sees it (BLG-501). */
    readonly private?: boolean;
  }): string;
  /** A board of its own covering a few repos (their names); its key prefix made from its name unless given. */
  createBoard(input: { readonly name: string; readonly repos: readonly string[]; readonly prefix?: string }): string;
  update(
    key: string | undefined,
    patch: {
      readonly title?: string;
      readonly status?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled';
      readonly priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
      readonly labels?: readonly string[];
      readonly estimate?: number | null;
      readonly assign?: 'me' | 'claude' | 'nobody';
      /** The repo it runs in from now on (a project's name). */
      readonly project?: string;
    },
  ): string;
  editBrief(key: string | undefined, section: 'goal' | 'context' | 'acceptance' | 'decisions' | 'questions' | 'handoff', content: string, reason?: string, mode?: 'replace' | 'append'): string;
  note(key: string | undefined, text: string): string;
  relate(key: string | undefined, relation: 'blocked_by' | 'blocks' | 'related', other: string, remove?: boolean): string;
  attachProof(key: string | undefined, proof: { readonly kind: 'image' | 'url' | 'file' | 'graph' | 'text'; readonly title: string; readonly path?: string; readonly url?: string; readonly body?: string }): string;
}

/** What a friend's task may look at on this Mac (see agent/task-tools.ts). */
export interface TaskTools {
  readonly screenshot?: (app?: string) => Promise<{ readonly text: string; readonly image?: { readonly data: string; readonly mimeType: string } }>;
  readonly deviceInfo?: () => Promise<string>;
}

/**
 * A worktree's project setup (core/workbench): what new worktrees run once, told to Claude in
 * `brief`, and `set` (Claude's set_project_setup tool) when it finds that setup incomplete.
 */
export interface SetupTools {
  readonly brief: string;
  set(command: string, why: string): string;
}

/**
 * Your phone's tools (agent/phone-tools.ts, server `beluga_phone`): your own runs, your own paired
 * phone (core/phone). Each answers in words (a screenshot also as an image). The controller picks
 * the route — Wireless debugging or the app's Accessibility service — so these don't say how.
 */
export interface PhoneTools {
  /** Which phone, how it's reached now, and what can be done; undefined when no phone is usable. */
  status(): Promise<string | undefined>;
  screenshot(): Promise<{ readonly text: string; readonly image?: { readonly data: string; readonly mimeType: string } }>;
  screen(): Promise<string>;
  tap(a: { readonly x: number; readonly y: number; readonly node?: number }): Promise<string>;
  swipe(a: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly ms?: number }): Promise<string>;
  type(a: { readonly text: string; readonly replace?: boolean; readonly enter?: boolean; readonly node?: number }): Promise<string>;
  key(key: string): Promise<string>;
  scroll(a: { readonly dir: 'up' | 'down' | 'left' | 'right'; readonly node?: number }): Promise<string>;
  open(a: { readonly package?: string; readonly url?: string }): Promise<string>;
  apps(): Promise<string>;
  info(): Promise<string>;
  /** Install an APK (a path on this Mac); the phone shows its own Install button. */
  install(apkPath: string): Promise<string>;
  /** Beluga Link installed over adb and its Accessibility turned on (BLG-391). */
  setUpLink(): Promise<string>;
  /** A shell command on the phone (needs Wireless debugging). */
  shell(command: string): Promise<string>;
  /** Recent logs (needs Wireless debugging). */
  logcat(filter?: string): Promise<string>;
  /** Send a file from this Mac to the phone (needs Wireless debugging); returns where it landed. */
  push(localPath: string, dest?: string): Promise<string>;
  /** Get a file from the phone to this Mac's scratch folder (needs Wireless debugging). */
  pull(remotePath: string): Promise<string>;
  /** The phone's current notifications (needs Wireless debugging). */
  notifications(): Promise<string>;
  /** Save a flow you just did as a named, repeatable macro (BLG-175). */
  macroSave(name: string, steps: readonly unknown[]): Promise<string>;
  /** The saved macros. */
  macroList(): Promise<string>;
  /** Run a saved macro on the phone. */
  macroRun(name: string): Promise<string>;
  /** Delete a saved macro. */
  macroDelete(name: string): Promise<string>;
}

/** "Your Mac"'s tools (agent/mac-tools.ts, server `beluga_mac`): each answers in words for Claude. */
export interface MacTools {
  /** A screenshot saved in its scratch folder (an output on both screens), with a copy for Claude to see. */
  screenshot(app?: string): Promise<{ readonly text: string; readonly image?: { readonly data: string; readonly mimeType: string } }>;
  deviceInfo(): Promise<string>;
  /** Projects, their worktrees and chats, what's running, plans. */
  listWork(): string;
  startWorktree(input: { readonly project: string; readonly message: string; readonly name?: string; readonly plan?: boolean }): Promise<string>;
  startTask(key: string): Promise<string>;
  startPlan(input: { readonly project: string; readonly goal: string }): Promise<string>;
  /** Archive a worktree (by id or name), losslessly as the Archive button does; `confirmed` once the owner said yes to stopping its Claude. */
  archiveWorktree(input: { readonly worktree: string; readonly confirmed?: boolean }): Promise<string>;
}

/** A message sent into a live run: while it waits on its background agents, or steering it. */
export interface FollowUp extends Pick<AgentRunInput, 'prompt' | 'requesterName' | 'viaAgent' | 'context' | 'onEvent' | 'onStep' | 'promptId'> {
  /**
   * The model the conversation uses now ('' for Claude Code's default). Picked after the run
   * started, the run switches to it before reading the message; unset: the run keeps its own.
   */
  readonly model?: string;
  readonly onDone: (final: string) => void;
  readonly onError: (reason: string) => void;
  /** Its own turn begins (see TurnRoute.onStart). */
  readonly onStart?: () => void;
  /** Claude took it into the turn it was working on (see TurnRoute.onFolded). */
  readonly onFolded?: () => void;
}

/** What a live run is doing right now, so a steer can tell whether Claude would read it soon. */
export interface LiveStatus {
  /** The oldest tool still running in the main conversation: what it is and since when (ms). */
  readonly tool?: { readonly label: string; readonly since: number };
  /** When the run last said anything (any message from Claude Code). */
  readonly lastEventAt: number;
  /** Claude has answered and waits between turns (a message starts a turn at once). */
  readonly between: boolean;
  /** Claude's last word was thinking (a quiet spell is Claude thinking, not a stuck step). */
  readonly thinking?: boolean;
  /** False once Claude Code's process is gone (the run is dead whatever else it says). */
  readonly alive?: boolean;
}

/** Claude Code's process behind a run (see AgentRunInput.onProcess). */
export interface RunProcess {
  readonly pid: number;
  alive(): boolean;
  /** SIGTERM, then SIGKILL if it's still there after a moment; resolves once it's gone. */
  kill(): Promise<void>;
  /** Resolves once it has exited, however that happened. */
  readonly exited?: Promise<void>;
}

/**
 * A way into a live run (see AgentRunInput.onSteer). Called: the message goes in and Claude reads
 * it at its next step. `status` and `interrupt` are there when the backend can tell and stop.
 */
export interface Steer {
  (followUp: FollowUp): boolean;
  readonly status?: () => LiveStatus;
  /**
   * Stop the running tool and turn (Claude Code's interrupt), the interrupted turn ending with
   * `note`, and answer `followUp` in the next turn. Resolves false when the run couldn't be interrupted.
   */
  readonly interrupt?: (followUp: FollowUp, note: string) => Promise<boolean>;
  /**
   * Send now: a message already steered in (this steer took it) that Claude hasn't read yet is
   * answered at once. The running step and turn stop (Claude Code's interrupt, the turn ending
   * with `note`) and the message, still in Claude Code's queue, is the next turn. Resolves false
   * when Claude read it already, or the run couldn't be interrupted.
   */
  readonly force?: (followUp: FollowUp, note: string) => Promise<boolean>;
  /**
   * Take back a message already steered in (this steer took it) that Claude hasn't read yet: it
   * leaves Claude Code's queue and is never read nor answered. Resolves false when Claude read it
   * already (or is reading it); rejects when the agent can't take messages back.
   */
  readonly cancel?: (followUp: FollowUp) => Promise<boolean>;
}

export interface AgentPlace {
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly autoEdit: boolean;
  /** The agent that runs here (unset: your default). Each run from this place goes to its runtime. */
  readonly agent?: AgentRef;
  /** The conversation to continue: always one `agent`'s runtime made (see session-carry.ts resumeFor). */
  readonly resume?: string;
  /** Branch `resume` into a new conversation (used by forks). */
  readonly forkSession?: boolean;
  readonly onSession: (sessionId: string) => void;
  /** The model picked for this conversation. */
  readonly model?: string;
  /** The thinking effort picked for this conversation (unset: Settings'). */
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** A project's main folder: questions only, nothing may change (see policy.ts). */
  /** `stays`: a read-only thread (core/threads) stays read-only: it cannot move itself into a worktree. */
  readonly askOnly?: { readonly project: string; readonly stays?: boolean };
  /** With askOnly, for one run: Claude brings the default branch up to date (git syncing only; see sync-main.ts). */
  readonly syncMain?: { readonly branch: string; readonly upstream: string };
  /** With askOnly: a hidden worktree Claude may edit to fix a conflict there (see policy.ts). */
  readonly fixup?: string;
  /**
   * Other worktrees this one works in too (an epic across repos, BLG-561): in `additionalDirectories`,
   * and edited without asking like its own folder when `autoEdit`.
   */
  readonly alsoEdit?: readonly string[];
  /** Continue After Merge: this worktree's earlier work went out in this pull request, merged into `into`. */
  readonly shipped?: { readonly number: number; readonly url?: string; readonly into: string };
  /** Its pull request is open (BLG-840): the run pushes its commits there (see prompt.ts buildCommitAppend). */
  readonly openPr?: OpenPr;
}

/** A worktree's open pull request, for its run's commit rules (BLG-840). */
export interface OpenPr {
  readonly number: number;
  readonly url?: string;
  /** The branch it's from: what to push. */
  readonly branch: string;
  /** Push to it at the end of a turn that committed (Settings › Workspaces, on by default). */
  readonly push: boolean;
  /** Someone's fork's pull request, checked out here (BLG-756): nothing here can push to it. */
  readonly fork?: boolean;
}

export interface SubAgentEvent {
  readonly id: string;
  readonly phase: 'start' | 'step' | 'done';
  readonly title?: string;
  readonly step?: string;
  /** 'agent' for sub-agents, 'background' for background terminals/agents. */
  readonly kind?: 'agent' | 'background';
  readonly failed?: boolean;
}

/** Something that can run an agent turn and return its final answer. */
/** Where the terminal's `show` keeps each visual (core/agent-term.ts): its number, for the token. */
export interface TerminalSink {
  add(block: string): number;
}

/**
 * The agent's own terminal app on a conversation (BLG-534): Claude Code's (a local model's too,
 * which runs in it; Codex's conversations stay in the chat). The program to run in a pty, and the
 * conversation it goes on with. Beluga's tools are served for it until close().
 */
export interface TerminalLaunch {
  readonly file: string;
  readonly args: readonly string[];
  /** Over the terminal's own (your variables, the worktree's tag, a local model's endpoint). */
  readonly env: Readonly<Record<string, string>>;
  /** Where its transcripts are kept, when not the agent's usual folder (the demo's stand-in). */
  readonly transcriptHome?: string;
  /** The conversation it writes to (Claude Code's session: resumed, or a new id it was given up front). */
  readonly session: string;
  /** It starts a conversation (not one the workspace already had). */
  readonly fresh: boolean;
  /** Stop serving its tools. */
  close(): void;
}

export interface AgentBackend {
  run(input: AgentRunInput): Promise<string>;
  /** The agent's own terminal app on `input.place`'s conversation, with Beluga's tools and rules (BLG-534). */
  terminal?(input: AgentRunInput, sink: TerminalSink): Promise<TerminalLaunch>;
  /** Fetch current plan usage without running a turn, when supported. */
  refreshUsage?(): Promise<Usage | undefined>;
  /** A short worktree name for a task (a small model names it). */
  nameTask?(prompt: string): Promise<string>;
  /** A short name for a new plan from its goal (a small model names it; undefined when it couldn't). */
  titlePlan?(goal: string): Promise<string | undefined>;
  /** A title from recent chat content. The call does not use the chat session. */
  titleChat?(content: string): Promise<string | undefined>;
  /** Answer in a friends' chat from its history (one turn, no tools; core/chat/claude.ts). */
  answerChat?(req: ChatAnswerRequest): Promise<string>;
  /** A side question about a conversation (/btw): a fork of its session, no tools, nothing kept (agent/btw.ts). */
  btw?(req: import('./btw.js').BtwRequest): Promise<string>;
  /** What a project's setup should be after `failed` failed in `dir` (a small model looks). */
  fixSetup?(dir: string, failed: string, output: string): Promise<SetupFix | undefined>;
  /** What a project's run command should be after `failed` failed in `dir` (a model looks). */
  fixRun?(dir: string, failed: string, output: string): Promise<ScriptFix | undefined>;
  /** A project's setup and/or run command, worked out from its files in `dir` (a model looks). */
  workOutScripts?(dir: string, want: { setup: boolean; run: boolean; system?: string }): Promise<WorkedOutScripts | undefined>;
  /** A task written from a description: title, goal, criteria, labels from the board's own (Sonnet). */
  draftTask?(text: string, ctx: DraftContext): Promise<TaskDraft | undefined>;
  /** What a project is about, from a quick read-only look at its folder (About This Project, BLG-298). */
  describeProject?(dir: string, project: string): Promise<string | undefined>;
  /** A pull request reviewed before a sentinel merges it: ship or hold, in one sentence (a small model, read-only). */
  reviewPr?(input: import('./pr-reviewer.js').PrReviewInput): Promise<import('./pr-reviewer.js').PrReview | undefined>;
  /** Models this Claude Code offers, for the model picker. */
  listModels?(): Promise<ReadonlyArray<{ value: string; label: string; description: string; efforts?: readonly string[] }> | undefined>;
  /**
   * Your MCP servers for these project folders, with how each is now (Claude: claude/mcp-connect.ts,
   * Codex: codex/mcp.ts). `runtime`: whose (a routed backend asks that runtime's; unset: the default's).
   */
  mcpServers?(projects: readonly string[], runtime?: string): Promise<readonly import('../shared/mcp.js').McpServerRow[]>;
  /** Start signing in to one of them: the page to open in your browser. */
  mcpSignIn?(projects: readonly string[], name: string, runtime?: string): Promise<import('../shared/mcp.js').McpSignIn>;
  /** Waits for that sign-in: true once connected, false when it gave up, undefined when none is waiting. */
  mcpSignedIn?(name: string, runtime?: string): Promise<boolean | undefined>;
  /** Turn one on or off where its agent keeps it (Codex: config.toml). Only rows with canTurnOff. */
  mcpSetEnabled?(projects: readonly string[], name: string, enabled: boolean, runtime?: string): Promise<import('../shared/mcp.js').McpTurned>;
}

/** One person as the agent sees them in list_peers. */
export interface PeerSummary {
  readonly name: string;
  readonly you: boolean;
  readonly agent: boolean;
  readonly shares: readonly string[];
  /** Their projects you may name in ask_agent / run_on_peer. */
  readonly projects: readonly string[];
  /** Their workspaces shared with you (ask_agent with project=<name> works there). */
  readonly workspaces: ReadonlyArray<{ name: string; project: string; role: string }>;
  /** What they let you do on their computer (as they told you; unknown for older Beluga). */
  readonly lets_you?: { trust: string; means: string };
}

/** What an agent may do to the room, exposed to it as MCP tools. */
export interface RoomBridge {
  selfName(): string;
  sendChat(text: string): void;
  listPeers(): readonly PeerInfo[];
  /** `project`: one of their projects (from list_peers) to work in. */
  askAgent(peerName: string, prompt: string, project?: string): Promise<string>;
  /** Run a shell command on a peer's computer through their Beluga; returns exit code and output. */
  runOnPeer?(peerName: string, command: string, opts?: { cwd?: string; project?: string; timeoutSec?: number; why?: string }): Promise<string>;
  /** People with what they offer you and what their trust in you lets you do (for list_peers). */
  describePeers?(): readonly PeerSummary[];
  listPeerFiles(peerName: string, share: string, path: string): Promise<readonly FsEntry[]>;
  readPeerFile(peerName: string, share: string, path: string): Promise<string>;
  writeReport(title: string, markdown: string): Promise<string>;
  /** Usage observed while running (rate-limit events, tokens), for that provider (Claude's unless named). */
  reportUsage(usage: UsageUpdate, agent?: AgentRef): void;
  /** Get a file from anywhere on a peer's computer (they approve); returns where it was saved here. */
  getPeerFile(peerName: string, path: string, saveTo?: string, why?: string): Promise<string>;
  /** Send a file from this computer to a peer; it's saved on their side. */
  sendFile(peerName: string, path: string, note?: string): Promise<string>;
  /** Tasks between Claudes (the Beluga app only; see agent/gateway-tools.ts). */
  readonly gateway?: import('./gateway-tools.js').GatewayBridge;
  /** The same tools bound to one conversation (a run's: chat, asks and their answers go there). */
  inChannel?(channel: string): RoomBridge;
}

/** Call notes as tools (core/calls/notes-tools.ts): each answers in words an agent reads. */
export interface CallNotesTools {
  /** The calls with notes, newest first. */
  list(limit?: number): string;
  /** Where something was said: the call, the time into it, who, and the words around it. */
  search(query: string, call?: string, limit?: number): string;
  /** A page of one call, from a turn (`from`) or a time into it (`at`: "12:30", or minutes). */
  read(call: string, opts?: { readonly from?: number; readonly at?: string | number; readonly limit?: number }): string;
}
