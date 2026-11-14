import path from 'node:path';
import type { McpServerRow, McpSignIn, McpTurned } from '../../../shared/mcp.js';
import type { CodexConnection } from './app-server.js';

/**
 * Your Codex MCP servers for Settings › Agent › MCP servers (BLG-518), through Codex's own
 * app-server, so they're what your Codex runs get (they read ~/.codex/config.toml themselves):
 *  - the list: `mcpServerStatus/list` (each server tried, its tools and sign-in state), with
 *    `config/read` for which are turned off and where each is set (yours or a project's);
 *  - signing in: `mcpServer/oauth/login` gives the page for your browser, and Codex waits on
 *    localhost for it to come back (`mcpServer/oauthLogin/completed`); Codex keeps the token;
 *  - on and off: `config/value/write` of `mcp_servers.<name>.enabled` in the file it's set in.
 * Shapes as codex-cli 0.166's `app-server generate-ts` writes them (checked against a real one).
 */

/** How long Codex gets to try every server (each has its own startup timeout, 10 s by default). */
const LIST_MS = 45_000;
/** How long a sign-in waits for you in the browser. */
const SIGN_IN_MS = 5 * 60_000;
const WRITE_MS = 15_000;

/** One server as `mcpServerStatus/list` says it (v2 McpServerStatus, the parts used here). */
export interface CodexMcpStatus {
  readonly name: string;
  readonly runtimeStatus?: 'notStarted' | 'starting' | 'connected' | 'authenticationRequired' | 'failed' | 'cancelled' | 'disabled' | null;
  readonly pluginId?: string | null;
  /** Set for a web server (only those can be signed in to). */
  readonly httpOrigin?: string | null;
  readonly tools?: Readonly<Record<string, unknown>>;
  readonly toolsError?: string | null;
  readonly authStatus?: 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth';
}

interface ConfigEntry {
  readonly enabled?: boolean;
  readonly url?: string;
  readonly command?: string;
}
type Origin = { readonly name?: { readonly type?: string; readonly file?: string; readonly dotCodexFolder?: string } };
interface ConfigRead {
  readonly config?: { readonly mcp_servers?: Readonly<Record<string, ConfigEntry>> | null };
  readonly origins?: Readonly<Record<string, Origin | undefined>>;
}

/** Codex's names for MCP servers are TOML keys: a dotted key path must not break on one. */
const SAFE_NAME = /^[\w-]{1,100}$/;

export class CodexMcp {
  private readonly signIns = new Map<string, { readonly conn: CodexConnection; readonly done: Promise<boolean> }>();

  constructor(
    private readonly connect: (cwd: string) => Promise<CodexConnection>,
    private readonly opts: { readonly listMs?: number; readonly signInMs?: number } = {},
  ) {}

  /** Your Codex servers as seen from `cwd` (yours, its project's, your plugins'), with how each is now. */
  async list(cwd: string): Promise<McpServerRow[]> {
    const conn = await this.connect(cwd);
    try {
      const config = await conn.rpc.request<ConfigRead>('config/read', { cwd }, WRITE_MS).catch((): ConfigRead => ({}));
      const statuses: CodexMcpStatus[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await conn.rpc.request<{ data: CodexMcpStatus[]; nextCursor?: string | null }>('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) }, this.opts.listMs ?? LIST_MS);
        statuses.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      const servers = config.config?.mcp_servers ?? {};
      const rows = statuses.map((st) => toCodexRow(st, servers[st.name], originOf(config, st.name)));
      // One turned off that Codex left out of its list still shows, to turn back on.
      for (const [name, entry] of Object.entries(servers)) if (!statuses.some((st) => st.name === name)) rows.push(toCodexRow({ name }, entry, originOf(config, name)));
      return rows.sort((a, b) => a.label.localeCompare(b.label));
    } finally {
      await conn.proc.kill();
    }
  }

  /** Start signing in to one: the page for your browser. Codex waits for it to come back (see signedIn). */
  async signIn(cwd: string, name: string): Promise<McpSignIn> {
    await this.drop(name);
    let conn: CodexConnection;
    try {
      conn = await this.connect(cwd);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const waitMs = this.opts.signInMs ?? SIGN_IN_MS;
    // Listen before asking: the completion can't come before the page, but never miss it.
    let finish!: (ok: boolean) => void;
    const done = new Promise<boolean>((resolve) => (finish = resolve));
    let loginId: string | undefined;
    const off = conn.rpc.onNotification((method, params) => {
      if (method !== 'mcpServer/oauthLogin/completed' || params.name !== name) return;
      if (loginId && params.loginId && params.loginId !== loginId) return;
      finish(params.success === true);
    });
    try {
      const res = await conn.rpc.request<{ authorizationUrl?: string; loginId?: string }>('mcpServer/oauth/login', { name, timeoutSecs: Math.round(waitMs / 1000) }, WRITE_MS);
      if (!res?.authorizationUrl) throw new Error('Codex didn’t give a page to sign in on.');
      loginId = res.loginId;
      const timer = setTimeout(() => finish(false), waitMs);
      timer.unref();
      void conn.rpc.closed.then(() => finish(false));
      const settled = done.finally(() => {
        clearTimeout(timer);
        off();
        void conn.proc.kill();
        if (this.signIns.get(name)?.conn === conn) this.signIns.delete(name);
      });
      this.signIns.set(name, { conn, done: settled });
      return { url: res.authorizationUrl };
    } catch (err) {
      off();
      await conn.proc.kill();
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Waits for a sign-in started with signIn: true once Codex says it's done, false when it failed or gave up; undefined when none is waiting. */
  signedIn(name: string): Promise<boolean | undefined> {
    return this.signIns.get(name)?.done ?? Promise.resolve(undefined);
  }

  /** A sign-in started with signIn is waiting for the browser now. */
  signingIn(name: string): boolean {
    return this.signIns.has(name);
  }

  /** Turn one of your servers on or off in the config.toml it's set in (yours, or its project's). */
  async setEnabled(cwd: string, name: string, enabled: boolean): Promise<McpTurned> {
    if (!SAFE_NAME.test(name)) return { error: `Codex can’t change ${name} from here. Edit ~/.codex/config.toml instead.` };
    let conn: CodexConnection;
    try {
      conn = await this.connect(cwd);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const config = await conn.rpc.request<ConfigRead>('config/read', { cwd }, WRITE_MS);
      if (!config.config?.mcp_servers?.[name]) return { error: `${name} isn’t in your Codex settings (a plugin’s server is turned off with its plugin).` };
      const origin = originOf(config, name);
      const filePath = origin.project ? path.join(origin.project, 'config.toml') : origin.file;
      await conn.rpc.request('config/value/write', { keyPath: `mcp_servers.${name}.enabled`, value: enabled, mergeStrategy: 'upsert', ...(filePath ? { filePath } : {}) }, WRITE_MS);
      return { ok: true };
    } catch (err) {
      return { error: `Codex couldn’t save it: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      await conn.proc.kill();
    }
  }

  /** Stop every sign-in still waiting (the daemon is going away). */
  close(): void {
    for (const name of [...this.signIns.keys()]) void this.drop(name);
  }

  private async drop(name: string): Promise<void> {
    const was = this.signIns.get(name);
    this.signIns.delete(name);
    await was?.conn.proc.kill();
  }
}

/** Where a server is set: your config.toml (`file`), a project's `.codex` folder (`project`), or neither (a plugin's). */
function originOf(config: ConfigRead, name: string): { readonly file?: string; readonly project?: string } {
  const prefix = `mcp_servers.${name}.`;
  const key = Object.keys(config.origins ?? {}).find((k) => k.startsWith(prefix));
  const src = key ? config.origins?.[key]?.name : undefined;
  if (src?.type === 'project' && src.dotCodexFolder) return { project: src.dotCodexFolder };
  if (src?.type === 'user' && src.file) return { file: src.file };
  return {};
}

/** Codex's error, without its Rust transport types: "MCP startup failed: …, when send initialize request". */
export function shortMcpError(error: string): string {
  const plain = error
    .replace(/Transport \[[^\]]*\] /g, '')
    .replace(/^MCP startup failed: /, '')
    .replace(/, when send initialize request.*$/s, '')
    .replace(/Send message error error: /g, '')
    .trim();
  return plain.length > 160 ? `${plain.slice(0, 157)}…` : plain;
}

/** A row for Settings, from Codex's status and its config entry. */
export function toCodexRow(st: CodexMcpStatus, entry: ConfigEntry | undefined, origin: { readonly file?: string; readonly project?: string } = {}): McpServerRow {
  const plugin = st.pluginId ? st.pluginId.split('@')[0] : undefined;
  const from: McpServerRow['from'] = plugin ? 'plugin' : origin.project ? 'project' : 'user';
  const where = plugin ?? (origin.project ? path.basename(path.dirname(origin.project)) : undefined);
  const web = Boolean(st.httpOrigin ?? entry?.url);
  const tools = st.tools ? Object.keys(st.tools).length : undefined;
  const status: McpServerRow['status'] =
    entry?.enabled === false || st.runtimeStatus === 'disabled'
      ? 'disabled'
      : st.authStatus === 'notLoggedIn' || st.runtimeStatus === 'authenticationRequired'
        ? 'needs-auth'
        : st.toolsError || st.runtimeStatus === 'failed' || st.runtimeStatus === 'cancelled'
          ? 'failed'
          : st.runtimeStatus === 'starting' || st.runtimeStatus === 'notStarted'
            ? 'pending'
            : 'connected';
  return {
    name: st.name,
    label: st.name,
    from,
    ...(where ? { where } : {}),
    status,
    ...(status === 'failed' && st.toolsError ? { error: shortMcpError(st.toolsError) } : {}),
    canSignIn: status === 'needs-auth' && web,
    ...(tools !== undefined && status === 'connected' ? { tools } : {}),
    ...(entry && SAFE_NAME.test(st.name) ? { canTurnOff: true } : {}),
  };
}
