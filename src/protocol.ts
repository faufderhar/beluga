import { z } from 'zod';
import { EmojiSchema } from './shared/reactions.js';

/** Wire protocol version. Bump on breaking changes. */
export const PROTOCOL_VERSION = 3;

export const MAX_TEXT = 64_000;
export const MAX_FILE_BYTES = 512 * 1024;
/** Downloads are sent in chunks small enough to fit comfortably in one frame. */
export const CHUNK_BYTES = 256 * 1024;
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** The longest workspace name `ws_invite` and `ws_handoff` carry. A name you give may be longer. */
export const WS_NAME_MAX = 80;

/** A workspace name cut to what `ws_invite` and `ws_handoff` carry, without splitting a character. */
export function wsWireName(name: string): string {
  if (name.length <= WS_NAME_MAX) return name;
  let out = '';
  for (const ch of name) {
    if (out.length + ch.length > WS_NAME_MAX) break;
    out += ch;
  }
  return out;
}

const shortStr = z.string().min(1).max(256);
const relPath = z.string().max(4096);

export const ShareInfo = z.object({
  name: z.string().regex(/^[\w.-]{1,64}$/),
  writable: z.boolean(),
});
export type ShareInfo = z.infer<typeof ShareInfo>;

export const UsageWindow = z.object({
  /** Percent of the window used, 0-100. */
  pct: z.number().min(0).max(100),
  /** Epoch ms when the window resets. */
  resetsAt: z.number().optional(),
});

/** Claude plan usage, shared so friends can see whose Claude has room left. */
export const Usage = z.object({
  plan: z.string().max(32).optional(),
  fiveHour: UsageWindow.optional(),
  week: UsageWindow.optional(),
  updatedAt: z.number(),
});
export type Usage = z.infer<typeof Usage>;

/** A plan window by its own name, for providers whose windows aren't Claude's 5-hour/week ("Daily", "Monthly"). */
export const NamedUsageWindow = UsageWindow.extend({ label: z.string().min(1).max(32) });
export type NamedUsageWindow = z.infer<typeof NamedUsageWindow>;

/** Runtimes Beluga knows by name; others (a newer Mac's) still parse, as their id. */
export const KNOWN_RUNTIMES = ['claude', 'codex', 'opencode', 'copilot', 'grok', 'local'] as const;
export type AgentRuntime = (typeof KNOWN_RUNTIMES)[number] | (string & {});

/**
 * Which agent it is: its runtime ("claude", "codex", "opencode", "local", …), the model when it's known
 * ("opus", "gpt-5", "qwen3"), and the name its owner gave it ("Claude", "Codex"). Screens say it
 * with shared/agent-label.ts; nothing assumes the agent is Claude.
 */
export const AgentRef = z.object({
  runtime: z.string().regex(/^[a-z][\w-]{0,31}$/) as z.ZodType<AgentRuntime>,
  model: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(64),
});
export type AgentRef = z.infer<typeof AgentRef>;

/** Before a Mac said which agent it runs, it was always Claude. */
export const CLAUDE_AGENT: AgentRef = { runtime: 'claude', label: 'Claude' };

/**
 * One provider's usage: quota windows where the plan has them (Claude's 5-hour/week, Codex's),
 * tokens and speed where it doesn't (a local model). One per runtime in Profile.usages.
 */
export const ProviderUsage = Usage.extend({
  agent: AgentRef,
  /** Windows that aren't the 5-hour/week pair, by their own names. */
  windows: z.array(NamedUsageWindow).max(6).optional(),
  /** Tokens used since the Mac started (for providers without a plan). */
  tokens: z.object({ input: z.number().min(0), output: z.number().min(0) }).optional(),
  /** Output tokens per second over the last run. */
  tokensPerSec: z.number().min(0).max(100_000).optional(),
  /** False when the provider is installed but not signed in. */
  signedIn: z.boolean().optional(),
});
export type ProviderUsage = z.infer<typeof ProviderUsage>;

/** The agent someone's Mac answers with when nobody names one: an older Mac's is Claude. */
export function defaultAgentOf(p: { readonly agents?: readonly AgentRef[]; readonly defaultAgent?: AgentRef } | undefined): AgentRef {
  return p?.defaultAgent ?? p?.agents?.[0] ?? CLAUDE_AGENT;
}

export const Profile = z.object({
  name: z.string().regex(/^[\w.-]{1,32}$/),
  shares: z.array(ShareInfo).max(32),
  agent: z.boolean(),
  /** Claude's usage, kept for older Macs that read only this; newer ones read `usages`. */
  usage: Usage.optional(),
  /** Usage per provider, one per runtime (an older Mac sends none: its `usage` is Claude's). */
  usages: z.array(ProviderUsage).max(8).optional(),
  /** Projects friends may ask to start a worktree in (names only; you approve each request). */
  projects: z.array(z.string().max(80)).max(60).optional(),
  /** The agents this person runs (an older Mac sends none: it runs Claude). */
  agents: z.array(AgentRef).max(8).optional(),
  /** The one that answers when someone asks them without naming one. */
  defaultAgent: AgentRef.optional(),
});
export type Profile = z.infer<typeof Profile>;

/** `host` is set by the hub (never by the peer) for the person whose computer runs the room. */
/** `guest` is set by the hub for someone who came in with a project link and only sees what they were invited to. */
export const PeerInfo = Profile.extend({ peerId: shortStr, host: z.boolean().optional(), guest: z.boolean().optional() });
export type PeerInfo = z.infer<typeof PeerInfo>;

// ---------------------------------------------------------------------------
// Application bodies (always end-to-end encrypted inside a frame "box")
// ---------------------------------------------------------------------------

/**
 * Which conversation a message belongs to: the room, a workspace ("ws:<id>"), or one of "Your
 * Mac"'s chats ("mac:assistant", "mac:assistant:<id>", core/assistant). Your own messages to your Claude are parsed by this too
 * (session's loopback), so a channel it refuses never reaches Claude.
 */
// `dm:`/`group:`: your own Claude acting in a friends' chat (BLG-207); its events only go to you.
// `sentinel-chat:<id>`: the Sentinel chat (docs/sentinel.md §12), yours only; its events only go to you.
export const Channel = z.string().regex(/^(room|mac:assistant(:[a-z0-9]{1,24})?|sentinel-chat:[a-z0-9]{1,24}|ws:[\w:.-]{1,80}|dm:[\w-]{8,64}|group:[\w-]{1,80})$/).default('room');

/**
 * An external agent acted through its owner's Beluga: the frame is signed with the owner's key, so
 * this says the words aren't the owner's. Additive: an older Mac drops it and shows the rest.
 */
export const MessageVia = z.object({ id: z.string().min(1).max(40), name: z.string().min(1).max(80), creationSource: z.literal('mcp') });
export type MessageVia = z.infer<typeof MessageVia>;

export const ChatBody = z.object({
  kind: z.literal('chat'),
  text: z.string().min(1).max(MAX_TEXT),
  byAgent: z.boolean().default(false),
  channel: Channel,
  /** With `byAgent`: which of their agents wrote it (an older Mac leaves it out: Claude). */
  agent: AgentRef.optional(),
  via: MessageVia.optional(),
  /**
   * BLG-702: the sender's own id for it, the same in every copy (a workspace chat goes to each person
   * in a frame of its own), so a reaction can name it: it's `<from>:<mid>` everywhere. An older Mac
   * sends none (its message keeps the frame's id) and drops it from ours.
   */
  mid: z.string().regex(/^[\w-]{8,64}$/).optional(),
});

/** A chat message's id as every copy of it has it: `<from>:<mid>`, or (from an older Mac) the frame's own. */
export const chatMessageId = (from: string, mid: string | undefined, frameId: string): string => (mid ? `${from}:${mid}` : frameId);

/**
 * BLG-702: one person's emoji on a chat message (`to`: its id, see chatMessageId) put on (`on`) or
 * taken off; `at` orders their changes to it (shared/reactions.ts: the newest wins, off wins a tie).
 * In the room it's kept with its history (late joiners get it too); in a workspace it goes to the
 * people in it, like a message. An older Mac doesn't know the kind and drops it.
 */
export const ChatReactBody = z.object({
  kind: z.literal('chat_react'),
  channel: Channel,
  to: z.string().regex(/^[\w:+/=.-]{1,200}$/),
  e: EmojiSchema,
  on: z.boolean(),
  at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const FocusBody = z.object({
  kind: z.literal('focus'),
  owner: shortStr,
  share: shortStr,
  path: relPath,
  actor: z.enum(['human', 'agent']),
});

export const AgentRequestBody = z.object({
  kind: z.literal('agent_request'),
  requestId: shortStr,
  prompt: z.string().min(1).max(MAX_TEXT),
  viaAgent: z.boolean().default(false),
  /** An external agent of theirs asked: their card says so. */
  via: MessageVia.optional(),
  channel: Channel,
  /** Now, not after the current task: your own steer the run working (read at its next step), else interrupt it. */
  urgent: z.boolean().default(false),
  /** Plan first: Claude investigates read-only and proposes a plan for you to approve. */
  plan: z.boolean().default(false),
  /** Run in one of the owner's projects (by name) instead of their shared folder. */
  project: z.string().min(1).max(80).optional(),
  /**
   * BLG-520: the agent a room message named ("@codex", "@bob:codex"). Their Mac runs it when its
   * card lists it and it runs there (your own: any that runs here), else its default, and says so
   * (`AgentEventBody.fallback`). Only for the room; a place's pin (a worktree's agent) still wins
   * there. An older Mac drops it and its default answers; a malformed one is dropped alone.
   */
  agent: AgentRef.optional().catch(undefined),
});

export const AgentEventKind = z.enum([
  'queued',
  'awaiting_approval',
  'started',
  'text',
  'tool',
  'done',
  'error',
  'denied',
  /** The first answer is ready (the run may go on for background agents); lets the asker stop waiting. */
  'answered',
  /** How far the step Claude is on has got, from its output ("137/215"; see progressCount). Empty: the step's tools returned, Claude thinks. */
  'progress',
  /** Sub-agent progress; text is JSON {id, phase, title?, step?}. */
  'sub',
  /** How full the conversation's context is; text is JSON {used, window}. */
  'context',
  /** The conversation was compacted; text is JSON {pre, post, trigger}. */
  'compact',
  /** Tokens and cost of a run; text is JSON {input, output, cacheRead, cacheWrite, cost, session}. */
  'usage',
]);
export type AgentEventKind = z.infer<typeof AgentEventKind>;

export const AgentEventBody = z.object({
  kind: z.literal('agent_event'),
  requestId: shortStr,
  requester: shortStr,
  event: AgentEventKind,
  text: z.string().max(MAX_TEXT).default(''),
  channel: Channel,
  /** With `queued`: it waits because its Claude works in as many conversations as it may at once (see shared/run-slots.ts). */
  slotWait: z.object({ running: z.number().int().min(0).max(1000), limit: z.number().int().min(0).max(1000) }).optional(),
  /** The agent doing the run (an older Mac leaves it out: Claude). */
  agent: AgentRef.optional(),
  /** BLG-520: the request named another agent, which doesn't run there: why `agent` answers instead (in words). */
  fallback: z.string().max(300).optional(),
  /** The run is an external agent's: its requester shows as this name. */
  via: MessageVia.optional(),
});

export const FsListBody = z.object({
  kind: z.literal('fs_list'),
  reqId: shortStr,
  share: shortStr,
  path: relPath,
  /** Say when each file last changed (`mtime`): a friend's Scratch tab, newest first (BLG-259). */
  times: z.boolean().optional(),
});

export const FsEntry = z.object({ name: z.string(), dir: z.boolean(), size: z.number(), mtime: z.number().optional() });
export type FsEntry = z.infer<typeof FsEntry>;

export const FsListResultBody = z.object({
  kind: z.literal('fs_list_result'),
  reqId: shortStr,
  ok: z.boolean(),
  entries: z.array(FsEntry).max(5000).optional(),
  error: z.string().optional(),
});

export const FsReadBody = z.object({
  kind: z.literal('fs_read'),
  reqId: shortStr,
  share: shortStr,
  path: relPath,
});

export const FsReadResultBody = z.object({
  kind: z.literal('fs_read_result'),
  reqId: shortStr,
  ok: z.boolean(),
  content: z.string().max(MAX_FILE_BYTES).optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
});

export const FsChangedBody = z.object({
  kind: z.literal('fs_changed'),
  share: shortStr,
  path: relPath,
});

export const FsFetchBody = z.object({
  kind: z.literal('fs_fetch'),
  reqId: shortStr,
  share: shortStr,
  path: relPath,
  offset: z.number().int().min(0),
});

export const FsChunkBody = z.object({
  kind: z.literal('fs_chunk'),
  reqId: shortStr,
  ok: z.boolean(),
  /** base64 bytes */
  data: z.string().max(Math.ceil((CHUNK_BYTES * 4) / 3) + 8).optional(),
  offset: z.number().int().min(0).optional(),
  total: z.number().int().min(0).optional(),
  error: z.string().optional(),
});

export const ReportBody = z.object({
  kind: z.literal('report'),
  share: shortStr,
  path: relPath,
  title: z.string().max(200),
});

/** The host cleared the group chat for everyone. */
export const RoomClearedBody = z.object({ kind: z.literal('room_cleared') });
/** The gateway (tasks between Claudes, core/gateway) over a room: one frame, to one person; it checks the frame itself. */
export const GatewayBody = z.object({ kind: z.literal('gateway'), frame: z.unknown() });
/** A call in the room's chat (core/calls, BLG-716): ringing, who's in, WebRTC setup, notes; sent to one person, checked there. */
export const CallBody = z.object({ kind: z.literal('call'), p: z.unknown() });
/**
 * Someone in the room wants to be friends on the Beluga network (BLG-202): a one-time friend
 * invitation made only for you. Accepting it pairs your Macs over the network. Older Macs drop it.
 */
export const FriendOfferBody = z.object({ kind: z.literal('friend_offer'), link: z.string().regex(/^beluga:\/\/add#[\w-]{22}$/), expiresAt: z.number().int().positive() });

// ---- Claude asking the person who asked it (questions, plans to approve) ----

const QuestionOption = z.object({ label: z.string().max(200), description: z.string().max(1000).default('') });
export const ClaudeQuestion = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    questions: z
      .array(z.object({ question: z.string().max(1000), header: z.string().max(40).default(''), options: z.array(QuestionOption).max(6), multiSelect: z.boolean().default(false) }))
      .min(1)
      .max(4),
  }),
  z.object({ kind: z.literal('plan'), plan: z.string().max(MAX_TEXT) }),
]);
export type ClaudeQuestion = z.infer<typeof ClaudeQuestion>;

export const ClaudeAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answers'), answers: z.record(z.string().max(1000), z.string().max(4000)) }),
  z.object({ kind: z.literal('plan'), approve: z.boolean(), feedback: z.string().max(4000).default('') }),
  z.object({ kind: z.literal('skip') }),
]);
export type ClaudeAnswer = z.infer<typeof ClaudeAnswer>;

export const AgentQuestionBody = z.object({
  kind: z.literal('agent_question'),
  requestId: shortStr,
  qid: shortStr,
  channel: Channel,
  question: ClaudeQuestion,
});
export const AgentAnswerBody = z.object({ kind: z.literal('agent_answer'), qid: shortStr, answer: ClaudeAnswer });

// ---- Sharing one workspace (its chat and folder) with people in the room ----

export const WsRole = z.enum(['view', 'contribute']);
export type WsRole = z.infer<typeof WsRole>;
/** What someone invited by link may do: watch, prompt your Claude, or let it edit without asking. */
export const GuestCan = z.enum(['watch', 'prompt', 'edit']);
export type GuestCan = z.infer<typeof GuestCan>;

/** Owner → invitee: you're in. Carries what the workspace is, recent history, and its folder share. */
export const WsInviteBody = z.object({
  kind: z.literal('ws_invite'),
  /** `agent`: the owner's agent that runs there (their pick for it, or their default; an older Mac leaves it out: Claude). */
  ws: z.object({ id: z.string().regex(/^[\w:.-]{1,80}$/), name: z.string().max(WS_NAME_MAX), project: z.string().max(80), branch: z.string().max(200).optional(), agent: AgentRef.optional() }),
  role: WsRole,
  /** Set for people invited by link: watch, prompt or edit (for showing what they can do). */
  can: GuestCan.optional(),
  share: z.string().regex(/^[\w.-]{1,64}$/),
  history: z.array(z.object({ from: shortStr, text: z.string().max(8000), ts: z.number(), byAgent: z.boolean() })).max(80),
});
/** Owner → everyone in the workspace: who's in it now. */
export const WsRosterBody = z.object({
  kind: z.literal('ws_roster'),
  id: z.string().regex(/^[\w:.-]{1,80}$/),
  members: z.array(z.object({ peerId: shortStr, role: WsRole })).max(32),
});
/** Either way: the owner removed you, or you left. */
export const WsLeaveBody = z.object({ kind: z.literal('ws_leave'), id: z.string().regex(/^[\w:.-]{1,80}$/) });

/** A folder shared with only you (or no longer). Folders shared with everyone are in the profile instead. */
export const ShareOfferBody = z.object({ kind: z.literal('share_offer'), name: z.string().regex(/^[\w.-]{1,64}$/), writable: z.boolean(), active: z.boolean() });

// ---- Working on each other's computers ----

const wsIdStr = z.string().regex(/^[\w:.-]{1,80}$/);
const historyItems = z.array(z.object({ from: shortStr, text: z.string().max(8000), ts: z.number(), byAgent: z.boolean() })).max(80);

/** "Start a worktree on your computer": in one of the projects you offer, for this task. */
export const WsRequestBody = z.object({ kind: z.literal('ws_request'), reqId: shortStr, project: z.string().min(1).max(80), task: z.string().min(1).max(MAX_TEXT), plan: z.boolean().default(false) });
export const WsRequestResultBody = z.object({ kind: z.literal('ws_request_result'), reqId: shortStr, ok: z.boolean(), wsId: wsIdStr.optional(), error: z.string().max(500).optional() });

/** Hand a workspace to someone: its branch (as a git bundle you download), a handoff note and the recent chat. */
export const WsHandoffBody = z.object({
  kind: z.literal('ws_handoff'),
  hid: shortStr,
  ws: z.object({ name: z.string().max(WS_NAME_MAX), project: z.string().max(80), branch: z.string().max(200), base: z.string().max(200) }),
  /** The project's origin URL, to find the same repository on the other computer. */
  remote: z.string().max(500),
  note: z.string().max(MAX_TEXT),
  history: historyItems,
  bundle: z.object({ share: z.string().regex(/^[\w.-]{1,64}$/), path: relPath, size: z.number().int().min(0) }).optional(),
});
/**
 * Why a handoff can't (or didn't) go through, so the one handing off hears the real reason (BLG-614):
 * they said no, they turned off work from friends, they don't have the repository, the branch name
 * isn't allowed here, or getting the branch failed. Unknown codes from a newer Beluga read as `failed`.
 */
export const HandoffReason = z.enum(['declined', 'off', 'no_repo', 'bad_branch', 'failed']).catch('failed');
export type HandoffReason = z.infer<typeof HandoffReason>;
export const WsHandoffResultBody = z.object({ kind: z.literal('ws_handoff_result'), hid: shortStr, ok: z.boolean(), error: z.string().max(500).optional(), reason: HandoffReason.optional() });

/** "Could you take this one over?" before anything is written or sent: do you have the same repository (BLG-614). */
export const WsHandoffCheckBody = z.object({ kind: z.literal('ws_handoff_check'), reqId: shortStr, remote: z.string().max(500) });
export const WsHandoffCheckResultBody = z.object({ kind: z.literal('ws_handoff_check_result'), reqId: shortStr, ok: z.boolean(), reason: HandoffReason.optional() });

/** Ask for a file anywhere on someone's computer (they approve unless they fully trust you). */
export const FileRequestBody = z.object({ kind: z.literal('file_request'), reqId: shortStr, path: z.string().min(1).max(4096), why: z.string().max(500).default('') });
export const FileRequestResultBody = z.object({
  kind: z.literal('file_request_result'),
  reqId: shortStr,
  ok: z.boolean(),
  share: z.string().regex(/^[\w.-]{1,64}$/).optional(),
  path: relPath.optional(),
  name: z.string().max(255).optional(),
  size: z.number().int().min(0).optional(),
  error: z.string().max(500).optional(),
});
/** "Here's a file for you": the recipient downloads it (automatically if they trust you). */
export const FileOfferBody = z.object({
  kind: z.literal('file_offer'),
  fid: shortStr,
  name: z.string().min(1).max(255),
  size: z.number().int().min(0),
  share: z.string().regex(/^[\w.-]{1,64}$/),
  path: relPath,
  note: z.string().max(1000).default(''),
});

// ---- Running a command on someone's computer (through their Beluga) ----

/** Most output a command sends back (its tail is kept). */
export const MAX_SHELL_OUTPUT = 64 * 1024;
export const MAX_SHELL_SECONDS = 600;

/** "Run this command on your computer": their trust in you decides whether they're asked first. */
export const ShellRequestBody = z.object({
  kind: z.literal('shell_request'),
  reqId: shortStr,
  command: z.string().min(1).max(8000),
  /** Folder to run in (~ is their home); default: their shared folder, or home with full trust. */
  cwd: z.string().max(4096).optional(),
  /** One of their projects (by name) to run in. */
  project: z.string().min(1).max(80).optional(),
  timeoutSec: z.number().int().min(1).max(MAX_SHELL_SECONDS).default(120),
  /** Your Claude asked (not you). */
  viaAgent: z.boolean().default(false),
  /** An external agent of theirs asked: their card says so. */
  via: MessageVia.optional(),
  why: z.string().max(500).default(''),
});
export const ShellResultBody = z.object({
  kind: z.literal('shell_result'),
  reqId: shortStr,
  ok: z.boolean(),
  exitCode: z.number().int().optional(),
  /** Output (stdout and stderr together), the tail when it was longer. */
  output: z.string().max(MAX_SHELL_OUTPUT + 1024).default(''),
  truncated: z.boolean().default(false),
  timedOut: z.boolean().default(false),
  /** Where it ran, as they'd say it (~/… paths). */
  cwd: z.string().max(4096).optional(),
  ms: z.number().int().min(0).optional(),
  /** Declined, blocked, or couldn't start. */
  error: z.string().max(500).optional(),
});
/** "Approved, running now": sent once the command starts, so the asker stops seeing "waiting". */
export const ShellStartedBody = z.object({
  kind: z.literal('shell_started'),
  reqId: shortStr,
  /** Where it runs, as they'd say it (~/… paths). */
  cwd: z.string().max(4096).optional(),
});
/** Your trust in someone, told to them so their Claude knows what it may ask for (informational only). */
export const TrustGrantBody = z.object({
  kind: z.literal('trust_grant'),
  level: z.enum(['blocked', 'ask', 'trusted', 'full']),
  reach: z.enum(['folder', 'full']),
});

// ---- Guests browsing a shared workspace (a read-only virtual shell and the diff) ----

/** Find files by name, or grep for text, inside a shared folder (the owner bounds the search). */
export const FsSearchBody = z.object({
  kind: z.literal('fs_search'),
  reqId: shortStr,
  share: z.string().regex(/^[\w.-]{1,64}$/),
  path: relPath,
  mode: z.enum(['find', 'grep']),
  query: z.string().min(1).max(200),
});
export const FsSearchResultBody = z.object({
  kind: z.literal('fs_search_result'),
  reqId: shortStr,
  ok: z.boolean(),
  hits: z.array(z.object({ path: relPath, line: z.number().int().min(0).optional(), text: z.string().max(400).optional() })).max(500).optional(),
  truncated: z.boolean().optional(),
  error: z.string().max(500).optional(),
});

/** What changed in a shared workspace: the summary, or one file's patch. */
export const WsDiffBody = z.object({ kind: z.literal('ws_diff'), reqId: shortStr, id: wsIdStr, file: relPath.optional() });
export const WsDiffResultBody = z.object({
  kind: z.literal('ws_diff_result'),
  reqId: shortStr,
  ok: z.boolean(),
  review: z
    .object({
      base: z.string().max(200),
      commits: z.array(z.object({ hash: z.string().max(40), subject: z.string().max(300) })).max(200),
      files: z.array(z.object({ path: relPath, added: z.number().int().min(0), removed: z.number().int().min(0), state: z.enum(['modified', 'added', 'deleted', 'untracked', 'renamed']) })).max(2000),
    })
    .optional(),
  patch: z.string().max(MAX_FILE_BYTES).optional(),
  error: z.string().max(500).optional(),
});

export const Body = z.discriminatedUnion('kind', [
  ShellRequestBody,
  ShellResultBody,
  ShellStartedBody,
  TrustGrantBody,
  FsSearchBody,
  FsSearchResultBody,
  WsDiffBody,
  WsDiffResultBody,
  WsRequestBody,
  WsRequestResultBody,
  WsHandoffBody,
  WsHandoffResultBody,
  WsHandoffCheckBody,
  WsHandoffCheckResultBody,
  FileRequestBody,
  FileRequestResultBody,
  FileOfferBody,
  RoomClearedBody,
  GatewayBody,
  CallBody,
  FriendOfferBody,
  ShareOfferBody,
  AgentQuestionBody,
  AgentAnswerBody,
  WsInviteBody,
  WsRosterBody,
  WsLeaveBody,
  ChatBody,
  ChatReactBody,
  FocusBody,
  AgentRequestBody,
  AgentEventBody,
  FsListBody,
  FsListResultBody,
  FsReadBody,
  FsReadResultBody,
  FsChangedBody,
  FsFetchBody,
  FsChunkBody,
  ReportBody,
]);
export type Body = z.infer<typeof Body>;
export type BodyOf<K extends Body['kind']> = Extract<Body, { kind: K }>;
/** Input shape for sending: fields with defaults are optional. */
export type BodyInput = z.input<typeof Body>;

// ---------------------------------------------------------------------------
// Frames (what actually travels over the websocket)
// ---------------------------------------------------------------------------

export const Box = z.object({ iv: z.string(), ct: z.string(), tag: z.string() });
export type Box = z.infer<typeof Box>;

export const ChallengeFrame = z.object({ t: z.literal('challenge'), v: z.number(), nonce: z.string() });
export const HelloFrame = z.object({
  t: z.literal('hello'),
  peerId: shortStr,
  /** HMAC with the invite key: proves you hold the invite. */
  proof: z.string(),
  /** Your public key and a signature of the challenge: proves the peer id is yours. */
  pub: z.string().max(200),
  sig: z.string().max(200),
  box: Box,
});
export const WelcomeFrame = z.object({
  t: z.literal('welcome'),
  you: PeerInfo,
  box: Box,
});
export const PeersFrame = z.object({ t: z.literal('peers'), box: Box });
export const MsgFrame = z.object({
  t: z.literal('msg'),
  from: shortStr.optional(),
  to: shortStr.optional(),
  keep: z.boolean().optional(),
  ts: z.number().optional(),
  box: Box,
  /** The sender's public key, signature over the box (+ recipient and send time), and send time. */
  pub: z.string().max(200).optional(),
  sig: z.string().max(200).optional(),
  sts: z.number().optional(),
});
export type MsgFrame = z.infer<typeof MsgFrame>;
export const ErrorFrame = z.object({ t: z.literal('error'), message: z.string() });
/** The host replaced the invite: members get the new secret (sealed with the room key) so they can reconnect. */
export const RekeyFrame = z.object({ t: z.literal('rekey'), box: Box });

export const Frame = z.discriminatedUnion('t', [
  ChallengeFrame,
  HelloFrame,
  WelcomeFrame,
  PeersFrame,
  MsgFrame,
  ErrorFrame,
  RekeyFrame,
]);
export type Frame = z.infer<typeof Frame>;

export const WelcomePayload = z.object({
  room: z.string().max(64).optional(),
  /** The room's message key, when it differs from the key your invite derives (after the invite was replaced). */
  roomKey: z.string().max(64).optional(),
  /** The current invite secret, when you came back with an older one (you were away when it changed). */
  secret: z.string().regex(/^[\w-]{16,256}$/).optional(),
  peers: z.array(PeerInfo),
  history: z.array(MsgFrame),
});

/** Parse untrusted JSON text into a frame, returning null if malformed. */
export const RekeyPayload = z.object({ secret: z.string().regex(/^[\w-]{16,256}$/) });

export function parseFrame(raw: string): Frame | null {
  try {
    const result = Frame.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
