import { claudeConfigDir, dropSession } from './claude/claude-sessions.js';
import { codexDataDir, dropCodexSessions } from './codex/codex-sessions.js';
import { dropOpenCodeSession } from './opencode/sessions.js';
import { dropGrokSession } from './grok/sessions.js';

/** Where each agent keeps its own records (tests point them at temporary folders). */
export interface AgentHomes {
  readonly claude?: string;
  readonly codex?: string;
  /** OpenCode's executable (it deletes its own sessions); unset: found on this Mac. */
  readonly opencode?: string;
  /** Grok Build's executable (it deletes its own sessions); unset: found on this Mac. */
  readonly grok?: string;
}

/**
 * Forget an agent's own record of a deleted chat (BLG-571): Claude Code's transcript, Codex's
 * rollout for that thread, or OpenCode's session. `runtime` is the agent the session is of (none:
 * Claude, as before any other ran). Other agents keep nothing of their own to drop.
 */
export async function dropAgentSession(dir: string, sessionId: string, runtime: string | undefined, homes: AgentHomes = {}): Promise<void> {
  if (runtime === 'codex') await dropCodexSessions({ threadId: sessionId }, homes.codex ?? codexDataDir()).catch(() => 0);
  else if (runtime === 'opencode') await dropOpenCodeSession(sessionId, homes.opencode).catch(() => false);
  else if (runtime === 'grok') await dropGrokSession(sessionId, homes.grok).catch(() => false);
  else if (!runtime || runtime === 'claude') await dropSession(dir, sessionId, homes.claude ?? claudeConfigDir()).catch(() => undefined);
}
