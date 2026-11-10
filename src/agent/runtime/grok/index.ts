import type { AgentRuntime, RuntimeCapabilities } from '../types.js';
import type { GrokConnect } from './connection.js';
import { createGrokBackend } from './runner.js';
import { grokComplete } from './side.js';
import { grokStatus } from './status.js';

/** Grok Build through `grok agent stdio`: what it can and can't do of what Beluga asks. */
export const GROK_CAPABILITIES: RuntimeCapabilities = {
  // Every tool call asks Beluga first, through a hook of Beluga's for that one process
  // (connection.ts). But a company's Grok policy (`allowManagedHooksOnly`) turns such hooks off,
  // and then what it thinks is read-only runs without asking, and Beluga is given no sandbox to
  // fall back on: so no friends' tasks and no guests (safetyFor).
  canGateEveryTool: false,
  hasSandbox: false,
  // One prompt at a time: a message sent while it works waits for its own turn; Send now stops the turn (session/cancel).
  canSteer: false,
  canInterrupt: true,
  // A read-only turn under Beluga's policy, then the same approval card (ACP has no plan mode here).
  hasPlanMode: true,
  // Its spawn_subagent tool, each a row. A run ends when it answers.
  hasSubagents: true,
  hasBackgroundAgents: false,
  // Tokens and cost per turn; its plan's windows aren't said over ACP.
  hasUsage: true,
  canResume: true,
  // Its own `x.ai/session/fork`.
  canFork: true,
  // Its question tool can't reach you over ACP: it asks in its answer.
  canAskUser: false,
  // Its own /compact.
  hasCompaction: true,
  hasModelList: true,
  hasProcess: true,
  // It loads your Claude Code skills itself; custom commands are expanded for it (opencode/skills.ts).
  skills: 'native',
  promptImages: true,
  toolMounts: ['stdio'],
};

/** A Grok Build runtime; `connect` swaps how it's reached (tests and the demo script it). */
export function createGrokRuntime(deps: { readonly connect?: GrokConnect; readonly status?: AgentRuntime['status'] } = {}): AgentRuntime {
  const side = deps.connect ? { connect: deps.connect, drop: async () => undefined } : {};
  return {
    id: 'grok',
    label: 'Grok Build',
    capabilities: GROK_CAPABILITIES,
    // `executablePath` is Claude Code's (the Mac app's pinned binary): never Grok's. Grok finds its own (findGrok, BELUGA_GROK_PATH).
    create: ({ executablePath: _claudePath, ...opts }) => createGrokBackend({ ...opts, ...(deps.connect ? { connect: deps.connect } : {}) }),
    complete: (req) => grokComplete(req, side),
    status: deps.status ?? (() => grokStatus()),
  };
}

export const grokRuntime: AgentRuntime = createGrokRuntime();
