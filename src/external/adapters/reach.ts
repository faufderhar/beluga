import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { belugaEnv } from '../../core/beluga-env.js';
import { openTunnel, type Tunnel, waitUntilReachable } from '../../net/tunnel.js';
import type { RemoteRoute } from '../domain/reach.js';

/**
 * The HTTPS roads to the external agents' listener, apart from the web port. Tailscale Serve on 8443
 * (never Funnel: only your tailnet reaches it), or a Cloudflare quick tunnel. A quick tunnel's name
 * changes when it reopens: tokens are bound to the name, so an agent signs in again.
 */

export const MCP_TAILSCALE_PORT = 8443;

export interface ReachRouteState {
  readonly kind: RemoteRoute;
  /** opening: the first try. reopening: it dropped, and a new name is on its way. */
  readonly state: 'opening' | 'on' | 'reopening';
  /** The MCP URL through this route, while it answers. */
  readonly url?: string;
  /** Why it isn't up, while it tries again. */
  readonly error?: string;
}

export type TailscaleRun = (bin: string, args: readonly string[]) => Promise<{ code: number; out: string; err: string }>;

export interface ExternalReachOptions {
  /** How the tailscale program runs (tests use a fake). */
  readonly run?: TailscaleRun;
  /** Opens a tunnel to this port. Default: a cloudflared quick tunnel. */
  readonly openTunnel?: (port: number, onDied: (reason: string) => void) => Promise<Tunnel>;
  /** Whether a fresh name answers yet. */
  readonly reachable?: (url: string) => Promise<boolean>;
  /** How long to wait before the nth try at a new tunnel. */
  readonly retryMs?: (attempt: number) => number;
  readonly log?: (line: string) => void;
}

/** The Mac app's own command line, when `tailscale` isn't on PATH. */
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const INSTALL_TAILSCALE = 'Install Tailscale from https://tailscale.com/download and log in.';
const MCP_PATH = '/mcp';

interface ServeStatus {
  readonly Web?: Readonly<Record<string, { readonly Handlers?: Readonly<Record<string, { readonly Proxy?: string }>> }>>;
  readonly AllowFunnel?: Readonly<Record<string, boolean>>;
}

export class ExternalReach {
  private served?: { readonly origin: string };
  private tunnel?: Tunnel;
  private publicState?: ReachRouteState;
  private publicPort?: number;
  private retry?: NodeJS.Timeout;
  private attempt = 0;

  constructor(private readonly opts: ExternalReachOptions = {}) {}

  /** Each route that is open or trying to be. */
  routes(): readonly ReachRouteState[] {
    return [...(this.served ? [{ kind: 'tailscale' as const, state: 'on' as const, url: `${this.served.origin}${MCP_PATH}` }] : []), ...(this.publicState ? [this.publicState] : [])];
  }

  /** The https origins this listener answers to now. An old tunnel name is not one. */
  origins(): readonly string[] {
    return this.routes().flatMap((r) => (r.state === 'on' && r.url ? [new URL(r.url).origin] : []));
  }

  /** Opens one road to this port. Throws why it can't; a public one keeps trying until it is closed. */
  async open(kind: RemoteRoute, port: number): Promise<void> {
    if (kind === 'tailscale') return this.openTailscale(port);
    if (this.publicPort === port && this.publicState) return;
    await this.close('public');
    this.publicPort = port;
    this.publicState = { kind: 'public', state: 'opening' };
    await this.openPublic(port);
  }

  async close(kind: RemoteRoute): Promise<void> {
    if (kind === 'tailscale') return this.closeTailscale();
    clearTimeout(this.retry);
    this.retry = undefined;
    this.publicPort = undefined;
    this.publicState = undefined;
    this.attempt = 0;
    const tunnel = this.tunnel;
    this.tunnel = undefined;
    tunnel?.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([this.close('tailscale'), this.close('public')]);
  }

  private async openTailscale(port: number): Promise<void> {
    const name = await this.tailscaleName();
    const hostPort = `${name}:${MCP_TAILSCALE_PORT}`;
    const target = `http://127.0.0.1:${port}`;
    const status = await this.serveStatus();
    if (status.AllowFunnel?.[hostPort]) throw new Error(`Tailscale Funnel is on for port ${MCP_TAILSCALE_PORT}, which would make this public. Turn it off, then try again.`);
    const handlers = Object.values(status.Web?.[hostPort]?.Handlers ?? {});
    if (handlers.some((h) => h.Proxy !== target)) throw new Error(`Port ${MCP_TAILSCALE_PORT} on your tailnet already serves something else. Free it with \`tailscale serve --https=${MCP_TAILSCALE_PORT} off\`, then try again.`);
    const served = await this.tailscale(['serve', '--bg', `--https=${MCP_TAILSCALE_PORT}`, target]);
    if (served.code !== 0) throw new Error(serveProblem(served.err || served.out));
    this.served = { origin: `https://${hostPort}` };
    this.opts.log?.(`external agents: on the tailnet at ${this.served.origin}${MCP_PATH}`);
  }

  private async closeTailscale(): Promise<void> {
    // Only what this one opened: a port that served something else was never ours to close.
    if (!this.served) return;
    this.served = undefined;
    const off = await this.tailscale(['serve', `--https=${MCP_TAILSCALE_PORT}`, 'off']).catch((err: unknown) => ({ code: 1, out: '', err: err instanceof Error ? err.message : String(err) }));
    if (off.code !== 0 && !/not found|no serve config|nothing/i.test(off.err + off.out)) this.opts.log?.(`external agents: tailscale serve off: ${(off.err || off.out).trim()}`);
  }

  private async tailscaleName(): Promise<string> {
    const status = await this.tailscale(['status', '--json']);
    if (status.code !== 0 && !status.out.trim()) throw new Error(`Tailscale isn't running here: ${status.err.trim() || 'no answer'}. ${INSTALL_TAILSCALE}`);
    let self: { BackendState?: string; Self?: { DNSName?: string } };
    try {
      self = JSON.parse(status.out) as typeof self;
    } catch {
      throw new Error('Tailscale said something this Beluga cannot read. Is it up to date?');
    }
    if (self.BackendState !== 'Running') throw new Error(`Tailscale isn't connected here (${self.BackendState ?? 'not running'}). Log in with \`sudo tailscale up\` or the Tailscale app, then try again.`);
    const name = (self.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) throw new Error('Tailscale gave this machine no name. Turn on MagicDNS in the admin console, then try again.');
    return name;
  }

  private async serveStatus(): Promise<ServeStatus> {
    const status = await this.tailscale(['serve', 'status', '--json']);
    if (status.code !== 0) throw new Error(serveProblem(status.err || status.out));
    try {
      return JSON.parse(status.out || '{}') as ServeStatus;
    } catch {
      throw new Error('Tailscale said something this Beluga cannot read. Is it up to date?');
    }
  }

  private async tailscale(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    const exec = this.opts.run ?? runProgram;
    const bins = [belugaEnv('TAILSCALE') ?? 'tailscale', ...(process.platform === 'darwin' && existsSync(MAC_APP_CLI) ? [MAC_APP_CLI] : [])];
    for (const bin of bins) {
      try {
        return await exec(bin, args);
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
      }
    }
    throw new Error(`Tailscale isn't installed here. ${INSTALL_TAILSCALE}`);
  }

  private async openPublic(port: number): Promise<void> {
    const stillOurs = (): boolean => this.publicPort === port;
    try {
      let tunnel: Tunnel | undefined;
      const died = (reason: string): void => {
        if (!stillOurs() || this.tunnel !== tunnel) return;
        this.opts.log?.(`external agents: the public address dropped (${reason}); opening a new one`);
        this.tunnel = undefined;
        this.publicState = { kind: 'public', state: 'reopening' };
        this.again(port);
      };
      tunnel = await (this.opts.openTunnel ?? defaultOpen)(port, died);
      if (!stillOurs()) return tunnel.close();
      this.tunnel = tunnel;
      // A plain-http name would carry tokens in the clear.
      if (!tunnel.publicUrl.startsWith('https://')) throw new Error(`A route must be https, and this one is ${tunnel.publicUrl}`);
      const reachable = this.opts.reachable ?? ((url: string) => waitUntilReachable(url));
      if (!(await reachable(tunnel.publicUrl))) throw new Error(`${tunnel.publicUrl} did not answer. Cloudflare may be slow right now. Try again in a minute.`);
      if (!stillOurs() || this.tunnel !== tunnel) return;
      this.attempt = 0;
      this.publicState = { kind: 'public', state: 'on', url: `${tunnel.publicUrl}${MCP_PATH}` };
      this.opts.log?.(`external agents: public at ${tunnel.publicUrl}${MCP_PATH}`);
    } catch (err) {
      if (!stillOurs()) return;
      this.tunnel?.close();
      this.tunnel = undefined;
      const error = err instanceof Error ? err.message : String(err);
      this.publicState = { kind: 'public', state: 'reopening', error };
      this.again(port);
      throw err;
    }
  }

  /** After a drop or a failure: a new tunnel, more slowly each time, until one is up or it's closed. */
  private again(port: number): void {
    if (this.retry) return;
    const wait = (this.opts.retryMs ?? defaultRetry)(this.attempt++);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.publicPort !== port) return;
      this.openPublic(port).catch((err: unknown) => this.opts.log?.(`external agents: no public address yet: ${err instanceof Error ? err.message : String(err)}`));
    }, wait);
    this.retry.unref?.();
  }
}

const defaultOpen = async (port: number, onDied: (reason: string) => void): Promise<Tunnel> => {
  const tunnel = await openTunnel('cloudflared', port, { onDied });
  if (!tunnel) throw new Error('cloudflared opened no tunnel');
  return tunnel;
};

const defaultRetry = (attempt: number): number => Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5));

const runProgram: TailscaleRun = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return reject(Object.assign(new Error('not found'), { code: 'ENOENT' }));
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
      resolve({ code, out: String(out), err: String(errOut) });
    });
  });

/** What a failed `tailscale serve` means, in words that say what to do. */
function serveProblem(text: string): string {
  const t = text.trim();
  if (/access denied|permission|operator|must be root/i.test(t)) return 'Tailscale needs your say-so to serve as you. Run once: `sudo tailscale set --operator=$USER`, then try again.';
  if (/https?.*(not enabled|disabled)|enable https|certificates/i.test(t)) return `Turn on HTTPS certificates for your tailnet (admin console, DNS), then try again. Tailscale said: ${t.split('\n')[0]}`;
  return `tailscale serve did not work: ${t || 'no reason given'}`;
}
