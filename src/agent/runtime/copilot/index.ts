import type { AgentRuntime, RuntimeCapabilities } from '../types.js';
import { copilotComplete } from './complete.js';
import type { CopilotConnect } from './connection.js';
import { createCopilotBackend } from './runner.js';
import { copilotStatus } from './status.js';

/** GitHub Copilot through `copilot --acp` (BLG-873): what it can and can't do of what Beluga asks. */
export const COPILOT_CAPABILITIES: RuntimeCapabilities = {
  // It asks Beluga before writes, commands that change things, other folders and MCP tools, and
  // each is judged as Claude's are. But it reads in the folder and runs read-only commands (ls,
  // git status, cat) without asking, and has no sandbox Beluga can rely on: no friends' tasks, no guests.
  canGateEveryTool: false,
  hasSandbox: false,
  // One prompt at a time: a message sent while it works waits for its own turn; Send now stops the turn (session/cancel).
  canSteer: false,
  canInterrupt: true,
  // Its own Plan mode: it looks, changes nothing, then the plan comes to you.
  hasPlanMode: true,
  hasSubagents: false,
  hasBackgroundAgents: false,
  // Tokens per turn and the context meter; no plan windows (Copilot doesn't say what's left of your plan).
  hasUsage: true,
  // session/load; it can't branch a session.
  canResume: true,
  canFork: false,
  // Its question form can't reach you over ACP (`--no-ask-user`): it asks in its answer.
  canAskUser: false,
  // Its own /compact.
  hasCompaction: true,
  hasModelList: true,
  hasProcess: true,
  // It loads your Claude Code skills and commands itself; others are expanded for it (opencode/skills.ts).
  skills: 'native',
  promptImages: true,
  // Copilot takes a client's MCP servers over HTTP only.
  toolMounts: ['http'],
};

/** A Copilot runtime; `connect` swaps how it's reached (tests and the demo script one). */
export function createCopilotRuntime(deps: { readonly connect?: CopilotConnect; readonly status?: AgentRuntime['status'] } = {}): AgentRuntime {
  const side = deps.connect ? { connect: deps.connect, drop: async () => undefined } : {};
  return {
    id: 'copilot',
    label: 'Copilot',
    capabilities: COPILOT_CAPABILITIES,
    // `executablePath` is Claude Code's (the Mac app's pinned binary): never Copilot's. Copilot finds its own (findCopilot, BELUGA_COPILOT_PATH).
    create: ({ executablePath: _claudePath, ...opts }) => createCopilotBackend({ ...opts, ...(deps.connect ? { connect: deps.connect } : {}) }),
    complete: (req) => copilotComplete(req, side),
    status: deps.status ?? (() => copilotStatus(deps.connect ? { connect: deps.connect } : {})),
  };
}

export const copilotRuntime: AgentRuntime = createCopilotRuntime();
