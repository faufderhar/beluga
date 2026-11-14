import type { AgentBackend, McpTools } from '../agent/types.js';
import { CLAUDE_AI_CONNECTORS_URL, type McpServerRow } from '../shared/mcp.js';

/**
 * Signing in to your MCP servers from a run (tools `mcp__beluga_mcp__*`): the same sign-in as the MCP
 * chip and Settings › Agent (BLG-251), started by the agent. The page opens on your screen, and the
 * tool waits a while for you; the tokens stay in your agent's own store. A connected server reaches
 * the turns running now (agent/runtime/claude/runner.ts reconnects it).
 */

/** How long one tool call waits for you in the browser: under a stdio tool call's usual limit (60 s). */
const WAIT_MS = 45_000;

export type McpBackend = Pick<AgentBackend, 'mcpServers' | 'mcpSignIn' | 'mcpSignedIn' | 'mcpSigningIn'>;

export interface McpSignInDeps {
  /** Your projects' folders: a server set for one of them is signed in to there. */
  readonly roots: () => readonly string[];
  /** Open a web page on your screen. */
  readonly openPage: (url: string) => Promise<void>;
  readonly waitMs?: number;
}

type Answer = Awaited<ReturnType<McpTools['signIn']>>;

export function mcpSignInTools(agent: McpBackend, deps: McpSignInDeps): McpTools {
  const rows = async (): Promise<readonly McpServerRow[]> => (await agent.mcpServers?.(deps.roots())) ?? [];

  return {
    async servers() {
      const list = await rows();
      return list.length ? list.map(describe).join('\n') : 'You have no MCP servers.';
    },

    async signIn(name) {
      const list = await rows();
      const row = list.find((r) => r.name === name) ?? list.find((r) => r.label === name);
      if (!row) return { ok: false, text: `No MCP server named ${name}. Yours: ${list.map((r) => r.name).join(', ') || 'none'}.` };
      // A sign-in already waiting for the browser (an earlier call, run, or the MCP chip): wait on it, never start over.
      if (agent.mcpSigningIn?.(row.name)) return wait(agent, row, deps);
      if (row.status === 'connected') return { ok: true, text: `${row.label} is already connected.` };
      if (row.from === 'claude.ai') {
        const shown = await show(deps, CLAUDE_AI_CONNECTORS_URL);
        return { ok: true, text: `${row.label} is a claude.ai connector: it is signed in on claude.ai, not here. ${shown} Its tools load in the next turn once the user connects it there.` };
      }
      if (!row.canSignIn || !agent.mcpSignIn) return { ok: false, text: `${row.label} can’t be signed in to from Beluga (${row.status}${row.error ? `: ${row.error}` : ''}).` };
      const started = await agent.mcpSignIn(deps.roots(), row.name);
      if ('error' in started) return { ok: false, text: `Couldn’t start the sign-in to ${row.label}: ${started.error}` };
      if ('connected' in started) return signedIn(row);
      const shown = await show(deps, started.url);
      const res = await wait(agent, row, deps);
      return res.ok && !res.text.startsWith('Signed in') ? { ...res, text: `${shown} ${res.text}` } : res;
    },
  };
}

function describe(r: McpServerRow): string {
  const name = r.label === r.name ? r.name : `${r.label} (${r.name})`;
  if (r.status === 'needs-auth') return `${name}: ${r.from === 'claude.ai' ? 'needs sign-in on claude.ai (mcp_sign_in opens it)' : r.canSignIn ? 'needs sign-in (mcp_sign_in)' : 'needs sign-in, not from Beluga'}`;
  return `${name}: ${r.status}${r.error ? ` (${r.error})` : ''}`;
}

/** Waits for the sign-in in the browser, up to waitMs: connected, given up, or still waiting. */
async function wait(agent: McpBackend, row: McpServerRow, deps: McpSignInDeps): Promise<Answer> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'waiting'>((resolve) => (timer = setTimeout(() => resolve('waiting'), deps.waitMs ?? WAIT_MS)));
  const done = await Promise.race([agent.mcpSignedIn?.(row.name) ?? Promise.resolve(undefined), late]).finally(() => clearTimeout(timer));
  if (done === 'waiting') return { ok: true, text: `The sign-in page is open in the browser. Still waiting for the user to finish signing in to ${row.label}: ask them to, then call mcp_sign_in again.` };
  if (done) return signedIn(row);
  return { ok: false, text: `The sign-in to ${row.label} didn’t finish (it timed out or was closed). Call mcp_sign_in again to start over.` };
}

function signedIn(row: McpServerRow): Answer {
  return { ok: true, text: `Signed in to ${row.label}. Its tools load in this turn (or the next, if this Claude Code can’t reload a server).` };
}

/** Opens a page on the user's screen; when that fails, the link for the user to open. */
async function show(deps: McpSignInDeps, url: string): Promise<string> {
  try {
    await deps.openPage(url);
    return 'Opened the page in the user’s browser.';
  } catch {
    return `Couldn’t open the browser: give the user this link to open: ${url}`;
  }
}
