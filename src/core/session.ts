import { actingVia, asActingAgent } from './acting-agent.js';
import { closePreviews } from '../preview/off.js';
import { experimentOn } from '../shared/experiments.js';
import { createHash, randomUUID } from 'node:crypto';
import { isTermBusy } from '../shared/terminal-keys.js';
import { agentLabel } from '../shared/agent-label.js';
import { KNOWN_RUNTIMES } from '../shared/agent-runtimes.js';
import { ASSISTANT_TITLE, isAssistant } from '../shared/assistant.js';
import { assistantOf } from './assistant/registry.js';
import os from 'node:os';
import path from 'node:path';
import type { AgentBackend, RoomBridge } from '../agent/types.js';
import type { AgentRuntime, RuntimeCapabilities, RuntimeId, RuntimeOptions } from '../agent/runtime/types.js';
import { guardedBackend } from '../agent/runtime/guard.js';
import { type SideRoute, routeSideCall, routedBackend } from '../agent/runtime/router.js';
import { sideCalls } from '../agent/side-calls.js';
import type { ChatAnswerRequest } from './chat/claude-prompt.js';
import { localRuntime } from '../agent/runtime/local.js';
import { LOCAL_RUNTIME } from '../shared/local-endpoints.js';
import type { LocalEndpoints } from './local-endpoints.js';
import type { IncomingMessage, PeerClient } from '../net/peer-client.js';
import { type AgentRef, Body, type BodyInput, type BodyOf, CLAUDE_AGENT, chatMessageId, defaultAgentOf, type FsEntry, MAX_TEXT, type MessageVia, type PeerInfo, type Profile } from '../protocol.js';
import { type UsageUpdate, withUsage } from '../agent/usage.js';
import { dialoguesOf } from './dialogues/registry.js';
import { agentName } from '../shared/agent-label.js';
import { parseInput, parseWorkspaceMention, workspaceMentions } from './mentions.js';
import { networkOf } from './network.js';
import { mentionNote, personMentions } from './person-mentions.js';
import type { SharedWorkspace } from './collab-store.js';
import { sharedAskTarget } from './shared-guest.js';
import { type ShareService, parseShareSpec } from './shares.js';
import { existsSync } from 'node:fs';
import { type Attention, type Location, type MyShare, type Prefs, type Store, peerName } from './store.js';
import { WorkspaceController } from './workspace-controller.js';
import { QuestionBroker } from './questions.js';
import { isPlanHome } from './plans/model.js';
import type { Conversation } from '../agent/transcript.js';
import { slugify } from '../agent/namer.js';
import type { ScriptFix, SetupFix, WorkedOutScripts } from '../agent/setup-fixer.js';
import type { DraftContext, TaskDraft } from '../agent/task-drafter.js';
import { WorkspaceSharing } from './workspace-sharing.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import { chosenAgent, publishedAgents, type Settings } from './settings.js';
import { runCommand } from './commands.js';
import { People } from './people.js';
import { ReplayGuard } from './replay.js';
import { AgentHost, type ApprovalAnswer } from './agent-host.js';
import { RoomFiles, dirKey } from './room-files.js';
import { createRoomBridge } from './agent-bridge.js';
import { createSessionParts } from './session-parts.js';
import { type Intent, IntentBus } from './intents.js';
import { AttentionRegistry } from './attention.js';
import { currentClient } from './client-context.js';
import { ATTACHMENT_SHARE } from './attachments.js';
import { Notifier } from './notify.js';
import { Workbench } from './workbench.js';
import { RemoteWork } from './remote-work.js';
import type { TerminalManager } from '../terminal/index.js';
import { type PeerRun, type ShellRunner, describeShellResult } from './peer-run.js';
import type { GuestControl, ProjectInvites } from './project-invites.js';
import type { GuestShell } from './guest-shell.js';
import { type SharedDiff, guestMayDo } from './shared-diff.js';
import { coalesce } from './coalesce.js';
import { PowerSaver, paced } from './power-saver.js';
import type { EnvVars } from './env-vars.js';
import { gatewayOf } from './gateway/registry.js';
import { receiveFriendOffer } from './friend-offers.js';
import { onChatReact, reactInChat, type RoomReactDeps } from './room-reactions.js';
import { receiveRoomCall } from './calls/launch.js';

/** Bigger, smaller, or back to normal text. */
export type ZoomDir = 'in' | 'out' | 'reset';

export interface SessionOptions {
  readonly client: PeerClient;
  readonly store: Store;
  readonly shares: ShareService;
  /** Factory so the backend can receive this session's RoomBridge. */
  readonly createAgent?: (bridge: RoomBridge) => AgentBackend;
  /**
   * Your agent through the runtime seam (agent/runtime): `agent` (an AgentRef's runtime, 'claude'
   * when unset) picked from `runtimes`, made with `options`. createAgent, when given, wins (the demo, tests).
   */
  /**
   * With createAgent: other runtimes beside it, each turn whose place picked one of them run there
   * (the demo's scripted Codex, so the Mac e2e can drive a Codex worktree: BLG-462).
   */
  readonly alsoRuntimes?: readonly AgentRuntime[];
  readonly runtime?: {
    readonly runtimes: (id?: RuntimeId) => AgentRuntime | undefined;
    readonly agent?: RuntimeId;
    readonly options: Omit<RuntimeOptions, 'bridge'>;
  };
  readonly agentCwd: string;
  readonly requestTimeoutMs?: number;
  readonly agentTimeoutMs?: number;
  /** Folder Beluga was started in; new stand-alone chats run here. */
  readonly launchDir?: string;
  /** Clipboard writer (injected so tests don't touch the real clipboard). */
  readonly copy?: (text: string) => Promise<unknown>;
  /** Where downloads are saved (default ~/Downloads/Beluga). */
  readonly downloadDir?: string;
  /** Persist a settings change (name, policy, theme…). */
  readonly saveSettings?: (patch: Partial<Settings>) => void;
  /** Open remote access and create an invite (Beluga starts solo; this runs on first Invite). */
  readonly startInvite?: () => void;
  /** How long an unanswered approval waits before it's declined (default 5 minutes). */
  readonly approvalTimeoutMs?: number;
  /** Projects and workspaces on this computer (omit to run without them). */
  readonly workspaces?: WorkspaceManager;
  /** Change the terminal's text size (injected so tests don't resize real windows). */
  readonly zoom?: (dir: ZoomDir) => Promise<{ ok: boolean; message: string }>;
  /** Bring the Mac app's window to the front (its `raise` capability); rejects when no screen can. */
  readonly raise?: () => Promise<unknown>;
  /** Only on the host: who may be in the room, and the invite link. */
  readonly room?: RoomControl;
  /** Terminal sessions for workspaces (omitted in tests). */
  readonly terminals?: TerminalManager;
  /** Show a desktop notification (omitted in tests: the inbox still fills). */
  readonly desktopNotify?: (n: import('./notify.js').DesktopNote) => void;
  /** Open a URL or file with the system (injected in tests). */
  readonly open?: (target: string) => void;
  /** Keep Claude Code current in the background (the Mac app's daemon; never in tests or the demo). */
  readonly updateAgent?: () => Promise<boolean>;
  /** Injected in tests: pull request lookups and the GitHub CLI check. */
  readonly findPr?: import('./workbench.js').WorkbenchDeps['findPr'];
  readonly hasGh?: () => Promise<boolean>;
  /** Trust levels you chose for people before (by key-derived id). */
  readonly savedPeople?: Settings['people'];
  /** Re-reads the saved trust levels (another Beluga with your identity, in another room, may have changed them). */
  readonly loadPeople?: () => Settings['people'];
  /** Where recent requests are remembered across restarts (omit in tests: memory only). */
  readonly replayFile?: string;
  /** Where the details of Claude's steps are kept across restarts (omit in tests: memory only). */
  readonly stepsDir?: string;
  /** Read Claude Code conversations from other tools (omitted in tests and the demo). */
  readonly findConversation?: (dir: string, self: { id: string; name: string }, opts?: { sessionId?: string; prefer?: string }) => Promise<Conversation | undefined>;
  /** Read Conductor's and Claude Code's data about worktrees Beluga didn't make (omitted in tests and the demo). */
  readonly otherTools?: import('./other-worktrees.js').OtherTools;
  /** How friends' commands run on this computer (the demo injects canned output). */
  readonly runShell?: ShellRunner;
  /** Stop Beluga itself (the daemon). */
  readonly shutdown?: () => void;
}

/** What the host can do with the room itself. */
export interface RoomControl {
  /** Disconnect someone and replace the invite so the old link stops working. */
  removePerson(peerId: string): void;
  /** Replace the invite link (the old one stops working; people here stay). */
  newInvite(): void;
  setOpen(open: boolean): void;
  /** Forget the history people who join later would see. */
  clearHistory(): void;
  /** Project links: who may come in with one, and what they reach. */
  readonly guests?: GuestControl;
}

/** `mirror`: the conversation your Claude asked from, where the friend's progress is shown too. */
type AgentWaiter = { peer: string; resolve: (text: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; mirror?: string };

const USAGE_REFRESH_MS = 10 * 60_000;
/** Reading usage starts a whole Claude Code: never two at once, at most once a minute (BLG-620). */
const USAGE_MIN_GAP_MS = 60_000;
/** While saving power (BLG-621): at most every half hour. */
const USAGE_SAVING_GAP_MS = 30 * 60_000;
const WORKSPACE_REFRESH_MS = 30_000;

/**
 * Kinds that make this computer do something or change what you're part of: only accepted
 * when sent recently, and only once (even across restarts).
 */
const GUARDED = new Set([
  'agent_request',
  'agent_answer',
  'file_request',
  'file_request_result',
  'ws_request',
  'ws_request_result',
  'ws_handoff',
  'ws_handoff_result',
  'file_offer',
  'fs_fetch',
  'fs_read',
  'fs_list',
  'ws_invite',
  'ws_leave',
  'ws_roster',
  'share_offer',
  'shell_request',
  'shell_result',
  'shell_started',
  'fs_search',
  'ws_diff',
  'gateway',
  'friend_offer',
]);

export { dirKey };

/** Glue between the network, local shares, the agent, and UI state. */
export class Session {
  readonly bridge: RoomBridge;
  readonly workspaces?: WorkspaceController;
  private workspaceTimer?: NodeJS.Timeout;
  private readonly agent?: AgentBackend;
  private readonly runtime?: AgentRuntime;
  private readonly agentWaiters = new Map<string, AgentWaiter>();
  /** Messages a screen sent with an id (a plan chat's), and the request each went as: a Retry of one that went doesn't go twice. */
  private readonly sentById = new Map<string, string>();
  private usageTimer?: NodeJS.Timeout;
  private usageFetched = false;
  private readonly usageCheck = coalesce(() => this.readUsage(), () => (this.store.getState().powerSaving ? USAGE_SAVING_GAP_MS : USAGE_MIN_GAP_MS));
  private powerSaver?: PowerSaver;
  /** The room welcomed you at least once (a later outage is "lost", not "can’t reach yet"). */
  private everConnected = false;
  readonly questions: QuestionBroker;
  readonly sharing: WorkspaceSharing;
  readonly people: People;
  private readonly replay: ReplayGuard;
  readonly notifier: Notifier;
  readonly workbench?: Workbench;
  readonly remote: RemoteWork;
  /** Commands on friends' computers (and theirs on yours), and telling friends your trust in them. */
  readonly peerRun: PeerRun;
  /** Your Claude serving requests: queue, approvals, runs. */
  readonly host: AgentHost;
  /** Friends' shared folders and yours: browsing, viewing, downloads. */
  readonly files: RoomFiles;
  /** Links that let someone into one project (or everything), knocking first. */
  readonly invites: ProjectInvites;
  /** The read-only shell over a workspace shared with you. */
  readonly shell: GuestShell;
  /** What changed in a workspace shared with you (and serving yours). */
  readonly diff: SharedDiff;
  /** Your environment variables for shells, scripts and your Claude (never sent to the room). */
  readonly env: EnvVars;
  /** Your local and bring-your-own endpoints (BLG-449), as they answer now. */
  readonly local: LocalEndpoints;
  /** The agent's own terminal on a conversation (BLG-534). */
  readonly agentTerms?: import('./agent-term.js').AgentTerminals;
  private projectsTimer?: NodeJS.Timeout;
  /** What this session asks screens to do (see core/intents.ts). */
  readonly intents = new IntentBus();
  /** What the attached screens look at (unread counts and notifications follow it). */
  readonly attention: AttentionRegistry;

  /** Backends for your other agents' runtimes (a dialogue's Codex beside your Claude), made when first needed. */
  private readonly otherBackends = new Map<string, AgentBackend>();
  /** Room asks that named an agent ("@bob:codex", BLG-520), until their run says which one answers. */
  private readonly namedAsks = new Map<string, { readonly peer: string; readonly agent: AgentRef }>();

  constructor(private readonly opts: SessionOptions) {
    if (opts.workspaces) opts.workspaces.branchPrefix = () => opts.store.getState().prefs.branchPrefix;
    this.bridge = createRoomBridge(this, () => opts.agentCwd);
    const parts = createSessionParts(this, opts);
    this.workspaces = parts.workspaces;
    this.notifier = parts.notifier;
    this.workbench = parts.workbench;
    this.questions = parts.questions;
    this.sharing = parts.sharing;
    this.replay = parts.replay;
    this.people = parts.people;
    this.files = parts.files;
    this.host = parts.host;
    this.remote = parts.remote;
    this.peerRun = parts.peerRun;
    this.invites = parts.invites;
    this.shell = parts.shell;
    this.diff = parts.diff;
    this.env = parts.env;
    this.local = parts.local;
    this.agentTerms = parts.agentTerms;
    this.runtime = opts.createAgent ? undefined : opts.runtime?.runtimes(opts.runtime.agent);
    // The session layer runs a runtime only as its capabilities allow (the safety rule: see guard.ts).
    this.agent = opts.createAgent ? this.beside(opts.createAgent(this.bridge), opts.alsoRuntimes ?? []) : this.runtime && opts.runtime ? this.routed(this.runtime, opts.runtime) : undefined;
    this.attention = new AttentionRegistry(opts.store);
    opts.store.dispatch({ type: 'identity', selfId: opts.client.peerId, isHost: Boolean(opts.room), home: os.homedir() });
    this.publishShares();
    this.wire();
  }

  /** A made agent (the demo's, a test's) with `also` beside it: a turn whose place picked one of them runs there. */
  private beside(agent: AgentBackend, also: readonly AgentRuntime[]): AgentBackend {
    if (!also.length) return agent;
    const options = { cwd: this.opts.agentCwd, autoEdit: true, additionalDirectories: [], bridge: this.bridge, ownEnv: this.ownEnv };
    return routedBackend(agent, 'claude', (id) => {
      const rt = also.find((r) => r.id === id);
      return rt ? guardedBackend(rt.create(options), rt.capabilities) : undefined;
    });
  }

  /**
   * Your saved variables for your agent's own checks in `cwd` (Settings' MCP servers, #442): as a
   * run of yours there gets them (yours, then the project's), read when asked so a change counts.
   */
  private readonly ownEnv = (cwd: string): Record<string, string> => this.env.envFor({ dir: cwd }, { claude: true });

  /** Your default agent's backend, sending each turn whose place picked another runtime to that one's (agent/runtime/router.ts). */
  private routed(main: AgentRuntime, rt: NonNullable<SessionOptions['runtime']>): AgentBackend {
    const make = (r: AgentRuntime): AgentBackend => guardedBackend(r.create({ ...rt.options, bridge: this.bridge, ownEnv: this.ownEnv }), r.capabilities);
    // Every other runtime that has plan usage reports it too (Codex's windows on the usage tab).
    const withUsage = KNOWN_RUNTIMES.map((r) => r.id).filter((id) => id !== main.id && rt.runtimes(id)?.capabilities.hasUsage);
    return routedBackend(
      make(main),
      main.id,
      (id) => {
        // A local endpoint is Claude Code pointed elsewhere (BLG-449): it runs wherever Claude does.
        const other = id === LOCAL_RUNTIME ? (rt.runtimes('claude') ? localRuntime((v) => this.local.resolve(v)) : undefined) : rt.runtimes(id);
        return other ? make(other) : undefined;
      },
      withUsage,
    );
  }

  get store(): Store {
    return this.opts.store;
  }

  /**
   * The backend for one of your agents' runtimes: your default agent's own, or one made for that
   * runtime (guarded the same way). The demo's fake agent answers for all of them.
   */
  backendFor(runtime: string): AgentBackend | undefined {
    if (!this.runtime || runtime === this.runtime.id) return this.agent;
    const made = this.otherBackends.get(runtime);
    if (made) return made;
    // A local endpoint is Claude Code pointed elsewhere (BLG-449), as in routed(): it runs wherever Claude does.
    const rt = runtime === LOCAL_RUNTIME ? (this.opts.runtime?.runtimes('claude') ? localRuntime((v) => this.local.resolve(v)) : undefined) : this.opts.runtime?.runtimes(runtime);
    if (!rt || !this.opts.runtime) return undefined;
    const backend = guardedBackend(rt.create({ ...this.opts.runtime.options, bridge: this.bridge, ownEnv: this.ownEnv }), rt.capabilities);
    this.otherBackends.set(runtime, backend);
    return backend;
  }

  /** Whether a runtime takes a message into a running turn (undefined: your default agent's). A local model is Claude Code pointed elsewhere. */
  canSteer(runtime: string | undefined): boolean {
    if (!runtime) return this.runtime?.capabilities.canSteer ?? false;
    const id = runtime === LOCAL_RUNTIME ? CLAUDE_AGENT.runtime : runtime;
    return (this.opts.runtime?.runtimes(id) ?? this.opts.alsoRuntimes?.find((r) => r.id === id))?.capabilities.canSteer ?? false;
  }

  /** Whether this Mac can run that agent now: its runtime is here (a local model: its endpoint is set up). */
  runsAgent(agent: AgentRef): boolean {
    if (agent.runtime === LOCAL_RUNTIME && this.runtime) return Boolean(this.opts.runtime?.runtimes(CLAUDE_AGENT.runtime) && this.local.resolve(agent.model));
    return Boolean(this.backendFor(agent.runtime));
  }

  get selfId(): string {
    return this.opts.client.peerId;
  }

  /** Your shared folders and workspaces' folders (who may open what). */
  get shareService(): ShareService {
    return this.opts.shares;
  }

  /** Your Claude (undefined when it's off). */
  get backend(): AgentBackend | undefined {
    return this.agent;
  }

  /** What your agent's runtime can do (undefined for a backend made without one: the demo, tests). */
  get capabilities(): RuntimeCapabilities | undefined {
    return this.runtime?.capabilities;
  }

  get approvalTimeoutMs(): number {
    return this.opts.approvalTimeoutMs ?? 5 * 60_000;
  }

  get launchDir(): string {
    return this.opts.launchDir ?? process.cwd();
  }

  get hasAgent(): boolean {
    return Boolean(this.agent);
  }

  start(): void {
    this.opts.shares.watch(
      (share, relPath) => this.files.queueFsChanged(share, relPath),
      (message) => this.system(message, 'warn'),
    );
    this.opts.client.connect();
    this.powerSaver ??= new PowerSaver({ store: this.store });
    this.usageTimer = setInterval(() => void this.refreshUsage(), USAGE_REFRESH_MS);
    this.usageTimer.unref();
    this.workbench?.start();
    if (this.workspaces) {
      void this.workspaces.refresh().then(() => this.offerProjects());
      const saving = (): boolean => this.store.getState().powerSaving;
      this.projectsTimer = setInterval(paced(WORKSPACE_REFRESH_MS, saving, () => this.offerProjects()), WORKSPACE_REFRESH_MS);
      this.projectsTimer.unref();
      this.workspaceTimer = setInterval(paced(WORKSPACE_REFRESH_MS, saving, () => void this.workspaces?.refresh()), WORKSPACE_REFRESH_MS);
      this.workspaceTimer.unref();
      // A quiet fetch of each project's remote every ~15 minutes (the project home's "fetched … ago").
      this.workspaces.mainSync.start();
    }
  }

  async stop(): Promise<void> {
    await this.host.abort();
    // The terminal's last words come back to the chat before it's saved.
    this.agentTerms?.closeAll();
    // A run that didn't end in time (or whose end never came back) won't now: not saved as running.
    this.store.dispatch({ type: 'runs_interrupted', owner: this.selfId });
    this.opts.client.close();
    await this.opts.shares.close();
    clearInterval(this.usageTimer);
    this.usageCheck.stop();
    this.powerSaver?.stop();
    clearInterval(this.workspaceTimer);
    this.workspaces?.stop();
    this.workbench?.stop();
    this.local.stop();
    this.notifier.stop();
    this.replay.flush();
    this.remote.stop();
    this.peerRun.stop();
    clearInterval(this.projectsTimer);
    this.files.stop();
    for (const w of this.agentWaiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('Session closed'));
    }
    this.agentWaiters.clear();
  }

  /** Leave: the screen that asked closes (the room stays up while other screens are attached). */
  quit(): void {
    this.intend({ type: 'quit' });
  }

  /** Stop Beluga entirely (every screen closes). */
  shutdown(): void {
    if (this.opts.shutdown) this.opts.shutdown();
    else this.intend({ type: 'quit' });
  }

  /** A screen says what it's looking at (`clientId`: which screen). */
  attend(clientId: string, attention: Attention): void {
    this.attention.set(clientId, attention);
  }

  /** A screen closed. */
  detach(clientId: string): void {
    this.attention.remove(clientId);
  }

  // -------------------------------------------------------------------------
  // User actions
  // -------------------------------------------------------------------------

  /**
   * Handle a line from the composer, typed in `channel` (the conversation on screen). `urgent`
   * (Alt/Ctrl+Enter) interrupts your Claude instead of queueing. False when a message for a
   * conversation's Claude couldn't go (why is said in a toast), so the box can keep it. `id`: the
   * same for every Retry of one message, so it's said in the chat and asked of Claude once.
   */
  submit(raw: string, { channel = 'room', urgent = false, id, terminal = false }: { channel?: string; urgent?: boolean; id?: string; terminal?: boolean } = {}): boolean {
    const state = this.store.getState();
    // "/run @bob <command>": the command exactly as typed (spacing and quotes kept).
    const peerRun = /^\/run\s+@([\w.-]+)\s+([\s\S]+)$/.exec(raw.trim());
    if (peerRun) {
      this.runOnPeerByHand(peerRun[1]!, peerRun[2]!.trim(), channel);
      return true;
    }
    // A dialogue between your agents: started here (proposed, you confirm its caps), or what you say into one (core/dialogues).
    if (dialoguesOf(this)?.fromComposer(raw, channel)) return true;
    // "@codex": your own Codex when it runs here, listed on your card or not (BLG-520).
    const parsed = parseInput(raw, this.selfId, state.peers, { runs: (runtime) => this.runsAgent({ runtime, label: runtime }) });
    // In a friend's worktree: their agent, or yours with "@claude" (core/shared-guest).
    const shared = channel !== 'room' && (parsed.kind === 'chat' || parsed.kind === 'agent') ? this.sharing.sharedFor(channel) : undefined;
    if (shared) return this.submitShared(raw, shared, channel, urgent, id);
    // In a workspace, you're talking to your Claude working in that folder.
    if (channel !== 'room' && (parsed.kind === 'chat' || parsed.kind === 'agent')) {
      // A leading "@claude" is just you talking to your Claude; "@claude:ata" stays in the words, so your
      // Claude knows to ask Ata's Claude (the room's own parse only knows people in the room).
      const onlyYours = parsed.kind === 'agent' && parsed.unknown.length === 0 && parsed.targets.every((t) => t === this.selfId);
      const prompt = parsed.kind === 'agent' && onlyYours ? parsed.prompt : parsed.text;
      const ask = (): string | undefined => (terminal ? this.startInTerminal(prompt, channel) : this.askOwnClaude(prompt, channel, urgent));
      if (!id) {
        const sent = ask() !== undefined;
        if (sent) this.tellMentioned(prompt, channel);
        return sent;
      }
      if (this.sentById.has(id)) return true;
      const requestId = ask();
      if (requestId === undefined) return false;
      this.tellMentioned(prompt, channel);
      this.sentById.set(id, requestId);
      if (this.sentById.size > 200) this.sentById.delete(this.sentById.keys().next().value!);
      return true;
    }
    // "@add-auth fix the test" from the main chat goes to the Claude working in that workspace.
    const toWorkspace = parsed.kind !== 'command' ? parseWorkspaceMention(raw, workspaceMentions(state.projects)) : undefined;
    if (toWorkspace) {
      this.askOwnClaude(toWorkspace.prompt, `ws:${toWorkspace.id}`, urgent);
      this.store.dispatch({ type: 'chat', id: randomUUID(), from: this.selfId, text: raw.slice(0, MAX_TEXT), ts: Date.now(), byAgent: false });
      this.system(`Sent to the agent in ${toWorkspace.label.slice(1)}. Open it in the sidebar to follow along.`);
      return true;
    }
    switch (parsed.kind) {
      case 'empty':
        return true;
      case 'command':
        runCommand(this, parsed.name, parsed.args, channel, raw);
        return true;
      case 'chat':
        this.sendChat(parsed.text, false);
        // On your own, the chat is a conversation with your Claude: no @claude needed.
        if (state.peers.length <= 1 && this.agent) this.requestAgent(this.selfId, parsed.text, false, 'room', urgent);
        return true;
      case 'agent':
        this.sendChat(parsed.text, false);
        for (const line of parsed.notes) this.toast(line, 'warn');
        // A named agent ("@codex", "@bob:codex") rides the ask; "@bob" and the "@claude…" forms leave it to their default.
        for (const t of parsed.to) this.requestAgent(t.peerId, parsed.prompt, false, 'room', urgent && t.peerId === this.selfId, undefined, undefined, t.named ? t.agent : undefined);
        // On your own, a name nobody has is still a line for your agent, as plain chat always is.
        if (parsed.to.length === 0 && state.peers.length <= 1 && this.agent) this.requestAgent(this.selfId, parsed.text, false, 'room', urgent);
        else if (parsed.to.length === 0 && parsed.notes.length === 0) this.toast('No agent is online', 'warn');
        return true;
    }
  }

  /**
   * A line in a worktree a friend shared with you: their agent answers it (it works on their Mac),
   * unless it starts with "@claude", your own agent: it runs here, reads their worktree from afar
   * and answers in the same conversation for everyone there. See submit for `id`.
   */
  private submitShared(raw: string, shared: SharedWorkspace, channel: string, urgent: boolean, id?: string): boolean {
    if (id && this.sentById.has(id)) return true;
    const ask = sharedAskTarget(raw, peerName(this.store.getState(), shared.owner));
    const requestId = ask.to === 'self' ? this.askOwnAgentIn(shared, raw, ask.prompt, channel, urgent) : this.askOwnClaude(ask.prompt, channel, urgent, raw.trim());
    if (requestId === undefined) return false;
    this.tellMentioned(ask.prompt, channel);
    if (id) {
      this.sentById.set(id, requestId);
      if (this.sentById.size > 200) this.sentById.delete(this.sentById.keys().next().value!);
    }
    return true;
  }

  /** Your own agent, asked in a friend's worktree: your line goes to everyone there, the run is yours. */
  private askOwnAgentIn(shared: SharedWorkspace, text: string, prompt: string, channel: string, urgent: boolean): string | undefined {
    if (shared.role !== 'contribute') {
      this.toast(`You can follow ${shared.name}, but not ask an agent there. Ask the owner to let you contribute`, 'warn');
      return undefined;
    }
    if (!this.agent) {
      this.toast('Your agent isn’t on, so it can’t answer here', 'warn');
      return undefined;
    }
    const requestId = randomUUID();
    this.sendChat(text.trim(), false, channel, requestId);
    return this.requestAgent(this.selfId, prompt, false, channel, urgent, undefined, requestId);
  }

  /**
   * "@ata" in what you said to your Claude is Ata, the person: Ata gets it as a direct message saying
   * where you mentioned them. "@claude:ata" (Ata's Claude) is your Claude's to ask, not a mention.
   */
  private tellMentioned(text: string, channel: string): void {
    const state = this.store.getState();
    const people = personMentions(text, state.network.friends);
    if (!people.length) return;
    let mesh: ReturnType<typeof networkOf>;
    try {
      mesh = networkOf(this);
    } catch {
      return;
    }
    const ws = channel.startsWith('ws:') ? state.projects.flatMap((p) => p.workspaces.map((w) => ({ w, p }))).find(({ w }) => w.id === channel.slice(3)) : undefined;
    const where = ws ? `${ws.w.name} (${ws.p.name})` : 'a conversation with their agent';
    const me = state.self?.name ?? state.network.self?.name ?? 'A friend';
    for (const f of people) {
      try {
        mesh.sendDm(f.peerId, mentionNote(me, where, text));
      } catch {
        continue;
      }
    }
    this.store.dispatch({ type: 'system', text: `Told ${people.map((f) => f.name).join(', ')} you mentioned them (a direct message).`, level: 'info', channel });
  }

  system(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.store.dispatch({ type: 'system', text, level });
  }

  toast(text: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
    this.intend({ type: 'toast', text, level });
  }

  /** Ask the screen(s) to go somewhere, open a dialog, show a message or close a tab. */
  intend(intent: Intent): void {
    this.intents.emit(intent, currentClient());
  }

  async copyInvite(): Promise<void> {
    const { invite, hosting } = this.store.getState();
    if (!invite) {
      if (hosting && hosting.phase !== 'failed') return this.toast('The invite link is still being created…');
      if (!this.opts.startInvite) return this.toast('No invite link available', 'warn');
      this.opts.startInvite();
      this.toast('Opening a secure link for friends… it will be copied when ready');
      return;
    }
    await this.copyOrShow(invite, 'Invite copied. Paste it to a friend');
  }

  async copyLastAnswer(): Promise<void> {
    const last = [...this.store.getState().log].reverse().find((l) => l.type === 'agent' && l.status === 'done');
    if (!last || last.type !== 'agent') {
      this.toast('No agent answer to copy yet', 'warn');
      return;
    }
    await this.copyOrShow(last.text, `Copied ${agentLabel(last.agent, last.ownerName, false)}'s answer`);
  }

  /** Copy text for you to paste (shown in the chat when there's no clipboard). */
  copyText(text: string, success: string): Promise<void> {
    return this.copyOrShow(text, success);
  }

  private async copyOrShow(text: string, success: string): Promise<void> {
    try {
      await (this.opts.copy ?? (async () => { throw new Error('no clipboard'); }))(text);
      this.toast(success, 'success');
    } catch {
      this.system(text);
      this.toast('Could not reach the clipboard. Copy it from the chat instead', 'warn');
    }
  }

  /**
   * `request`: the request to your Claude the message is (kept on it here, so its card's state can
   * show on it); `steer`: it steers the turn your Claude is on (shown as not read yet from the start);
   * `queued`: it waits behind that turn (in the queue from the start, never a sent bubble for a moment).
   */
  sendChat(text: string, byAgent: boolean, channel = 'room', request?: string, steer = false, queued = false, by: MessageVia | undefined = actingVia()): void {
    const agent = byAgent ? { agent: this.agentRef } : {};
    const via = by ? { via: by } : {};
    // Its own id, the same in every copy, so reactions can name it (BLG-702).
    const mid = randomUUID();
    if (channel !== 'room') {
      // Workspace conversations stay on this computer, plus the people you invited into them.
      const id = chatMessageId(this.selfId, mid, '');
      this.store.dispatch({ type: 'chat', id, from: this.selfId, text: text.slice(0, MAX_TEXT), ts: Date.now(), byAgent, channel, ...agent, ...via, ...(request ? { request } : {}), ...(steer ? { steer: true as const } : {}), ...(queued ? { queued: true as const } : {}) });
      for (const to of this.sharing.recipients(channel)) this.send({ kind: 'chat', text: text.slice(0, MAX_TEXT), byAgent, channel, mid, ...agent, ...via }, { to });
      return;
    }
    if (this.store.getState().self?.guest && !this.store.getState().peers.find((p) => p.peerId === this.selfId && !p.guest)) {
      this.toast("You came in with a link to a project, so there's no group chat here. Open it in Projects", 'warn');
      return;
    }
    if (!this.send({ kind: 'chat', text: text.slice(0, MAX_TEXT), byAgent, mid, ...agent, ...via }, { keep: true })) {
      this.toast('Not connected, so the message was not sent', 'error');
    }
  }

  /** Put an emoji on a message of the group chat or a workspace chat, or take yours off (BLG-702). → its chips now. */
  reactChat(channel: string, id: string, emoji: string, on?: boolean): ReturnType<typeof reactInChat> {
    return reactInChat(this.reactDeps, channel, id, emoji, on);
  }

  private get reactDeps(): RoomReactDeps {
    return { store: this.store, selfId: () => this.selfId, send: (body, opts) => this.send(body, opts), sharing: this.sharing, ensureLoaded: (wsId) => void this.workspaces?.ensureLoaded(wsId) };
  }

  /** Ask an agent (ours or a peer's) to do something. Returns the request id. */
  requestAgent(target: string, prompt: string, viaAgent: boolean, channel = 'room', urgent = false, project?: string, requestId: string = randomUUID(), agent?: AgentRef, via: MessageVia | undefined = actingVia()): string {
    const plan = this.store.getState().planMode[channel] === true;
    this.questions.track(requestId, target, channel);
    // "@bob:codex" (BLG-520): the agent rides the ask, in the room only; their Mac runs it or says which one did (see namedAsks).
    const named = agent && channel === 'room' ? { agent: { runtime: agent.runtime, label: agent.label, ...(agent.model ? { model: agent.model } : {}) } } : {};
    if (named.agent) {
      this.namedAsks.set(requestId, { peer: target, agent: named.agent });
      if (this.namedAsks.size > 200) this.namedAsks.delete(this.namedAsks.keys().next().value!);
    }
    this.send({ kind: 'agent_request', requestId, prompt: prompt.slice(0, MAX_TEXT), viaAgent, channel, urgent, plan, ...(project ? { project: project.slice(0, 80) } : {}), ...(via ? { via } : {}), ...named }, { to: target });
    return requestId;
  }

  /**
   * Send a message to the Claude of a workspace conversation: yours, or (in a workspace
   * someone shared with you) theirs. `echo: false` leaves the prompt out of the chat (it's there already);
   * a string shows that instead (a short line for a long brief: Claude still gets the whole prompt).
   * Returns the request's id (undefined when you can't ask there). `shown`: the message is in the
   * chat already, under this request id (see showAsk), so it isn't drawn again.
   */
  askOwnClaude(prompt: string, channel: string, urgent = false, echo: boolean | string = true, shown?: string): string | undefined {
    const shared = this.sharing.sharedFor(channel);
    if (shared && shared.role !== 'contribute') {
      this.toast(`You can follow ${shared.name}, but not ask its agent. Ask the owner to let you contribute`, 'warn');
      return undefined;
    }
    // Load the saved conversation first, so what's said now is kept with it.
    if (!shared && channel.startsWith('ws:')) this.workspaces?.ensureLoaded(channel.slice(3));
    const requestId = shown ?? randomUUID();
    // How a worktree is as you send this, so editing the message later can go back to it (BLG-385).
    if (!shared && (echo || shown)) void this.workspaces?.snapshotPrompt(channel, requestId);
    // Your own Claude at work here: a steer says it isn't read yet from the moment it's drawn, and anything else waits in the queue from then.
    const running = !shared && this.host.runningIn(channel);
    if (echo && !shown) this.sendChat(typeof echo === 'string' ? echo : prompt, false, channel, requestId, urgent && running, !urgent && running);
    return this.requestAgent(shared ? shared.owner : this.selfId, prompt, false, channel, urgent, undefined, requestId);
  }

  /**
   * A turn a plan starts by itself. In a worktree an external agent started it stays at that agent's
   * level, and ends with its grant: a plan's brief must not lift it to yours.
   */
  askForPlan(prompt: string, channel: string, echo: boolean): string | undefined {
    const ws = channel.startsWith('ws:') ? this.workspaces?.manager.find(channel.slice(3)) : undefined;
    const agent = ws?.kind === 'worktree' ? ws.startedByAgent : undefined;
    return agent ? asActingAgent(agent, () => this.askOwnClaude(prompt, channel, false, echo)) : this.askOwnClaude(prompt, channel, false, echo);
  }

  /**
   * Your message in a conversation you see as its agent's terminal, before that has had a turn
   * (BLG-553): drawn in the chat as always, then the terminal opens with it as its first prompt,
   * instead of a turn in the chat. When the terminal can't open (a turn already running there, a
   * shared or Codex conversation), it goes to the chat as any message does. `shown`: see askOwnClaude.
   */
  startInTerminal(prompt: string, channel: string, shown?: string): string | undefined {
    const terms = this.agentTerms;
    const wsId = channel.slice(3);
    if (!terms || !channel.startsWith('ws:') || !terms.canOpen(wsId) || this.sharing.sharedFor(channel) || this.host.runningIn(channel) || terms.driving(channel)) return this.askOwnClaude(prompt, channel, false, true, shown);
    this.workspaces?.ensureLoaded(wsId);
    const requestId = shown ?? randomUUID();
    if (!shown) {
      void this.workspaces?.snapshotPrompt(channel, requestId);
      this.sendChat(prompt, false, channel, requestId);
    }
    terms.open(wsId, undefined, prompt).catch((err: unknown) => {
      const why = (err instanceof Error ? err.message : String(err)).replace(/^Error: /, '');
      if (!isTermBusy(why)) this.toast(`The terminal couldn’t open (${why}), so your message went to the chat`, 'warn');
      this.askOwnClaude(prompt, channel, false, true, requestId);
    });
    return requestId;
  }

  /**
   * Your first message in a conversation that isn't there yet (a worktree being made), drawn at
   * once so sending it shows something (BLG-531); askOwnClaude with `shown` sends it when it's
   * ready. Returns the request id it's drawn under.
   */
  showAsk(prompt: string, channel: string): string {
    const requestId = randomUUID();
    this.sendChat(prompt, false, channel, requestId);
    return requestId;
  }

  /** Run your Claude for someone else in one of your workspaces (they were invited to work there). */
  runFor(from: string, channel: string, prompt: string, plan = false): void {
    this.host.runFor(from, channel, prompt, plan);
  }

  /** Run your Claude with text from someone else; their trust level decides what it may do. */
  runOnBehalf(from: string, channel: string, prompt: string): void {
    this.host.runOnBehalf(from, channel, prompt);
  }

  answerApproval(answer: ApprovalAnswer, id?: string): boolean {
    return this.host.answerApproval(answer, id);
  }

  stopAgent(): void {
    this.host.stopAgent();
  }

  /** Compact a conversation's context (Claude keeps what matters; the chat stays on screen). */
  compact(channel: string, instructions = ''): void {
    if (channel.startsWith('ws:')) this.workspaces?.ensureLoaded(channel.slice(3));
    this.host.compact(channel, instructions);
  }

  /** A side question about a conversation (/btw): answered beside it while Claude keeps working. */
  btw(channel: string, question: string): Promise<void> {
    if (channel.startsWith('ws:')) this.workspaces?.ensureLoaded(channel.slice(3));
    return this.host.btw.ask(channel, question);
  }

  /** Close a conversation's side question. */
  btwDismiss(channel: string): void {
    this.host.btw.dismiss(channel);
  }

  /** Ask you to approve something; `peer` is who it's for. */
  ask(kind: 'request' | 'tool', title: string, detail: string, peer?: string): Promise<'yes' | 'no' | 'always'> {
    return this.host.ask(kind, title, detail, peer);
  }

  /**
   * Ask a friend's Claude (it runs on their computer) and wait for its final answer. `project`:
   * one of their projects to work in. Its progress also shows in `mirror` (the conversation
   * your Claude asked from), not only in the group chat.
   */
  askPeerAgent(peerId: string, name: string, prompt: string, opts: { project?: string; mirror?: string; via?: MessageVia } = {}): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // In a workspace shared with you, their Claude works right there (you were invited to).
      const shared = opts.project ? this.store.getState().shared.find((w) => w.owner === peerId && w.role === 'contribute' && (w.name === opts.project || w.project === opts.project)) : undefined;
      const requestId = shared
        ? this.requestAgent(peerId, prompt, true, `ws:${shared.id}`, false, undefined, undefined, undefined, opts.via)
        : this.requestAgent(peerId, prompt, true, 'room', false, opts.project, undefined, undefined, opts.via);
      const timer = setTimeout(() => {
        this.agentWaiters.delete(requestId);
        reject(new Error(`${name}'s agent did not finish in time`));
      }, this.opts.agentTimeoutMs ?? 15 * 60_000);
      const mirror = !shared && opts.mirror && opts.mirror !== 'room' ? opts.mirror : undefined;
      this.agentWaiters.set(requestId, { peer: peerId, resolve, reject, timer, ...(mirror ? { mirror } : {}) });
    });
  }

  /** Run a command on a friend's computer (through their Beluga) and show it with its output here. */
  async runOnPeer(name: string, command: string, opts: { cwd?: string; project?: string; timeoutSec?: number; why?: string; viaAgent?: boolean; channel?: string; via?: MessageVia } = {}): Promise<string> {
    const peer = this.findPeer(name);
    if (!peer || peer.peerId === this.selfId) throw new Error(`No friend named "${name}" is here. Call list_peers first.`);
    const res = await this.peerRun.run(peer.peerId, command, { ...opts, viaAgent: opts.viaAgent ?? false, channel: opts.channel ?? 'room' });
    return describeShellResult(peer.name, res);
  }

  /** "/run @bob npm test" and the person menu: you run a command on a friend's computer (shown in `channel`). */
  runOnPeerByHand(name: string, command: string, channel = 'room'): void {
    this.runOnPeer(name, command, { channel: channel === 'draft' ? 'room' : channel }).catch((err: unknown) => this.toast(errorText(err), 'warn'));
  }

  /** Which of your shares a file on this computer is in (for announcing reports). */
  locateShared(absPath: string): { share: string; path: string } | undefined {
    return this.opts.shares.locate(absPath) ?? undefined;
  }

  /**
   * A file or folder on this computer as something the viewer and Files browser can open: inside
   * one of your shares if it is, else in a private, unannounced share of its folder (only you can open it).
   */
  localLocation(absPath: string, dir: boolean): Location {
    const found = this.opts.shares.locate(absPath);
    if (found) return { owner: this.selfId, ...found };
    const root = dir ? absPath : path.dirname(absPath);
    const name = `local-${createHash('sha1').update(root).digest('hex').slice(0, 10)}`;
    if (!this.opts.shares.configs.some((c) => c.name === name)) this.opts.shares.upsert({ name, root, writable: false, private: true, allowed: [] });
    this.publishShares();
    return { owner: this.selfId, share: name, path: dir ? '' : path.basename(absPath) };
  }

  /** Let these people open the files in `root` (images you pasted into the room), under `name`. */
  serveFolder(name: string, root: string, allowed: readonly string[]): void {
    const current = this.opts.shares.configs.find((c) => c.name === name)?.allowed ?? [];
    this.opts.shares.upsert({ name, root, writable: false, private: true, allowed: [...new Set([...current, ...allowed])] });
    this.publishShares();
  }

  /** Ask your own Claude in a conversation (shown there) and wait for its final answer. */
  askAndWait(prompt: string, channel: string, timeoutMs = 5 * 60_000): Promise<string> {
    this.sendChat(prompt, false, channel);
    return new Promise<string>((resolve, reject) => {
      const requestId = this.requestAgent(this.selfId, prompt, false, channel);
      const timer = setTimeout(() => {
        this.agentWaiters.delete(requestId);
        reject(new Error('The agent did not finish in time'));
      }, timeoutMs);
      this.agentWaiters.set(requestId, { peer: this.selfId, resolve, reject, timer });
    });
  }

  /** Tell the room which projects friends may ask to start work in (names only). */
  offerProjects(): void {
    const state = this.store.getState();
    const names = state.prefs.friendWorktrees === 'ask' && this.workspaces ? this.workspaces.manager.list.filter((p) => p.root && !p.error).map((p) => p.name).slice(0, 60) : [];
    const current = this.opts.client.currentProfile.projects ?? [];
    if (names.length === current.length && names.every((n, i) => n === current[i])) return;
    this.updateProfile({ projects: names.length ? names : undefined });
  }

  /** Whether friends may ask to start worktrees here or hand work over to you. */
  setFriendWorktrees(value: 'ask' | 'off'): void {
    this.setPrefs({ friendWorktrees: value });
    this.offerProjects();
    this.toast(value === 'ask' ? 'Friends can ask to start work on this computer; you approve each request' : 'Friends can no longer start work on this computer', 'success');
  }

  /** Whether Claude is signed in here, asked once in a while (a local model's side calls go to Claude only then). */
  private claudeReadyAt?: { readonly at: number; readonly ready: Promise<boolean> };

  /**
   * Where a side call goes now (BLG-503): your default agent (the project's own, when one is named)
   * decides each time, so a change in Settings counts at once. Codex: its own one-shot call, then
   * Claude's when it fails. A local model: Claude's only when Claude is signed in here (its side calls
   * can't run on the endpoint yet), never quietly to Anthropic otherwise. Claude, the demo, tests: the backend's.
   */
  private sideRoute(project?: string): SideRoute {
    const rt = this.opts.runtime;
    if (!this.runtime || !rt) return { claude: () => this.agent };
    const claude = (): AgentBackend | undefined => (this.runtime?.id === CLAUDE_AGENT.runtime ? this.agent : this.backendFor(CLAUDE_AGENT.runtime));
    const agent = this.agentFor(project);
    if (agent.runtime === CLAUDE_AGENT.runtime) return { claude };
    if (agent.runtime === LOCAL_RUNTIME) return { claude: async () => ((await this.claudeSignedIn()) ? claude() : undefined) };
    const own = rt.runtimes(agent.runtime);
    if (!own) return { claude };
    // Claude's aliases ('haiku': quick) are the runtime's to map (Codex: its small model, else its default).
    return { own: { complete: own.complete, cwd: this.opts.agentCwd, ...(agent.model ? { model: agent.model } : {}) }, claude };
  }

  /** Claude's runtime is here and, when it can say, signed in (asked again after a minute). */
  private claudeSignedIn(): Promise<boolean> {
    const claude = this.opts.runtime?.runtimes(CLAUDE_AGENT.runtime);
    if (!claude) return Promise.resolve(false);
    if (!claude.status) return Promise.resolve(true);
    if (!this.claudeReadyAt || Date.now() - this.claudeReadyAt.at > 60_000) {
      this.claudeReadyAt = { at: Date.now(), ready: claude.status().then((s) => s.state === 'ready', () => false) };
    }
    return this.claudeReadyAt.ready;
  }

  /** A worktree name for a task: from a small model on your agent (Claude when it can't), else from its words. */
  async nameTask(prompt: string): Promise<string> {
    return routeSideCall(this.sideRoute(), (on) => on.nameTask?.(prompt), slugify(prompt));
  }

  /** A short name for a new plan (undefined without an agent to ask, or when the model couldn't). */
  async titlePlan(goal: string): Promise<string | undefined> {
    return routeSideCall(this.sideRoute(), (on) => on.titlePlan?.(goal), undefined);
  }

  /** Name a chat from its recent content with a separate side call. */
  async titleChat(content: string): Promise<string | undefined> {
    return routeSideCall(this.sideRoute(), (on) => on.titleChat?.(content), undefined);
  }

  /** What a project's setup should be after it failed in a worktree (undefined without an agent to ask). */
  async fixSetup(dir: string, failed: string, output: string): Promise<SetupFix | undefined> {
    return routeSideCall(this.sideRoute(), (on) => on.fixSetup?.(dir, failed, output), undefined);
  }

  /** What a project's run command should be after it failed in a worktree (undefined without an agent to ask). */
  async fixRun(dir: string, failed: string, output: string): Promise<ScriptFix | undefined> {
    return routeSideCall(this.sideRoute(), (on) => on.fixRun?.(dir, failed, output), undefined);
  }

  /** Some agent here can answer in a friends' chat. */
  get answersChats(): boolean {
    return Boolean(this.agent?.answerChat);
  }

  /**
   * A friends' chat answer (core/chat/claude.ts) on your default agent, or on Claude when that one has
   * no one-shot call or it failed, with the agent that really answered (its name goes on the answer).
   * Its trouble is said, not swallowed: the chat tells you why it couldn't.
   */
  async answerChat(req: ChatAnswerRequest): Promise<{ readonly text: string; readonly agent: AgentRef }> {
    const route = this.sideRoute();
    const mine = this.agentFor();
    let trouble: unknown;
    if (route.own) {
      try {
        return { text: await sideCalls(route.own.complete, route.own.cwd, route.own.model).answerChat(req), agent: mine };
      } catch (err) {
        if (req.signal.aborted) throw err;
        trouble = err;
      }
    }
    const claude = await route.claude?.();
    if (!claude?.answerChat) throw trouble ?? new Error(mine.runtime === LOCAL_RUNTIME ? 'a local model can’t answer in chats yet, and Claude isn’t signed in here' : 'no agent here can answer');
    // Not your default's model on Claude: Settings' (Claude's) one.
    const asClaude = this.runtime && mine.runtime !== CLAUDE_AGENT.runtime;
    const model = asClaude ? this.store.getState().prefs.model : req.model;
    const { model: _m, ...rest } = req;
    const text = await claude.answerChat({ ...rest, ...(model ? { model } : {}) });
    return { text, agent: asClaude ? { ...CLAUDE_AGENT, ...(model ? { model } : {}) } : mine };
  }

  /** Whether an agent here can work out a project's setup and run commands. */
  get worksOutScripts(): boolean {
    return Boolean(this.agent?.workOutScripts);
  }

  /** A project's setup and/or run command from its files (undefined without an agent to ask, or on trouble). */
  async workOutScripts(dir: string, want: { setup: boolean; run: boolean; system?: string }): Promise<WorkedOutScripts | undefined> {
    return routeSideCall(this.sideRoute(), (on) => on.workOutScripts?.(dir, want), undefined);
  }

  /** An agent here can write a task from a description (Tasks' New Task). */
  get draftsTasks(): boolean {
    return Boolean(this.agent?.draftTask);
  }

  /** A task written from a description by the project's agent (undefined on any trouble, or without one). */
  async draftTask(text: string, ctx: DraftContext): Promise<TaskDraft | undefined> {
    return routeSideCall(this.sideRoute(), (on) => on.draftTask?.(text, ctx), undefined);
  }

  /** An agent here can write what a project is about (About This Project). */
  get describesProjects(): boolean {
    return Boolean(this.agent?.describeProject);
  }

  /** What a project is about, from a quick look at its folder by its agent (undefined on any trouble, or without one). */
  async describeProject(dir: string, project: string): Promise<string | undefined> {
    return routeSideCall(this.sideRoute(), (on) => on.describeProject?.(dir, project), undefined);
  }

  /** A pull request reviewed before a sentinel merges it (undefined without an agent to ask, or on trouble). */
  async reviewPr(input: import('../agent/pr-reviewer.js').PrReviewInput): Promise<import('../agent/pr-reviewer.js').PrReview | undefined> {
    return routeSideCall(this.sideRoute(), (on) => on.reviewPr?.(input), undefined);
  }

  /** Plan first in this conversation: Claude investigates read-only, then proposes a plan. */
  setPlanMode(channel: string, on: boolean): void {
    // A plan's own conversation: its head Claude runs the plan, and stopping to have a plan of its own approved would stall it.
    if (on && isPlanHome(this.store.getState().plans, channel)) return this.toast('A plan’s own conversation has no plan mode: talk the plan through on its page', 'info');
    this.store.dispatch({ type: 'plan_mode', channel, on });
    this.toast(on ? 'Plan mode: your agent looks first and asks you to approve a plan before changing anything' : 'Plan mode off: your agent works right away', 'success');
  }

  openLocation(at: Location, opts: { by?: string; broadcast?: boolean } = {}): Promise<void> {
    return this.files.openLocation(at, opts);
  }

  openSpec(spec: string): void {
    this.files.openSpec(spec);
  }

  loadDir(at: Location): Promise<void> {
    return this.files.loadDir(at);
  }

  browseTo(at: Location): Promise<void> {
    return this.files.browseTo(at);
  }

  browserEnter(index: number): Promise<void> {
    return this.files.browserEnter(index);
  }

  browserUp(): Promise<void> {
    return this.files.browserUp();
  }

  /** Download a shared file to ~/Downloads/Beluga/<friend>/, or to `opts.to` (an absolute path). */
  download(at: Location, opts: { to?: string } = {}): Promise<string | undefined> {
    return this.files.download(at, opts);
  }

  downloadSpec(spec: string): void {
    this.files.downloadSpec(spec);
  }

  listFiles(at: Location, opts: { times?: boolean } = {}): Promise<readonly FsEntry[]> {
    return this.files.listFiles(at, opts);
  }

  readFile(at: Location): Promise<{ content: string; truncated: boolean }> {
    return this.files.readFile(at);
  }

  follow(name: string | undefined): void {
    if (!name) {
      this.store.dispatch({ type: 'follow', peerId: undefined });
      this.toast('Stopped following');
      return;
    }
    const peer = this.findPeer(name);
    if (!peer) return this.toast(`Nobody named "${name}" is here`, 'warn');
    this.store.dispatch({ type: 'follow', peerId: peer.peerId });
    this.toast(`Following ${peer.name} and their agent. /unfollow to stop`, 'success');
    const state = this.store.getState();
    const latest = [state.focus[peer.peerId], state.focus[`${peer.peerId}:agent`]]
      .filter((f) => f !== undefined)
      .sort((a, b) => b.ts - a.ts)[0];
    if (latest) void this.openLocation(latest, { by: peer.name, broadcast: false });
  }

  // ----------------------------------------------------------------- room

  get isHost(): boolean {
    return Boolean(this.opts.room);
  }

  /** Host only: disconnect someone and replace the invite so their link stops working. */
  removePerson(peerId: string): void {
    const room = this.opts.room;
    const name = peerName(this.store.getState(), peerId);
    if (!room || peerId === this.selfId) return;
    for (const wsId of Object.keys(this.store.getState().members)) this.sharing.remove(wsId, peerId);
    this.people.setTrust(peerId, 'blocked');
    room.removePerson(peerId);
    this.system(`You removed ${name} from the room. The invite link changed, so the old one no longer works.`);
    this.toast(`${name} was removed. Use Copy invite for the new link`, 'success');
  }

  /** Host only: replace the invite link (people already here stay). */
  newInviteLink(): void {
    if (!this.opts.room) return this.toast('Only the host can change the invite link', 'warn');
    this.opts.room.newInvite();
    this.toast('New invite link made. The old one no longer works', 'success');
    void this.copyInvite();
  }

  /** Dial the room now instead of waiting for the next try. */
  retryConnection(): void {
    if (!this.opts.client.retryNow()) return;
    const trouble = this.store.getState().connection;
    if (trouble?.state === 'reconnecting') this.store.dispatch({ type: 'connection', connection: { ...trouble, retryAt: Date.now() } });
  }

  /** Host only: stop (or start again) letting new people in. */
  setRoomOpen(open: boolean): void {
    if (!this.opts.room) return this.toast('Only the host can close the room', 'warn');
    this.opts.room.setOpen(open);
    this.store.dispatch({ type: 'room_open', open });
    this.toast(open ? 'The room takes new people again' : "Room closed: nobody new can join, even with the link. People here stay", 'success');
  }

  /**
   * Clear a conversation. In the group chat the host may clear it for everyone (and for
   * people who join later); otherwise it's cleared on your screen. In a workspace, `fresh`
   * also starts a new Claude conversation there.
   */
  clearChat(channel: string, opts: { everyone?: boolean; fresh?: boolean } = {}): void {
    this.store.dispatch({ type: 'clear', channel });
    if (channel === 'room' && opts.everyone && this.opts.room) {
      this.opts.room.clearHistory();
      this.send({ kind: 'room_cleared' });
      this.toast('Group chat cleared for everyone', 'success');
      return;
    }
    if (opts.fresh && channel.startsWith('ws:')) {
      this.workspaces?.forgetConversation(channel.slice(3));
      this.store.dispatch({ type: 'context_reset', channel });
      this.host.forgetContext(channel);
      this.toast('Cleared. Your agent starts a fresh conversation here', 'success');
      return;
    }
    if (opts.fresh && isAssistant(channel)) {
      assistantOf(this)?.forget(channel);
      this.store.dispatch({ type: 'context_reset', channel });
      this.host.forgetContext(channel);
      this.toast(`Cleared. ${ASSISTANT_TITLE} starts a fresh conversation`, 'success');
      return;
    }
    this.toast(channel.startsWith('ws:') || isAssistant(channel) ? 'Messages cleared. Your agent still remembers the conversation' : 'Cleared on your screen', 'success');
  }

  findPeer(name: string): PeerInfo | undefined {
    const lower = name.toLowerCase().replace(/^@/, '');
    return this.store.getState().peers.find((p) => p.name.toLowerCase() === lower);
  }

  // -------------------------------------------------------------------------
  // Networking
  // -------------------------------------------------------------------------

  /**
   * Sharing with friends over the network (core/friend-share) takes the messages about what you
   * share with a friend (or they with you) to that friend's Mac: true or false when it took one
   * (it went, or waits for them), undefined to leave it to the room.
   */
  meshRoute?: (to: string, body: BodyInput) => boolean | undefined;

  /** A room message that came over a friend's network link (core/friend-share checked what it may be). */
  receiveFromFriend(from: string, body: Body, frameId: string): Promise<void> {
    const now = Date.now();
    return this.handle({ id: `mesh:${from}:${frameId}`, from, ts: now, sentAt: now, body }).catch((err: unknown) => this.system(`Error handling ${body.kind}: ${errorText(err)}`, 'error'));
  }

  send(body: BodyInput, opts: { to?: string; keep?: boolean } = {}): boolean {
    if (opts.to !== undefined && opts.to !== this.selfId) {
      const routed = this.meshRoute?.(opts.to, body);
      if (routed !== undefined) return routed;
    }
    // To yourself (your Claude in your own conversations, its events back to you): handled right
    // here, never through the room. A dropped or half-open room connection (after sleep, a network
    // change, offline) used to swallow these silently: the plan chat's message never reached Claude
    // and its replies went missing until the connection came back (KLD-64).
    if (opts.to !== undefined && opts.to === this.selfId) return this.loopback(body);
    try {
      return this.opts.client.send(body, opts);
    } catch (err) {
      this.system(`Could not send ${body.kind}: ${errorText(err)}`, 'error');
      return false;
    }
  }

  /** A message to yourself, delivered on the next turn (as one from the room would be). */
  private loopback(input: BodyInput): boolean {
    let body: Body;
    try {
      body = Body.parse(input);
    } catch (err) {
      this.system(`Could not send ${input.kind}: ${errorText(err)}`, 'error');
      return false;
    }
    const now = Date.now();
    const msg: IncomingMessage = { id: `local-${randomUUID()}`, from: this.selfId, ts: now, sentAt: now, body };
    setImmediate(() => void this.handle(msg).catch((err: unknown) => this.system(`Error handling ${body.kind}: ${errorText(err)}`, 'error')));
    return true;
  }

  private wire(): void {
    const { client, store } = this.opts;
    client.on('status', (status) => {
      store.dispatch({ type: 'status', status });
      if (status !== 'connected' || !store.getState().connection) return;
      store.dispatch({ type: 'connection' });
      this.system('Back online');
    });
    // Failed dials update one status (see ConnectionTrouble); the chat gets one line per outage.
    // The same goes for what the room says when it turns you away (a version mismatch, "already
    // connected"): it's the status's reason, and the outage's one line says it.
    client.on('retrying', ({ attempt, retryAt, reason, said }) => {
      const before = store.getState().connection;
      store.dispatch({ type: 'connection', connection: { state: 'reconnecting', attempt, retryAt, reason, since: before?.since ?? Date.now() } });
      if (before) return;
      this.system(said ? `${reason}. Retrying in the background` : this.everConnected ? 'Lost connection to the room. Retrying in the background' : 'Can’t reach the room yet. Retrying in the background', 'warn');
    });
    client.on('welcome', (self, room) => {
      this.everConnected = true;
      store.dispatch({ type: 'welcome', self });
      if (room) store.dispatch({ type: 'room', room });
      if (self.guest && !store.getState().shared.length) this.system(`You came in with a link to ${room ?? 'a project'}. Waiting for them to let you in…`);
      this.host.flushOutbox();
      if (!this.usageFetched) {
        this.usageFetched = true;
        void this.refreshUsage();
      }
    });
    client.on('peers', (peers) => {
      const before = store.getState().peers;
      store.dispatch({ type: 'peers', peers });
      this.people.onPeers(before, peers);
      this.invites.onPeers(peers);
      const gone = before.filter((p) => !peers.some((n) => n.peerId === p.peerId)).map((p) => p.peerId);
      if (gone.length) {
        // A dropped connection isn't leaving: workspace seats survive, only open questions end.
        store.dispatch({ type: 'peer_gone', peerIds: gone });
        for (const id of gone) this.questions.cancelFor(id);
      }
    });
    // A refusal while joining comes again as the reason of the retry (or the end) that follows it;
    // with no retry to follow (reconnect off), it's said here, once.
    client.on('error', (message) => {
      if (client.connected || !client.retries) this.system(message, 'error');
    });
    client.on('rekey', (secret) => {
      // The host replaced the invite link; keep yours current so /invite shares one that works.
      const invite = store.getState().invite;
      if (invite && /#[\w-]+$/.test(invite)) store.dispatch({ type: 'invite', invite: invite.replace(/#[\w-]+$/, `#${secret}`) });
    });
    client.on('ended', (why) => {
      const before = store.getState().connection;
      store.dispatch({ type: 'connection', connection: { state: 'offline', attempt: before?.attempt ?? 0, reason: why, since: before?.since ?? Date.now() } });
      this.system(`${why}. You can keep working on your own; restart Beluga to join a room again.`, 'warn');
      this.toast(why, 'warn');
      store.dispatch({ type: 'shared_clear' });
    });
    client.on('message', (msg) => {
      this.handle(msg).catch((err: unknown) => this.system(`Error handling ${msg.body.kind}: ${errorText(err)}`, 'error'));
    });
  }

  private async handle({ id, from, ts, sentAt, body }: IncomingMessage): Promise<void> {
    // Requests that act on this computer must be fresh and new: an old signed request replayed later is dropped.
    if (GUARDED.has(body.kind) && !this.replay.admit(id, sentAt)) return;
    // Someone invited by link to a project only reaches that project.
    if (from !== this.selfId && this.invites.isRestricted(from) && !guestMayDo(body, this.opts.shares)) return;
    switch (body.kind) {
      case 'fs_search':
        if (!this.opts.shares.canAccess(body.share, from, this.selfId) || !this.opts.shares.isPrivate(body.share)) {
          this.send({ kind: 'fs_search_result', reqId: body.reqId, ok: false, error: 'That folder is not shared with you' }, { to: from });
          return;
        }
        return this.diff.serveSearch(from, body);
      case 'ws_diff':
        return this.diff.serve(from, body);
      case 'fs_search_result':
      case 'ws_diff_result':
        this.files.settle(from, body.reqId, body);
        return;
      case 'gateway':
        // Tasks between Claudes (core/gateway): sent to one person; the gateway checks who may say what.
        gatewayOf(this)?.onRoomFrame(from, body.frame);
        return;
      case 'call':
        // A call in the room's chat (core/calls): the call service checks who may say what.
        receiveRoomCall(this, from, body.p);
        return;
      case 'friend_offer':
        // Someone in the room wants to be friends on the network (BLG-202): shown, never acted on by itself.
        return receiveFriendOffer(this, from, body);
      case 'room_cleared':
        if (this.store.getState().peers.find((p) => p.peerId === from)?.host) {
          this.store.dispatch({ type: 'clear', channel: 'room' });
          this.system(`${peerName(this.store.getState(), from)} cleared the group chat`);
        }
        return;
      case 'share_offer':
        this.store.dispatch({ type: 'offer', offer: { owner: from, name: body.name, writable: body.writable }, active: body.active });
        if (body.active) this.toast(`${peerName(this.store.getState(), from)} shared ${body.name} with you. It's in Files`, 'success');
        return;
      case 'agent_question':
        return this.questions.onQuestion(from, body);
      case 'agent_answer':
        return this.questions.onAnswer(from, body);
      case 'ws_invite':
        return this.sharing.onInvite(from, body);
      case 'ws_request':
        return this.remote.onWsRequest(from, body);
      case 'ws_request_result':
        return this.remote.onWsRequestResult(from, body);
      case 'ws_handoff':
        return this.remote.onHandoff(from, body);
      case 'ws_handoff_result':
        return this.remote.onHandoffResult(from, body);
      case 'ws_handoff_check':
        return this.remote.onHandoffCheck(from, body);
      case 'ws_handoff_check_result':
        return this.remote.onHandoffCheckResult(from, body);
      case 'file_request':
        return this.remote.onFileRequest(from, body);
      case 'file_request_result':
        return this.remote.onFileRequestResult(from, body);
      case 'file_offer':
        return this.remote.onFileOffer(from, body);
      case 'shell_request':
        return this.peerRun.onShellRequest(from, body);
      case 'shell_result':
        return this.peerRun.onShellResult(from, body);
      case 'shell_started':
        return this.peerRun.onShellStarted(from, body);
      case 'trust_grant':
        return this.peerRun.onTrustGrant(from, body);
      case 'ws_roster':
        return this.sharing.onRoster(from, body);
      case 'ws_leave':
        return this.sharing.onLeave(from, body);
      case 'chat': {
        // Workspace chats only reach people in that workspace, and only contributors may post.
        if (body.channel !== 'room' && !this.sharing.canPost(from, body.channel)) return;
        // A worktree deleted here: a message that comes back late (the hub's echo of yours, its run's
        // last words) would bring its conversation back; its log was cleared, so no repeat is noticed.
        if (body.channel && this.workspaces?.deletedChannel(body.channel)) return;
        if (body.channel?.startsWith('ws:')) this.workspaces?.ensureLoaded(body.channel.slice(3));
        const chatId = chatMessageId(from, body.mid, id);
        // The same message again (sent once more after a lost acknowledgement): it's here already.
        if (body.mid && this.store.getState().log.some((l) => l.id === chatId && l.channel === body.channel)) return;
        this.store.dispatch({ type: 'chat', id: chatId, from, text: body.text, ts, byAgent: body.byAgent, channel: body.channel, ...(body.agent ? { agent: body.agent } : {}), ...(body.via ? { via: body.via } : {}) });
        return;
      }
      case 'chat_react':
        return onChatReact(this.reactDeps, from, body);
      case 'focus':
        return this.onFocus(from, ts, body);
      case 'agent_request':
        return this.host.onAgentRequest(from, body);
      case 'agent_event':
        return this.onAgentEvent(from, ts, body);
      case 'fs_list':
      case 'fs_read':
      case 'fs_fetch':
        if (!this.opts.shares.canAccess(body.share, from, this.selfId)) {
          const reply = body.kind === 'fs_list' ? 'fs_list_result' : body.kind === 'fs_read' ? 'fs_read_result' : 'fs_chunk';
          this.send({ kind: reply, reqId: body.reqId, ok: false, error: 'That folder is not shared with you' }, { to: from });
          return;
        }
        return this.files.serveFs(from, body);
      case 'fs_list_result':
      case 'fs_read_result':
      case 'fs_chunk':
        this.files.settle(from, body.reqId, body);
        return;
      case 'fs_changed': {
        // Previews of it (Changes, Files, Scratch) read it again: a rewritten picture shows the new one.
        this.store.dispatch({ type: 'file_written', at: { owner: from, share: body.share, path: body.path }, ts: Date.now() });
        const viewer = this.store.getState().viewer;
        if (viewer && viewer.owner === from && viewer.share === body.share && viewer.path === body.path) {
          await this.files.loadViewer(viewer);
        }
        return;
      }
      case 'report':
        this.system(`${peerName(this.store.getState(), from)}'s agent wrote a report. Open it with /open ${peerName(this.store.getState(), from)}:${body.share}/${body.path}`);
        return;
    }
  }

  private async onFocus(from: string, ts: number, body: BodyOf<'focus'>): Promise<void> {
    const key = body.actor === 'agent' ? `${from}:agent` : from;
    const focus = { owner: body.owner, share: body.share, path: body.path, actor: body.actor, ts };
    this.store.dispatch({ type: 'focus', actorKey: key, focus });
    const state = this.store.getState();
    if (state.follow === from && from !== this.selfId) {
      const by = `${peerName(state, from)}${body.actor === 'agent' ? "'s agent" : ''}`;
      await this.openLocation(focus, { by, broadcast: false });
    }
  }

  /** Choose whether people in the room may use your Claude (from onboarding or /policy). */
  setClaudeSharing(policy: 'ask' | 'auto' | 'deny'): void {
    this.store.dispatch({ type: 'policy', policy });
    this.updateProfile({ agent: this.hasAgent && policy !== 'deny' });
    this.opts.saveSettings?.({ policy });
  }

  /** Change your display name for this room and future ones. */
  rename(raw: string | undefined): void {
    const name = (raw ?? '').replace(/[^\w.-]/g, '').slice(0, 32);
    if (!name) {
      this.toast('Usage: /name <new name> (letters, numbers, . - _)', 'warn');
      return;
    }
    this.updateProfile({ name });
    this.opts.saveSettings?.({ name });
    this.toast(`You're now ${name}`, 'success');
  }

  /**
   * Show something on every screen (not only the one that asked: the phone isn't one of them) and
   * bring the Mac app's window to the front. → whether a window came forward.
   */
  async showOnScreens(intent: Intent): Promise<boolean> {
    this.intents.emit(intent, undefined);
    if (!this.opts.raise) return false;
    return this.opts.raise().then(
      () => true,
      () => false,
    );
  }

  /** Make the terminal's text bigger or smaller, without needing a keyboard shortcut. */
  async zoom(dir: ZoomDir): Promise<void> {
    if (!this.opts.zoom) return this.toast('Text size can only be changed from a terminal', 'warn');
    // No window open (a server): said, not thrown.
    const result = await this.opts.zoom(dir).catch((err: unknown) => ({ ok: false, message: err instanceof Error ? err.message : String(err) }));
    this.toast(result.message, result.ok ? 'success' : 'warn');
  }

  /** Update a display preference and remember it. */
  /** Change preferences; a null (or undefined) one goes back to its default. */
  setPrefs(prefs: { readonly [K in keyof Prefs]?: Prefs[K] | null }): void {
    // Unset travels as null, so every screen clears it too (JSON drops undefined).
    const forScreens = Object.fromEntries(Object.entries(prefs).map(([k, v]) => [k, v === undefined ? null : v]));
    this.store.dispatch({ type: 'prefs', prefs: forScreens });
    this.opts.saveSettings?.(Object.fromEntries(Object.entries(prefs).map(([k, v]) => [k, v === null ? undefined : v])) as Partial<Settings>);
    // Live previews turned off (Settings › Experimental): every one is let go at once.
    if ('experiments' in prefs && !experimentOn(this.store.getState().prefs.experiments, 'previews')) void closePreviews();
    // Your default agent rides on your peer card: friends see the change at once, no reconnect.
    if ('defaultAgent' in prefs || 'projectAgents' in prefs) {
      const chosen = this.store.getState().prefs;
      this.updateProfile({ defaultAgent: chosenAgent(chosen), agents: publishedAgents(chosen) });
    }
  }

  /** Whether `/name` is a skill or command of your own in this conversation's folder (it wins over a Claude Code built-in of that name). */
  async ownSkill(name: string, channel: string): Promise<boolean> {
    const dir = channel === 'room' ? undefined : this.workspaces?.inChannel(channel)?.path;
    if (!dir) return false;
    const { findSkill } = await import('./claude-code/skills.js');
    const { claudeHome } = await import('./claude-code/launch.js');
    return Boolean(await findSkill(name, dir, claudeHome()).catch(() => undefined));
  }

  /** The agent that answers for work in `project` (its own default over yours; BLG-444). */
  agentFor(project?: string): AgentRef {
    return chosenAgent(this.store.getState().prefs, project);
  }

  /** Share a folder with the room (read-only unless `writable`). */
  /**
   * Share a folder with everyone in the room, or only with `only` (they get a private
   * offer; nobody else sees it). Sharing the same folder again changes who sees it.
   */
  shareFolder(dir: string, writable = false, only?: readonly string[]): void {
    const spec = parseShareSpec(`${dir}${writable ? ':rw' : ''}`, process.cwd());
    if (!existsSync(spec.root)) return this.toast(`${spec.root} doesn't exist`, 'warn');
    const previous = this.opts.shares.configs.find((c) => path.resolve(c.root) === path.resolve(spec.root) && !c.name.startsWith('ws-') && !c.name.startsWith('local-') && c.name !== ATTACHMENT_SHARE);
    if (previous) this.unshareFolder(previous.name, true);
    const config = only?.length ? { ...spec, private: true, allowed: [...only] } : spec;
    this.opts.shares.upsert(config);
    this.updateProfile({ shares: this.opts.shares.infos });
    this.publishShares();
    for (const to of only ?? []) this.send({ kind: 'share_offer', name: config.name, writable: config.writable, active: true }, { to });
    const state = this.store.getState();
    const who = only?.length ? only.map((id) => peerName(state, id)).join(', ') : 'the room';
    this.toast(`Sharing ${spec.name} with ${who}${writable ? ' (your agent may edit it)' : ' (read-only)'}`, 'success');
  }

  unshareFolder(name: string, quiet = false): void {
    const config = this.opts.shares.configs.find((c) => c.name === name);
    if (!config) return quiet ? undefined : this.toast(`Nothing called ${name} is shared`, 'warn');
    for (const to of config.private ? (config.allowed ?? []) : []) this.send({ kind: 'share_offer', name, writable: config.writable, active: false }, { to });
    this.opts.shares.remove(name);
    this.updateProfile({ shares: this.opts.shares.infos });
    this.publishShares();
    if (!quiet) this.toast(`Stopped sharing ${name}`);
  }

  /** Your shared folders (not workspaces), for the Share menu. */
  get myShares(): readonly MyShare[] {
    return this.opts.shares.configs
      .filter((c) => !c.name.startsWith('ws-') && !c.name.startsWith('local-') && c.name !== ATTACHMENT_SHARE)
      .map((c) => ({ name: c.name, root: c.root, ...(c.private ? { private: true } : {}), ...(c.allowed ? { allowed: c.allowed } : {}), ...(c.writable ? { writable: true } : {}) }));
  }

  /** Keep the list of your shared folders in the state (screens show it in the Share menu). */
  private publishShares(): void {
    const shares = this.myShares;
    const now = this.store.getState().myShares;
    if (shares.length === now.length && shares.every((x, i) => JSON.stringify(x) === JSON.stringify(now[i]))) return;
    this.store.dispatch({ type: 'my_shares', shares });
  }

  /** Give a friend access to only your shared folders, or your whole computer. */
  setAccess(peerId: string, scope: 'folder' | 'full'): void {
    this.store.dispatch({ type: 'access', peerId, scope });
  }

  /** The agent this Mac answers with (its profile's default; Claude until it names one). */
  get agentRef(): AgentRef {
    return defaultAgentOf(this.opts.client.currentProfile);
  }

  private updateProfile(patch: Partial<Profile>): void {
    this.opts.client.updateProfile({ ...this.opts.client.currentProfile, ...patch });
  }

  /** Merge new usage numbers into that provider's (Claude's unless named) and share them with the room. */
  updateUsage(update: UsageUpdate, agent: AgentRef = CLAUDE_AGENT): void {
    this.updateProfile(withUsage(this.opts.client.currentProfile, agent, update));
  }

  /** Ask the agent backend for fresh plan usage (no prompt is sent), joined with other asks around it. */
  refreshUsage(): Promise<void> {
    return this.usageCheck();
  }

  private async readUsage(): Promise<void> {
    const usage = await this.agent?.refreshUsage?.().catch(() => undefined);
    if (usage) this.updateUsage(usage, CLAUDE_AGENT);
  }

  /**
   * A room ask that named an agent, at its first word back (BLG-520): when another agent answers,
   * a line says which and why: it isn't set up there, or their Mac is older and runs its default.
   */
  private sayWhoAnswers(from: string, body: BodyOf<'agent_event'>): void {
    const asked = this.namedAsks.get(body.requestId);
    if (!asked || asked.peer !== from) return;
    this.namedAsks.delete(body.requestId);
    const by = body.agent ?? CLAUDE_AGENT;
    if (by.runtime === asked.agent.runtime && !body.fallback) return;
    const mine = from === this.selfId;
    const name = peerName(this.store.getState(), from);
    const wanted = agentName(asked.agent);
    const answered = agentName(by);
    if (mine) this.system(`Your ${wanted} isn’t set up on this Mac, so your ${answered} answers`, 'warn');
    else if (body.fallback) this.system(`${name}’s ${wanted} isn’t set up on their Mac, so their ${answered} answers`, 'warn');
    else this.system(`${name}’s Mac can’t pick an agent by name yet (an older Beluga), so their ${answered} answers`, 'warn');
  }

  private onAgentEvent(from: string, ts: number, body: BodyOf<'agent_event'>): void {
    // Your own agent writes into your workspaces, and in one shared with you its owner's; a contributor's
    // own agent too, answering what they asked it there (their "@claude" in a friend's worktree).
    if (body.channel !== 'room' && !this.sharing.agentMayWrite(from, body.channel, body.requester)) return;
    if (body.event === 'usage') {
      if (from === this.selfId) this.workbench?.onUsage(body.channel, body.text);
      return;
    }
    const waiter = this.agentWaiters.get(body.requestId);
    if (body.event === 'answered') {
      // Only for the Claude waiting on it; the chat shows the run as it goes on.
      if (waiter && waiter.peer === from) {
        clearTimeout(waiter.timer);
        this.agentWaiters.delete(body.requestId);
        waiter.resolve(body.text);
      }
      return;
    }
    this.sayWhoAnswers(from, body);
    // Your Claude asked from a workspace: follow the friend's Claude there (only from the one you asked).
    const channel = waiter?.mirror && waiter.peer === from && body.requester === this.selfId ? waiter.mirror : body.channel;
    if (!this.workspaces?.deletedChannel(channel)) this.store.dispatch({ type: 'agent_event', owner: from, requestId: body.requestId, requester: body.requester, event: body.event, text: body.text, ts, channel, ...(body.slotWait ? { slotWait: body.slotWait } : {}), ...(body.agent ? { agent: body.agent } : {}), ...(body.via ? { via: body.via } : {}) });
    if (!waiter || waiter.peer !== from || !['done', 'error', 'denied'].includes(body.event)) return;
    clearTimeout(waiter.timer);
    this.agentWaiters.delete(body.requestId);
    if (body.event === 'done') waiter.resolve(body.text);
    else waiter.reject(new Error(body.text || body.event));
  }

}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
