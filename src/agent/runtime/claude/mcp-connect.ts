import path from 'node:path';
import { type McpServerStatus, type Options, query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerRow, McpSignIn } from '../../../shared/mcp.js';
import { type OwnerMcpEntry, ownerMcpEntries } from './owner-mcp.js';
import { claudeExecutable } from '../../claude-code.js';

/** How long Claude Code gets to say how each server is (a local one may take a while to start). */
const SETTLE_MS = 12_000;
/** How long a sign-in waits for you in the browser. */
const SIGN_IN_MS = 5 * 60_000;
const POLL_MS = 1_500;

/** The parts of a Claude Code session this uses (a fake one in tests). */
export interface McpSession {
  mcpServerStatus(): Promise<McpServerStatus[]>;
  /** Claude Code's own sign-in: the page to open, while it waits on localhost for the browser to come back. */
  mcpAuthenticate?(serverName: string): Promise<{ authUrl?: string; requiresUserAction?: boolean } | undefined>;
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
    } = {},
  ) {}

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
        return res?.requiresUserAction === false ? { connected: true } : { error: 'Claude Code didn’t give a page to sign in on.' };
      }
      const done = this.waitConnected(session, name).finally(() => {
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

  /** Waits for a sign-in started with signIn: true once the server is connected, false when it gave up; undefined when none is waiting. */
  signedIn(name: string): Promise<boolean | undefined> {
    return this.signIns.get(name)?.done ?? Promise.resolve(undefined);
  }

  /** Stop every sign-in still waiting (the daemon is going away). */
  close(): void {
    for (const { session } of this.signIns.values()) session.close();
    this.signIns.clear();
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

  /** The statuses once none is still starting, or as they are when it took too long. */
  private async settle(session: McpSession): Promise<McpServerStatus[]> {
    const until = Date.now() + (this.opts.settleMs ?? SETTLE_MS);
    for (;;) {
      const statuses = await session.mcpServerStatus();
      if (!statuses.some((s) => s.status === 'pending') || Date.now() >= until) return statuses;
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
