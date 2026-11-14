import path from 'node:path';
import { type McpServerStatus, type Options, query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerRow, McpSignIn } from '../../../shared/mcp.js';
import type { AppReadResult, AppToolResult } from '../../../shared/mcp-apps.js';
import { type ControlChannel, sdkMcpCall } from '../../../mcp-apps/adapters/sdk-mcp-call.js';
import type { CatalogTool } from '../../../mcp-apps/ports/tool-catalog.js';
import { KeptSessions } from './kept-sessions.js';
import { type OwnerMcpEntry, ownerMcpEntries } from './owner-mcp.js';
import { claudeExecutable } from '../../claude-code.js';

/** How long Claude Code gets to say how each server is (a local one may take a while to start). */
const SETTLE_MS = 12_000;
/** How long a sign-in waits for you in the browser. */
const SIGN_IN_MS = 5 * 60_000;
const POLL_MS = 1_500;
/** How long an app's session stays open after its last use (BLG-391): the next tools/call opens none. */
const KEEP_MS = 60_000;

/** The parts of a Claude Code session this uses (a fake one in tests). */
export interface McpSession {
  mcpServerStatus(): Promise<McpServerStatus[]>;
  /** Claude Code's own sign-in: the page to open, while it waits on localhost for the browser to come back. */
  mcpAuthenticate?(serverName: string): Promise<{ authUrl?: string; requiresUserAction?: boolean } | undefined>;
  /** MCP Apps: a `ui://` resource of a connected server (Claude Code's mcp_read_resource_v1). */
  readMcpResource?(serverName: string, uri: string): Promise<AppReadResult>;
  /** MCP Apps: Query's control channel, for the `mcp_call` request the SDK has no method for yet. */
  request?: ControlChannel['request'];
  close(): void;
}

/** `env`, when given, is Claude Code's whole environment (else Beluga's own). */
export type OpenMcpSession = (cwd: string, servers: NonNullable<Options['mcpServers']>, env?: Readonly<Record<string, string | undefined>>) => McpSession;

/** A Claude Code session that takes no prompt: only asked about its MCP servers. */
export function claudeMcpSession(claudePath?: string): OpenMcpSession {
  return (cwd, mcpServers, env) => {
    const idle = (async function* () {
      await new Promise(() => undefined);
    })() as AsyncIterable<never>;
    return query({ prompt: idle, options: { cwd, settingSources: [], mcpServers, ...(env ? { env: { ...env } } : {}), ...claudeExecutable(claudePath) } }) as unknown as McpSession;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/**
 * Your MCP servers for Settings › Claude (BLG-251): how each is (connected, needs you to sign in,
 * failed), and signing in to one, the way `/mcp` does in Claude Code. The tokens go where Claude
 * Code keeps them, so a server signed in here is signed in for your runs and for Claude Code.
 */
export class McpConnect {
  private readonly signIns = new Map<string, { readonly session: McpSession; readonly done: Promise<boolean> }>();
  private readonly listeners = new Set<(name: string) => void>();
  /** MCP Apps: one session per server, kept for a short time after its last use. */
  private readonly kept: KeptSessions<McpSession>;

  constructor(
    private readonly open: OpenMcpSession,
    private readonly opts: {
      /** Where `${VAR}` in your servers' settings is read from (default: Beluga's own environment). */
      readonly env?: NodeJS.ProcessEnv;
      /** Your saved variables for a folder, over that (RuntimeOptions.ownEnv, #442): given to Claude Code too, as your runs are. */
      readonly ownEnv?: (cwd: string) => Readonly<Record<string, string>>;
      readonly home?: string;
      readonly settleMs?: number;
      readonly signInMs?: number;
      readonly pollMs?: number;
      /** How long an app's session stays open after its last use. */
      readonly keepMs?: number;
    } = {},
  ) {
    this.kept = new KeptSessions(opts.keepMs ?? KEEP_MS);
  }

  /** Your servers for these folders (the first is where Claude Code starts), with how each is now. */
  async list(cwds: readonly string[]): Promise<McpServerRow[]> {
    const entries = this.entries(cwds);
    const session = this.openFor(cwds, entries);
    try {
      const statuses = await this.settle(session);
      return statuses.map((st) => toRow(st, entries.find((e) => e.name === st.name)));
    } finally {
      session.close();
    }
  }

  /** Start signing in to one: the page for your browser. Claude Code waits for it to come back (see signedIn). */
  async signIn(cwds: readonly string[], name: string): Promise<McpSignIn> {
    const entries = this.entries(cwds);
    if (!entries.some((e) => e.name === name)) return { error: `No MCP server named ${name}.` };
    this.signIns.get(name)?.session.close();
    this.signIns.delete(name);
    const session = this.openFor(cwds, entries);
    try {
      if (typeof session.mcpAuthenticate !== 'function') throw new Error('This Claude Code can’t sign in to MCP servers from Beluga. Update Claude Code, or sign in with /mcp there.');
      const res = await session.mcpAuthenticate(name);
      if (!res?.authUrl) {
        session.close();
        if (res?.requiresUserAction !== false) return { error: 'Claude Code didn’t give a page to sign in on.' };
        this.announce(name);
        return { connected: true };
      }
      const done = this.waitConnected(session, name).then((connected) => {
        if (connected) this.announce(name);
        return connected;
      }).finally(() => {
        session.close();
        if (this.signIns.get(name)?.session === session) this.signIns.delete(name);
      });
      this.signIns.set(name, { session, done });
      return { url: res.authUrl };
    } catch (err) {
      session.close();
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * MCP Apps: one `ui://` resource of one of your servers, read in a session of its own (the run
   * that called the tool may be over): its HTML and the content item's `_meta` (its csp).
   */
  async readUiResource(cwds: readonly string[], server: string, uri: string): Promise<{ html: string; meta?: Record<string, unknown> }> {
    const item = (await this.appRead(cwds, server, uri)).contents.find((c) => typeof c.text === 'string');
    if (!item?.text) throw new Error('That MCP App has no page to show.');
    return { html: item.text, ...(item._meta ? { meta: item._meta } : {}) };
  }

  /** MCP Apps: resources/read of one `ui://` resource, whole, for an app (apps.read). */
  appRead(cwds: readonly string[], server: string, uri: string): Promise<AppReadResult> {
    return this.withServer(cwds, server, (session) => {
      if (typeof session.readMcpResource !== 'function') throw new Error('This Claude Code can’t read MCP App views. Update Claude Code.');
      return session.readMcpResource(server, uri);
    });
  }

  /** MCP Apps: one server's tools now, with their annotations and `_meta` (for the app tool gate). */
  appTools(cwds: readonly string[], server: string): Promise<readonly CatalogTool[]> {
    return this.withServer(cwds, server, async (_session, statuses) => (statuses.find((s) => s.name === server)?.tools ?? []) as readonly CatalogTool[]);
  }

  /** MCP Apps: an app's tools/call, its result for the app and never a model (apps.call; gated by the caller). */
  appCall(cwds: readonly string[], server: string, tool: string, args: Readonly<Record<string, unknown>>): Promise<AppToolResult> {
    return this.withServer(cwds, server, (session) => {
      if (typeof session.request !== 'function') throw new Error('This Claude Code can’t call MCP App tools. Update Claude Code.');
      return sdkMcpCall({ request: (req) => session.request!(req) }, server, tool, args);
    });
  }

  /** Waits for a sign-in started with signIn: true once the server is connected, false when it gave up; undefined when none is waiting. */
  signedIn(name: string): Promise<boolean | undefined> {
    return this.signIns.get(name)?.done ?? Promise.resolve(undefined);
  }

  /** A sign-in started with signIn is waiting for the browser now. */
  signingIn(name: string): boolean {
    return this.signIns.has(name);
  }

  /** Told the name of each server a sign-in connected (the name only: never a token or a page). Returns how to stop listening. */
  onSignedIn(listener: (name: string) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Stop every sign-in still waiting, and close the apps' sessions (the daemon is going away). */
  close(): void {
    for (const { session } of this.signIns.values()) session.close();
    this.signIns.clear();
    this.kept.closeAll();
  }

  /**
   * The session kept for `server` with your servers (opened now when there is none), once `server`
   * is up (or as it is when that took too long). It stays open for the next call only while the
   * server is connected and the call did not fail. A server that needs a sign-in is refused with
   * words the chat can show.
   */
  private withServer<T>(cwds: readonly string[], server: string, use: (session: McpSession, statuses: McpServerStatus[]) => Promise<T>): Promise<T> {
    return this.kept.use(JSON.stringify([cwds, server]), () => this.openFor(cwds, this.entries(cwds)), async (session, forget) => {
      const statuses = await this.settle(session, server);
      const status = statuses.find((s) => s.name === server)?.status;
      if (status === 'needs-auth') throw new Error(`${server} needs you to sign in. Sign in to it, then open this chat again.`);
      if (status !== 'connected') forget();
      return use(session, statuses);
    });
  }

  private announce(name: string): void {
    for (const listener of this.listeners) {
      try {
        listener(name);
      } catch {
        // A listener failing never undoes a sign-in.
      }
    }
  }

  private entries(cwds: readonly string[]): OwnerMcpEntry[] {
    return ownerMcpEntries(cwds, this.envAt(cwds), this.opts.home);
  }

  /** Where Claude Code starts (the first folder): Beluga's environment, with your saved variables there over it. */
  private envAt(cwds: readonly string[]): NodeJS.ProcessEnv {
    const base = this.opts.env ?? process.env;
    return this.opts.ownEnv ? { ...base, ...this.opts.ownEnv(cwds[0] ?? process.cwd()) } : base;
  }

  private openFor(cwds: readonly string[], entries: readonly OwnerMcpEntry[]): McpSession {
    const servers = Object.fromEntries(entries.map((e) => [e.name, e.config]));
    const cwd = cwds[0] ?? process.cwd();
    return this.opts.ownEnv ? this.open(cwd, servers, this.envAt(cwds)) : this.open(cwd, servers);
  }

  /** The statuses once none (or `only`, when named) is still starting, or as they are when it took too long. */
  private async settle(session: McpSession, only?: string): Promise<McpServerStatus[]> {
    const until = Date.now() + (this.opts.settleMs ?? SETTLE_MS);
    for (;;) {
      const statuses = await session.mcpServerStatus();
      if (!statuses.some((s) => s.status === 'pending' && (only === undefined || s.name === only)) || Date.now() >= until) return statuses;
      await sleep(this.opts.pollMs ?? POLL_MS);
    }
  }

  private async waitConnected(session: McpSession, name: string): Promise<boolean> {
    const until = Date.now() + (this.opts.signInMs ?? SIGN_IN_MS);
    while (Date.now() < until) {
      await sleep(this.opts.pollMs ?? POLL_MS);
      const status = (await session.mcpServerStatus().catch(() => [])).find((s) => s.name === name)?.status;
      if (status === 'connected') return true;
      if (status === undefined) return false;
    }
    return false;
  }
}

function toRow(st: McpServerStatus, entry: OwnerMcpEntry | undefined): McpServerRow {
  const claudeAi = !entry && (st.scope === 'claudeai' || st.source === 'claudeai' || st.name.startsWith('claude.ai '));
  const from: McpServerRow['from'] = entry?.from ?? (claudeAi ? 'claude.ai' : 'user');
  const where = entry?.from === 'plugin' ? entry.plugin : entry?.from === 'project' && entry.project ? path.basename(entry.project) : undefined;
  const kind = st.config && 'type' in st.config ? st.config.type : undefined;
  return {
    name: st.name,
    label: entry?.from === 'plugin' ? (st.name.split(':').slice(2).join(':') || st.name) : claudeAi ? st.name.replace(/^claude\.ai /, '') : st.name,
    from,
    ...(where ? { where } : {}),
    status: st.status,
    ...(st.error ? { error: st.error } : {}),
    canSignIn: st.status === 'needs-auth' && from !== 'claude.ai' && (kind === 'http' || kind === 'sse'),
  };
}
