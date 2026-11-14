import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.js';
import { runtimeFor } from '../agent/runtime/registry.js';
import { claudeStatus } from '../agent/runtime/claude/status.js';
import type { AgentRuntime, RuntimeId } from '../agent/runtime/types.js';
import { createMockBackend } from '../agent/mock.js';
import { createCodexRuntime } from '../agent/runtime/codex/index.js';
import { ScriptedCodex } from '../agent/runtime/codex/scripted.js';
import { createOpenCodeRuntime } from '../agent/runtime/opencode/index.js';
import { ScriptedOpenCode } from '../agent/runtime/opencode/scripted.js';
import { createGrokRuntime } from '../agent/runtime/grok/index.js';
import { ScriptedGrok } from '../agent/runtime/grok/scripted.js';
import { DEMO_PROVIDER_MODELS, demoDescription } from '../agent/runtime/opencode/demo-models.js';
import { createCopilotRuntime } from '../agent/runtime/copilot/index.js';
import { ScriptedCopilot } from '../agent/runtime/copilot/scripted.js';
import { AUTO_MODEL } from '../agent/runtime/copilot/status.js';
import { findConversation } from '../agent/runtime/claude/claude-sessions.js';
import { otherTools } from '../agent/other-tools.js';
import { copyNative, pasteText } from '../core/clipboard.js';
import { DEFAULT_LINK } from '../core/project-invites.js';
import { type SessionOptions, Session } from '../core/session.js';
import { chosenAgent, loadSettings, publishedAgents, saveSettings } from '../core/settings.js';
import { ShareService } from '../core/shares.js';
import { leaveNetwork, networkSwitch } from '../core/network.js';
import { launchBoard } from '../core/board/launch.js';
import { launchDialogues } from '../core/dialogues/launch.js';
import { launchSentinel } from '../core/sentinel/launch.js';
import { launchTriage, sendAutomatic } from '../core/triage/launch.js';
import { AutoContinue } from '../core/auto-continue.js';
import { launchAssistant } from '../core/assistant/launch.js';
import { launchThreads, threadsOf } from '../core/threads/launch.js';
import { launchChat } from '../core/chat/launch.js';
import { launchCalls } from '../core/calls/launch.js';
import { launchGateway } from '../core/gateway/launch.js';
import { launchFriendShares } from '../core/friend-share/launch.js';
import { launchEarnings } from '../core/stripe-launch.js';
import { launchRevenueCat } from '../core/revenuecat-launch.js';
import { launchSupport } from '../core/merge-counter.js';
import { launchTelemetry } from '../telemetry/launch.js';
import { launchStats } from '../core/stats/counter.js';
import { launchLeaderboard } from '../core/leaderboard/launch.js';
import { claudeHome, launchClaudeCode } from '../core/claude-code/launch.js';
import { launchCompanion } from '../companion/launch.js';
import { launchExternal } from '../external/launch.js';
import { swappableIdentity } from '../core/identity.js';
import { identitiesAtStart } from '../machines/identity-load.js';
import { closePreviews } from '../preview/off.js';
import { Store, initialState, prefsFrom } from '../core/store.js';
import { createDemoFolders, createDemoWorkspaces, seedDemoContext, startDemoFriend, startDemoGuest } from '../demo.js';
import { type Identity, deriveKeys, generateSecret } from '../net/crypto.js';
import { type GuestAccess, type GuestGate, type Hub, startHub } from '../net/hub.js';
import { P2P_SCHEME, decodeInvite, encodeInvite, findInvite, isDirect, toWsUrl } from '../net/invite.js';
import { PeerClient } from '../net/peer-client.js';
import { closeAllTunnels, offersDirect, openTunnel, waitUntilReachable } from '../net/tunnel.js';
import { TerminalManager } from '../terminal/index.js';
import { WorkspaceManager } from '../workspaces/manager.js';
import { belugaHome } from '../workspaces/store.js';
import { belugaEnv } from '../core/beluga-env.js';
import { loadDismissedNeeds } from '../core/dismissed-needs.js';
import { claudeCodeReady } from '../agent/claude-code.js';
import { updateClaudeCode } from '../agent/claude-code-updates.js';
import { claudeCodeWorks } from '../agent/runtime/claude/probe.js';

/**
 * Everything Beluga is apart from its screens: your identity, the room (hosted or joined),
 * remote access, projects, terminals and the Session that ties them together. `beluga daemon`
 * builds one and serves it to every screen.
 */

interface Room {
  readonly url: string;
  /** Joiners: the relay to use when a direct connection can't be made. */
  readonly fallbackUrl?: string;
  /** Changes when the host replaces the invite link. */
  secret: string;
  readonly room: string;
  readonly hub?: Hub;
  readonly invite?: string;
  /** The host's signing identity (its peer id is marked as host in the room). */
  readonly identity?: Identity;
  /** Where friends reach the room, once remote access is up: direct (`p2p://`) or a relay, plus an optional fallback relay. */
  reach?: { url: string; relay?: string };
}

const roomInvite = (room: Room): string | undefined => (room.reach ? encodeInvite({ ...room.reach, secret: room.secret }) : undefined);

/** The demo's OpenCode: ready, with the scripted one's models, and DeepSeek's, Kimi's and OpenRouter's (BLG-945). */
function demoOpenCode(): AgentRuntime {
  const scripted = new ScriptedOpenCode({ stepMs: 600 });
  scripted.models = [...scripted.models, ...DEMO_PROVIDER_MODELS.map((m) => ({ value: m.value, name: m.name, efforts: [...m.efforts] }))];
  const context = new Map(DEMO_PROVIDER_MODELS.map((m) => [m.value, m.context]));
  const models = scripted.models.map((m) => ({ value: m.value, label: m.name.split('/').at(-1) ?? m.name, description: demoDescription({ value: m.value, ...(context.has(m.value) ? { context: context.get(m.value) } : {}) }), ...(m.efforts.length ? { efforts: m.efforts } : {}) }));
  return createOpenCodeRuntime({ connect: scripted.connect, resolve: async () => undefined, status: async () => ({ state: 'ready', models }) });
}

/** The demo's Grok Build: ready, with the scripted one's models. */
function demoGrok(): AgentRuntime {
  const scripted = new ScriptedGrok({ stepMs: 600 });
  const models = scripted.models.map((m) => ({ value: m.value, label: m.name, description: 'xAI', efforts: m.efforts }));
  return createGrokRuntime({ connect: scripted.connect, status: async () => ({ state: 'ready', models }) });
}

/** The demo's Copilot: ready, on a plan with a few models besides Auto. */
function demoCopilot(): AgentRuntime {
  const offered = ['claude-sonnet-4.5', 'gpt-5.3-codex'];
  const scripted = new ScriptedCopilot({ stepMs: 600, models: offered });
  const names: Readonly<Record<string, string>> = { 'claude-sonnet-4.5': 'Claude Sonnet 4.5', 'gpt-5.3-codex': 'GPT-5.3-Codex' };
  const models = [AUTO_MODEL, ...offered.map((value) => ({ value, label: names[value] ?? value, description: '' }))];
  return createCopilotRuntime({ connect: scripted.connect, status: async () => ({ state: 'ready', models }) });
}

let claudeWithStatus: AgentRuntime | undefined;
/** The runtimes, Claude's saying whether it's signed in (a local model's side calls go to Claude only then, BLG-503). */
function withClaudeStatus(id?: RuntimeId): AgentRuntime | undefined {
  const rt = runtimeFor(id);
  if (!rt || rt.id !== 'claude' || rt.status) return rt;
  return (claudeWithStatus ??= { ...rt, status: () => claudeStatus() });
}

function lanAddress(): string | undefined {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
}

async function hostRoom(config: Config, identity: Identity): Promise<Room> {
  const secret = generateSecret();
  const room = `${config.name}'s room`;
  const lan = config.lan || config.tunnel === 'none';
  // The host's peer id comes from its own key, so nobody else can claim to be the host.
  const hub = await startHub({ keys: deriveKeys(secret), port: config.port, host: lan ? '0.0.0.0' : '127.0.0.1', roomName: room, hostId: identity.peerId });
  return { url: `ws://127.0.0.1:${hub.port}`, secret, room, hub, identity };
}

async function resolveJoinInvite(config: Config): Promise<string> {
  if (config.invite) return config.invite;
  const found = findInvite((await pasteText()) ?? '');
  if (!found) throw new Error('No invite given and none found on your clipboard. Copy the link your friend sent, then join again');
  return found;
}

async function joinRoom(config: Config): Promise<Room> {
  const code = await resolveJoinInvite(config);
  const invite = decodeInvite(code);
  const relayHost = (url: string): string => new URL(url.replace(/^ws/, 'http')).host;
  const label = isDirect(invite.url) ? (invite.relay ? relayHost(invite.relay) : `direct ${invite.url.slice(P2P_SCHEME.length, P2P_SCHEME.length + 6)}…`) : relayHost(invite.url);
  return { url: invite.url, ...(invite.relay ? { fallbackUrl: invite.relay } : {}), secret: invite.secret, room: label, invite: encodeInvite(invite) };
}

type Announce = (phase: 'ready' | 'local') => Promise<void>;

/** Start accepting direct connections; the invite is ready as soon as the host is on the DHT (~1-2s). */
async function publishDirect(room: Room, hub: Hub, announce: Announce): Promise<boolean> {
  try {
    room.reach = { url: `${P2P_SCHEME}${await hub.listenP2P()}` };
    await announce('ready');
    return true;
  } catch {
    return false;
  }
}

/**
 * `auto` with a direct invite already out: bring up a relay in the background for friends
 * whose network blocks direct connections, and add it to the invite once it answers.
 */
async function addFallbackRelay(room: Room, session: Session, isClosing: () => boolean): Promise<void> {
  const store = session.store;
  const update = async (next: Room['reach']): Promise<void> => {
    const before = roomInvite(room);
    room.reach = next;
    const after = roomInvite(room);
    if (isClosing() || !after) return;
    store.dispatch({ type: 'invite', invite: after });
    // Refresh the clipboard only if it still holds the link we put there.
    if (before && (await pasteText().catch(() => undefined))?.trim() === before) await copyNative(after).catch(() => false);
  };
  try {
    const tunnel = await openTunnel('auto', room.hub?.port ?? 0, {
      onDied: () => {
        if (isClosing() || !room.reach) return;
        void update({ url: room.reach.url });
        // A fresh tunnel (a new name) in a moment, added to the invite once it answers.
        setTimeout(() => void addFallbackRelay(room, session, isClosing), 30_000).unref();
      },
    });
    if (!tunnel || isClosing() || !(await waitUntilReachable(tunnel.publicUrl)) || !room.reach) return;
    await update({ ...room.reach, relay: toWsUrl(tunnel.publicUrl) });
  } catch {
    // The direct invite still works; it just has no fallback.
  }
}

/** Bring remote access up in the background so the UI appears instantly. */
async function publish(config: Config, room: Room, session: Session, isClosing: () => boolean): Promise<void> {
  const store = session.store;
  const port = room.hub?.port ?? 0;
  const lanReach = (): boolean => {
    const ip = lanAddress();
    if (ip) room.reach = { url: `ws://${ip}:${port}` };
    return Boolean(ip);
  };
  const announce: Announce = async (phase) => {
    const invite = roomInvite(room);
    if (isClosing() || !invite) return;
    store.dispatch({ type: 'invite', invite });
    store.dispatch({ type: 'hosting', hosting: { phase } });
    // Only auto-copy with a real clipboard tool; never silently push secrets through the terminal.
    const copied = await copyNative(invite).catch(() => false);
    if (!isClosing()) store.dispatch({ type: 'hosting', hosting: { phase, copied } });
  };

  if (config.tunnel === 'none') {
    if (lanReach()) await announce('local');
    else store.dispatch({ type: 'hosting', hosting: { phase: 'failed', detail: 'No network address found.' } });
    return;
  }
  store.dispatch({ type: 'hosting', hosting: { phase: 'tunnel' } });
  if (offersDirect(config.tunnel) && room.hub) {
    if (await publishDirect(room, room.hub, announce)) {
      if (config.tunnel === 'auto') void addFallbackRelay(room, session, isClosing);
      return;
    }
    if (config.tunnel === 'p2p') {
      store.dispatch({ type: 'hosting', hosting: { phase: 'failed', detail: 'Could not reach the peer-to-peer network. Check your connection, or switch Remote access to Cloudflare in /settings.' } });
      return;
    }
    // auto: no direct connections today, so fall back to the relay alone.
  }
  try {
    const tunnel = await openTunnel(config.tunnel, port, {
      onProgress: (detail) => store.dispatch({ type: 'hosting', hosting: { phase: 'tunnel', detail } }),
      onDied: (reason) => {
        if (isClosing()) return;
        store.dispatch({ type: 'hosting', hosting: { phase: 'failed', detail: `${reason}. Restart Beluga to get a new invite.` } });
        session.toast('Remote access stopped: the tunnel closed', 'error');
      },
    });
    if (!tunnel || isClosing()) return;
    store.dispatch({ type: 'hosting', hosting: { phase: 'reachable' } });
    if (!(await waitUntilReachable(tunnel.publicUrl))) throw new Error('The tunnel never became reachable');
    room.reach = { url: toWsUrl(tunnel.publicUrl) };
    await announce('ready');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const fallback = config.lan && lanReach();
    if (fallback) await announce('local');
    store.dispatch({
      type: 'hosting',
      hosting: { phase: 'failed', detail: `${reason}. ${fallback ? 'Friends on your Wi-Fi can still join with /invite.' : 'Restart with --lan to invite people on your Wi-Fi.'}` },
    });
  }
}

/** What only a screen (or the process showing it) can do for the core. */
export type CoreHooks = Pick<SessionOptions, 'copy' | 'desktopNotify' | 'zoom' | 'raise' | 'open' | 'openPage' | 'shutdown'>;

export interface Core {
  readonly config: Config;
  readonly session: Session;
  readonly store: Store;
  readonly terminals: TerminalManager;
  /** The room's name (one room per core). */
  readonly room: string;
  /** Where its workspaces' records and saved conversations are kept. */
  readonly workspacesHome: string;
  /** Start everything: the connection, timers, remote access when asked for, the demo's friends. */
  start(): void;
  /** Leave the room and stop everything. */
  stop(): Promise<void>;
  /** The Mac is about to sleep: mail what friends haven't taken (BLG-277). */
  sleeping(): Promise<void>;
}

/** Build Beluga's core for this config (hosting a room, or joining one). */
export async function buildCore(input: Config, hooks: CoreHooks, opts: { readonly network?: boolean } = {}): Promise<Core> {
  let config = input;
  const demo = config.mode === 'demo' ? createDemoFolders() : undefined;
  if (demo) config = { ...config, tunnel: 'none', policyChosen: true, shares: [{ name: 'landing', root: demo.mine, writable: true }] };
  // The Mac app's first launch: fetch Claude Code now, so it's usually there before the first message (BLG-384).
  if (!demo && config.agent && !belugaEnv('CLAUDE_PATH')) void claudeCodeReady().catch(() => {});
  // Your own key, kept between runs: friends recognize you, and the trust they gave you comes back.
  // Rooms sign as you even after your identity moved to your Always On (BLG-846: this Mac's standby copy, never its stand-in key);
  // who this install is on the network can move there and back (BLG-796): the parts that follow it read `you`.
  const { local, you: identity } = identitiesAtStart(belugaHome());
  const you = swappableIdentity(local);
  const saved = loadSettings();
  const room = config.mode === 'join' ? await joinRoom(config) : await hostRoom(config, identity);
  const shares = new ShareService(config.shares);
  // Remember an explicitly chosen name, so plain `beluga` uses it next time.
  if (process.argv.includes('--name') || process.argv.includes('-n')) saveSettings({ name: config.name });
  const store = new Store(initialState(room.room, config.policy, { ...prefsFrom(saved), theme: config.theme, mouse: config.mouse, tunnel: config.tunnel, selfApproval: config.selfApproval }));
  if (room.invite) store.dispatch({ type: 'invite', invite: room.invite });
  store.dispatch({ type: 'needs_dismissed', ids: loadDismissedNeeds() });

  const client = new PeerClient({
    url: room.url,
    ...(room.fallbackUrl ? { fallbackUrl: room.fallbackUrl } : {}),
    keys: deriveKeys(room.secret),
    profile: { name: config.name, shares: shares.infos, agent: config.agent, agents: publishedAgents(saved), defaultAgent: chosenAgent(saved) },
    identity,
  });
  const hub = room.hub;
  const replaceInvite = (): void => {
    if (!hub) return;
    room.secret = generateSecret();
    hub.replaceInvite(room.secret, deriveKeys(room.secret));
    const invite = roomInvite(room);
    if (invite) store.dispatch({ type: 'invite', invite });
  };
  const roomControl = hub
    ? {
        removePerson: (peerId: string) => {
          hub.kick(peerId);
          replaceInvite();
        },
        newInvite: replaceInvite,
        setOpen: (open: boolean) => hub.setOpen(open),
        clearHistory: () => hub.clearHistory(),
        guests: {
          setGate: (gate: GuestGate) => hub.setGuestGate(gate),
          setAccess: (peerId: string, access: GuestAccess) => hub.setGuestAccess(peerId, access),
          turnAway: (peerId: string) => void hub.dismiss(peerId, `${config.name} didn't let you in this time`),
        },
      }
    : undefined;

  const primary = config.shares[0];
  const agentCwd = primary?.root ?? process.cwd();
  let closing = false;
  let saveAsked = false;
  const workspaces = demo ? await createDemoWorkspaces() : new WorkspaceManager();
  // The demo reads Claude Code's conversations only from a pretend ~/.claude (BELUGA_CLAUDE_HOME, the e2e's), never yours.
  const readsClaude = !demo || Boolean(belugaEnv('CLAUDE_HOME'));
  if (demo && readsClaude) process.env.CLAUDE_CONFIG_DIR = claudeHome();
  const terminals = new TerminalManager();
  const session: Session = new Session({
    workspaces,
    client,
    store,
    shares,
    agentCwd,
    ...hooks,
    // Remote access only opens when you ask for an invite.
    startInvite: () => {
      if (config.mode !== 'host' || demo) return;
      if (config.agent && !config.policyChosen && !saveAsked) {
        saveAsked = true;
        session.intend({ type: 'overlay', overlay: 'welcome' });
      }
      void publish(config, room, session, () => closing);
    },
    saveSettings: (patch) => void saveSettings(patch),
    createAgent: demo
      ? (bridge) => createMockBackend(bridge, Number(belugaEnv('DEMO_PACE')) || 2.6) // unhurried, so you can watch workspaces run side by side
      : undefined,
    // The demo's Codex, OpenCode, Grok Build and Copilot: the real runtimes over a scripted app-server,
    // a scripted `opencode acp`, a scripted `grok agent stdio` and a scripted `copilot --acp`
    // (BLG-462, BLG-686, BLG-873).
    ...(demo ? { alsoRuntimes: [createCodexRuntime({ connect: new ScriptedCodex({ stepMs: 600 }).connect }), demoOpenCode(), demoGrok(), demoCopilot()] } : {}),
    // Your agent through the runtime seam (agent/runtime): Claude, the only one registered yet.
    ...(!demo && config.agent
      ? {
          // runtime.agent stays unset (Claude): the routed backend's fallback, so side calls and usage keep a
          // Claude to fall back on; each run follows its place's agent, side calls your default (session.sideRoute).
          runtime: {
            runtimes: withClaudeStatus,
            options: {
              cwd: agentCwd,
              autoEdit: primary?.writable ?? false,
              additionalDirectories: config.shares.slice(1).map((s) => s.root),
              ...(config.model ? { model: config.model } : {}),
              // Your own Claude Code when you named one; else unset: each call asks for the current one (claudeExecutable), so a newer one Beluga moved to is used from the next run.
              ...(belugaEnv('CLAUDE_PATH') ? { executablePath: belugaEnv('CLAUDE_PATH') } : {}),
            },
          },
        }
      : {}),
    launchDir: process.cwd(),
    terminals,
    // Claude Code kept current in the background (a newer one in the build's line, checked first), unless you run your own.
    ...(!demo && config.agent && !belugaEnv('CLAUDE_PATH') && belugaEnv('CLAUDE_CODE_UPDATES') !== 'off' ? { updateAgent: async () => (await updateClaudeCode({ works: (bin) => claudeCodeWorks(bin) })) === 'updated' } : {}),
    savedPeople: saved.people,
    loadPeople: () => loadSettings().people,
    replayFile: path.join(belugaHome(), 'seen.json'),
    stepsDir: path.join(belugaHome(), 'steps'),
    ...(readsClaude ? { findConversation, otherTools } : {}),
    ...(roomControl ? { room: roomControl } : {}),
  });

  for (const note of config.notes) session.system(note, 'warn');
  if (config.mode === 'join') session.system(`Joining ${room.room}…`);

  let stopNetwork = async (): Promise<void> => undefined;
  let stopEarnings = (): void => undefined;
  let stopRevenueCat = (): void => undefined;
  let stopSupport = (): void => undefined;
  let stopTelemetry = async (): Promise<void> => undefined;
  let stopStats = (): void => undefined;
  let stopLeaderboard = (): void => undefined;
  let stopClaudeCode = (): void => undefined;
  let stopGateway = (): void => undefined;
  let stopChat = (): void => undefined;
  let stopCalls = (): void => undefined;
  let stopFriendShares = (): void => undefined;
  let stopBoard = (): void => undefined;
  let stopDialogues = (): void => undefined;
  let stopSentinel = (): void => undefined;
  let stopTriage = (): void => undefined;
  let stopAutoContinue = (): void => undefined;
  let stopAssistant = (): void => undefined;
  let stopThreads = (): void => undefined;
  let stopCompanion = async (): Promise<void> => undefined;
  let stopExternal = async (): Promise<void> => undefined;
  const start = (): void => {
    session.start();
    // The Beluga network (friends, groups, presence): only the daemon runs it, and only when it's turned on.
    // It can be turned on and off later too (`network.setEnabled`).
    if (opts.network) stopNetwork = networkSwitch({ session, store, identity: you.identity, name: config.name, dir: belugaHome(), demo: Boolean(demo), warn: (text) => session.system(text, 'warn') }, saved).stop;
    // Earnings from Stripe per project (the Mac app shows them): the daemon counts them in the background.
    if (opts.network) stopEarnings = launchEarnings({ session, store, demo: Boolean(demo) });
    // Earnings from RevenueCat per project, added to Stripe's (its exchange rates come from launchEarnings).
    if (opts.network) stopRevenueCat = launchRevenueCat({ session, store, demo: Boolean(demo) });
    // Merged work made in Beluga, counted once per branch: the first and fifth merge ask for a star and a coffee.
    if (opts.network) stopSupport = launchSupport({ session, store, demo: Boolean(demo), asks: belugaEnv('DEMO_ASKS') });
    // Usage statistics, when you chose to share them: only Beluga's own releases can send (src/telemetry).
    if (opts.network) stopTelemetry = launchTelemetry({ session, store, demo: Boolean(demo), asks: belugaEnv('DEMO_ASKS') });
    // Your stats for the Usage tab: prompts, agent time, worktrees, pull requests, by project and agent.
    // BELUGA_DEMO_STATS=sparse: someone with only Claude, a plan without a 5-hour limit, no GitHub CLI, never dictating.
    if (opts.network) stopStats = launchStats({ session, store, demo: Boolean(demo), sparse: belugaEnv('DEMO_STATS') === 'sparse' });
    // The leaderboard: friends swap three numbers a day (prompt characters, merged PRs, agent time) while the network is on.
    if (opts.network) stopLeaderboard = launchLeaderboard({ session, store, demo: Boolean(demo) });
    // Claude Code sessions running outside Beluga (Conductor, a terminal): the Mac app shows them live, read-only.
    // Tasks between Claudes (the gateway): over this room now, and over the network whenever it's on.
    if (opts.network) stopGateway = launchGateway({ session, store, demo: Boolean(demo) });
    // Chats: files shared Mac to Mac, Claudes called into a conversation, your main channel.
    if (opts.network) stopChat = launchChat({ session, store, demo: Boolean(demo) });
    // Calls in a conversation with friends: ringing, who's in, and WebRTC setup between windows (core/calls).
    if (opts.network) stopCalls = launchCalls({ session, store, demo: Boolean(demo) });
    // Projects, worktrees and folders shared with friends over the network, nobody hosting.
    if (opts.network) stopFriendShares = launchFriendShares({ session, store, demo: Boolean(demo) });
    // Tasks (the board): opened by worktrees, moved by pull requests, kept true by Claude.
    if (opts.network) stopBoard = launchBoard({ session, store, demo: Boolean(demo) });
    // Each chat's category for you (core/triage): after the board, because it reads plans and their tasks.
    if (opts.network) stopTriage = launchTriage({ session, store, demo: Boolean(demo) });
    // Dialogues between your agents, chaired by Beluga (core/dialogues): saved beside plans.
    if (opts.network) stopDialogues = launchDialogues({ session, store, demo: Boolean(demo) });
    // Sentinel: watchers that run on a schedule or by hand, do a few steps and leave a report (docs/sentinel.md).
    if (opts.network) stopSentinel = launchSentinel({ session, store, demo: Boolean(demo) });
    // A run that stopped on your usage limit is told to continue once the limit resets (shared/auto-continue.ts).
    if (opts.network) {
      // A child thread (core/threads) a stop reached is not sent on; one it sends on owes that turn to its parent.
      const auto = new AutoContinue({
        store,
        ask: (prompt, channel) => sendAutomatic(session, () => session.askOwnClaude(prompt, channel, true)),
        warn: (text) => console.warn(text),
        skip: (channel) => threadsOf(session)?.skipsContinue(channel) ?? false,
        sent: (channel, requestId) => threadsOf(session)?.limitContinued(channel, requestId),
      });
      stopAutoContinue = () => auto.stop();
    }
    // "Your Mac": one conversation with your Claude for the whole Mac, from the phone and the sidebar (core/assistant).
    if (opts.network) stopAssistant = launchAssistant({ session, store, demo: Boolean(demo) });
    // Child threads your agents start (core/threads): the tools show only with prefs.agentThreads on.
    if (opts.network) stopThreads = launchThreads(session);
    if (opts.network) stopClaudeCode = launchClaudeCode({ session, store, demo: Boolean(demo), notify: (e) => session.notifier.notify(e) });
    // Your phone (docs/companion.md): pairing it, and its link. Its DHT node runs only while a phone is paired or a pairing is open.
    if (opts.network) stopCompanion = launchCompanion({ session, store, identity: you.identity, you, terminals, demo: Boolean(demo), log: (line) => console.warn(line) });
    // External agents (GrokBot, a Claude Code in your terminal): their own port, off until you turn it on.
    if (opts.network) stopExternal = launchExternal({ session, log: (line) => console.warn(line) });
    if (config.mode === 'host' && config.inviteNow) void publish(config, room, session, () => closing);
    if (!demo) return;
    // A pretend friend and a fake invite so every part of the UI has something to show.
    store.dispatch({ type: 'invite', invite: 'https://calm-river-demo.trycloudflare.com#k3JdQ9vXr2Lm8TzW4yBn' });
    store.dispatch({ type: 'hosting', hosting: { phase: 'ready', copied: true } });
    session.system('Demo mode: bob, mia and every Claude are simulated. Nothing leaves your computer.');
    seedDemoContext(store);
    setTimeout(() => {
      if (belugaEnv('DEMO_STATS') === 'sparse') return void session.updateUsage({ plan: 'pro', week: { pct: 38 } });
      session.updateUsage({ plan: 'max', fiveHour: { pct: 12 }, week: { pct: 38 } });
      // A second and a third provider, so the Usage tab shows a card for each shape (BLG-458).
      session.updateUsage({ plan: 'plus', windows: [{ label: 'Weekly', pct: 24 }] }, { runtime: 'codex', model: 'gpt-5', label: 'Codex' });
      session.updateUsage({ tokens: { input: 182_000, output: 41_500 }, tokensPerSec: 38 }, { runtime: 'local', model: 'qwen3', label: 'Local' });
    }, 300);
    // bob "arrives" a moment later so you first see how inviting works (sooner at a faster pace: the e2e tests).
    const soon = (ms: number): number => ms * Math.min(1, Number(process.env.KLAUD_DEMO_PACE) || 1);
    setTimeout(() => startDemoFriend(room.url, deriveKeys(room.secret), demo.bob, 'bob'), soon(2500));
    setTimeout(() => startDemoFriend(room.url, deriveKeys(room.secret), demo.mine, 'mia'), soon(3500));
    // zoe got a link to bob-api and knocks, so you see the card for letting someone in.
    setTimeout(() => {
      const project = store.getState().projects.find((p) => p.name === 'bob-api');
      if (!project) return;
      void session.invites.create({ scope: project.id, ...DEFAULT_LINK }, { copy: false }).then((link) => {
        const secret = link && session.invites.urlOf(link.id)?.match(/#([\w-]+)$/)?.[1];
        if (secret) startDemoGuest(room.url, deriveKeys(secret));
      });
    }, soon(5500));
  };

  const stop = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    closeAllTunnels();
    await stopExternal();
    await leaveNetwork(session);
    stopGateway();
    stopCalls();
    stopChat();
    stopFriendShares();
    stopAssistant();
    stopThreads();
    stopSentinel();
    stopTriage();
    stopAutoContinue();
    stopBoard();
    stopDialogues();
    await closePreviews().catch(() => undefined);
    await stopCompanion();
    await stopNetwork();
    stopEarnings();
    stopRevenueCat();
    stopSupport();
    await stopTelemetry();
    stopLeaderboard();
    stopStats();
    stopClaudeCode();
    await session.stop();
    terminals.closeAll();
    await room.hub?.close();
  };

  /** The Mac is about to sleep (BLG-277): what friends haven't taken goes to their mailboxes now. */
  const sleeping = (): Promise<void> => leaveNetwork(session);
  return { config, session, store, terminals, room: room.room, workspacesHome: workspaces.store.home, start, stop, sleeping };
}
