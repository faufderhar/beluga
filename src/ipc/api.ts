import { z } from 'zod';
import { AgentRef, ClaudeAnswer, GuestCan, WsRole } from '../protocol.js';
import { EmojiSchema } from '../shared/reactions.js';
import { ARCHIVE_SETTLED_DAYS_MAX, BRANCH_PREFIX_RE, EFFORTS, KEEP_AWAKE, LOW_POWER, NotifySettings, RUN_ON, SETTLE_IDLE_DAYS_MAX, THEMES, ThreadLimitsSchema, TRUST_LEVELS } from '../shared/settings-schema.js';
import { AUTO_COMPACT_MAX, AUTO_COMPACT_MIN } from '../shared/context-usage.js';
import { PARALLEL_RUNS_MAX, PARALLEL_RUNS_MIN } from '../shared/run-slots.js';
import { CHAT_LIMIT_MAX } from '../shared/chat-limit.js';
import { AUTO_CONTINUE_OFF_MAX } from '../shared/auto-continue.js';
import { ENV_KEY, MAX_ENV_VALUE, MAX_ENV_VARS } from '../shared/env-vars.js';
import { MAX_RANGE } from '../shared/text-range.js';
import { type ArgsRuntime, MAX_AGENT_ARGS, MAX_AGENT_ARG_LENGTH, agentArgsProblem } from '../shared/agent-args.js';
import { NETWORK_API } from './network-api.js';
import { STRIPE_API } from './stripe-api.js';
import { REVENUECAT_API } from './revenuecat-api.js';
import { TRIAGE_API } from './triage-api.js';
import { SUPPORT_API } from './support-api.js';
import { TELEMETRY_API } from './telemetry-api.js';
import { STATS_API } from './stats-api.js';
import { WEB_API } from './web-api.js';
import { DIAGNOSTICS_API } from './diagnostics-api.js';
import { CLAUDE_CODE_API } from './claude-code-api.js';
import { STEPS_API } from './steps-api.js';
import { EXTERNAL_API } from './external-api.js';
import { GATEWAY_API } from './gateway-api.js';
import { BOARD_API } from './board-api.js';
import { CI_API } from './ci-api.js';
import { DASHBOARD_API } from './dashboard-api.js';
import { SENTINEL_API } from './sentinel-api.js';
import { PLANS_API } from './plans-api.js';
import { DIALOGUES_API } from './dialogues-api.js';
import { ISSUES_API } from './issues-api.js';
import { TEAM_API } from './team-api.js';
import { GIT_API } from './git-api.js';
import { VIEWS_API } from './views-api.js';
import { PREVIEW_API } from './preview-api.js';
import { MCP_APPS_API } from './mcp-apps-api.js';
import { FILES_EDIT_API } from './files-api.js';
import { COMPANION_API } from './companion-api.js';
import { MACHINE_API } from './machine-api.js';
import { ASSISTANT_API } from './assistant-api.js';
import { CHATS_API } from './chats-api.js';
import { VOICE_API } from './voice-api.js';
import { CALLS_API } from './calls-api.js';
import { TERMINAL_IMPORT_API } from './terminal-import-api.js';
import { AGENT_TERM_API } from './agent-term-api.js';
import { HANDOFF_MODES } from '../shared/agent-handoff.js';
import { FETCH_EVERY_MAX, FETCH_EVERY_MIN } from '../shared/background-fetch.js';

/**
 * Everything a client can ask Beluga to do, in one list. The daemon validates every call
 * against it (handlers.ts implements each one), and the Mac app calls through it, so the
 * two can't drift apart. Browser-safe: no Node imports.
 *
 * Each entry is the method's arguments as a zod tuple. Results are typed from the handlers.
 */

const str = z.string().max(64_000);
const id = z.string().min(1).max(200);
const channel = z.string().min(1).max(200);
const path = z.string().max(4096);
const bool = z.boolean();
/** A worktree id a screen chose (wt- and 12 of a UUID's characters, as the core makes them). */
export const WorktreeId = z.string().regex(/^wt-[0-9a-f-]{12}$/);
const opt = <T extends z.ZodType>(t: T) => t.optional();
function args(): { args: z.ZodTuple<[], null> };
function args<T extends [z.ZodType, ...z.ZodType[]]>(...items: T): { args: z.ZodTuple<T, null> };
function args(...items: z.ZodType[]): { args: z.ZodTuple } {
  return { args: items.length ? z.tuple(items as [z.ZodType, ...z.ZodType[]]) : z.tuple([]) };
}

export const Location = z.object({ owner: id, share: z.string().min(1).max(200), path });

/** A project (all its worktrees, now and later) or one worktree, shared with a friend over the network. */
const FriendShare = z.object({ peerId: id, projectId: opt(id), workspaceId: opt(id), role: WsRole, whole: opt(bool) }).refine((x) => x.projectId || x.workspaceId, 'Say which project or worktree');
const FriendUnshare = z.object({ peerId: id, projectId: opt(id), workspaceId: opt(id) }).refine((x) => x.projectId || x.workspaceId, 'Say which project or worktree');

/** Your flags for one agent's command line, refused when Beluga sets one of them itself (shared/agent-args.ts). */
const agentArgs = (runtime: ArgsRuntime) =>
  z
    .array(z.string().max(MAX_AGENT_ARG_LENGTH))
    .max(MAX_AGENT_ARGS)
    .superRefine((args, ctx) => {
      const problem = agentArgsProblem(runtime, args);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    });

/** How many experiment ids a list may hold (more than there are: a newer Beluga's stay). */
const EXPERIMENTS_MAX = 20;

/** A settings change (no defaults: only the keys you send change). */
export const PrefsPatch = z
  .object({
    theme: z.enum(THEMES),
    mouse: bool,
    tunnel: z.enum(['auto', 'p2p', 'cloudflared', 'ngrok', 'none']),
    keepAwake: z.enum(KEEP_AWAKE),
    runOn: z.string().regex(RUN_ON),
    lowPower: z.enum(LOW_POWER),
    selfApproval: z.enum(['never', 'ask']),
    notify: NotifySettings,
    // null: back to the default (JSON can't carry undefined, so "unset" travels as null).
    model: z.string().max(80).nullable().optional(),
    effort: z.enum(EFFORTS).nullable().optional(),
    // Which models the chat menu offers (`runtime|value`). Empty: every model.
    openModels: z.array(z.string().max(120)).max(80),
    // Who answers "@you" (null: back to Claude), and per-project ones by project name (BLG-444).
    defaultAgent: AgentRef.nullable().optional(),
    projectAgents: z.record(z.string().min(1).max(80), AgentRef),
    autoSetup: bool,
    branchPrefix: z.string().regex(BRANCH_PREFIX_RE, 'Use letters, digits and . _ - / only'),
    contextMeter: bool,
    autoCompact: bool,
    autoCompactAt: z.number().int().min(AUTO_COMPACT_MIN).max(AUTO_COMPACT_MAX),
    autoContinue: bool,
    autoContinueOff: z.array(z.string().max(200)).max(AUTO_CONTINUE_OFF_MAX),
    autoContinueSkip: z.number().int().min(0),
    parallelRuns: z.number().int().min(PARALLEL_RUNS_MIN).max(PARALLEL_RUNS_MAX),
    chatLimit: z.number().int().min(0).max(CHAT_LIMIT_MAX),
    agentThreads: bool,
    threadLimits: ThreadLimitsSchema,
    chatCategories: bool,
    settleOnMerge: bool,
    settleIdleDays: z.number().int().min(0).max(SETTLE_IDLE_DAYS_MAX),
    archiveSettledDays: z.number().int().min(0).max(ARCHIVE_SETTLED_DAYS_MAX),
    pushToPr: bool,
    // Minutes between background fetches; 0: never on its own (#479).
    fetchEvery: z.union([z.literal(0), z.number().int().min(FETCH_EVERY_MIN).max(FETCH_EVERY_MAX)]),
    prOnReview: bool,
    scratchFolder: bool,
    subagents: z.enum(['full', 'compact', 'hidden']),
    hiddenButtons: z.array(z.string().max(40)).max(40),
    friendWorktrees: z.enum(['ask', 'off']),
    chatClaude: z.enum(['everyone', 'trusted', 'off']),
    shareUsage: z.enum(['trusted', 'everyone', 'off']),
    readReceipts: bool,
    // null: back to the login shell (JSON can't carry undefined, so "unset" travels as null).
    shell: z.string().max(200).nullable().optional(),
    shellLogin: bool,
    shellArgs: z.array(z.string().max(200)).max(20),
    claudeArgs: agentArgs('claude'),
    codexArgs: agentArgs('codex'),
    earningsCurrency: z.string().regex(/^[a-z]{3}$/).nullable().optional(),
    // Experimental features that are on (shared/experiments.ts): the whole list each time.
    experiments: z.array(z.string().max(40)).max(EXPERIMENTS_MAX),
  })
  .partial();

/** Environment variables for one place (names checked; empty rows are skipped). */
const EnvRows = z.array(z.object({ key: z.union([z.literal(''), z.string().regex(ENV_KEY, 'Use letters, digits and _ only').max(200)]), value: z.string().max(MAX_ENV_VALUE) })).max(MAX_ENV_VARS + 50);

const WorkspaceTab = z.enum(['chat', 'files', 'review', 'terminal']);
const Policy = z.enum(['ask', 'auto', 'deny']);
/** 'project': always, for this project (only a .env approval offers it). */
const Answer = z.enum(['yes', 'no', 'always', 'project']);
const LinkOptions = z.object({ scope: id, can: GuestCan, knock: bool, singleUse: bool, expiresInMs: z.number().int().min(0) });
const GuestPatch = z.object({ addProject: opt(id), room: opt(bool), can: opt(GuestCan) });
/** A project (by id) or a group (by name) in the sidebar's arrangement. */
const ArrangeTarget = z.union([z.object({ project: id }).strict(), z.object({ group: z.string().min(1).max(80) }).strict()]);
const TermSize = z.object({ cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) });

export const API = {
  // ---- the room, chat and your preferences
  // `terminal`: the conversation is seen as its agent's terminal and hasn't had a turn yet: that opens on the message (BLG-553).
  'session.submit': args(str, opt(z.object({ channel: opt(channel), urgent: opt(bool), id: opt(id), terminal: opt(bool) }))),
  'session.copyInvite': args(),
  'session.copyLastAnswer': args(),
  'session.copyText': args(str, z.string().max(500)),
  'session.setPrefs': args(PrefsPatch),
  'session.setPlanMode': args(channel, bool),
  'session.setClaudeSharing': args(Policy),
  'session.rename': args(z.string().max(64)),
  'session.zoom': args(z.enum(['in', 'out', 'reset'])),
  'session.shareFolder': args(path, opt(bool), opt(z.array(id).max(50))),
  'session.unshareFolder': args(id),
  'session.follow': args(opt(z.string().max(64))),
  'session.clearChat': args(channel, opt(z.object({ everyone: opt(bool), fresh: opt(bool) }))),
  // BLG-702: put an emoji on a message of the group chat or a workspace chat (`true`), take yours off (`false`), or flip it (none): → its reactions.
  'session.react': args(channel, z.string().regex(/^[\w:+/=.-]{1,200}$/), EmojiSchema, opt(bool)),
  'session.removePerson': args(id),
  'session.newInviteLink': args(),
  'session.setRoomOpen': args(bool),
  'session.retryConnection': args(),
  'session.setFriendWorktrees': args(z.enum(['ask', 'off'])),
  'session.setAccess': args(id, z.enum(['folder', 'full'])),
  'session.runOnPeerByHand': args(z.string().max(64), str, opt(channel)),
  'session.stopAgent': args(),
  'session.compact': args(channel, opt(z.string().max(2000))),
  // A side question (/btw): answered beside the conversation, never part of it; resolves once answered.
  'session.btw': args(channel, z.string().min(1).max(4000)),
  'session.btwDismiss': args(channel),
  'session.quit': args(),
  'session.serveFolder': args(id, path, z.array(id).max(50)),
  'session.localLocation': args(path, bool),
  'session.testNotification': args(),

  // ---- your Claude's queue and approvals
  'host.answerApproval': args(Answer, id),
  // Steer a waiting message now: read at the agent's next step. `interrupt` (a plan's Steer Now): a long command or a stuck turn is stopped for it.
  'host.promote': args(id, opt(z.object({ interrupt: opt(bool) }))),
  // Send a waiting message next, never interrupting (Send Now).
  'host.sendNext': args(id),
  // Send now a message steered into the running turn that Claude hasn't read yet: its step stops, your message is next (BLG-54).
  'host.steerNow': args(id),
  // Cancel a message steered into the running turn that Claude hasn't read yet: → { cancelled, prompt: its words, for the box }.
  'host.cancelSteer': args(id),
  // Stop your Claude in one conversation: → { stopped, returned: your queued prompts, in order }.
  'host.stopRun': args(channel),
  // A person's Stop on one child thread, from the parent's panel.
  'threads.stop': args(id),
  // A person's Stop All Running on a chat's threads: its own turn goes on → { stopped: how many }.
  'threads.stopAll': args(id),
  'host.cancelQueued': args(id),
  'host.reorderQueued': args(id, z.number().int().min(0).max(100)),

  // ---- the inbox
  'inbox.read': args(opt(z.object({ channel: opt(channel), id: opt(z.number().int()) }))),
  'inbox.unread': args(z.number().int()),
  'inbox.clear': args(opt(z.object({ id: opt(z.number().int()) }))),

  // ---- Claude's questions and plans
  'questions.answer': args(id, ClaudeAnswer),
  'questions.pick': args(id, z.string().max(2000), z.string().max(4000)),

  // ---- people and trust
  'people.setTrust': args(id, z.enum(TRUST_LEVELS)),
  'people.dismissPrompt': args(id),

  // ---- what needs you: Dismiss takes an item off every list (phone, the Mac's bell) without answering it
  'needs.dismiss': args(z.string().min(1).max(300)),
  'people.forget': args(id),

  // ---- workspaces you share, and ones shared with you
  'sharing.invite': args(id, id, WsRole),
  'sharing.remove': args(id, id),
  'sharing.leave': args(id, id),
  // Over the network, with friends (core/friend-share): nobody hosts, it stays while someone is offline.
  'sharing.shareWithFriend': args(FriendShare),
  'sharing.unshareFriend': args(FriendUnshare),
  // Leave a project a friend shared with you (owner, project id).
  'sharing.leaveProject': args(id, id),
  // Make (or try again to make) your own copy of a project a friend shares with you whole (owner, project id).
  'sharing.copyProject': args(id, id),
  // A friend's shared worktree's scratch folder, for your Scratch tab (owner, worktree id).
  'sharing.scratch': args(id, id),
  // Scrolling back in a friend's shared worktree: its page of conversation before what you have (owner, worktree id).
  'sharing.earlier': args(id, id),
  // Say it in a friend's worktree but to your own Claude, in your copy of the project (owner, worktree id, message).
  'sharing.runHere': args(id, id, z.string().min(1).max(100_000)),
  // Fork a friend's shared worktree to this Mac: its changes, Scratch and conversation, as a worktree of yours (owner, worktree id, name?).
  'sharing.fork': args(id, id, z.string().max(120).optional()),

  // ---- links into one project (or everything)
  'invites.create': args(LinkOptions),
  'invites.revoke': args(id),
  'invites.copyLink': args(id),
  'invites.letIn': args(id, opt(GuestCan)),
  'invites.decline': args(id),
  'invites.change': args(id, GuestPatch),
  'invites.remove': args(id),

  // ---- work on a friend's computer
  'remote.requestWorktree': args(id, z.string().max(80), str, opt(bool)),
  'remote.handoff': args(id, id),
  // Can this worktree go to them (who they are, and whether their Mac has the repository)? Asked as the Hand Off sheet opens.
  'remote.canHandOff': args(id, id),

  // ---- a workspace shared with you: what changed, and its read-only shell
  'diff.load': args(id),
  'diff.select': args(z.number().int().min(0)),
  'shell.run': args(id, z.string().max(2000)),
  'shell.openEntry': args(id, path, bool),

  // ---- shared files: browsing, the viewer, downloads
  'files.browseTo': args(Location),
  'files.enter': args(z.number().int().min(0)),
  'files.up': args(),
  'files.loadDir': args(Location),
  'files.open': args(Location, opt(z.object({ by: opt(z.string().max(80)), broadcast: opt(bool) }))),
  'files.openSpec': args(z.string().max(4096)),
  // `to`: save exactly there (an absolute path from a Save dialog) instead of ~/Downloads/Beluga.
  'files.download': args(Location, opt(z.object({ to: opt(path) }))),
  'files.downloadSpec': args(z.string().max(4096)),
  'files.closeViewer': args(),
  'files.readImage': args(),
  // An image a document points at (Markdown's ![](diagram.png)), a PDF or a video (the reader plays it), read the way files.open reads one: → { mediaType, data (base64) }.
  'files.readImageFile': args(Location),
  // Which version of a file this is, without reading it: → { size, mtime (ms) }. A picture kept by its path is read again once either changes (BLG-749).
  'files.version': args(Location),
  // A file's text without opening it in the viewer (the Mac Changes tab shows a changed file as itself): → { content, truncated }.
  'files.read': args(Location),
  // One piece of a file's text (BLG-791): `length` bytes from `offset`, ended on a line → TextRange { content, offset, next?, total, mtime, binary?, stale? }. `cache`: a copy fetched moments ago will do (on a computer, this Mac's cache answers it).
  'files.readRange': args(Location, z.object({ offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), length: z.number().int().min(1).max(MAX_RANGE), cache: opt(bool) }).strict()),

  // ---- projects and workspaces
  // `req`: a screen's id for this open, echoed in the navigate intent (it showed the workspace ahead, see ClientStore.openAhead).
  'workspaces.open': args(id, opt(WorkspaceTab), opt(z.object({ req: opt(z.string().max(64)) }))),
  // Load a workspace's saved conversation without going there (the Mac Overview's read-only look at an archived one).
  'workspaces.load': args(id),
  'workspaces.refresh': args(),
  // Set the display name. A worktree's own branch takes it too unless it's on a remote (a / in it: exactly that branch); the folder stays. → { name, branch?, branchKept? }.
  'workspaces.rename': args(id, z.string().trim().min(1).max(200)),
  // Generate a title from recent chat content. The chat session stays unchanged.
  'workspaces.regenerateTitle': args(id),
  // Remind Me Later: a chat or worktree stays quiet (its news, failing checks, conflicts) until then (epoch ms), then you're reminded once. Null or left out: show it again now.
  'workspaces.newWorktree': args(id, z.string().max(200), opt(z.object({ base: opt(z.string().min(1).max(250)), agent: opt(AgentRef) }))),
  'workspaces.newChat': args(id, z.string().max(200), opt(path)),
  // `terminal`: you see it as its agent's terminal, so that opens on the message (BLG-553).
  'workspaces.startChat': args(id, str, opt(path.nullable()), opt(z.object({ terminal: opt(bool), plan: opt(bool) }))),
  // → the new worktree's id. `plan`: its Claude plans first. `tasks`: Plan with Tasks, its conversation is a
  // draft plan's home, written from the first message. `quiet`: started from the phone, the Mac's window stays put.
  // `id`: the id it gets, chosen by the screen that shows it as being made already (BLG-942; taken only when free).
  'workspaces.startWorktree': args(id, str, opt(z.object({ base: opt(z.string().min(1).max(250)), name: opt(z.string().max(200)), plan: opt(bool), tasks: opt(bool), quiet: opt(bool), agent: opt(AgentRef), terminal: opt(bool), id: opt(WorktreeId) }))),
  // What a new worktree can start from: → { base: the default, branches: default first, then newest }.
  'workspaces.branches': args(id),
  'workspaces.fork': args(id, z.string().max(200)),
  // Edit a message you sent (workspace, message id, its new words, how): 'here' rewinds this conversation to it (files too), 'fork' goes on in a new worktree or chat → the conversation it went on in.
  'workspaces.editPrompt': args(id, id, str, z.enum(['here', 'fork'])),
  // Carry a conversation (an ask chat in a main folder, or any chat) into a new worktree and go on there → the new workspace's id.
  // `agent` (BLG-506): who goes on there; unset: the conversation's own. One that can't resume the conversation starts fresh, handed it.
  'workspaces.continueInWorktree': args(id, opt(z.object({ task: opt(str), base: opt(z.string().min(1).max(250)), name: opt(z.string().max(200)), agent: opt(AgentRef) }).strict())),
  // Continue On another computer (BLG-808), as your app runs it (src/machines/move.ts). Here: its branch,
  // changes not committed (asked about), whether its agent is at work, its project → WorktreeCheck.
  'workspaces.moveCheck': args(id),
  // Packed to go: its branch pushed (or bundled), its conversation; changes not committed only with commit → { token, chunks }.
  'workspaces.movePack': args(id, z.object({ commit: opt(bool), to: z.string().min(1).max(80) }).strict()),
  'workspaces.moveChunk': args(z.string().uuid(), z.number().int().min(0).max(200)),
  // There: one piece coming in, then landed as a worktree on its branch in that project → its id (the .env ask follows).
  'workspaces.moveReceive': args(z.string().uuid(), z.number().int().min(0).max(200), z.number().int().min(1).max(201), z.string().max(2 * 1024 * 1024)),
  'workspaces.moveLand': args(z.string().uuid(), id, z.string().min(1).max(80)),
  // Here: the new one runs there, this one is archived (saying where it went). There: a landed one whose move didn't finish, archived again.
  'workspaces.moveDone': args(id, z.string().min(1).max(80)),
  'workspaces.moveUndo': args(id),
  // `quiet`: no success toast; a batch says it once for all its chats (the sidebar's chat selection).
  'workspaces.archive': args(id, opt(bool), opt(z.object({ children: opt(z.enum(['with', 'keep'])), quiet: opt(bool) }).strict())),
  'workspaces.restore': args(id),
  // What archiving (or freeing space) would throw away and keep → ArchivePreview (none: not a worktree that's there).
  'workspaces.archivePlan': args(id),
  // What deleting would lose that archiving keeps → DeletePlan (none: nothing pushed nowhere, or not a worktree of ours).
  'workspaces.deletePlan': args(id),
  // Throw away a worktree's dependencies, builds and caches → bytes freed.
  'workspaces.freeSpace': args(id),
  // `quiet`: as for archive.
  'workspaces.remove': args(id, opt(z.object({ children: opt(z.enum(['with', 'keep'])), quiet: opt(bool) }).strict())),
  'workspaces.commit': args(id, opt(z.string().max(2000))),
  'workspaces.merge': args(id),
  'workspaces.prepareRemoval': args(id),
  'workspaces.applyEnvBack': args(id, opt(bool)),
  // A worktree's env changes stay there: not asked about again until they change (BLG-369).
  'workspaces.keepEnvHere': args(id),
  // Save a worktree's env changes as the project's own variables in Beluga (every worktree gets them; the main .env is left alone).
  'workspaces.saveEnvInBeluga': args(id),
  // Look at a project's worktrees' env files now (untouched copies follow the main folder; changed ones are asked about).
  'workspaces.checkEnv': args(id),
  // The ports a worktree's processes listen on now (BLG-801): [{ port, pid, name (vite, next…), host }].
  'workspaces.ports': args(id),
  'workspaces.askClaudeToReview': args(id),
  'workspaces.askClaudeToMerge': args(id),
  'workspaces.compact': args(id, opt(z.string().max(2000))),
  'workspaces.openInFinder': args(id),
  'workspaces.setGroup': args(id, opt(z.string().max(80))),
  'workspaces.renameGroup': args(z.string().min(1).max(80), z.string().max(80)),
  'workspaces.ungroup': args(z.string().min(1).max(80)),
  // Arranging the sidebar: move a project (into a group or to the top level) or a group, before another item or last.
  'workspaces.arrange': args(ArrangeTarget, opt(z.object({ into: opt(z.string().min(1).max(80).nullable()), before: opt(ArrangeTarget.nullable()) }).strict())),
  // A new empty group, before an item or last; with a project, it moves in. → its name.
  'workspaces.newGroup': args(z.string().min(1).max(80), opt(z.object({ before: opt(ArrangeTarget.nullable()), project: opt(id) }).strict())),
  'workspaces.showProject': args(path),
  'workspaces.hideProject': args(id),
  // Delete Project: out of Beluga (worktrees archived losslessly); `trash`: its folder to the Trash too.
  'workspaces.removeProject': args(id, opt(z.object({ trash: opt(bool) }).strict())),
  'workspaces.cleanAgentWorktrees': args(id),
  // Worktrees Beluga didn't make (Conductor's, Claude Code's, a script's): who made them, their info page, tidying up.
  'workspaces.otherOrigins': args(id),
  // When each one last changed (git's view): the Mac sidebar lists them most recent first.
  'workspaces.otherActivity': args(id),
  'workspaces.worktreeInfo': args(id),
  'workspaces.showConversation': args(id, z.string().min(1).max(100)),
  // Claude Code conversations from outside Beluga in a project's folder (or `path`), and going on with one in a new worktree (BLG-321).
  'workspaces.outsideConversations': args(id, opt(path)),
  'workspaces.importOutside': args(id, path, z.string().regex(/^[\w-]{1,100}$/), opt(z.string().max(120))),
  'workspaces.removeOther': args(id, opt(bool)),
  'workspaces.staleOthers': args(id, opt(z.enum(['conductor', 'claude', 'other']))),
  'workspaces.cleanUpOthers': args(id, z.array(id).max(500)),
  'workspaces.addProject': args(path),
  'workspaces.addFolder': args(path),
  'workspaces.selectFile': args(z.number().int().min(0)),
  // Work out changed file N's diff ahead of a click (the file under the pointer): the pick then shows it at once (BLG-853).
  'workspaces.diffAhead': args(z.number().int().min(0)),
  // Load (or reload) what changed in a workspace without going to it (the Mac app's Changes panel).
  'workspaces.review': args(id),
  // A workspace's scratch folder (.beluga/scratch/): where it is and its files, newest first. → { root, dir, files: [{ path, size, mtime }] }
  'workspaces.scratch': args(id),

  // ---- runs, scripts, pull requests, models, search, templates
  'workbench.run': args(id),
  'workbench.stopRun': args(id),
  'workbench.runSetup': args(id),
  'workbench.setScript': args(id, z.enum(['setup', 'run']), z.string().max(2000), opt(bool)),
  'workbench.shareScripts': args(id),
  'workbench.setModel': args(opt(channel), z.string().max(80)),
  /**
   * Thinking effort for one conversation (the composer’s meter). `''` clears it, so Settings apply again.
   * The phone does not set effort.
   */
  'workbench.setEffort': args(channel, z.union([z.enum(EFFORTS), z.literal('')])),
  /**
   * A conversation's agent (BLG-446): its runtime and model; null goes back to your default agent (nullish: over the socket a null arrives as undefined, see daemon/dispatch.ts).
   * Then, when the new agent can't read the session (BLG-592): 'quiet' switches now and sends the recent conversation with your next message; 'note' (left out) has the old agent write a handoff note first.
   */
  'workbench.setAgent': args(channel, AgentRef.nullish(), opt(z.enum(HANDOFF_MODES))),
  'workbench.createPr': args(id, opt(str)),
  // Create PR without Claude: commit what's left, push, open it titled from the commits → { ok, message, trouble? }.
  // https: push this once over HTTPS with gh's login (the SSH key isn't working; origin stays as it is).
  'workbench.quickPr': args(id, opt(z.object({ draft: opt(bool), https: opt(bool), original: opt(bool), own: opt(bool) }).strict())),
  // Merge into its base with no PR (BLG-265): commit what's left, land the branch on origin/<base> and push it there → { ok, message, trouble? }.
  'workbench.mergeToBase': args(id, opt(z.object({ https: opt(bool) }).strict())),
  // A fix from a GitHub trouble card (BLG-213), then Create PR again ('pr', 'pr_draft'), Merge into its base ('merge_base') or nothing ('none') → { ok, message, trouble? }.
  'workbench.gitFix': args(id, z.enum(['push_https', 'use_https', 'install_gh', 'gh_login', 'add_ssh_key', 'check_host', 'retry']), opt(z.enum(['pr', 'pr_draft', 'pr_original', 'merge_base', 'none']))),
  // A failed run's card when Claude Code isn't signed in: `claude auth login` in your shell `id` (shell:N), then Claude goes on in `channel` → { ok, message }.
  // How: 'claudeai' (a Claude subscription, the default) or 'console' (an Anthropic Console account, API billing).
  'workbench.signInClaude': args(id, channel, opt(z.enum(['claudeai', 'console']))),
  'workbench.fixChecks': args(id),
  'workbench.resolvePrConflicts': args(id),
  'workbench.continueAfterMerge': args(id),
  'workbench.openPr': args(id),
  // Merge a worktree's PR on GitHub (gh pr merge); auto: once its checks pass. → { ok, result | reason, message }
  'workbench.mergePr': args(id, z.object({ method: z.enum(['squash', 'merge', 'rebase']), auto: opt(bool), deleteBranch: opt(bool), admin: opt(bool) }).strict()),
  // A PR's one-click step on GitHub: bring its base in ('update_branch') or mark a draft ready ('ready') → { ok, message }.
  'workbench.prStep': args(id, z.enum(['update_branch', 'ready'])),
  // Push a worktree's commits to its open PR (GitHub's checks and conflicts were for an older commit) → { ok, message, trouble? }.
  'workbench.pushPr': args(id),
  // Re-run a PR's failed GitHub Actions jobs on the same commit (gh run rerun --failed) → { ok, message, trouble? }.
  'workbench.rerunChecks': args(id),
  // A worktree's PR conversation: comments, reviews and threads on lines (BLG-514).
  'workbench.prConversation': args(id),
  'workbench.prPost': args(id, z.discriminatedUnion('kind', [z.object({ kind: z.literal('comment'), body: z.string().min(1).max(60_000) }).strict(), z.object({ kind: z.literal('reply'), thread: z.string().min(1).max(200), body: z.string().min(1).max(60_000) }).strict(), z.object({ kind: z.enum(['resolve', 'unresolve']), thread: z.string().min(1).max(200) }).strict()])),
  'workbench.addressPrComments': args(id, opt(z.string().min(1).max(200))),
  // Lines of a file in a workspace, for a beluga-code block in chat → { ok, excerpt | message }.
  'workbench.openCode': args(id, z.string().min(1).max(1000), opt(z.number().int().min(1))),
  'workbench.excerpt': args(id, z.string().min(1).max(1000), opt(z.number().int().min(1)), opt(z.number().int().min(1))),
  // Stop Merge When Ready from merging it (GitHub's auto-merge too) → { ok, message }.
  'workbench.cancelMergeWhenReady': args(id),
  // A worktree's PR now (or all of them; true: check gh again), or { reason } to look at what's due:
  // 'focus' (the window came forward) or 'push' (a branch was pushed; id: which worktree).
  'workbench.refreshPrs': args(opt(z.union([id, z.object({ reason: z.enum(['focus', 'push']), id: opt(id) }).strict()])), opt(bool)),
  'workbench.editPrPrompt': args(),
  'workbench.resetPrPrompt': args(),
  'workbench.measureDisk': args(),
  // Check Again (BLG-507): every agent asked now (Claude Code signed in? Codex installed and signed in?) → RuntimeChoice[].
  'workbench.checkAgents': args(),
  // An agent's own sign-in (claude auth login, codex login), opened in Terminal → true when it opened.
  'workbench.agentSignIn': args(z.string().regex(/^[a-z][\w-]{0,31}$/)),
  'workbench.search': args(z.string().max(500)),
  'workbench.openHit': args(z.number().int().min(0)),
  'workbench.saveTemplate': args(str, opt(bool)),
  'workbench.removeTemplate': args(id),

  // ---- terminals (the bytes themselves stream separately; see protocol.ts)
  'terminals.shell': args(id, opt(TermSize)),
  'terminals.global': args(id, path, opt(TermSize)),
  'terminals.close': args(id),
  // Start a shell or the run command again with your variables as they are now (its name stays).
  'terminals.restart': args(id),
  'terminals.rename': args(id, z.string().max(200)),

  // ---- your environment variables (no project: yours everywhere; else that project's)
  'env.get': args(opt(id)),
  'env.set': args(opt(id), EnvRows, opt(bool)),
  // Your own Claude reads .env files without asking (false: it asks again), in a project or (none) everywhere.
  'env.claudeDotenv': args(opt(id), bool),
  // Connect to the database a view would use there (a project, or none: yours) → { ok, from } or { ok: false, message } (never a value).
  'env.testDatabase': args(opt(id)),
  // Copy a project's main folder .env values into its own variables (kept even if the file goes) → how many were added.
  'env.importDotenv': args(id),
  // Keys a worktree adds go into the project's main .env on their own (on by default).
  'env.newKeysBack': args(id, bool),
  // A worktree's own variables, over its project's (BLG-924) → them, with what it gets from below and its .env.example.
  'env.worktree': args(id),
  'env.setWorktree': args(id, EnvRows),
  // Before a worktree goes: its own variables into the project's (same name: the worktree's wins) → how many.
  'env.carryWorktree': args(id),
  // A project's environment in names and counts (its page, the phone): never a value.
  'env.overview': args(id),
  // List in the main folder's .env.example what's set and it doesn't list (placeholders, never values) → the names added.
  'env.addToExample': args(id),
  // Keys a worktree adds to or removes from its .env reach its .env.example (on by default, BLG-925).
  'env.exampleSync': args(id, bool),
  // Local and bring-your-own endpoints (BLG-449): → each with its URL and models, never its key (hasKey).
  'env.endpoints': args(),
  // Add (no id) or change one; key unset keeps it, '' removes it → its id.
  'env.saveEndpoint': args(z.object({ id: opt(z.string().max(20)), label: z.string().min(1).max(40), baseUrl: z.string().min(1).max(500), key: opt(z.string().max(4000)), models: opt(z.array(z.string().max(40)).max(20)) })),
  'env.removeEndpoint': args(z.string().max(20)),
  // Look at every endpoint again now → the list, with which answer.
  'env.checkEndpoints': args(),

  // ---- images in a message (screens without their own disk access: the Mac app)
  'attachments.add': args(z.enum(['png', 'jpg', 'jpeg', 'gif', 'webp']), z.string().max(6_000_000)),
  // An image file on this Mac (its path was pasted), copied in and made smaller if it's too big. → { n, chip, file }
  'attachments.addFile': args(path),
  // An image you linked in a message (its file name), waiting in the box again. → { n, chip }
  'attachments.reattach': args(z.string().min(1).max(255)),
  // `only`: the images waiting in the box (others' "[image N]" stay words). `shown`: the number each
  // of them has in the box, which its "[image N]" says (else N is the image's own number).
  'attachments.expand': args(str, channel, opt(z.array(z.number().int().positive()).max(100)), opt(z.array(z.number().int().positive()).max(100))),
  // An image linked in a message (owner peer id, file name): its bytes to show, or opened in Preview.
  'attachments.read': args(id, z.string().min(1).max(255)),
  'attachments.open': args(id, z.string().min(1).max(255)),

  // ---- Beluga itself
  'daemon.stop': args(),

  // ---- projects on this computer: their icons, adding them
  'projects.icon': args(id),
  'projects.setIcon': args(id, opt(path)),
  'projects.add': args(path),
  // A project's git origin (none: it has none), for matching it on, or cloning it to, one of your computers (BLG-788).
  'projects.origin': args(id),
  'projects.addFolder': args(path),
  // Make a folder that isn't a git project one (git, a .gitignore, a first commit), then add it.
  'projects.initGit': args(path),
  'projects.suggest': args(),
  // Start a new project: a folder (name, in this folder or your code folder), git and a first commit → { id, path }.
  'projects.create': args(z.string().max(100), opt(path)),
  // A project from its git address (https or ssh), cloned into this folder or your code folder, then added → { id, path, existed? }
  // (existed: a project of that repository was here already, so nothing was cloned).
  'projects.clone': args(z.string().min(1).max(500), opt(path)),
  // Where a new project goes unless you pick somewhere.
  'projects.newHome': args(),
  // Your GitHub repositories (through gh's sign-in), most recently pushed first, for the Clone tab → { gh, repos: [{ fullName, url, private, pushedAt, here? }] }.
  'projects.myRepos': args(),
  // The icon of a folder that isn't a project yet (one of the suggestions).
  'projects.iconAt': args(path),

  // ---- this computer
  'local.listDirs': args(path),
  // A folder of this computer for a browser's folder picker (BLG-651): where it is, its parent, its folders. → { path, parent?, home, dirs: [{ name, git }] }
  'local.browse': args(opt(path)),
  'local.openFolder': args(path),
  // Pasted paths: is each a file, a folder, or nothing? (Read-only.) → [{ path, name, kind, size, image }]
  'local.statFiles': args(z.array(path).min(1).max(20)),

  // ---- the Beluga network: friends, direct messages, groups, your status (network-api.ts)
  ...NETWORK_API,

  // ---- earnings from Stripe, per project (stripe-api.ts)
  ...STRIPE_API,
  // ---- earnings from RevenueCat, per project, added to Stripe's (revenuecat-api.ts)
  ...REVENUECAT_API,
  // ---- supporting Beluga: the star and coffee asks merges bring (support-api.ts)
  ...SUPPORT_API,
  // ---- usage statistics: your level (Off, Limited, On), the ask after an update, what's sent (telemetry-api.ts)
  ...TELEMETRY_API,
  // ---- your stats in the Usage tab: counted by the daemon, pastes and dictation from the Mac (stats-api.ts)
  ...STATS_API,
  // ---- problem reports: the daemon's black box in one redacted file (diagnostics-api.ts)
  ...DIAGNOSTICS_API,
  ...CLAUDE_CODE_API,
  ...STEPS_API,
  ...EXTERNAL_API,
  ...GATEWAY_API,
  // ---- tasks: the board, its tasks and their briefs (board-api.ts)
  ...BOARD_API,
  // ---- Sentinel: watchers on a schedule or by hand, their runs and reports (sentinel-api.ts)
  ...SENTINEL_API,
  // ---- Dashboards: the numbers sentinels keep, arranged in tiles (dashboard-api.ts)
  ...DASHBOARD_API,
  ...PLANS_API,
  ...DIALOGUES_API,
  // ---- a project's GitHub issues, and handing one to Claude (issues-api.ts)
  ...ISSUES_API,
  // ---- a project's GitHub Actions: its runs, a run's jobs and steps, its workflows (ci-api.ts)
  ...CI_API,
  // ---- team boards: friends on the same GitHub repository keep one board (team-api.ts)
  ...TEAM_API,
  // ---- each chat's category for you (triage-api.ts)
  ...TRIAGE_API,
  // ---- git: keeping main current, GitHub, history (git-api.ts)
  ...GIT_API,
  ...VIEWS_API,
  ...PREVIEW_API,
  // ---- MCP Apps: a UI tool's app in the chat (mcp-apps-api.ts)
  ...MCP_APPS_API,
  // ---- your workspace's files: searching their contents, editing, formatting (files-api.ts)
  ...FILES_EDIT_API,
  // ---- your phone: pairing it, removing it, what it asks for (companion-api.ts)
  ...COMPANION_API,
  // ---- your devices and computers: pairing one, your device set, forgetting a device (machine-api.ts)
  ...MACHINE_API,
  // ---- Your Mac's chats, as tabs on the Mac (assistant-api.ts)
  ...ASSISTANT_API,
  // ---- a chat's address: what it is now (chats-api.ts)
  ...CHATS_API,
  // ---- speaking instead of typing: the Mac writes it down (voice-api.ts)
  ...VOICE_API,
  // ---- calls in a conversation with friends: voice, screen sharing (calls-api.ts)
  ...CALLS_API,
  // ---- bringing another terminal's look into Beluga's (terminal-import-api.ts)
  ...TERMINAL_IMPORT_API,
  // ---- the agent's own terminal on a conversation, and its visuals (agent-term-api.ts)
  ...AGENT_TERM_API,
  // ---- browsers on the web port: join links, the ones let in, revoking (web-api.ts)
  ...WEB_API,
} as const;

export type Api = typeof API;
export type Method = keyof Api;
export type Args<M extends Method> = z.infer<Api[M]['args']>;

export const METHODS = Object.keys(API) as Method[];

export const isMethod = (name: string): name is Method => Object.hasOwn(API, name);

/** Check a call's arguments (the daemon does this for every call it gets). */
export function parseArgs<M extends Method>(method: M, raw: unknown): Args<M> {
  const parsed = API[method].args.safeParse(raw);
  if (!parsed.success) throw new Error(`Bad arguments for ${method}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data as Args<M>;
}
