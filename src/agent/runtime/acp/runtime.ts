import type { AgentRuntime, RuntimeCapabilities } from '../types.js';
import { acpComplete } from './complete.js';
import type { AcpExtension } from './extension.js';
import { createAcpBackend } from './runner.js';
import type { AcpAgentSpec, AcpConnect } from './spec.js';
import { acpStatus } from './status.js';

/**
 * A runtime for one ACP agent on the core: its spec, its extension (genericExtension() for one
 * Beluga has nothing of its own for) and what it can do; `connect` swaps how it's reached (tests
 * script one).
 */
export function createAcpRuntime(spec: AcpAgentSpec, ext: AcpExtension, capabilities: RuntimeCapabilities, deps: { readonly connect?: AcpConnect; readonly status?: AgentRuntime['status'] } = {}): AgentRuntime {
  const side = deps.connect ? { connect: deps.connect, drop: async () => undefined } : {};
  return {
    id: spec.id,
    label: spec.label,
    capabilities,
    // `executablePath` is Claude Code's (the Mac app's pinned binary): never this agent's.
    create: ({ executablePath: _claudePath, ...opts }) => createAcpBackend(spec, ext, { ...opts, ...(deps.connect ? { connect: deps.connect } : {}) }),
    complete: (req) => acpComplete(spec, ext, req, side),
    status: deps.status ?? (() => acpStatus(spec, ext, deps.connect ? { connect: deps.connect } : {})),
  };
}
