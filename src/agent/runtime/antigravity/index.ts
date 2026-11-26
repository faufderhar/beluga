import type { AgentRuntime, RuntimeCapabilities } from '../types.js';
import { agyComplete } from './complete.js';
import type { AgyConnect } from './connection.js';
import { createAgyBackend } from './runner.js';
import { agyStatus } from './status.js';

/** Antigravity through `agy acp`, with your own Antigravity plan: what it can and can't do of what Beluga asks. */
export const ANTIGRAVITY_CAPABILITIES: RuntimeCapabilities = {
  // It asks Beluga before commands, writes and MCP tools, and each is judged as Claude's are. But it
  // reads files (inside the folder and out, .env files too) without asking, and its permission
  // rules don't reach reads over ACP: no friends' tasks, no guests.
  canGateEveryTool: false,
  hasSandbox: false,
  // One prompt at a time: a message sent while it works waits for its own turn; Send now stops the turn (session/cancel).
  canSteer: false,
  canInterrupt: true,
  // Its own Plan mode: it looks, then the plan comes to you (Beluga turns its writes down until you approve).
  hasPlanMode: true,
  hasSubagents: false,
  hasBackgroundAgents: false,
  // Tokens per turn and the context meter; its quota per model family, asked of its own language
  // server (quota.ts: ACP doesn't say it), on its own usage card.
  hasUsage: true,
  // session/load; it can't branch a conversation.
  canResume: true,
  canFork: false,
  // Its question form doesn't reach a client over ACP, but its ask_question call carries the
  // question whole: Beluga asks it for Antigravity, and your answer is its next turn (questions.ts).
  canAskUser: true,
  // Its own /compact.
  hasCompaction: true,
  hasModelList: true,
  hasProcess: true,
  // Its own skills and commands run as typed; Claude Code's custom commands are expanded for it (opencode/skills.ts).
  skills: 'native',
  promptImages: true,
  // It takes a client's MCP servers over stdio and HTTP; Beluga's go over HTTP, as Copilot's do.
  toolMounts: ['http'],
};

/** An Antigravity runtime; `connect` swaps how it's reached (tests and the demo script one). */
export function createAntigravityRuntime(deps: { readonly connect?: AgyConnect; readonly status?: AgentRuntime['status'] } = {}): AgentRuntime {
  const side = deps.connect ? { connect: deps.connect, drop: async () => undefined } : {};
  return {
    id: 'antigravity',
    label: 'Antigravity',
    capabilities: ANTIGRAVITY_CAPABILITIES,
    // `executablePath` is Claude Code's (the Mac app's pinned binary): never Antigravity's. It finds its own (findAgy, BELUGA_AGY_PATH).
    create: ({ executablePath: _claudePath, ...opts }) => createAgyBackend({ ...opts, ...(deps.connect ? { connect: deps.connect } : {}) }),
    complete: (req) => agyComplete(req, side),
    status: deps.status ?? (() => agyStatus(deps.connect ? { connect: deps.connect } : {})),
  };
}

export const antigravityRuntime: AgentRuntime = createAntigravityRuntime();
