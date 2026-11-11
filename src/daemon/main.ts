import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import { copyNative } from '../core/clipboard.js';
import { currentClient } from '../core/client-context.js';
import { belugaHome } from '../core/home.js';
import { openWithSystem } from '../core/local.js';
import { IPC_VERSION } from '../ipc/protocol.js';
import { type Core, buildCore } from './core.js';
import type { Recorder } from '../core/blackbox/recorder.js';
import { blackbox } from '../core/blackbox/recorder.js';
import { startBlackbox } from './blackbox.js';
import { clearDaemonInfo, writeDaemonInfo } from './files.js';
import { watchEventLoop } from './lag.js';
import { keepLogSmall } from './log-size.js';
import type { Readable } from 'node:stream';
import { stopWhenInputEnds } from './stop-on-input.js';
import { DaemonServer } from './server.js';
import { attachScreenDoor, machinesOf } from '../machines/registry.js';
import { isDemoMachine } from '../machines/demo.js';
import { demoLinkMs, withLatency } from '../machines/latency.js';
import { type WebArgs, sshWords } from './web.js';
import { WebAccess, attachWebAccess, readWebConfig } from './web-access.js';
import { publicWords } from './reach/public.js';
import { tailscaleWords } from './reach/tailscale.js';
import { dropAppImageEnv } from '../core/appimage-env.js';
import { dropGitLocalEnv } from '../core/git-env.js';

/** How long the daemon waits after the last screen closes before leaving the room. */
export const LINGER_MS = 3000;
/** A daemon nobody attaches to (the screen that started it died) stops after this long. */
export const FIRST_CLIENT_MS = 30_000;

/** Which room a config is for, so a screen only attaches to a daemon in the same one. */
export function roomKeyOf(config: Pick<Config, 'mode' | 'invite'>): string {
  if (config.mode === 'demo') return 'demo';
  if (config.mode === 'join') return `join:${createHash('sha256').update(config.invite ?? '').digest('hex').slice(0, 16)}`;
  return 'host';
}

export interface DaemonOptions {
  readonly version: string;
  /** Keep running with no screens attached (the Mac app's sidecar). */
  readonly keepAlive: boolean;
  readonly port?: number;
  readonly allowedOrigins?: readonly string[];
  /** Where to say what's happening (the daemon's log). */
  readonly log?: (line: string) => void;
  /** Override LINGER_MS / FIRST_CLIENT_MS (tests). */
  readonly lingerMs?: number;
  readonly firstClientMs?: number;
  /** Log the event-loop delay every this often, slow or not (scripts/perf-lag.mjs); otherwise only slow periods and hourly (lag.ts). */
  readonly lagEveryMs?: number;
  /** What writes daemon.log, kept small while it runs (log-size.ts): stderr unless said otherwise. */
  readonly logFd?: number;
  /** The black box to keep event-loop periods and state changes in (core/blackbox/recorder.ts). */
  readonly record?: Recorder;
  /** Stop once this ends: the app's pipe on Windows, which has no signals (stop-on-input.ts). */
  readonly stopWithInput?: Readable;
  /** Also serve the UI to browsers on the web port (`beluga web`, daemon/web.ts). */
  readonly web?: Partial<WebArgs> & { readonly root?: string };
  /** Where `beluga web` says the link (its terminal). */
  readonly announce?: (text: string) => void;
  /** A QR code of a link as lines for that terminal (none when it isn't one): the tailnet address for a phone. */
  readonly announceQr?: (text: string) => readonly string[];
}

export interface RunningDaemon {
  readonly core: Core;
  readonly server: DaemonServer;
  readonly port: number;
  readonly token: string;
  /** Browsers: the web port (open when asked for, or when it was before) and who is let in. */
  readonly web: WebAccess;
  /** The web port's address, when it's open. */
  readonly webUrl?: string;
  /** Leave the room and stop serving. Resolves once everything is closed. */
  stop(reason?: string): Promise<void>;
  /** Resolves when the daemon has stopped (by stop(), a signal, or the last screen leaving). */
  readonly done: Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * `beluga daemon`: build the core once and serve it to every screen on this computer. Leaves the
 * room a few seconds after the last screen closes, unless it's kept alive for the
 * Mac app.
 */
export async function startDaemon(config: Config, opts: DaemonOptions): Promise<RunningDaemon> {
  const log = opts.log ?? (() => undefined);
  const token = randomBytes(32).toString('hex');
  let server!: DaemonServer;
  let stopping: Promise<void> | undefined;
  let web: WebAccess | undefined;
  let resolveDone!: () => void;
  let stopLag = (): void => undefined;
  const done = new Promise<void>((r) => (resolveDone = r));
  const stop = (reason = 'Beluga is shutting down'): Promise<void> => {
    stopping ??= (async () => {
      log(`stopping: ${reason}`);
      clearTimeout(linger);
      clearTimeout(firstClient);
      stopLag();
      clearDaemonInfo();
      await web?.close().catch(() => undefined);
      await server.close(reason).catch(() => undefined);
      await core.stop().catch((err: unknown) => log(`stop failed: ${errorText(err)}`));
      resolveDone();
    })();
    return stopping;
  };

  const core = await buildCore(config, {
    // The clipboard tool on this computer first; else the screen that asked.
    copy: async (text) => {
      if (await copyNative(text).catch(() => false)) return;
      await server.callCap('copyText', [text], currentClient());
    },
    desktopNotify: (n) => server.notify([n]),
    zoom: async (dir) => (await server.callCap('zoom', [dir], currentClient())) as { ok: boolean; message: string },
    // The Mac app's window to the front (Open on your Mac, from the phone): the window that can.
    raise: () => server.callCap('raise', []),
    open: (target) => openWithSystem(target),
    shutdown: () => void stop('Quit from a screen'),
  }, { network: true });
  server = new DaemonServer({ session: core.session, token, version: opts.version, terminals: core.terminals, log, ...(opts.port ? { port: opts.port } : {}), ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}) });
  const port = await server.listen();
  // Your computers (BLG-775): an app of yours driving this one comes in as a screen; this app's
  // screens on one of yours go out through the machines' door.
  attachScreenDoor(core.session, server);
  server.routeMachines((id, ws, hello) => {
    // The demo's computers (BLG-779) are this daemon itself: their pages open and stream as a computer's would (BLG-784).
    // BELUGA_DEMO_LINK_MS adds a link's round trip to them (BLG-792), for e2e at a real link's pace.
    if (config.mode === 'demo' && isDemoMachine(id)) return server.serveAsMachine(withLatency(ws, demoLinkMs() / 2), hello);
    const machines = machinesOf(core.session);
    if (machines) machines.door.open(id, ws, hello);
    else ws.close(4404, 'No computers here');
  });
  web = new WebAccess({ door: server, log, ...(opts.web?.root ? { root: opts.web.root } : {}) });
  attachWebAccess(core.session, web);
  let webAt: string | undefined;
  if (opts.web) {
    webAt = await web.start(opts.web).catch(async (err: unknown) => {
      await server.close().catch(() => undefined);
      await core.stop().catch(() => undefined);
      throw new Error(`The web port couldn't open: ${errorText(err)}`);
    });
  } else {
    // Opened before (`beluga web`, Settings): open again, but a busy port doesn't stop Beluga.
    const remembered = readWebConfig();
    if (remembered) webAt = await web.start(remembered).catch((err: unknown) => void log(`web port: ${errorText(err)}`));
    // The public link too, when it was on: in the background, Cloudflare takes a while.
    if (remembered?.public && webAt) void web.goPublic().catch((err: unknown) => log(`web: public link: ${errorText(err)}`));
    if (remembered?.tailscale && webAt) void web.goTailscale().catch((err: unknown) => log(`web: tailscale: ${errorText(err)}`));
  }
  writeDaemonInfo({ pid: process.pid, port, token, version: opts.version, ipc: IPC_VERSION, room: core.room, roomKey: roomKeyOf(config), startedAt: Date.now(), keepAlive: opts.keepAlive, workspaces: core.workspacesHome });
  log(`listening on 127.0.0.1:${port} for ${core.room}${opts.keepAlive ? ' (kept alive)' : ''}`);

  let linger: NodeJS.Timeout | undefined;
  let firstClient: NodeJS.Timeout | undefined;
  let seen = false;
  if (!opts.keepAlive) {
    firstClient = setTimeout(() => {
      if (!seen) void stop('Nobody attached');
    }, opts.firstClientMs ?? FIRST_CLIENT_MS);
  }
  server.clients.onChange((count) => {
    log(`${count} screen${count === 1 ? '' : 's'} attached`);
    if (count > 0) {
      seen = true;
      clearTimeout(firstClient);
      clearTimeout(linger);
      linger = undefined;
      return;
    }
    if (opts.keepAlive) return;
    linger = setTimeout(() => {
      if (server.clients.size === 0) void stop('The last screen closed');
    }, opts.lingerMs ?? LINGER_MS);
  });

  const record = opts.record;
  const stopActions = record ? core.session.store.onAction((a) => record.action(a.type)) : () => undefined;
  core.start();
  const onPeriod = record ? (lag: Parameters<Recorder['period']>[0]) => record.period(lag, process.memoryUsage()) : undefined;
  const stopWatch = watchEventLoop(log, { ...(opts.lagEveryMs ? { everyMs: opts.lagEveryMs, all: true } : {}), ...(onPeriod ? { onPeriod } : {}) });
  stopLag = () => {
    stopWatch();
    stopActions();
  };
  return { core, server, port, token, web, ...(webAt ? { webUrl: webAt } : {}), stop, done };
}

/** Run the daemon as this process: signals stop it, problems are logged and shown, never fatal. */
export async function runDaemon(config: Config, opts: DaemonOptions): Promise<void> {
  // Started from inside git (a hook, an alias, git bisect run): its git commands must not land in that repository (git-env.ts).
  dropGitLocalEnv();
  // Started from the Linux AppImage: what it runs uses the system's libraries, not the app's (appimage-env.ts).
  dropAppImageEnv();
  const log = (line: string): void => {
    blackbox.record('log', line);
    if (opts.log) opts.log(line);
    else process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  };
  // Once the terminal or pipe it was started from is gone (EIO, EPIPE), every write fails: drop those lines.
  // Unheard, each failed write was an uncaught error whose log line failed again, spinning a core (BLG-365).
  process.stderr.on('error', () => {});
  const box = startBlackbox({ version: opts.version });
  const daemon = await startDaemon(config, { ...opts, log, record: blackbox });
  keepLogSmall(opts.logFd ?? 2, log);
  if (opts.web && opts.announce && daemon.webUrl) {
    const { url, expiresAt } = daemon.web.sessions.link(daemon.webUrl);
    const clear = opts.web.insecureHttp ? `\nCareful: --insecure-http sends this link and the browser's session over plain http on ${opts.web.host}. Anyone on that network can read them and get in.\n` : '';
    opts.announce(`${clear}Beluga's web UI is on ${daemon.webUrl}\nOpen this link in your browser to let it in (once, until ${new Date(expiresAt).toLocaleTimeString()}):\n\n  ${url}\n\n${sshWords(daemon.webUrl)}More links: beluga web link. Browsers let in: beluga web sessions.\n`);
    if (opts.web.tailscale) {
      await daemon.web
        .goTailscale()
        .then((t) => opts.announce?.(`\n${tailscaleWords(t, opts.announceQr?.(t.url))}`))
        .catch((err: unknown) => opts.announce?.(`Not on the tailnet: ${errorText(err)}\n`));
    }
    if (opts.web.public) {
      opts.announce('\nOpening a public link through Cloudflare…\n');
      await daemon.web
        .goPublic()
        .then((pub) => opts.announce?.(`\n${publicWords(pub)}`))
        .catch((err: unknown) => opts.announce?.(`No public link: ${errorText(err)}\n`));
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void daemon.stop(`Got ${signal}`));
  if (opts.stopWithInput) stopWhenInputEnds(opts.stopWithInput, (why) => void daemon.stop(why));
  // The Mac app's word that the Mac is about to sleep (BLG-277, src-tauri/src/power.rs): mail the
  // outboxes, then say so in a file the app waits for before it lets the Mac sleep.
  // Windows has no SIGUSR2 (listening for it throws there); its app has no sleep hook yet.
  if (process.platform !== 'win32') process.on('SIGUSR2', () => {
    void daemon.core
      .sleeping()
      .catch((err: unknown) => log(`before sleep: ${errorText(err)}`))
      .finally(() => {
        try {
          writeFileSync(path.join(belugaHome(), 'slept.at'), `${Date.now()}\n`, { mode: 0o600 });
        } catch {
          // The app stops waiting after a few seconds anyway.
        }
      });
  });
  process.on('unhandledRejection', (err) => {
    log(`unhandled: ${errorText(err)}`);
    box.incident('unhandled rejection', err instanceof Error ? (err.stack ?? err.message) : String(err));
    daemon.core.session.toast(`Something went wrong: ${errorText(err)}`.slice(0, 200), 'error');
  });
  // Everyone's screens and the room hang off this process: log a stray throw rather than die.
  process.on('uncaughtException', (err) => {
    log(`uncaught: ${err.stack ?? errorText(err)}`);
    box.incident('uncaught exception', err.stack ?? errorText(err));
  });
  process.once('exit', (code) => {
    clearDaemonInfo();
    box.saveNow(`exit ${code}`);
  });
  await daemon.done;
  process.exit(0);
}
