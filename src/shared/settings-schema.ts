import { z } from 'zod';
import { AgentRef } from '../protocol.js';
import { AUTO_COMPACT_DEFAULT, AUTO_COMPACT_MAX, AUTO_COMPACT_MIN } from './context-usage.js';
import { PARALLEL_RUNS_DEFAULT, PARALLEL_RUNS_MAX, PARALLEL_RUNS_MIN } from './run-slots.js';
import { CHAT_LIMIT_DEFAULT, CHAT_LIMIT_MAX } from './chat-limit.js';
import { AUTO_CONTINUE_OFF_MAX } from './auto-continue.js';
import { MAX_AGENT_ARGS, MAX_AGENT_ARG_LENGTH } from './agent-args.js';
import { THREAD_LIMITS_DEFAULT, THREAD_LIMITS_MAX } from './threads.js';
import { coercePerKind, coerceSound, DEFAULT_SOUND, DEFAULT_VOLUME, PerKindSounds, SoundChoice } from './notify-sound.js';

// Settings as data (no file access), so the reducer and the clients can use them anywhere.

export const THEMES = ['calm', 'light', 'contrast', 'mono'] as const;
export type ThemeName = (typeof THEMES)[number];

/**
 * How much you trust someone, from "can't use my Claude" to "do anything without asking".
 * Secrets (.env, keys, .ssh…) stay blocked at every level.
 */
export const TRUST_LEVELS = ['blocked', 'ask', 'trusted', 'full'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** What new worktrees' branches start with (`beluga/fix-login`); empty: just the name. */
export const BRANCH_PREFIX_DEFAULT = 'beluga/';
/** A prefix git accepts in front of a slug: letters, digits, `. _ - /`, no `..`, `//`, or part starting with `.` `-` `/`. */
export const BRANCH_PREFIX_RE = /^(?![./-])(?!.*\.\.)(?!.*\/\/)(?!.*\/[.-])[\w./-]{0,40}$/;

/** How many days without activity settle a chat (core/triage); 0: never. */
export const SETTLE_IDLE_DAYS_DEFAULT = 3;
export const SETTLE_IDLE_DAYS_MAX = 365;

/** Keep the Mac awake for your phone: never, only on power, or always (the display may still sleep). */
export const KEEP_AWAKE = ['off', 'power', 'always'] as const;
export type KeepAwake = (typeof KEEP_AWAKE)[number];
/** Low Power mode (BLG-621): never, on battery (or macOS Low Power Mode), or always. */
export const LOW_POWER = ['off', 'battery', 'always'] as const;
export type LowPower = (typeof LOW_POWER)[number];

/** Which events can notify you (desktop notification + the in-app inbox). */
export const NotifySettings = z.object({
  /** Show a desktop notification (macOS Notification Center, notify-send on Linux). */
  desktop: z.boolean().default(true),
  /** The sound notifications make (was on/off: `true` reads as the default sound, `false` as none). */
  sound: z.preprocess((v) => (v === undefined ? v : coerceSound(v)), SoundChoice).default(DEFAULT_SOUND),
  /** How loud Beluga's own sounds (8-bit, generated) are, 0–1. Mac sounds play at the system's alert volume. */
  soundVolume: z.number().min(0).max(1).default(DEFAULT_VOLUME),
  /** A sound for each kind of notification (`null`: the same sound for all). */
  perKind: z.preprocess((v) => (v === undefined ? v : coercePerKind(v)), PerKindSounds.partial().nullable()).default(null),
  /** Generated sounds you kept (their seeds), to pick from again. */
  madeSounds: z.array(z.number().int().min(0).max(0xffffffff)).max(12).default([]),
  /** Claude finished (or stopped) in a workspace you're not looking at. */
  done: z.boolean().default(true),
  /** Also when it's the conversation you're looking at: a run of yours that took a while, once nothing else runs there. */
  doneHere: z.boolean().default(true),
  /** Claude asks a question, proposes a plan, or needs an approval. */
  needsYou: z.boolean().default(true),
  /** Errors, merge conflicts, failed setup scripts. */
  problems: z.boolean().default(true),
  /** Someone joins, leaves, invites you, or hands work to you. */
  people: z.boolean().default(true),
  /** A pull request was opened or its checks finished. */
  pr: z.boolean().default(true),
  /** Someone mentions you (@name), or writes to you when it's just the two of you. */
  mentions: z.boolean().default(true),
  /** Background work finishes: a task Claude runs in the background, a new worktree's setup. */
  background: z.boolean().default(true),
  /** Sentinels: a run's result, a failure, one pausing itself (one waiting for you still tells, under needsYou). */
  sentinels: z.boolean().default(true),
  /** A plan speaks for its tasks: you hear at milestones and when it needs you; its tasks' news goes quietly into the inbox. */
  planMilestones: z.boolean().default(true),
  /** When Claude needs you (a question, an approval, a decision, a milestone to pass): a card on top of whatever you're doing, as friends' requests get. */
  popup: z.boolean().default(true),
  /** Desktop notifications only while no Beluga window is in front. */
  onlyAway: z.boolean().default(false),
  /** Do Not Disturb: no desktop notifications (the inbox still fills). Ends at `until` (ms), or when you turn it off. */
  dnd: z.object({ until: z.number().int().positive().optional() }).nullable().default(null),
});
export type NotifySettings = z.infer<typeof NotifySettings>;

const peerKey = z.string().regex(/^[\w-]{8,64}$/);

/**
 * A computer's icon (BLG-780): its kind's own (`auto`: a brand mark or a fitting glyph) or one of a
 * small generic set. Kept on the computer, so every device of yours shows the same.
 */
export const MACHINE_ICONS = ['auto', 'server', 'cloud', 'desktop', 'laptop', 'chip', 'box'] as const;
export type MachineIcon = (typeof MACHINE_ICONS)[number];

/** Where new work runs (BLG-780): this computer, the least busy of yours that's ready, or one by its id. */
export const RUN_ON = /^(here|best|[0-9a-f]{16})$/;

const threadLimit = (max: number) => z.number().int().min(1).max(max);
/** How far your agents' threads go (shared/threads.ts). */
export const ThreadLimitsSchema = z.object({
  depth: threadLimit(THREAD_LIMITS_MAX.depth),
  treeRunning: threadLimit(THREAD_LIMITS_MAX.treeRunning),
  treeLive: threadLimit(THREAD_LIMITS_MAX.treeLive),
  macRunning: threadLimit(THREAD_LIMITS_MAX.macRunning),
});

/** Choices that persist between runs in ~/.beluga/settings.json. */
export const Settings = z.object({
  name: z.string().regex(/^[\w.-]{1,32}$/).optional(),
  /** What your phone calls this computer (`beluga setup`); unset: its own name (Sharing name, else host name). */
  computerName: z.string().trim().min(1).max(64).optional(),
  /** Its icon, as your app shows it on every device (BLG-780). */
  computerIcon: z.enum(MACHINE_ICONS).optional(),
  /** Run New Work On (BLG-780): `here`, `best`, or a computer's id. */
  runOn: z.string().regex(RUN_ON).default('here'),
  theme: z.enum(THEMES).default('calm'),
  /** Default trust for people you haven't chosen a level for. Unset until you answer the welcome screen once. */
  policy: z.enum(['ask', 'auto', 'deny']).optional(),
  mouse: z.boolean().default(true),
  tunnel: z.enum(['auto', 'p2p', 'cloudflared', 'ngrok', 'none']).default('auto'),
  /** Keep the Mac from sleeping while a phone is paired, so it stays reachable (companion/awake.ts): never, on power only, or always. */
  keepAwake: z.enum(KEEP_AWAKE).default('off'),
  /** Low Power mode: Beluga does less and shows less to save the battery (core/power-saver.ts). */
  lowPower: z.enum(LOW_POWER).default('off'),
  /** Whether your own Claude asks before shell commands and other risky actions. */
  selfApproval: z.enum(['never', 'ask']).default('never'),
  notify: NotifySettings.default(NotifySettings.parse({})),
  /** Model for new conversations (unset: Claude Code's default). */
  model: z.string().regex(/^[\w.:[\]-]{1,80}$/).optional(),
  effort: z.enum(EFFORTS).optional(),
  /**
   * Models the chat’s model menu offers, as `runtime|value` (shared/open-models.ts).
   * Empty: every model, including ones found later.
   */
  openModels: z.array(z.string().max(120)).max(80).catch([]).default([]),
  /** The agent that answers when someone addresses you plainly ("@kay"); published on your peer card. Unset: Claude. */
  defaultAgent: AgentRef.optional(),
  /** A project's own default agent (by project name), over `defaultAgent` for work in that project. */
  projectAgents: z.record(z.string().min(1).max(80), AgentRef).optional(),
  /** What new worktrees' branches start with (`beluga/<name>`); empty: no prefix. */
  branchPrefix: z.string().regex(BRANCH_PREFIX_RE).catch(BRANCH_PREFIX_DEFAULT),
  /** Run the project's setup script (e.g. npm install) in every new worktree. */
  autoSetup: z.boolean().default(true),
  /** Show how full each conversation's context is. */
  contextMeter: z.boolean().default(true),
  /** Compact a conversation on its own when its context is nearly full (the chat stays on screen). Off until you turn it on. */
  autoCompact: z.boolean().default(false),
  /** You chose auto-compact yourself. Older files saved `autoCompact: true` as a default nobody picked, so without this it reads as off. */
  autoCompactChosen: z.boolean().optional(),
  /** How full (percent) a conversation gets before it's compacted. */
  autoCompactAt: z.number().int().min(AUTO_COMPACT_MIN).max(AUTO_COMPACT_MAX).catch(AUTO_COMPACT_DEFAULT),
  /** After your usage limit resets, tell the agent that stopped on it to continue (shared/auto-continue.ts). On until you turn it off. */
  autoContinue: z.boolean().default(true),
  /** Chats it's off in (the limit card's "Not in this chat"). */
  autoContinueOff: z.array(z.string().max(200)).max(AUTO_CONTINUE_OFF_MAX).catch([]).default([]),
  /** "Not this session": limit resumes due at or before this time (epoch ms) aren't sent; 0: none. */
  autoContinueSkip: z.number().int().min(0).catch(0).default(0),
  /** How many conversations your Claude works in at once; a message past it waits for one to finish (and says so). */
  parallelRuns: z.number().int().min(PARALLEL_RUNS_MIN).max(PARALLEL_RUNS_MAX).catch(PARALLEL_RUNS_DEFAULT),
  /** How many chats Your Mac and Sentinel each keep open (shared/chat-limit.ts); 0: no limit. */
  chatLimit: z.number().int().min(0).max(CHAT_LIMIT_MAX).catch(CHAT_LIMIT_DEFAULT),
  /** Your agents may start child threads (core/threads). Off until you turn it on. */
  agentThreads: z.boolean().default(false),
  /** How far those threads go (shared/threads.ts). */
  threadLimits: ThreadLimitsSchema.catch(THREAD_LIMITS_DEFAULT),
  /** Sort chats into Inbox, Working, Later and Settled (core/triage). Off: nothing settles, and triage.json only keeps Remind Me Later. */
  chatCategories: z.boolean().catch(false),
  /** A merged PR settles its chat. */
  settleOnMerge: z.boolean().catch(true),
  /** Days without activity before a chat settles; 0: never. */
  settleIdleDays: z.number().int().min(0).max(SETTLE_IDLE_DAYS_MAX).catch(SETTLE_IDLE_DAYS_DEFAULT),
  /** An agent in a worktree whose pull request is open pushes its commits there when its turn ends (BLG-840). */
  pushToPr: z.boolean().catch(true),
  /** Claude keeps screenshots and scratch output in the workspace's git-ignored `.beluga/scratch/` folder. */
  scratchFolder: z.boolean().default(true),
  /** How much of Claude's sub-agent work the chat shows. */
  subagents: z.enum(['full', 'compact', 'hidden']).default('full'),
  /** Workspace buttons you chose to hide from the top bar. */
  hiddenButtons: z.array(z.string().max(40)).max(40).default([]),
  /** Friends may ask to start a worktree (and hand work over) on this computer; you still approve each one. */
  friendWorktrees: z.enum(['ask', 'off']).default('ask'),
  /** Who may call your Claude into a chat (you always can): friends in the chat, people you trust, or only you. */
  chatClaude: z.enum(['everyone', 'trusted', 'off']).default('everyone'),
  /** Who sees how much of your plans (Claude Code, Codex…) you have left, on your profile: people you trust, every friend, or no one (BLG-597). */
  shareUsage: z.enum(['trusted', 'everyone', 'off']).default('trusted'),
  /** Tell friends when you've seen their direct messages (BLG-798: Seen, sent only from a screen of yours, never by your Always On itself). */
  readReceipts: z.boolean().default(true),
  /** Your main channel: a group with all your friends (made the first time you open it). */
  mainChannel: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  /** People you chose a trust level for (by their key-derived id). */
  people: z.record(peerKey, z.object({ name: z.string().max(32), trust: z.enum(TRUST_LEVELS) })).default({}),
  /** Shell for the built-in terminal (default: $SHELL). */
  shell: z.string().max(200).optional(),
  /** Start it as a login shell (reads your profile, e.g. ~/.zprofile). */
  shellLogin: z.boolean().default(true),
  /** Extra arguments for the shell, after -l. */
  shellArgs: z.array(z.string().max(200)).max(20).default([]),
  /** Your own flags for `claude` and `codex` on your own runs (shared/agent-args.ts), e.g. --dangerously-skip-permissions. */
  claudeArgs: z.array(z.string().max(MAX_AGENT_ARG_LENGTH)).max(MAX_AGENT_ARGS).default([]),
  codexArgs: z.array(z.string().max(MAX_AGENT_ARG_LENGTH)).max(MAX_AGENT_ARGS).default([]),
  /** Experimental features you turned on (shared/experiments.ts); ids a newer Beluga knows are kept. */
  experiments: z.array(z.string().max(40)).max(20).catch([]).default([]),
  /** Show every earnings total in this currency (lowercase ISO code; unset: the one most was earned in). */
  earningsCurrency: z.string().regex(/^[a-z]{3}$/).optional(),
  /** Be on the Beluga network (friends, groups, presence) while the Mac app's daemon runs. Off by default for now. */
  network: z.boolean().optional(),
  /** Where frames wait for a friend you're never online with at the same time (BLG-272): a mailbox's https URL, or "off". Unset: Beluga's own. */
  mailbox: z.union([z.string().url().max(300), z.literal('off')]).optional(),
  /** Minutes a frame waits for a friend's link before it goes to their mailbox. */
  mailboxAfterMin: z.number().min(0).max(24 * 60).optional(),
  /** "Ask me for…": a short note friends' Claudes see on your card (the gateway, Mac app). */
  askMeFor: z.string().max(280).optional(),
  /** Friends your Claude may ask without checking with you first ("Always" on its "Ask X's Claude?" card), by peer id. */
  askFreely: z.array(z.string().max(80)).max(500).optional(),
  /** What friends' Claudes may do here, by trust level (checked fully in core/gateway/access.ts). */
  capabilities: z.object({ levels: z.record(z.string(), z.record(z.string(), z.string())).optional(), folders: z.array(z.string().max(4096)).max(20).optional() }).optional(),
});
export type Settings = z.infer<typeof Settings>;
