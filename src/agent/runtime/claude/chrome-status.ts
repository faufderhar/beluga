import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import type { McpTools } from '../../types.js';
import type { SignInVar } from './sign-in-env.js';

/**
 * Claude in Chrome as a chat run sees it (BLG-1027): `mcp_servers` lists it with how it is, says
 * why when this run has none, and `mcp_sign_in claude-in-chrome` reconnects it in the running
 * session, so a chat never has to be started over to get the browser back.
 */

/** Claude Code's name for its Claude in Chrome server. */
export const CHROME_SERVER = 'claude-in-chrome';
const LABEL = `Claude in Chrome (${CHROME_SERVER})`;
const RECONNECT_WAIT_MS = 10_000;
const POLL_MS = 500;
const STATUS_MS = 5_000;

/** Whether this run's Claude Code was started with Claude in Chrome, and if not, why (in words the agent can act on). */
export type ChromeLaunch = { readonly on: true } | { readonly on: false; readonly why: string };

export interface ChromeLaunchFacts {
  /** The run may use Chrome (AgentRunInput.chrome). */
  readonly allowed: boolean;
  /** Your launch flags say --no-chrome. */
  readonly noChromeFlag: boolean;
  /** The variable Claude Code signs in with in this run, if not your claude.ai login. */
  readonly signIn?: SignInVar;
  /** That variable comes from this project's or chat's variables, not from how Beluga's Claude Code is signed in. */
  readonly signInFromPlace?: boolean;
}

export function chromeLaunch(facts: ChromeLaunchFacts): ChromeLaunch {
  if (facts.noChromeFlag) return { on: false, why: 'the owner’s Claude launch flags say --no-chrome (Settings › Agents › Launch flags). Removing it there brings Claude in Chrome back from the next message on, in this same chat.' };
  if (!facts.allowed) return { on: false, why: 'this kind of run doesn’t get Claude in Chrome (only the owner’s own runs, and runs they approve, do).' };
  if (facts.signIn) {
    const where = facts.signInFromPlace
      ? `${facts.signIn} comes from this project’s or this chat’s variables. Removing it there (or turning off its .env for Claude) brings Claude in Chrome back from the next message on, in this same chat.`
      : `Beluga’s Claude Code is signed in with ${facts.signIn}. Signing Claude Code in with the owner’s claude.ai account brings it back from the next message on, in this same chat.`;
    return { on: false, why: `Claude Code in this run signs in with ${facts.signIn} instead of a claude.ai account, and Claude in Chrome (like the claude.ai connectors) needs the claude.ai login. ${where}` };
  }
  return { on: true };
}

/** Claude in Chrome's line in mcp_servers. */
export function chromeRow(launch: ChromeLaunch, status: McpServerStatus | undefined): string {
  if (!launch.on) return `${LABEL}: not in this run: ${launch.why}`;
  if (status?.status === 'connected') return `${LABEL}: connected`;
  if (status?.status === 'disabled') return `${LABEL}: off in this session (mcp_sign_in with ${CHROME_SERVER} turns it back on)`;
  const error = status?.error ? ` (${status.error})` : '';
  return `${LABEL}: extension not found${error}. The owner opens Chrome with the Claude in Chrome extension on, signed in to the same claude.ai account; then mcp_sign_in with ${CHROME_SERVER} reconnects it in this turn.`;
}

/** The parts of the running session this needs. */
export interface ChromeSession {
  readonly launch: ChromeLaunch;
  /** Claude Code's own list of its servers now. */
  servers(): Promise<readonly McpServerStatus[]>;
  reconnect(name: string): Promise<void>;
  enable(name: string): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())]);

async function chromeStatus(session: ChromeSession): Promise<McpServerStatus | undefined> {
  return (await within(session.servers(), STATUS_MS))?.find((s) => s.name === CHROME_SERVER);
}

const isChromeName = (name: string): boolean => /^(claude[- ]in[- ]chrome|chrome)$/i.test(name.trim()) || name.trim() === LABEL;

/** Your MCP servers' tools with Claude in Chrome added: its row, and reconnecting it by name. */
export function withChrome(tools: McpTools, session: ChromeSession, opts: { readonly waitMs?: number; readonly pollMs?: number } = {}): McpTools {
  return {
    async servers() {
      const [list, status] = await Promise.all([tools.servers(), session.launch.on ? chromeStatus(session) : undefined]);
      return `${list}\n${chromeRow(session.launch, status)}`;
    },
    async signIn(name) {
      if (!isChromeName(name)) return tools.signIn(name);
      if (!session.launch.on) return { ok: false, text: `Claude in Chrome can’t be reconnected in this run: ${session.launch.why}` };
      const before = await chromeStatus(session);
      if (before?.status === 'connected') return { ok: true, text: 'Claude in Chrome is already connected: load its tools (mcp__claude-in-chrome__*) with ToolSearch.' };
      if (before?.status === 'disabled') await within(session.enable(CHROME_SERVER), STATUS_MS);
      await within(session.reconnect(CHROME_SERVER), opts.waitMs ?? RECONNECT_WAIT_MS);
      const until = Date.now() + (opts.waitMs ?? RECONNECT_WAIT_MS);
      let now = await chromeStatus(session);
      while (now?.status !== 'connected' && Date.now() < until) {
        await sleep(opts.pollMs ?? POLL_MS);
        now = await chromeStatus(session);
      }
      if (now?.status === 'connected') return { ok: true, text: 'Reconnected Claude in Chrome: its tools (mcp__claude-in-chrome__*) are back in this turn; load them with ToolSearch.' };
      return { ok: false, text: `Couldn’t reconnect Claude in Chrome. ${chromeRow(session.launch, now)}` };
    },
  };
}

/** What the run's instructions say when this run has no Claude in Chrome though it may use it. */
export function chromeNote(launch: ChromeLaunch, allowed: boolean): string {
  if (launch.on || !allowed) return '';
  return `\n\nClaude in Chrome isn’t available in this run: ${launch.why} Tell the user that if they ask for the browser; never tell them to start a new chat for it.`;
}
