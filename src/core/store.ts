import type { AgentEventKind, AgentRef, FsEntry, MessageVia, PeerInfo } from '../protocol.js';
import { agentName } from '../shared/agent-label.js';
import { isExternalRequester } from './trust.js';
import { type AssistantChats, NO_ASSISTANT_CHATS, activeAssistantChannel, assistantChannel } from '../shared/assistant.js';
import type { ConnectionStatus } from '../net/peer-client.js';
import type { Effort, NotifySettings, Settings, ThemeName, TrustLevel } from './settings.js';
import { BRANCH_PREFIX_DEFAULT, NotifySettings as NotifySchema, SETTLE_IDLE_DAYS_DEFAULT } from '../shared/settings-schema.js';
import type { Review } from '../workspaces/git.js';
import type { Project, ProjectGroup } from '../workspaces/types.js';
import type { EnvChange } from '../workspaces/env.js';
import type { EnvSendAsk } from '../shared/env-send.js';
import type { PortForward, PortShare } from '../shared/forwards.js';
import type { Bitmap } from '../image/bitmap.js';
import { type CollabAction, type CollabState, initialCollab, reduceCollab } from './collab-store.js';
import { type SearchState, type WorkAction, type WorkState, initialWork, reduceWork } from './work-store.js';
import { type NetworkAction, type NetworkSlice, initialNetwork, reduceNetwork } from './network-store.js';
import { type RevenueCatAction, type RevenueCatSlice, initialRevenueCat, reduceRevenueCat } from './revenuecat-store.js';
import { type EarningsAction, type EarningsSlice, initialEarnings, reduceEarnings } from './earnings-store.js';
import { type SupportAction, type SupportSlice, initialSupport } from './support-store.js';
import { type ClaudeCodeAction, type ClaudeCodeSlice, initialClaudeCode, reduceClaudeCode } from './claude-code/model.js';
import { type GatewayAction, type GatewaySlice, initialGateway, reduceGateway } from './gateway/model.js';
import { type FriendShareAction, type FriendShareSlice, initialFriendShare, reduceFriendShare } from './friend-share-store.js';
import { type BoardAction, type BoardSlice, initialBoard, reduceBoard } from './board/model.js';
import { FIRST_SENTINEL_CHAT, type SentinelAction, type SentinelSlice, initialSentinel, reduceSentinel, sentinelChatChannel } from './sentinel/model.js';
import { type PlansAction, type PlansSlice, initialPlans, isPlanHome, reducePlans } from './plans/model.js';
import { type DialoguesAction, type DialoguesSlice, initialDialogues, reduceDialogues } from './dialogues/model.js';
import { type TeamAction, type TeamSlice, initialTeam, reduceTeam } from './team/model.js';
import { type CompactMark, type ContextInfo, applyContextEvent, parseContextEvent } from './context-log.js';
import { AUTO_COMPACT_DEFAULT } from '../shared/context-usage.js';
import { PARALLEL_RUNS_DEFAULT, type SlotWait } from '../shared/run-slots.js';
import { CHAT_LIMIT_DEFAULT } from '../shared/chat-limit.js';
import { THREAD_LIMITS_DEFAULT, type ThreadLimits } from '../shared/threads.js';
import { READS_AFTER_STEP, STOPPING_FOR } from '../shared/claude-notices.js';
import { type ChatTriage, triageKey } from './triage/model.js';
import type { CompanionSlice } from '../companion/protocol.js';
import type { ReactionEvent } from '../shared/reactions.js';
import { type ChatReactAction, reactOnLog } from './chat-reactions.js';

export type { CompactMark, ContextInfo } from './context-log.js';

export type Policy = 'ask' | 'auto' | 'deny';

export interface SubAgent {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly string[];
  readonly status: 'running' | 'done' | 'failed';
  /** Sub-agent, or background work (a background terminal or agent). */
  readonly kind?: 'agent' | 'background';
  /** When it started (missing on items saved before it was kept): where it sits among the steps. */
  readonly startedAt?: number;
}

/**
 * A run's card: what its last event said, or 'interrupted': klaud stopped (quit, crashed) while it
 * ran and no end came, so it's not running any more (see settleRun). Never sent; only ever local.
 */
export type AgentItemStatus = AgentEventKind | 'interrupted';

/** A card whose run is still going: waiting its turn or for approval, or working. */
export const isRunning = (status: AgentItemStatus): boolean =>
  status === 'started' || status === 'text' || status === 'tool' || status === 'sub' || status === 'awaiting_approval' || status === 'queued';

/** A card that says it's running but has no live run behind it any more: interrupted, its sub-agents done. */
export function settleRun(item: LogItem): LogItem {
  if (item.type !== 'agent' || !isRunning(item.status)) return item;
  return { ...item, status: 'interrupted', endTs: item.endTs ?? item.lastAt ?? item.ts, subagents: item.subagents.map((s) => (s.status === 'running' ? { ...s, status: 'done' as const } : s)) };
}

export type LogItem =
  | {
      readonly id: string;
      readonly type: 'chat';
      readonly channel: string;
      readonly from: string;
      readonly name: string;
      readonly text: string;
      readonly ts: number;
      readonly byAgent: boolean;
      /** With `byAgent`: which agent wrote it (left out: Claude, from before agents were named). */
      readonly agent?: AgentRef;
      /** An external agent sent it through its owner's Beluga: the words aren't the sender's. */
      readonly via?: MessageVia;
      /** The request this message is to your Claude (its card's requestId): how its card's state shows on it (a steer Claude hasn't read yet). */
      readonly request?: string;
      /** Sent to steer the turn your Claude is on (⌥↩): sent but not read until Claude reads it (see shared/claude-notices.ts steeredMessages). */
      readonly steer?: true;
      /** Sent while your agent works in this conversation (↩ queues it): it waits in the queue, not the chat, until its card says otherwise (see shared/claude-notices.ts asSent). */
      readonly queued?: true;
      /** A turn of a chaired dialogue (core/dialogues): which one, and its number (0: a person's interjection). */
      readonly dialogue?: DialogueMark;
      /** Emoji reactions on it (BLG-702): each person's latest change per emoji (core/chat-reactions.ts draws the chips). */
      readonly reacts?: readonly ReactionEvent[];
    }
  | { readonly id: string; readonly type: 'system'; readonly channel: string; readonly text: string; readonly ts: number; readonly level: 'info' | 'warn' | 'error'; readonly said?: SaidBy; readonly compact?: CompactMark; readonly shipped?: ShippedMark; readonly merged?: MergedMark; readonly dialogue?: DialogueMark }
  | {
      readonly id: string;
      readonly type: 'agent';
      readonly channel: string;
      readonly subagents: readonly SubAgent[];
      readonly requestId: string;
      readonly owner: string;
      readonly ownerName: string;
      readonly requesterName: string;
      /** Who asked (a peer id; missing on items saved before it was kept). */
      readonly requester?: string;
      /** The agent doing the run (left out: Claude, from before agents were named). */
      readonly agent?: AgentRef;
      /** What was asked, once known (sent with the "queued" event, for the queue). */
      readonly prompt?: string;
      /** Queued only because your Claude works in as many other conversations as it may at once. */
      readonly slotWait?: SlotWait;
      /** When it left the queue (it waited its turn): where the chat draws it and the message it answers (see shared/claude-notices.ts asSent). */
      readonly queuedUntil?: number;
      readonly status: AgentItemStatus;
      readonly text: string;
      readonly steps: readonly string[];
      readonly ts: number;
      /** When the run finished (done/error/denied). */
      readonly endTs?: number;
      /** Its heartbeat: when Claude last did something (started, wrote, took a step, a sub-agent moved). */
      readonly lastAt?: number;
      /** When the step it's on (its last tool call) began. */
      readonly stepAt?: number;
      /** How far that step has got, when its output says ("137/215"). */
      readonly progress?: string;
      /** Between steps: Claude thinks (its turn began, or the step's tools returned) or wrote last; unset while a step runs. */
      readonly between?: 'thinking' | 'writing';
      /** Since when it has been `between` that way. */
      readonly betweenAt?: number;
      /** What it said before a later step: drawn quietly among its steps, not as its answer (see agentRemarks). */
      readonly remarks?: readonly Remark[];
    }
  | ShellItem;

/** Words Claude said between its steps, and when (a step came after them, so they aren't its answer). */
export interface Remark {
  readonly text: string;
  readonly ts: number;
}

/**
 * Who wrote a line of a shared workspace's earlier conversation (it arrives as a system line,
 * "bob: …"): screens that draw it as that person's message use this.
 */
/**
 * Continue After Merge: the chat above this line went out as pull request `number` (merged into
 * `into`), and what follows is new work for a new pull request. Drawn as a divider.
 */
export interface ShippedMark {
  readonly number: number;
  readonly url?: string;
  readonly into: string;
}

/** A shipped divider's words, where it's drawn as plain text (the phone, a log). */
export const shippedText = (number: number, into: string): string => `Above this line went to PR #${number}, merged into ${into}. New work starts here, for a new pull request.`;

/**
 * The worktree's work merged (Beluga's Merge, Merge When Ready, on GitHub, or into the main
 * folder): `number` is its pull request (none: merged without one). Drawn as a divider.
 */
export interface MergedMark {
  readonly into: string;
  readonly number?: number;
  readonly url?: string;
}

/** A merged divider's words, where it's drawn as plain text (the phone, a log). */
export const mergedText = (m: MergedMark): string => `Above this line was merged into ${m.into}${m.number !== undefined ? ` in PR #${m.number}` : ''}.`;

/** Where a dialogue shows in a conversation: its header card (a system line) and its turns (chat lines). */
export interface DialogueMark {
  readonly id: string;
  readonly turn?: number;
}

export interface SaidBy {
  /** Their peer id, when they're in the room (else "history:<name>"). */
  readonly from: string;
  /** "bob", or "bob's Claude". */
  readonly name: string;
  readonly text: string;
  readonly byAgent: boolean;
  /** When they said it. */
  readonly ts: number;
}

/** A command run on someone's computer (through their Beluga), with its output. */
export interface ShellItem {
  readonly id: string;
  readonly type: 'shell';
  readonly channel: string;
  readonly ts: number;
  /** Whose computer it runs on. */
  readonly owner: string;
  readonly ownerName: string;
  /** "you" or "your Claude". */
  readonly by: string;
  readonly command: string;
  readonly cwd?: string;
  /** waiting (for them to approve) → running → done / failed / declined. */
  readonly status: 'waiting' | 'running' | 'done' | 'failed' | 'declined';
  readonly exitCode?: number;
  readonly output: string;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
  readonly error?: string;
  /** When it started running (after their approval). */
  readonly startTs?: number;
  readonly endTs?: number;
}

export interface Approval {
  readonly id: string;
  /** 'secret': your own Claude wants a .env file (answers: once, always for `project`, always). */
  readonly kind: 'request' | 'tool' | 'secret';
  readonly title: string;
  readonly detail: string;
  /** A secret's project, by name: "Always for <project>" is offered. */
  readonly project?: string;
  /** When it was asked, and how long it waits before it's declined (screens show a countdown). */
  readonly askedAt?: number;
  readonly timeoutMs?: number;
  /** Who it's for (someone else's request: quiet on Do Not Disturb). */
  readonly peer?: string;
  /** The friend's request it's about (the gateway: the request sheet and notifications open it). */
  readonly task?: string;
  /** Only Allow once / Decline: a friend's request for a secret (trust, rules and Always never cover it). */
  readonly once?: boolean;
  /** An external agent asks: its name, as NeedsYou shows who it's from. */
  readonly asker?: string;
  /** The conversation it holds up (a workspace "ws:<id>", Your Mac "mac:assistant:<id>", a friends' chat "dm:<peerId>" / "group:<id>", the Sentinel chat…): the sidebar marks it as needing you, the chat shows it, and Review in Beluga opens it. */
  readonly channel?: string;
}

export interface Location {
  readonly owner: string;
  readonly share: string;
  readonly path: string;
}

export interface BrowserRow {
  readonly label: string;
  readonly dir: boolean;
  readonly target: Location | 'up';
  readonly size?: number;
  /** At the top of Files: whose folder it is (rows of one person come together, under their name). */
  readonly group?: string;
}

/** The Shared files browser: the folder open and what's in it (each screen keeps its own cursor). */
export interface BrowserDomain {
  readonly at?: Location;
  readonly rows: readonly BrowserRow[];
  readonly loading: boolean;
  readonly error?: string;
}

export interface BrowserState extends BrowserDomain {
  readonly cursor: number;
}

/** The file open in the viewer (each screen keeps its own scroll position). */
export interface ViewerDomain extends Location {
  readonly content: string;
  /** Decoded pixels when the file is an image. */
  readonly image?: Bitmap;
  readonly truncated: boolean;
  /** A big file opened by its first piece (BLG-791): where the rest starts, and its size; the reader streams the rest as you scroll. */
  readonly next?: number;
  readonly total?: number;
  readonly loading: boolean;
  readonly error?: string;
  readonly by?: string;
}

export interface ViewerState extends ViewerDomain {
  readonly scroll: number;
}

export interface Focus extends Location {
  readonly actor: 'human' | 'agent';
  readonly ts: number;
}

export type HostingPhase = 'tunnel' | 'reachable' | 'ready' | 'local' | 'failed';

export interface Hosting {
  readonly phase: HostingPhase;
  readonly detail?: string;
  /** Whether the invite was actually placed on the clipboard. */
  readonly copied?: boolean;
}

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly level: 'info' | 'success' | 'warn' | 'error';
}

export type Overlay = 'help' | 'settings' | 'welcome' | 'clear' | 'model' | 'inbox' | 'templates' | 'handoff' | 'add_friend';

/** Preferences mirrored from ~/.beluga/settings.json (every key here is a settings key). */
export interface Prefs {
  readonly theme: ThemeName;
  readonly mouse: boolean;
  readonly tunnel: Settings['tunnel'];
  /** Keep the Mac awake while a phone is paired (companion/awake.ts). */
  readonly keepAwake: Settings['keepAwake'];
  /** Run New Work On (BLG-780): `here`, `best`, or one of your computers by id (src/machines/placement.ts). */
  readonly runOn: Settings['runOn'];
  /** Low Power mode: when Beluga saves power (core/power-saver.ts). */
  readonly lowPower: Settings['lowPower'];
  /** 'never': your own Claude just works; 'ask': it asks before risky actions. */
  readonly selfApproval: 'never' | 'ask';
  readonly notify: NotifySettings;
  /** Default model for new conversations (undefined: Claude Code's default). */
  readonly model?: string;
  readonly effort?: Effort;
  /** Models the chat menu offers (`runtime|value`). Empty: every model. */
  readonly openModels: readonly string[];
  /** Who answers "@you" (core/settings.ts chosenAgent; undefined: Claude). */
  readonly defaultAgent?: AgentRef;
  /** Per-project defaults over `defaultAgent`, by project name. */
  readonly projectAgents?: Readonly<Record<string, AgentRef>>;
  readonly autoSetup: boolean;
  /** What new worktrees' branches start with (`beluga/`; empty: none). */
  readonly branchPrefix: string;
  readonly contextMeter: boolean;
  /** Compact a conversation on its own when its context passes `autoCompactAt` percent. */
  readonly autoCompact: boolean;
  readonly autoCompactAt: number;
  /** After your usage limit resets, the agent that stopped on it continues: off everywhere, in some chats, or this session (shared/auto-continue.ts). */
  readonly autoContinue: boolean;
  readonly autoContinueOff: readonly string[];
  readonly autoContinueSkip: number;
  /** How many conversations your Claude works in at once (see shared/run-slots.ts). */
  readonly parallelRuns: number;
  /** How many chats Your Mac and Sentinel each keep open; 0: no limit (see shared/chat-limit.ts). */
  readonly chatLimit: number;
  /** Your agents may start child threads (core/threads): off means your runs have no thread tools. */
  readonly agentThreads: boolean;
  /** How far those threads go (see shared/threads.ts). */
  readonly threadLimits: ThreadLimits;
  /** Sort chats into Inbox, Working, Later and Settled (core/triage). Off: nothing settles, and triage.json only keeps Remind Me Later. */
  readonly chatCategories: boolean;
  /** A merged PR settles its chat. */
  readonly settleOnMerge: boolean;
  /** Days without activity before a chat settles; 0: never. */
  readonly settleIdleDays: number;
  /** An agent in a worktree whose pull request is open pushes its commits there when its turn ends (BLG-840). */
  readonly pushToPr: boolean;
  /** Claude keeps screenshots and scratch output in the workspace's git-ignored `.beluga/scratch/` folder (watched live in the Mac app). */
  readonly scratchFolder: boolean;
  /** Experimental features that are on (shared/experiments.ts), off until you turn each on. */
  readonly experiments: readonly string[];
  readonly subagents: Settings['subagents'];
  readonly hiddenButtons: readonly string[];
  readonly friendWorktrees: Settings['friendWorktrees'];
  /** Who may call your Claude into a chat (core/chat/claude.ts). */
  readonly chatClaude: Settings['chatClaude'];
  /** Who sees your plan usage on your profile (core/gateway: it rides on your card). */
  readonly shareUsage: Settings['shareUsage'];
  /** Friends see Seen under their direct messages once one was on your screen (BLG-798). */
  readonly readReceipts: boolean;
  readonly shell?: string;
  /** Start the terminal's shell as a login shell. */
  readonly shellLogin: boolean;
  /** Extra arguments for the terminal's shell. */
  readonly shellArgs: readonly string[];
  /** Your own flags for `claude` and `codex`, on your own runs (shared/agent-args.ts). */
  readonly claudeArgs: readonly string[];
  readonly codexArgs: readonly string[];
  /** The currency every earnings total is shown in (lowercase ISO code; undefined: the one most was earned in). */
  readonly earningsCurrency?: string;
}

export interface Transfer {
  readonly id: string;
  readonly name: string;
  readonly from: string;
  readonly received: number;
  readonly total: number;
  readonly status: 'active' | 'done' | 'failed';
  readonly savedTo?: string;
  readonly error?: string;
}

/** What the main area shows. */
export type View =
  | { readonly kind: 'room' }
  /** "Your Mac" (core/assistant): your Claude for the whole Mac, the same as on the phone; one of its chats (tabs, BLG-102), the open one when unset. */
  | { readonly kind: 'assistant'; readonly chat?: string }
  /** "Your phone" (BLG-171): the live mirror of your paired Android phone and what Claude's done on it. Only when one is paired. */
  | { readonly kind: 'phone' }
  | { readonly kind: 'files' }
  | { readonly kind: 'overview' }
  | { readonly kind: 'workspace'; readonly id: string; readonly tab: WorkspaceTab }
  /** Search every conversation. */
  | { readonly kind: 'search' }
  /** Disk space and Claude usage per workspace. */
  | { readonly kind: 'usage' }
  /** Shells of your own, in the current project's folder (or your home folder). */
  | { readonly kind: 'terminal' }
  /** A new chat that doesn't exist until you send the first message. */
  | { readonly kind: 'draft'; readonly projectId: string; readonly dir?: string; readonly back: View }
  /** A new worktree: your first message names it (via a small model) and starts the work. */
  | { readonly kind: 'draft_worktree'; readonly projectId: string; readonly back: View }
  /** Someone else's workspace that they shared with you. */
  | { readonly kind: 'shared'; readonly owner: string; readonly id: string; readonly tab: SharedTab }
  /** A conversation on the Beluga network (Mac app): with a friend (`dm:<peerId>`) or in a group (`group:<id>`). */
  | { readonly kind: 'conversation'; readonly id: string }
  /** Claude Code sessions running outside Beluga, live and read-only (Mac app): all of them, or one session or agent. */
  | { readonly kind: 'claude_code'; readonly session?: string; readonly agent?: string }
  /** A project's home (Mac app): start work in a new worktree or ask about it; its worktrees and chats. */
  | { readonly kind: 'project'; readonly id: string; readonly page?: 'history' }
  /** Tasks between Claudes (Mac app): what you and your Claude asked of others, and what they asked of you. */
  | { readonly kind: 'requests' }
  /** Tasks (Mac app): one project's board (the one you were last in when unset), and one task's page. */
  | { readonly kind: 'tasks'; readonly projectId?: string; /** Only the tasks this worktree does or carries. */ readonly worktree?: string }
  | { readonly kind: 'task'; readonly id: string }
  /** GitHub issues (Mac app): one project's issues (the one you were last in when unset), and one issue's page. */
  | { readonly kind: 'issues'; readonly projectId?: string }
  | { readonly kind: 'gh_issue'; readonly projectId: string; readonly number: number }
  /** GitHub pull requests (Mac app): one project's open pull requests, anyone's (the one you were last in when unset). */
  | { readonly kind: 'pulls'; readonly projectId?: string }
  /** GitHub Actions (Mac app): one project's workflow runs, or its workflows drawn as graphs; and one run's page (its jobs and steps, live). */
  | { readonly kind: 'actions'; readonly projectId?: string; readonly page?: 'workflows' }
  | { readonly kind: 'gh_run'; readonly projectId: string; readonly runId: number }
  /** Plans (Mac app): one project's plans, and one plan's page (its graph, outline and conversation). */
  | { readonly kind: 'plans'; readonly projectId?: string }
  | { readonly kind: 'plan'; readonly id: string; readonly task?: string }
  /** A plan draft a teammate shared with you (core/team): read-only, to review, comment, suggest or approve. */
  | { readonly kind: 'team_plan'; readonly owner: string; readonly id: string }

  /** Every worktree in your projects (Mac app): who made it, whether it's done, the space it takes; archive or clean them. */
  | { readonly kind: 'worktrees'; readonly projectId?: string }
  /** Sentinel (Mac app, docs/sentinel.md): every sentinel (one project's, or Your Mac's: `projectId` 'mac'), one sentinel's page, and one run. */
  | { readonly kind: 'sentinel'; readonly projectId?: string }
  | { readonly kind: 'sentinel_page'; readonly id: string }
  | { readonly kind: 'sentinel_run'; readonly runId: string }
  /** Sentinel › Dashboard (docs/sentinel.md §10): your dashboards, one open (none: the first). */
  | { readonly kind: 'dashboard'; readonly id?: string }
  /** The Sentinel chat (docs/sentinel.md §12), one of its conversations (none: the first), docked beside Sentinel's page, or beside a sentinel's own page (`about`, its id) when you asked from there. */
  | { readonly kind: 'sentinel_chat'; readonly chat?: string; readonly about?: string }
  /**
   * A page on one of your computers (BLG-784, Mac app): the app draws `view` itself, with that
   * computer's state and calls (its screen over /machine/<id>). Only this window's screen has it;
   * the computer's own screen shows `view`.
   */
  | { readonly kind: 'machine'; readonly machine: string; readonly view: View };

/** Tabs of a workspace someone shared with you: the chat, its files, a read-only shell over them, and what changed. */
export type SharedTab = 'chat' | 'files' | 'terminal' | 'diff';

export type WorkspaceTab = 'chat' | 'files' | 'review' | 'terminal';

/** A workspace's changes: the files, and the diff of the one selected (its scroll is per screen). */
export interface ReviewDomain {
  readonly workspaceId: string;
  readonly data?: Review;
  readonly selected: number;
  readonly diff?: string;
  readonly loading: boolean;
  readonly error?: string;
}

export interface ReviewState extends ReviewDomain {
  readonly diffScroll: number;
}

/**
 * A side question about a conversation (/btw) and Claude's answer, shown beside the chat and
 * never part of it: one per conversation, until you close it or ask another (core/btw.ts).
 */
export interface Btw {
  readonly id: string;
  readonly question: string;
  /** The answer so far (all of it once done). */
  readonly text: string;
  readonly state: 'thinking' | 'answering' | 'done' | 'failed';
  readonly error?: string;
  readonly at: number;
}

/** A compaction that just happened, kept briefly so the UI can animate it. */
export interface Compaction {
  readonly pre: number;
  readonly post: number;
  readonly at: number;
}

export const channelOf = (view: View): string =>
  view.kind === 'workspace' || view.kind === 'shared'
    ? `ws:${view.id}`
    : view.kind === 'assistant'
      ? view.chat
        ? assistantChannel(view.chat)
        : activeAssistantChannel(NO_ASSISTANT_CHATS)
      : view.kind === 'sentinel_chat'
        ? sentinelChatChannel(view.chat ?? FIRST_SENTINEL_CHAT)
        : view.kind === 'draft' || view.kind === 'draft_worktree'
          ? 'draft'
          : 'room';

/** The conversation a view shows, if any (Overview, Search, Terminal… show none, so the chat's unread count stays). */
export const shownChannel = (view: View): string | undefined =>
  view.kind === 'conversation' ? view.id : view.kind === 'room' || view.kind === 'workspace' || view.kind === 'shared' || view.kind === 'assistant' || view.kind === 'sentinel_chat' ? channelOf(view) : undefined;

/** What the screens attached to this computer's Beluga are looking at (all of them together). */
export interface Attention {
  /** Conversations some screen shows: new messages there aren't unread. */
  readonly shown: readonly string[];
  /** Conversations a screen in front shows: nothing is announced about them. */
  readonly visible: readonly string[];
  /** Some screen shows Shared files (every folder there counts as seen). */
  readonly files: boolean;
  /** Some Beluga window is in front (focused, or a terminal that was used lately). */
  readonly front: boolean;
}

export const NO_ATTENTION: Attention = { shown: [], visible: [], files: false, front: false };

/** A folder you share (not a workspace), for the Share menu. */
export interface MyShare {
  readonly name: string;
  readonly root: string;
  readonly private?: boolean;
  readonly allowed?: readonly string[];
  /** Your Claude may edit files there (when friends ask it). */
  readonly writable?: boolean;
}

/**
 * Everything Beluga knows that isn't about a screen: the room, people, projects, conversations,
 * approvals… The core (the daemon) owns it and every client sees the same.
 */
export interface DomainState extends CollabState, WorkState, NetworkSlice, EarningsSlice, RevenueCatSlice, SupportSlice, ClaudeCodeSlice, GatewaySlice, BoardSlice, SentinelSlice, PlansSlice, DialoguesSlice, CompanionSlice, FriendShareSlice, TeamSlice {
  readonly room: string;
  readonly projects: readonly Project[];
  readonly projectGroups: readonly ProjectGroup[];
  /** The sidebar's top level in the order you arranged it: project roots and `group:<name>` (see workspaces/arrange.ts). */
  readonly projectOrder: readonly string[];
  /** Roots of projects you hid (still on disk), to show again. */
  readonly hiddenProjects: readonly string[];
  /** Needs-you items you dismissed without answering, by id (core/dismissed-needs.ts). */
  readonly dismissedNeeds: readonly string[];
  /** Files with merge conflicts from the last merge attempt, per workspace. */
  readonly conflicts: Readonly<Record<string, readonly string[]>>;
  readonly review?: ReviewDomain;
  /** Unread message counts per channel. */
  readonly unread: Readonly<Record<string, number>>;
  /** Shared folders you've already seen in Shared files (see shareKeys); others count as new. */
  readonly seenShares: readonly string[];
  /** Context usage per conversation (channel). */
  readonly context: Readonly<Record<string, ContextInfo>>;
  readonly compactions: Readonly<Record<string, Compaction>>;
  /** Side questions (/btw) per conversation, while they're open. */
  readonly btw: Readonly<Record<string, Btw>>;
  /** Env changes found in a worktree that's about to be archived or deleted. */
  readonly envChanges: Readonly<Record<string, readonly EnvChange[]>>;
  /** Worktrees whose env files changed and the main folder doesn't have it: copy it there, or keep it here (BLG-369). */
  readonly envAsks: Readonly<Record<string, readonly EnvChange[]>>;
  /** Worktrees made on your computers whose project lacks .env files this Mac has: send them? Names only, never on the phone (BLG-800). */
  readonly envSends: readonly EnvSendAsk[];
  /** Your computers' dev servers open on this Mac at localhost (BLG-802). */
  readonly forwards: readonly PortForward[];
  /** Ports of this Mac shared with worktrees on your computers, and which worktrees are on which computer (BLG-804). */
  readonly portShares: readonly PortShare[];
  readonly onComputers: Readonly<Record<string, string>>;
  readonly hosting?: Hosting;
  readonly invite?: string;
  /** Your peer id on this computer (known before the room answers). */
  readonly selfId: string;
  /** Your home folder on this computer (screens show paths under it as ~/…). */
  readonly home: string;
  /** You host the room (you can remove people, change the link, close it). */
  readonly isHost: boolean;
  /** The folders you share (not workspaces). */
  readonly myShares: readonly MyShare[];
  readonly attention: Attention;
  readonly status: ConnectionStatus;
  /** While the room can't be reached: what's happening and when the next try is (never in the log). */
  readonly connection?: ConnectionTrouble;
  readonly self?: PeerInfo;
  readonly peers: readonly PeerInfo[];
  readonly log: readonly LogItem[];
  readonly approvals: readonly Approval[];
  readonly browser: BrowserDomain;
  readonly viewer?: ViewerDomain;
  /** When each watched file was last written (fileKey), so a preview of it reads it again: a picture shows the new one. */
  readonly written: Readonly<Record<string, number>>;
  readonly follow?: string;
  readonly focus: Readonly<Record<string, Focus>>;
  /** Your default for people you haven't picked a trust level for. */
  readonly policy: Policy;
  /** Trust levels you picked per person (see core/trust.ts). */
  readonly levels: Readonly<Record<string, TrustLevel>>;
  /** How far each friend's requests may reach on this computer (default: shared folders only). */
  readonly access: Readonly<Record<string, 'folder' | 'full'>>;
  /** Directory listings used for /open autocomplete, keyed "owner:share/path". */
  readonly dirCache: Readonly<Record<string, readonly FsEntry[]>>;
  /** Recent downloads (newest last). */
  readonly transfers: readonly Transfer[];
  readonly prefs: Prefs;
  /** Saving power now: Low Power mode is on, always or on battery while on battery (core/power-saver.ts). */
  readonly powerSaving: boolean;
  /** Your Mac's chats, as tabs (BLG-102, core/assistant): which there are and the one open. */
  readonly assistant: AssistantChats;
  /** Each chat's category record, by channel (core/triage), for you only: it never leaves this computer. */
  readonly triage: Readonly<Record<string, ChatTriage>>;
}

/** What one screen shows: where it is, its tabs and dialogs, and its own cursors and scroll positions. */
export interface ScreenState {
  readonly view: View;
  /** Workspaces open as tabs, in order. */
  readonly tabs: readonly string[];
  readonly toast?: Toast;
  readonly overlay?: Overlay;
  /** The window is in the background. */
  readonly away: boolean;
  readonly browserCursor: number;
  readonly viewerScroll: number;
  readonly diffScroll: number;
  readonly searchCursor: number;
}

/** What a client draws: the shared state seen through its own screen (see client/screen.ts). */
export interface AppState extends Omit<DomainState, 'browser' | 'viewer' | 'review' | 'search'> {
  readonly view: View;
  readonly tabs: readonly string[];
  readonly toast?: Toast;
  readonly overlay?: Overlay;
  readonly away: boolean;
  readonly browser: BrowserState;
  readonly viewer?: ViewerState;
  readonly review?: ReviewState;
  readonly search: SearchState & { readonly cursor: number };
}

/** The room is out of reach: retrying (attempt and next try) or offline for good. */
export interface ConnectionTrouble {
  readonly state: 'reconnecting' | 'offline';
  /** Failed tries in a row. */
  readonly attempt: number;
  /** When the next try starts (ms since the epoch); none when offline. */
  readonly retryAt?: number;
  readonly reason: string;
  /** When this outage began. */
  readonly since: number;
}

export type Action =
  | { type: 'status'; status: ConnectionStatus }
  /** Leave out `connection` when you're connected again. */
  | { type: 'connection'; connection?: ConnectionTrouble }
  | { type: 'invite'; invite: string }
  | { type: 'room'; room: string }
  | { type: 'hosting'; hosting: Hosting }
  | { type: 'welcome'; self: PeerInfo }
  | { type: 'peers'; peers: readonly PeerInfo[] }
  | { type: 'chat'; id: string; from: string; text: string; ts: number; byAgent: boolean; channel?: string; request?: string; steer?: true; queued?: true; agent?: AgentRef; via?: MessageVia; dialogue?: DialogueMark }
  | ChatReactAction
  /** `id`/`ts` are stamped before reducing (see stampAction). */
  | { type: 'system'; text: string; level?: 'info' | 'warn' | 'error'; channel?: string; id?: string; ts?: number; said?: SaidBy; shipped?: ShippedMark; merged?: MergedMark; dialogue?: DialogueMark }
  | { type: 'shell'; item: ShellItem }
  /** `itemId` (stamped before reducing) names the chat item a new run creates. */
  | { type: 'agent_event'; owner: string; requestId: string; requester: string; event: AgentEventKind; text: string; ts: number; channel?: string; itemId?: string; slotWait?: SlotWait; agent?: AgentRef; via?: MessageVia }
  /** One owner's waiting requests in a conversation, in their new order (see orderQueued). */
  | { type: 'queue_order'; owner: string; ids: readonly string[] }
  | { type: 'projects'; projects: readonly Project[]; groups?: readonly ProjectGroup[]; order?: readonly string[]; hidden?: readonly string[] }
  | { type: 'conflicts'; id: string; files: readonly string[] }
  | { type: 'review'; review?: ReviewDomain }
  | { type: 'history'; channel: string; items: readonly LogItem[] }
  /** Items put into a conversation as they come (the agent's terminal turns, BLG-534): each replaces the one with its id, else goes at the end. */
  | { type: 'log_upsert'; channel: string; items: readonly LogItem[] }
  /** klaud is stopping: `owner`'s runs that haven't ended (their end won't come now) are interrupted. */
  | { type: 'runs_interrupted'; owner: string }
  | { type: 'env_changes'; id: string; changes: readonly EnvChange[] }
  | { type: 'env_asks'; asks: Readonly<Record<string, readonly EnvChange[]>> }
  | { type: 'env_sends'; asks: readonly EnvSendAsk[] }
  | { type: 'forwards'; forwards: readonly PortForward[] }
  | { type: 'port_shares'; shares: readonly PortShare[]; onComputers: Readonly<Record<string, string>> }
  | { type: 'approval_add'; approval: Approval }
  | { type: 'approval_remove'; id: string }
  | { type: 'browser_root' }
  | { type: 'browser_loading'; at: Location }
  | { type: 'browser_entries'; at: Location; entries: readonly FsEntry[] }
  | { type: 'browser_error'; error: string }
  | { type: 'viewer_open'; at: Location; by?: string }
  | { type: 'viewer_content'; at: Location; content: string; truncated: boolean; next?: number; total?: number }
  | { type: 'viewer_image'; at: Location; image: Bitmap }
  | { type: 'viewer_error'; at: Location; error: string }
  | { type: 'viewer_close' }
  /** A watched file was written again (fs_changed). */
  | { type: 'file_written'; at: Location; ts: number }
  | { type: 'focus'; actorKey: string; focus: Focus }
  | { type: 'follow'; peerId?: string }
  | { type: 'policy'; policy: Policy }
  | { type: 'trust'; peerId: string; trusted: boolean }
  | { type: 'full_trust'; peerId: string; trusted: boolean }
  | { type: 'trust_level'; peerId: string; level?: TrustLevel }
  | { type: 'access'; peerId: string; scope: 'folder' | 'full' }
  | { type: 'dir_cache'; key: string; entries: readonly FsEntry[] }
  | { type: 'transfer'; transfer: Transfer }
  | { type: 'prefs'; prefs: { readonly [K in keyof Prefs]?: Prefs[K] | null } }
  | { type: 'power_saving'; on: boolean }
  | { type: 'clear'; channel: string }
  | { type: 'context_reset'; channel: string }
  /** A conversation's side question (/btw) changed; none: it was closed. */
  | { type: 'btw'; channel: string; btw?: Btw }
  /** What the attached screens look at changed (see core/attention.ts). */
  | { type: 'attention'; attention: Attention }
  | { type: 'my_shares'; shares: readonly MyShare[] }
  | { type: 'identity'; selfId: string; isHost: boolean; home?: string }
  /** Your paired phones (never keys) and the pairing open now (src/companion/host.ts). */
  | { type: 'companion'; companion: CompanionSlice['companion'] }
  /** Your Mac's chats changed (one made, opened or deleted; core/assistant). */
  | { type: 'assistant_chats'; assistant: AssistantChats }
  /** The needs-you items you dismissed (all of them: on start, and after a Dismiss). */
  | { type: 'needs_dismissed'; ids: readonly string[] }
  /** One chat's category record changed (none: removed). `read`: the conversations whose unread count clears too (you settled it). */
  | { type: 'triage_set'; channel: string; record?: ChatTriage; read?: readonly string[] }
  | CollabAction
  | WorkAction
  | NetworkAction
  | EarningsAction
  | RevenueCatAction
  | ClaudeCodeAction
  | GatewayAction
  | FriendShareAction
  | BoardAction
  | SentinelAction
  | PlansAction
  | DialoguesAction
  | TeamAction
  | SupportAction;

const LOG_LIMIT = 1000;
const TRANSFER_LIMIT = 20;

/** Strip terminal control sequences from peer-supplied text (keeps newlines and tabs). */
// eslint-disable-next-line no-control-regex
/** Strip control characters (terminal escapes) and invisible bidi/zero-width marks from remote text. */
export const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200D\u202A-\u202E\u2066-\u2069]/g, '');

/** A client picks an agent's name and the wire allows line breaks: on one line, so it can't forge lines in a card or a prompt. */
export const viaName = (via: { readonly name: string }): string => clean(via.name).replace(/\s+/g, ' ').trim() || 'An external agent';
/** A friend's request from their agent: you trust the friend, and you see who is behind it. */
export const viaRequester = (owner: string, via: { readonly name: string }): string => `${owner} (via ${viaName(via)})`;
const MAX_STEPS = 6;
/** What a card keeps of what Claude said between its steps (the newest). */
const MAX_REMARKS = 40;

export const DEFAULT_PREFS: Prefs = {
  theme: 'calm',
  mouse: true,
  tunnel: 'auto',
  keepAwake: 'off',
  runOn: 'here',
  lowPower: 'off',
  selfApproval: 'never',
  notify: NotifySchema.parse({}),
  openModels: [],
  autoSetup: true,
  branchPrefix: BRANCH_PREFIX_DEFAULT,
  contextMeter: true,
  autoCompact: false,
  autoCompactAt: AUTO_COMPACT_DEFAULT,
  autoContinue: true,
  autoContinueOff: [],
  autoContinueSkip: 0,
  parallelRuns: PARALLEL_RUNS_DEFAULT,
  chatLimit: CHAT_LIMIT_DEFAULT,
  agentThreads: false,
  threadLimits: THREAD_LIMITS_DEFAULT,
  chatCategories: false,
  settleOnMerge: true,
  settleIdleDays: SETTLE_IDLE_DAYS_DEFAULT,
  pushToPr: true,
  scratchFolder: true,
  experiments: [],
  subagents: 'full',
  hiddenButtons: [],
  friendWorktrees: 'ask',
  chatClaude: 'everyone',
  shareUsage: 'trusted',
  readReceipts: true,
  shellLogin: true,
  shellArgs: [],
  claudeArgs: [],
  codexArgs: [],
};

/** The preference fields out of saved settings. */
export function prefsFrom(settings: Partial<Settings>): Prefs {
  const picked = Object.fromEntries(Object.keys(DEFAULT_PREFS).concat(['model', 'effort', 'defaultAgent', 'projectAgents', 'shell', 'earningsCurrency']).filter((k) => settings[k as keyof Settings] !== undefined).map((k) => [k, settings[k as keyof Settings]]));
  return { ...DEFAULT_PREFS, ...picked };
}

export function initialState(room: string, policy: Policy = 'ask', prefs: Partial<Prefs> = DEFAULT_PREFS): DomainState {
  return {
    room,
    projects: [],
    projectGroups: [],
    projectOrder: [],
    hiddenProjects: [],
    dismissedNeeds: [],
    conflicts: {},
    unread: {},
    seenShares: [],
    context: {},
    compactions: {},
    btw: {},
    envChanges: {},
    envAsks: {},
    envSends: [],
    forwards: [],
    portShares: [],
    onComputers: {},
    status: 'connecting',
    peers: [],
    log: [],
    approvals: [],
    browser: { rows: [], loading: false },
    written: {},
    focus: {},
    policy,
    levels: {},
    access: {},
    dirCache: {},
    transfers: [],
    prefs: { ...DEFAULT_PREFS, ...prefs },
    powerSaving: (prefs.lowPower ?? DEFAULT_PREFS.lowPower) === 'always',
    selfId: '',
    home: '',
    isHost: false,
    myShares: [],
    attention: NO_ATTENTION,
    ...initialCollab,
    ...initialWork,
    ...initialNetwork,
    ...initialEarnings,
    ...initialRevenueCat,
    ...initialSupport,
    ...initialClaudeCode,
    ...initialGateway,
    ...initialFriendShare,
    ...initialBoard,
    ...initialSentinel,
    ...initialPlans,
    ...initialDialogues,
    ...initialTeam,
    companion: { devices: [] },
    assistant: NO_ASSISTANT_CHATS,
    triage: {},
  };
}

let seq = 0;
const nextId = (): string => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Fill in what an action needs from the clock or a counter (ids, timestamps), so reducing it
 * is pure: the same state and stamped action always give the same result. The daemon stamps
 * once and every client replays the same stamped action. Already stamped actions come back as is.
 */
export function stampAction<A extends Action>(action: A): A {
  switch (action.type) {
    case 'system':
      return action.id !== undefined && action.ts !== undefined ? action : { ...action, id: action.id ?? nextId(), ts: action.ts ?? Date.now() };
    case 'agent_event':
      return action.itemId !== undefined ? action : { ...action, itemId: nextId() };
    case 'notice_add':
      return action.ts !== undefined ? action : { ...action, ts: Date.now() };
    default:
      return action;
  }
}

/** Someone's name: in the room, yourself, a friend, or someone in a project a friend shared with you. */
export const peerName = (state: Pick<DomainState, 'peers' | 'self'> & { readonly network?: Pick<DomainState['network'], 'friends'>; readonly sharedProjects?: DomainState['sharedProjects']; readonly remembered?: DomainState['remembered'] }, peerId: string): string =>
  state.peers.find((p) => p.peerId === peerId)?.name ??
  (state.self?.peerId === peerId
    ? state.self.name
    : (state.network?.friends.find((f) => f.peerId === peerId)?.name ?? state.sharedProjects?.flatMap((p) => p.members).find((m) => m.peerId === peerId)?.name ?? state.remembered?.[peerId]?.name ?? peerId.slice(0, 6)));

/** One file, wherever it is: the key `written` is kept by. */
export const fileKey = (at: Location): string => `${at.owner}\0${at.share}\0${at.path}`;

/** How many files' last writes are kept (the most recent; as many as are watched). */
export const WRITTEN_LIMIT = 200;

function noteWritten(written: Readonly<Record<string, number>>, key: string, ts: number): Readonly<Record<string, number>> {
  const { [key]: _old, ...rest } = written;
  const kept = Object.entries(rest).slice(-(WRITTEN_LIMIT - 1));
  return { ...Object.fromEntries(kept), [key]: ts };
}

const sameLoc = (a: Location | undefined, b: Location): boolean =>
  Boolean(a) && a?.owner === b.owner && a.share === b.share && a.path === b.path;

/** Append, keeping at most LOG_LIMIT items per conversation (never trimming other conversations). */
function appendLog(log: readonly LogItem[], item: LogItem): readonly LogItem[] {
  const next = [...log, item];
  const inChannel = next.filter((l) => l.channel === item.channel).length;
  if (inChannel <= LOG_LIMIT) return next;
  const drop = next.findIndex((l) => l.channel === item.channel);
  return next.filter((_l, i) => i !== drop);
}

/**
 * Every folder you can open, grouped by whose it is: what friends share with you over the network,
 * what people in the room share (with everyone, or just you), and workspaces a room invited you into.
 * Worktrees friends share over the network are projects, not folders: they're in Projects.
 */
function rootRows(state: DomainState): BrowserRow[] {
  const name = (id: string) => state.peers.find((p) => p.peerId === id)?.name ?? state.network.friends.find((f) => f.peerId === id)?.name ?? 'someone';
  const friends = state.friendFolders.map((f) => ({ label: `${f.ownerName} · ${f.label}${f.writable ? '' : ' (read-only)'}`, dir: true, target: { owner: f.owner, share: f.name, path: '' }, group: f.ownerName }));
  const room = state.peers.flatMap((p) =>
    p.shares.map((s) => ({ label: `${p.name} · ${s.name}${s.writable ? '' : ' (read-only)'}`, dir: true, target: { owner: p.peerId, share: s.name, path: '' }, group: p.name })),
  );
  const offers = state.offers.map((o) => ({ label: `${name(o.owner)} · ${o.name} (shared with you)`, dir: true, target: { owner: o.owner, share: o.name, path: '' }, group: name(o.owner) }));
  const workspaces = state.shared.filter((w) => w.via !== 'mesh').map((w) => ({ label: `${name(w.owner)} · ${w.name} (workspace)`, dir: true, target: { owner: w.owner, share: w.share, path: '' }, group: name(w.owner) }));
  const seen = new Set<string>();
  const all = [...friends, ...room, ...offers, ...workspaces].filter((r) => !seen.has(`${r.target.owner}/${r.target.share}`) && Boolean(seen.add(`${r.target.owner}/${r.target.share}`)));
  // One person's folders together, in the order people first appear.
  const order = [...new Set(all.map((r) => r.group))];
  return all.map((r, i) => ({ r, i })).sort((a, b) => order.indexOf(a.r.group) - order.indexOf(b.r.group) || a.i - b.i).map(({ r }) => r);
}

/** One key per folder listed at the top of Shared files (to tell which ones are new). */
export function shareKeys(state: Pick<DomainState, 'peers' | 'offers' | 'shared' | 'self' | 'friendFolders'>): string[] {
  return [
    ...state.friendFolders.map((f) => `${f.owner}/${f.name}`),
    ...state.peers.filter((p) => p.peerId !== state.self?.peerId).flatMap((p) => p.shares.map((s) => `${p.peerId}/${s.name}`)),
    ...state.offers.map((o) => `${o.owner}/${o.name}`),
    ...state.shared.filter((w) => w.via !== 'mesh').map((w) => `${w.owner}/${w.share}`),
  ];
}

/** Folders shared since you last looked at Shared files (0 while you're there). */
export function newShares(state: AppState): number {
  if (state.view.kind === 'files') return 0;
  const seen = new Set(state.seenShares);
  return new Set(shareKeys(state).filter((k) => !seen.has(k))).size;
}

/**
 * Put one owner's waiting requests in the order given, each in a place one of them already
 * takes in the log (so the chat reads in the order Claude will run them). Unchanged if any is missing.
 */
export function orderQueued(log: readonly LogItem[], owner: string, ids: readonly string[]): readonly LogItem[] {
  const wanted = new Set(ids);
  const slots = log.flatMap((l, i) => (l.type === 'agent' && l.owner === owner && wanted.has(l.requestId) ? [i] : []));
  if (slots.length !== ids.length) return log;
  const byId = new Map(slots.map((i) => [(log[i] as Extract<LogItem, { type: 'agent' }>).requestId, log[i]!]));
  const placed = new Map(slots.map((slot, k) => [slot, byId.get(ids[k]!)!]));
  return slots.every((slot) => placed.get(slot) === log[slot]) ? log : log.map((l, i) => placed.get(i) ?? l);
}

function reduceAgent(state: DomainState, raw: Extract<Action, { type: 'agent_event' }>): DomainState {
  const a = { ...raw, text: clean(raw.text) };
  const idx = state.log.findIndex((l) => l.type === 'agent' && l.requestId === a.requestId && l.owner === a.owner);
  const existing = idx >= 0 ? (state.log[idx] as Extract<LogItem, { type: 'agent' }>) : undefined;
  const base = existing ?? {
    id: a.itemId ?? `${a.owner}:${a.requestId}`,
    type: 'agent' as const,
    requestId: a.requestId,
    owner: a.owner,
    ownerName: peerName(state, a.owner),
    requesterName: !a.via ? peerName(state, a.requester) : isExternalRequester(a.requester) || (a.requester === a.owner && a.via.creationSource === 'mcp') ? viaName(a.via) : viaRequester(peerName(state, a.requester), a.via),
    requester: a.requester,
    status: a.event,
    text: '',
    steps: [],
    subagents: [],
    channel: a.channel ?? 'room',
    ts: a.ts,
  };
  // A new step starts with no count; a count says how far the step it's on has got.
  // Waiting for a free Claude lasts until anything else is said about it (it starts, goes back in line, is dropped).
  const { progress: was, between: wasBetween, betweenAt: wasAt, slotWait: _slot, ...rest } = base as typeof base & { progress?: string; between?: 'thinking' | 'writing'; betweenAt?: number; slotWait?: SlotWait };
  const progress = a.event === 'progress' ? a.text.slice(0, 40) : a.event === 'tool' || a.event === 'done' || a.event === 'error' ? undefined : was;
  // What it does after its step: a turn starting or an empty progress (the step's tools returned) is thinking, words are writing; a step (or its count) ends that.
  // A sub-agent it launched still at work keeps it in its step (an older runner says its tools returned while one runs).
  const subOpen = base.subagents.some((sub) => sub.status === 'running' && sub.kind !== 'background');
  const between = a.event === 'started' || (a.event === 'progress' && !a.text && !subOpen) ? 'thinking' : a.event === 'text' ? 'writing' : a.event === 'tool' || a.event === 'progress' ? undefined : wasBetween;
  const betweenAt = between === undefined ? undefined : between === wasBetween && wasAt !== undefined ? wasAt : a.ts;
  const noted = base.text === READS_AFTER_STEP || base.text === STOPPING_FOR;
  const subagents = a.event === 'sub' ? applySub(base.subagents, a.text, a.ts) : a.event === 'done' || a.event === 'error' ? base.subagents.map((s) => (s.status === 'running' ? { ...s, status: 'done' as const } : s)) : base.subagents;
  // A step after its words (a tool, a sub-agent starting) makes them something it said on the way, not its answer.
  const stepped = a.event === 'tool' || subagents.length > base.subagents.length;
  const remark = stepped && base.text && !noted ? { text: base.text, ts: wasBetween === 'writing' && wasAt !== undefined ? wasAt : a.ts } : undefined;
  const updated = {
    ...rest,
    ...(progress ? { progress } : {}),
    ...(between ? { between, betweenAt } : {}),
    ...(remark ? { remarks: [...(base.remarks ?? []), remark].slice(-MAX_REMARKS) } : {}),
    status: a.event === 'text' || a.event === 'tool' || a.event === 'sub' || a.event === 'progress' ? 'started' : a.event,
    // The run ended: ones still running end with it; one that failed or was stopped stays so.
    subagents,
    text:
      // A steered message's note ("reads this after its current step") isn't Claude's words: its own turn starting (or going back in line) ends it, a newer note replaces it.
      noted && (a.event === 'started' || a.event === 'text' || a.event === 'queued')
        ? a.event === 'text' ? a.text : ''
        : remark
          ? ''
          : // Each thing Claude says between steps is its own paragraph (one newline would run them into one blob).
            a.event === 'text'
            ? (base.text ? `${base.text}\n\n` : '') + a.text
            : a.event === 'done' || a.event === 'error' || a.event === 'denied'
              ? a.text || base.text
              : base.text,
    steps: a.event === 'tool' ? [...base.steps, a.text].slice(-MAX_STEPS) : base.steps,
    endTs: a.event === 'done' || a.event === 'error' || a.event === 'denied' ? a.ts : base.endTs,
    ...(a.event === 'started' || a.event === 'text' || a.event === 'tool' || a.event === 'sub' || a.event === 'progress' ? { lastAt: a.ts } : {}),
    ...(a.event === 'tool' ? { stepAt: a.ts } : {}),
    ...(a.event === 'queued' && a.text ? { prompt: a.text } : {}),
    ...(a.event === 'queued' && a.slotWait ? { slotWait: a.slotWait } : {}),
    ...(existing?.status === 'queued' && a.event !== 'queued' ? { queuedUntil: a.ts } : {}),
    // Any event may name the agent (the first one an older card saw may not have).
    ...(a.agent ? { agent: a.agent } : {}),
  } satisfies LogItem;
  const log = existing ? state.log.map((l, i) => (i === idx ? updated : l)) : appendLog(state.log, updated);
  // A new message, or a run in a workspace finishing while no screen shows it (Claude's answer is news).
  const finished = Boolean(existing) && updated.channel.startsWith('ws:') && (updated.status === 'done' || updated.status === 'error') && existing?.status !== 'done' && existing?.status !== 'error';
  return bumpUnread({ ...state, log }, updated.channel, !existing || finished);
}

/** Context meter updates and compactions: the meter's numbers, and a divider where Claude compacted (see context-log.ts). */
function reduceContext(state: DomainState, a: Extract<Action, { type: 'agent_event' }>): DomainState {
  const data = parseContextEvent(a.text);
  if (!data || (a.event !== 'context' && a.event !== 'compact')) return state;
  return applyContextEvent(state, { event: a.event, channel: a.channel ?? 'room', id: a.itemId ?? a.requestId, ts: a.ts, data }, appendLog);
}

export const formatTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Apply one sub-agent event (JSON from the runner) to the list. */
function applySub(list: readonly SubAgent[], json: string, ts: number): readonly SubAgent[] {
  let e: { id?: string; phase?: string; title?: string; step?: string; kind?: 'agent' | 'background'; failed?: boolean };
  try {
    e = JSON.parse(json) as typeof e;
  } catch {
    return list;
  }
  if (!e.id) return list;
  const existing = list.find((s) => s.id === e.id);
  if (e.phase === 'start' && !existing) return [...list, { id: e.id, title: e.title ?? 'sub-agent', steps: [], status: 'running', kind: e.kind ?? 'agent', startedAt: ts }];
  return list.map((s) => {
    if (s.id !== e.id) return s;
    if (e.phase === 'step' && e.step) return { ...s, steps: [...s.steps, e.step].slice(-MAX_STEPS) };
    if (e.phase === 'done') return { ...s, status: e.failed ? 'failed' : 'done', steps: e.step ? [...s.steps, e.step].slice(-MAX_STEPS) : s.steps };
    return s;
  });
}

/** Count new messages in conversations no screen is showing. */
function bumpUnread(state: DomainState, channel: string, isNew: boolean): DomainState {
  if (!isNew || state.attention.shown.includes(channel)) return state;
  return { ...state, unread: { ...state.unread, [channel]: (state.unread[channel] ?? 0) + 1 } };
}

/** A Claude Code session in one of your workspaces stopped working (its turn ended): unread there, unless it's shown. */
function ccFinished(prev: DomainState, next: DomainState): DomainState {
  const was = new Set(prev.claudeCode.sessions.filter((x) => x.status === 'working' && !x.own).map((x) => x.id));
  return next.claudeCode.sessions.reduce((st, x) => (x.workspaceId && was.has(x.id) && x.status !== 'working' ? bumpUnread(st, `ws:${x.workspaceId}`, true) : st), next);
}

/** Apply an action: stamps it first (see stampAction), then reduces it purely. */
export function reduce(state: DomainState, action: Action): DomainState {
  return reduceDomain(state, stampAction(action));
}

/** Screens just started showing these: what's there is no longer unread or new. */
function attend(state: DomainState, attention: Attention): DomainState {
  const fresh = attention.shown.filter((c) => !state.attention.shown.includes(c));
  const unread = Object.fromEntries(Object.entries(state.unread).filter(([c]) => !fresh.includes(c)));
  // Opening (or leaving) Shared files counts every folder there as seen.
  const seenShares = attention.files !== state.attention.files ? shareKeys(state) : state.seenShares;
  return { ...state, attention, unread, seenShares, triage: withoutBack(state, fresh) };
}

/** Opening a chat that woke from a snooze ends its Back state. `triage` is absent in a snapshot from an older daemon. */
function withoutBack(state: DomainState, opened: readonly string[]): DomainState['triage'] {
  const keys = new Set(opened.map((c) => triageKey(state, c)));
  const back = Object.entries(state.triage ?? {}).filter(([key, record]) => record.backAt !== undefined && keys.has(key));
  if (!back.length) return state.triage;
  return { ...state.triage, ...Object.fromEntries(back.map(([key, { backAt: _gone, ...record }]) => [key, record])) };
}

/** The reducer itself: pure for stamped actions (no clock, no counters). */
export function reduceDomain<S extends DomainState>(state: S, action: Action): S;
export function reduceDomain(state: DomainState, action: Action): DomainState {
  switch (action.type) {
    case 'status':
      return { ...state, status: action.status };
    case 'connection': {
      const { connection: _gone, ...rest } = state;
      return action.connection ? { ...state, connection: action.connection } : rest;
    }
    case 'invite':
      return { ...state, invite: action.invite };
    case 'room':
      return { ...state, room: clean(action.room) };
    case 'hosting':
      return { ...state, hosting: action.hosting };
    case 'welcome':
      return { ...state, self: action.self };
    case 'peers': {
      const browser = state.browser.at ? state.browser : { ...state.browser, rows: rootRows({ ...state, peers: action.peers }) };
      const ids = new Set(action.peers.map((p) => p.peerId));
      const follow = state.follow && ids.has(state.follow) ? state.follow : undefined;
      // Trust is re-applied from your saved choices when someone comes back (see Session).
      const levels = Object.fromEntries(Object.entries(state.levels).filter(([id]) => ids.has(id)));
      const access = Object.fromEntries(Object.entries(state.access).filter(([id]) => ids.has(id)));
      return { ...state, peers: action.peers, browser, follow, levels, access };
    }
    case 'chat':
      return bumpUnread({
        ...state,
        log: appendLog(state.log, {
          id: action.id,
          type: 'chat',
          channel: action.channel ?? 'room',
          from: action.from,
          name: peerName(state, action.from) + (action.byAgent ? `'s ${agentName(action.agent)}` : ''),
          text: clean(action.text),
          ts: action.ts,
          byAgent: action.byAgent,
          ...(action.byAgent && action.agent ? { agent: action.agent } : {}),
          ...(action.via ? { via: action.via } : {}),
          ...(action.request ? { request: action.request } : {}),
          ...(action.steer ? { steer: true as const } : {}),
          ...(action.queued ? { queued: true as const } : {}),
          ...(action.dialogue ? { dialogue: action.dialogue } : {}),
        }),
      }, action.channel ?? 'room', true);
    case 'chat_react': {
      const log = reactOnLog(state.log, action);
      return log === state.log ? state : { ...state, log };
    }
    case 'system':
      return {
        ...state,
        log: appendLog(state.log, { id: action.id ?? '', type: 'system', channel: action.channel ?? 'room', text: clean(action.text), ts: action.ts ?? 0, level: action.level ?? 'info', ...(action.said ? { said: action.said } : {}), ...(action.shipped ? { shipped: action.shipped } : {}), ...(action.merged ? { merged: action.merged } : {}), ...(action.dialogue ? { dialogue: action.dialogue } : {}) }),
      };
    case 'conflicts': {
      const { [action.id]: _old, ...rest } = state.conflicts;
      return { ...state, conflicts: action.files.length ? { ...rest, [action.id]: action.files } : rest };
    }
    case 'projects':
      return { ...state, projects: action.projects, projectGroups: action.groups ?? state.projectGroups, projectOrder: action.order ?? state.projectOrder, hiddenProjects: action.hidden ?? state.hiddenProjects };
    case 'attention':
      return attend(state, action.attention);
    case 'my_shares':
      return { ...state, myShares: action.shares };
    case 'companion':
      return { ...state, companion: action.companion };
    case 'identity':
      return state.selfId === action.selfId && state.isHost === action.isHost && state.home === (action.home ?? state.home) ? state : { ...state, selfId: action.selfId, isHost: action.isHost, home: action.home ?? state.home };
    case 'review':
      return { ...state, review: action.review };
    case 'env_changes':
      return { ...state, envChanges: { ...state.envChanges, [action.id]: action.changes } };
    case 'env_asks':
      return { ...state, envAsks: action.asks };
    case 'env_sends':
      return { ...state, envSends: action.asks };
    case 'forwards':
      return { ...state, forwards: action.forwards };
    case 'port_shares':
      return { ...state, portShares: action.shares, onComputers: action.onComputers };
    case 'runs_interrupted': {
      const log = state.log.map((l) => (l.type === 'agent' && l.owner === action.owner ? settleRun(l) : l));
      return log.every((l, i) => l === state.log[i]) ? state : { ...state, log };
    }
    case 'history': {
      const others = state.log.filter((l) => l.channel !== action.channel);
      return { ...state, log: [...action.items.slice(-LOG_LIMIT).map((i) => ({ ...i, channel: action.channel })), ...others] };
    }
    case 'log_upsert': {
      let log = state.log;
      for (const raw of action.items) {
        const item = { ...raw, channel: action.channel } as LogItem;
        const idx = log.findIndex((l) => l.id === item.id && l.channel === action.channel);
        if (idx < 0) log = appendLog(log, item);
        else if (JSON.stringify(log[idx]) !== JSON.stringify(item)) log = log.map((l, i) => (i === idx ? item : l));
      }
      return log === state.log ? state : { ...state, log };
    }
    case 'shell': {
      const item = { ...action.item, command: clean(action.item.command), output: clean(action.item.output), ...(action.item.cwd ? { cwd: clean(action.item.cwd) } : {}), ...(action.item.error ? { error: clean(action.item.error) } : {}) };
      const idx = state.log.findIndex((l) => l.id === item.id);
      if (idx >= 0) return { ...state, log: state.log.map((l, i) => (i === idx ? item : l)) };
      return bumpUnread({ ...state, log: appendLog(state.log, item) }, item.channel, true);
    }
    case 'agent_event':
      if (action.event === 'usage') return state;
      if (action.event === 'context' || action.event === 'compact') return reduceContext(state, action);
      return reduceAgent(state, action);
    case 'approval_add':
      return {
        ...state,
        approvals: [...state.approvals, { ...action.approval, title: clean(action.approval.title), detail: clean(action.approval.detail) }],
      };
    case 'approval_remove':
      return { ...state, approvals: state.approvals.filter((a) => a.id !== action.id) };
    case 'browser_root':
      return { ...state, browser: { rows: rootRows(state), loading: false } };
    case 'browser_loading':
      return { ...state, browser: { ...state.browser, at: action.at, loading: true, error: undefined } };
    case 'browser_entries': {
      if (!sameLoc(state.browser.at, action.at)) return state;
      const rows: BrowserRow[] = [
        { label: '..', dir: true, target: 'up' },
        ...action.entries.map((e) => ({
          label: e.name,
          dir: e.dir,
          size: e.size,
          target: { ...action.at, path: action.at.path ? `${action.at.path}/${e.name}` : e.name },
        })),
      ];
      return { ...state, browser: { at: action.at, rows, loading: false } };
    }
    case 'browser_error':
      return { ...state, browser: { ...state.browser, loading: false, error: action.error } };
    case 'viewer_open': {
      const keep = sameLoc(state.viewer, action.at) ? state.viewer : undefined;
      return {
        ...state,
        viewer: { ...action.at, content: keep?.content ?? '', truncated: keep?.truncated ?? false, loading: true, by: action.by },
      };
    }
    case 'viewer_image':
      if (!state.viewer || !sameLoc(state.viewer, action.at)) return state;
      return { ...state, viewer: { ...state.viewer, image: action.image, content: '', truncated: false, loading: false, error: undefined } };
    case 'viewer_content':
      if (!state.viewer || !sameLoc(state.viewer, action.at)) return state;
      return { ...state, viewer: { ...state.viewer, content: clean(action.content), truncated: action.truncated, next: action.next, total: action.total, loading: false, error: undefined } };
    case 'viewer_error':
      if (!state.viewer || !sameLoc(state.viewer, action.at)) return state;
      return { ...state, viewer: { ...state.viewer, loading: false, error: action.error } };
    case 'viewer_close':
      return { ...state, viewer: undefined };
    case 'file_written':
      return { ...state, written: noteWritten(state.written, fileKey(action.at), action.ts) };
    case 'focus':
      return { ...state, focus: { ...state.focus, [action.actorKey]: action.focus } };
    case 'follow':
      return { ...state, follow: action.peerId };
    case 'full_trust':
      // Taking back full trust only changes someone who had it.
      if (!action.trusted && state.levels[action.peerId] !== 'full') return state;
      return reduceDomain(state, { type: 'trust_level', peerId: action.peerId, level: action.trusted ? 'full' : 'ask' });
    case 'trust_level': {
      const { [action.peerId]: _old, ...rest } = state.levels;
      return { ...state, levels: action.level ? { ...rest, [action.peerId]: action.level } : rest };
    }
    case 'access':
      return { ...state, access: { ...state.access, [action.peerId]: action.scope } };
    case 'policy':
      return { ...state, policy: action.policy };
    case 'trust':
      if (!action.trusted && state.levels[action.peerId] !== 'trusted') return state;
      return reduceDomain(state, { type: 'trust_level', peerId: action.peerId, level: action.trusted ? (state.levels[action.peerId] === 'full' ? 'full' : 'trusted') : 'ask' });
    case 'power_saving':
      return state.powerSaving === action.on ? state : { ...state, powerSaving: action.on };
    case 'prefs': {
      // A null clears a preference back to its default (an unset value can't travel as JSON).
      const prefs: Record<string, unknown> = { ...state.prefs };
      for (const [key, value] of Object.entries(action.prefs)) {
        if (value === null) delete prefs[key];
        else if (value !== undefined) prefs[key] = value;
      }
      return { ...state, prefs: prefs as unknown as Prefs };
    }
    case 'transfer': {
      const others = state.transfers.filter((t) => t.id !== action.transfer.id);
      return { ...state, transfers: [...others, action.transfer].slice(-TRANSFER_LIMIT) };
    }
    case 'dir_cache':
      return { ...state, dirCache: { ...state.dirCache, [action.key]: action.entries } };
    case 'clear':
      return { ...state, log: state.log.filter((l) => l.channel !== action.channel) };
    case 'question_add':
    case 'question_pick':
    case 'question_remove':
    case 'room_open':
    case 'shared_add':
    case 'shared_remove':
    case 'member_set':
    case 'roster':
    case 'plan_mode':
    case 'peer_gone':
    case 'shared_clear':
    case 'trust_prompt':
    case 'granted':
    case 'link_set':
    case 'link_remove':
    case 'guest_set':
    case 'knock':
    case 'guest_shell':
    case 'offer': {
      const next = { ...state, ...reduceCollab(state, action) };
      // The Shared files list updates live while you're looking at it.
      return next.browser.at ? next : { ...next, browser: { ...next.browser, rows: rootRows(next) } };
    }
    case 'notice_add':
    case 'notice_read':
    case 'notice_unread':
    case 'notice_clear':
    case 'models':
    // Which agents run here and their models (BLG-462: dropped before, so Codex stayed greyed in the picker).
    case 'runtimes':
    case 'disk':
    case 'archiving':
    case 'pr':
    case 'setup':
    case 'search':
    case 'templates':
    case 'terminal':
    case 'terminal_exit':
    case 'terminal_name':
    case 'terminal_env_stale':
    case 'agent_term':
    case 'term_visuals':
    case 'shell_choices':
    case 'env_keys':
    case 'pr_custom':
    case 'gh':
    case 'remembered':
      return { ...state, ...reduceWork(state, action) };
    case 'net_summary':
    case 'net_message':
    case 'net_messages':
    case 'net_unsent':
    case 'net_reacted':
    case 'net_cleared':
    case 'net_files':
    case 'net_live':
    case 'net_main':
    case 'net_offer':
    case 'net_offer_gone':
    case 'net_calls':
    case 'net_call_notes':
    case 'net_missed_calls':
    case 'net_off':
    case 'net_mirror':
      return { ...state, ...reduceNetwork(state, action) };
    case 'support':
      return { ...state, support: action.support };
    case 'assistant_chats':
      return { ...state, assistant: action.assistant };
    case 'needs_dismissed':
      return { ...state, dismissedNeeds: action.ids };
    case 'triage_set':
      return reduceTriage(state, action);
    case 'btw': {
      const { [action.channel]: _gone, ...rest } = state.btw ?? {};
      return { ...state, btw: action.btw ? { ...rest, [action.channel]: action.btw } : rest };
    }
    case 'earnings':
    case 'fx_rates':
      return { ...state, ...reduceEarnings(state, action) };
    case 'revenuecat':
      return { ...state, ...reduceRevenueCat(state, action) };
    case 'claude_code':
    case 'codex_sessions':
      return ccFinished(state, { ...state, ...reduceClaudeCode(state, action) });
    case 'agent_origins':
      return { ...state, ...reduceClaudeCode(state, action) };
    case 'gw_init':
    case 'gw_task':
    case 'gw_forget':
    case 'gw_card':
    case 'gw_note':
    case 'gw_rules':
    case 'gw_caps':
    case 'gw_freely':
    case 'gw_off':
      return { ...state, ...reduceGateway(state, action) };
    case 'fshare_folders': {
      // The top of Files updates live while you're looking at it.
      const next = { ...state, ...reduceFriendShare(state, action) };
      return next.browser.at ? next : { ...next, browser: { ...next.browser, rows: rootRows(next) } };
    }
    case 'fshare_projects':
    case 'fshare_grants':
    case 'fshare_delivery':
    case 'fshare_fork':
      return { ...state, ...reduceFriendShare(state, action) };
    case 'board_init':
    case 'board_issue':
    case 'board_remove':
    case 'board_meta':
    case 'board_sync':
    case 'board_off':
      return { ...state, ...reduceBoard(state, action) };
    case 'sentinel_init':
    case 'sentinel_put':
    case 'sentinel_remove':
    case 'sentinel_run':
    case 'sentinel_runs_gone':
    case 'sentinel_ask':
    case 'sentinel_trouble':
    case 'sentinel_webhook':
    case 'sentinel_metric':
    case 'sentinel_dashboards':
    case 'sentinel_refresh':
    case 'sentinel_dashboard_ask':
    case 'sentinel_output':
    case 'sentinel_chats':
    case 'sentinel_off':
      return { ...state, ...reduceSentinel(state, action) };
    case 'plans_init':
    case 'plan_put':
    case 'plan_remove':
    case 'plans_style':
    case 'plans_off':
      return offPlanHomes({ ...state, ...reducePlans(state, action) });
    case 'dialogues_init':
    case 'dialogue_put':
    case 'dialogue_remove':
      return { ...state, ...reduceDialogues(state, action) };
    case 'team_state':
    case 'team_off':
      return { ...state, ...reduceTeam(state, action) };
    case 'context_reset': {
      const { [action.channel]: _gone, ...context } = state.context;
      return { ...state, context };
    }
    case 'queue_order': {
      const log = orderQueued(state.log, action.owner, action.ids);
      return log === state.log ? state : { ...state, log };
    }
    default:
      return state;
  }
}

function reduceTriage(state: DomainState, action: Extract<Action, { type: 'triage_set' }>): DomainState {
  const { [action.channel]: was, ...rest } = state.triage;
  if (!action.record && !was) return state;
  const read = action.read ?? [];
  const unread = read.length ? Object.fromEntries(Object.entries(state.unread).filter(([c]) => !read.includes(c))) : state.unread;
  return { ...state, triage: action.record ? { ...state.triage, [action.channel]: action.record } : rest, unread };
}

/**
 * A plan's own conversation has no plan mode (KLD-66): one that had it on before it became a
 * plan's home (or when plans load) has it turned off, so its banner can't get stuck with no way out.
 */
function offPlanHomes<S extends DomainState>(state: S): S {
  const stuck = Object.keys(state.planMode).filter((channel) => isPlanHome(state.plans, channel));
  if (!stuck.length) return state;
  return { ...state, planMode: Object.fromEntries(Object.entries(state.planMode).filter(([channel]) => !stuck.includes(channel))) };
}

/** Minimal observable store of the domain state. `onAction` sees every (stamped) action that changed it. */
export class Store {
  private state: DomainState;
  private readonly listeners = new Set<() => void>();
  private readonly actionListeners = new Set<(action: Action) => void>();

  constructor(initial: DomainState) {
    this.state = initial;
  }

  getState = (): DomainState => this.state;

  dispatch = (input: Action): void => {
    const action = stampAction(input);
    const next = reduceDomain(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const l of this.actionListeners) l(action);
    for (const l of this.listeners) l();
  };

  /** Every action that changed the state, stamped, in order (the daemon streams these to clients). */
  onAction = (listener: (action: Action) => void): (() => void) => {
    this.actionListeners.add(listener);
    return () => void this.actionListeners.delete(listener);
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
