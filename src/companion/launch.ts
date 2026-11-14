import { EnvSend, attachEnvSend } from '../machines/env-send.js';
import { Forwarder, attachForwarder, serveTunnels } from '../machines/forward.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCodeOf } from '../core/claude-code/launch.js';
import { belugaEnv } from '../core/beluga-env.js';
import { belugaHome } from '../core/home.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import type { Session } from '../core/session.js';
import type { Store } from '../core/store.js';
import { installedVersion } from '../core/version.js';
import { dispatchCall } from '../daemon/dispatch.js';
import type { Identity } from '../net/crypto.js';
import { listScratch } from '../workspaces/scratch.js';
import { isSentPath } from '../shared/scratch-dir.js';
import { assistantOf } from '../core/assistant/registry.js';
import { ASSISTANT_CHANNEL, isAssistant } from '../shared/assistant.js';
import { DeviceBook } from './devices.js';
import { CompanionHost } from './host.js';
import { idleWhenWatched } from './push.js';
import { attachCompanion, detachCompanion } from './registry.js';
import type { ConvOutput } from './views.js';
import type { NetworkSummary } from '../net/mesh/views.js';
import { needSentinel } from '../core/sentinel/registry.js';
import { DEMO_ALWAYS_ON, demoMachines } from '../machines/demo.js';
import { collectInfo, realInfoDeps } from '../machines/info.js';
import { ComputerUpdater, psHere, updateRunner } from '../machines/versions.js';
import { IPC_VERSION } from '../ipc/protocol.js';
import { Machines } from '../machines/machines.js';
import { SettingsSync } from '../machines/sync.js';
import { attachMachines, detachMachines, screenDoorOf } from '../machines/registry.js';
import { AlwaysOn, attachAlwaysOn, detachAlwaysOn } from '../machines/always-on.js';
import { FriendsLink, attachFriendsLink, detachFriendsLink } from '../machines/friends.js';
import { LeaseKeeper, dhtLeaseBoard } from '../machines/lease.js';
import { gateNetwork } from '../core/network.js';
import { type SwappableIdentity, swappableIdentity } from '../core/identity.js';
import { networkSummaryOf, networkSwitchOf } from '../core/network.js';
import { pinCompanionSeed } from './host.js';

/**
 * Start the phone companion for the daemon (the Mac app's Beluga): the device book in
 * ~/.beluga/devices.json and the CompanionHost (which runs a DHT node only while a phone is
 * paired or a pairing is open). The demo keeps its phones in a temporary folder.
 *
 * Outputs for the phone's views come from disk, so they're gathered here in the background (a
 * conversation's scratch folder, and what its sub-agents made, as the Mac's Outputs tab shows
 * them) for the conversations a phone has open plus the latest few, every few seconds while a
 * phone is linked; views read the cache, never the disk.
 */

const REFRESH_MS = 5_000;
/** Besides the ones on a phone's screen: the latest conversations, for Home's outputs strip. */
const RECENT = 8;

class OutputCache {
  private readonly cache = new Map<string, readonly ConvOutput[]>();
  private watched: readonly string[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly session: Session,
    private readonly store: Store,
    private readonly changed: () => void,
  ) {}

  // Your Mac's chats share its folder, so its outputs (BLG-102).
  get = (channel: string): readonly ConvOutput[] => this.cache.get(isAssistant(channel) ? ASSISTANT_CHANNEL : channel) ?? [];

  watch(channels: readonly string[], linked: boolean): void {
    this.watched = channels;
    if (linked && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
      this.timer.unref();
      void this.refresh();
    } else if (!linked && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    } else if (linked) void this.refresh();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private channels(): string[] {
    const state = this.store.getState();
    const last = new Map<string, number>();
    for (const l of state.log) if (l.channel.startsWith('ws:')) last.set(l.channel, Math.max(last.get(l.channel) ?? 0, l.ts));
    const recent = [...last.entries()].sort((a, b) => b[1] - a[1]).slice(0, RECENT).map(([c]) => c);
    // Your Mac always: Home's "Ask your Mac" counts what it sent you.
    return [...new Set([ASSISTANT_CHANNEL, ...this.watched, ...recent])];
  }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const state = this.store.getState();
      let moved = false;
      for (const channel of this.channels()) {
        if (channel === ASSISTANT_CHANNEL) {
          // Its scratch folder: the screenshots and files it sent you (core/assistant).
          const mine = (await assistantOf(this.session)?.outputs().catch(() => [])) ?? [];
          const all = mine.slice(0, 100);
          if (JSON.stringify(this.cache.get(channel)) !== JSON.stringify(all)) moved = true;
          this.cache.set(channel, all);
          continue;
        }
        const wsId = channel.slice(3);
        const ws = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId);
        if (!ws?.path) continue;
        // What you sent Claude (sent/) is yours, not one of its outputs.
        const scratch = (await listScratch(ws.path).catch(() => [])).filter((f) => !isSentPath(f.path)).map((f) => ({ path: path.join(ws.path, f.path), size: f.size, ts: f.mtime, cwd: ws.path }));
        const agents = this.agentOutputs(wsId, ws.path);
        const all = [...agents, ...scratch].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, 100);
        const before = this.cache.get(channel);
        if (JSON.stringify(before) !== JSON.stringify(all)) moved = true;
        this.cache.set(channel, all);
      }
      if (moved) this.changed();
    } finally {
      this.busy = false;
    }
  }

  /** What the sub-agents of this workspace's own Claude Code sessions made (claudeCode.outputs). */
  private agentOutputs(wsId: string, cwd: string): ConvOutput[] {
    let watcher: ReturnType<typeof claudeCodeOf>;
    try {
      watcher = claudeCodeOf(this.session);
    } catch {
      return [];
    }
    return this.store
      .getState()
      .claudeCode.sessions.filter((s) => s.workspaceId === wsId)
      .flatMap((s) =>
        s.agents.flatMap((a) =>
          watcher.outputs(s.id, a.id).outputs.map((o) => ({ path: o.path, size: o.size, ts: o.mtime, by: a.toolUseId ?? a.id, cwd })),
        ),
      );
  }
}

export interface CompanionLaunch {
  readonly session: Session;
  readonly store: Store;
  readonly identity: Identity;
  /** Your identity as it moves to your Always On and back (BLG-796); `identity` reads through it. */
  readonly you?: SwappableIdentity;
  readonly demo: boolean;
  readonly log?: (line: string) => void;
  /** The daemon's terminals: a worktree's, shared with the phone. */
  readonly terminals?: import('../terminal/pty-host.js').TerminalManager;
}

/** The Mac's name as people know it ("Kayra’s MacBook Pro"): the one set in `beluga setup`, its Sharing name, else its host name. */
let named: string | undefined;
function macName(): string {
  if (named) return named;
  named = loadSettings().computerName;
  if (named) return named;
  try {
    if (process.platform === 'darwin') named = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2_000 }).trim() || undefined;
  } catch {
    // no scutil: the host name will do
  }
  named ??= os.hostname().replace(/\.local$/, '').replace(/-/g, ' ') || (process.platform === 'darwin' ? 'Your Mac' : 'Your computer');
  return named;
}

/**
 * BELUGA_DHT_BOOTSTRAP="127.0.0.1:49737,…": the phones' network is a local testnet (tests that run
 * the daemon whole, such as `beluga pair` in a terminal); unset, the public one.
 */
export function dhtFromEnv(env: NodeJS.ProcessEnv = process.env): { dht?: { bootstrap: { host: string; port: number }[]; host: string } } {
  const raw = belugaEnv('DHT_BOOTSTRAP', env);
  if (!raw) return {};
  const bootstrap = raw.split(',').map((a) => /^\s*([\w.-]+):(\d+)\s*$/.exec(a)).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => ({ host: m[1]!, port: Number(m[2]) }));
  return bootstrap.length ? { dht: { bootstrap, host: '127.0.0.1' } } : {};
}

export function launchCompanion(opts: CompanionLaunch): () => Promise<void> {
  const dir = opts.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-companion-')) : belugaHome();
  const devices = new DeviceBook(path.join(dir, 'devices.json'));
  const seedFile = path.join(dir, 'companion-seed.json');
  let host: CompanionHost | undefined;
  // Your device set and computers (BLG-774): they share the phones' node, relay and address.
  // Its name and icon as kept here (BLG-780): what every device of yours shows.
  const infoDeps = { ...realInfoDeps(() => opts.store.getState(), { version: installedVersion(), ipc: IPC_VERSION }), look: () => ({ name: macName(), ...(loadSettings().computerIcon ? { icon: loadSettings().computerIcon! } : {}) }) };
  // Update It from your app (BLG-777): `beluga update` here once nothing runs, or what runs is said.
  const run = opts.demo ? undefined : updateRunner();
  const updater = new ComputerUpdater({
    state: () => opts.store.getState(),
    shells: () => (opts.terminals?.list() ?? []).filter((p) => p.running && p.pid !== undefined).map((p) => p.pid!),
    ps: psHere,
    ...(run ? { run } : {}),
    name: macName,
    ...(opts.log ? { log: opts.log } : {}),
  });
  // .env files for worktrees made on your computers (BLG-800): asked with names, sent over the link.
  let envSend: EnvSend | undefined;
  // Your settings, the same on every device of yours (BLG-805); your own variables only with computers you said yes for.
  const settings = opts.demo
    ? undefined
    : new SettingsSync({
        file: path.join(dir, 'settings-sync.json'),
        prefs: () => opts.store.getState().prefs,
        watch: (listener) => opts.store.subscribe(listener),
        apply: (patch) => opts.session.setPrefs(patch as Parameters<Session['setPrefs']>[0]),
        secrets: { read: () => opts.session.env.globals(), write: (key, value) => opts.session.env.setOne(undefined, key, value), watch: (listener) => opts.session.env.watch(listener) },
        ...(opts.log ? { log: opts.log } : {}),
      });
  // Make Always On (BLG-796): your identity and friends network move to one of your computers and back.
  let alwaysOn: AlwaysOn | undefined;
  let friends: FriendsLink | undefined;
  let lease: LeaseKeeper | undefined;
  const you = opts.you ?? swappableIdentity(opts.identity);
  const machines = new Machines({
    dir,
    identity: you.identity,
    devices,
    node: () => host!.dhtNode(),
    address: () => host!.address(),
    relayUrl: () => host?.relayUrl(),
    relay: { add: (route) => host?.reach.server.add(route), remove: (key) => host?.reach.server.remove(key) },
    name: macName,
    version: installedVersion(),
    removePhone: (id) => void host?.removeDevice(id, 'This phone was forgotten on another of your devices'),
    onChange: () => host?.machinesChanged(),
    // What this computer has free, for an app of yours that asks (BLG-778).
    info: () => collectInfo(infoDeps),
    updater,
    ...(settings ? { settings } : {}),
    // Renamed or a new icon from your app: this computer's own settings, so every device agrees.
    setLook: (look) => {
      saveSettings({ ...(look.name ? { computerName: look.name } : {}), ...(look.icon ? { computerIcon: look.icon } : {}) });
      if (look.name) named = undefined;
    },
    // Add Over SSH (BLG-781): your own ssh, keys and agent.
    ssh: belugaEnv('SSH') ?? 'ssh',
    // An app of yours driving this computer: a screen of the daemon's, of kind machine (BLG-775).
    adopt: (socket, hello) => {
      const door = screenDoorOf(opts.session);
      if (door) door.adoptMachine(socket, hello);
      else socket.close(1013, 'Beluga is starting');
    },
    // The demo's Mac mini and build-box (BLG-779), for the e2e tests and GIFs.
    ...(opts.demo ? { demo: () => demoMachines(opts.store.getState()) } : {}),
    // An app of yours forwarding this computer's dev servers to itself, or sharing its own ports here (BLG-802/804).
    tunnels: (socket) => void serveTunnels(socket, { name: macName, ...(opts.log ? { log: opts.log } : {}) }),
    alwaysOn: {
      serve: (socket, cert, hello) => (alwaysOn ? alwaysOn.serve(socket, cert, hello) : socket.close(1013, 'Beluga is starting')),
      at: () => alwaysOn?.at(),
      net: () => {
        const summary = networkSummaryOf(opts.session);
        return summary?.enabled ? { ...summary, enabled: true as const, friends: [...summary.friends], groups: [...summary.groups], invitations: [...summary.invitations], pendingJoins: [...summary.pendingJoins] } : undefined;
      },
      // Between polls the friends link mirrors it live; this only fills in while that link is down.
      mirror: (net) => {
        if (!friends?.live) opts.store.dispatch({ type: 'net_summary', summary: net as unknown as NetworkSummary });
      },
    },
    onWorktree: (machineId, workspaceId) => void envSend?.offer(machineId, workspaceId).catch((err: unknown) => opts.log?.(`env-send: couldn't offer env files: ${err instanceof Error ? err.message : String(err)}`)),
    ...(opts.log ? { log: opts.log } : {}),
  });
  envSend = new EnvSend({
    file: path.join(dir, 'env-send.json'),
    projects: () => opts.store.getState().projects,
    machineName: (id) => machines.book.get(id)?.name ?? 'Your computer',
    call: (machineId, method, args) => machines.door.call(machineId, method, args),
    publish: (asks) => opts.store.dispatch({ type: 'env_sends', asks }),
    ...(opts.log ? { log: opts.log } : {}),
  });
  attachEnvSend(opts.session, envSend);
  // Your computers' dev servers at localhost on this Mac, while a screen of yours drives them (BLG-802).
  const forwarder = new Forwarder({
    live: () => machines.door.live(),
    machineName: (id) => machines.book.get(id)?.name ?? 'Your computer',
    call: (machineId, method, args) => machines.door.call(machineId, method, args),
    openLink: (id) => {
      const record = machines.book.get(id);
      return record ? machines.openLink(record) : Promise.reject(new Error('That computer is gone from your devices'));
    },
    publish: (forwards) => opts.store.dispatch({ type: 'forwards', forwards }),
    publishShares: (shares, onComputers) => opts.store.dispatch({ type: 'port_shares', shares, onComputers }),
    ...(opts.log ? { log: opts.log } : {}),
  });
  if (!opts.demo) forwarder.start();
  attachForwarder(opts.session, forwarder);
  const outputs = new OutputCache(opts.session, opts.store, () => host?.refreshViews());
  host = new CompanionHost({
    identity: you.identity,
    seedFile,
    // A phone's certificate is signed by your identity: while your Always On holds it, phones pair there.
    cannotPair: () => {
      const at = opts.demo ? undefined : alwaysOn?.view();
      return at && !at.here ? `${at.name ?? 'Your Always On'} holds your identity now: make this Mac Always On again (Settings › Your Computers) to pair a phone here.` : undefined;
    },
    store: opts.store,
    devices,
    call: (clientId, method, args) => dispatchCall(opts.session, clientId, method, args),
    macName,
    ...dhtFromEnv(),
    version: installedVersion(),
    thumbsDir: path.join(dir, 'companion', 'thumbs'),
    macrosFile: path.join(dir, 'phone-macros.json'),
    outputs: outputs.get,
    // MCP Apps: a step whose tool has an app says so on the phone (the step book is read only for turns with MCP steps: views.ts).
    appSteps: (channel, itemId) => new Set(opts.session.host.stepsFor(channel, itemId).steps.filter((x) => x.hasApp).map((x) => x.title)),
    // A kept table's documents and storage objects, streamed to the phone from memory (BLG-386).
    documents: (d) => {
      const sn = needSentinel(opts.session);
      if (d.run !== undefined) return Promise.resolve(sn.runFileBytes(d.run, d.name));
      if (d.history !== undefined) {
        const out = sn.metricExport(d.sentinelId, d.history, 'csv');
        return Promise.resolve({ name: out.name, mime: out.mime, bytes: new TextEncoder().encode(out.text) });
      }
      return sn.documentBytes(d.sentinelId, d.metric, d.column, d.value);
    },
    watching: (channels, linked) => outputs.watch(channels, linked),
    idleMs: idleWhenWatched(() => opts.session.attention.screens),
    ...(opts.terminals ? { terminals: opts.terminals } : {}),
    // The relay through Cloudflare, unless Remote access is set to direct only (or the network only),
    // or it's the demo (nothing leaves the computer).
    relay: opts.demo || ['p2p', 'none'].includes(opts.store.getState().prefs.tunnel) ? 'off' : 'cloudflared',
    ...(opts.log ? { log: opts.log } : {}),
    machines,
    // Your Always On runs your friends network: it tells your phones what comes in, not this Mac too (BLG-850).
    tellsFriends: () => !alwaysOn?.at(),
  });
  alwaysOn = new AlwaysOn({
    dir,
    machines,
    you,
    network: () => networkSwitchOf(opts.session),
    settings: { load: loadSettings, save: (patch) => void saveSettings(patch) },
    pinAddress: (identity) => pinCompanionSeed(seedFile, identity),
    phones: () => devices.all().map((r) => r.cert.device),
    onChange: () => {
      host?.machinesChanged();
      friends?.check();
    },
    // Trust levels arriving with your identity count at once (the gateway reads Ask Me For from disk each time).
    settingsChanged: () => opts.store.dispatch({ type: 'remembered', people: loadSettings().people }),
    ...(opts.demo ? { demo: { start: { ...DEMO_ALWAYS_ON }, name: (id) => machines.list().find((m) => m.id === id)?.name } } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  attachAlwaysOn(opts.session, alwaysOn);
  // Friends through your Always On (BLG-797): its network shown and used from here, over your own link.
  if (!opts.demo) {
    friends = new FriendsLink({
      machines,
      at: () => alwaysOn?.at(),
      store: opts.store,
      intents: opts.session.intents,
      version: installedVersion(),
      file: path.join(dir, 'friends-mirror.json'),
      ...(opts.log ? { log: opts.log } : {}),
    });
    attachFriendsLink(opts.session, friends);
    // Never two of you, never none (BLG-799): the lease on the DHT, renewed by whichever install is you.
    const ao = alwaysOn;
    lease = new LeaseKeeper({
      host: ao,
      board: dhtLeaseBoard(() => host!.dhtNode()),
      self: () => ({ id: machines.runOnDevice().id, name: macName() }),
      heard: (id) => machines.lastHeard(id),
      reachable: (id) => machines.reach(id),
      ...(opts.log ? { log: opts.log } : {}),
    });
    const keeper = lease;
    gateNetwork(opts.session, () => keeper.mayRun());
  }
  attachCompanion(opts.session, host);
  attachMachines(opts.session, machines);
  void host
    .start()
    .then(() => {
      machines.start();
      alwaysOn?.start();
      friends?.start();
      lease?.start();
    })
    .catch((err: unknown) => opts.log?.(`companion: could not start: ${String(err)}`));
  // A phone on this Mac's USB: set up by itself, or what to switch on said in Settings › Phone (BLG-190).
  if (!opts.demo) host.watchCable();
  return async () => {
    outputs.stop();
    forwarder.stop();
    detachCompanion(opts.session);
    detachMachines(opts.session);
    detachAlwaysOn(opts.session);
    alwaysOn?.stop();
    detachFriendsLink(opts.session);
    friends?.stop();
    lease?.stop();
    await machines.stop();
    await host?.stop();
    host = undefined;
  };
}
