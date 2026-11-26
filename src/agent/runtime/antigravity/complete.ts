import { type AcpSideDeps, acpComplete } from '../acp/complete.js';
import type { CompletionRequest } from '../types.js';
import { antigravityExtension } from './extension.js';
import { ANTIGRAVITY } from './spec.js';

export type AgySideDeps = AcpSideDeps;

/**
 * A side call on Antigravity (agent/side-calls.ts): one prompt in a conversation of its own
 * (dropped after), its request marked as input (sidePrompt: Antigravity keeps its own system
 * prompt). It may use only the tools it was given, each one asked about (vetTool) when Antigravity
 * asks; Beluga's suites, when given, are mounted for this call alone. A model of Antigravity's
 * when one was named; 'haiku' (small and fast) is its default model at its lowest thinking level.
 */
export function agyComplete(req: CompletionRequest, deps: AgySideDeps = {}): Promise<string> {
  return acpComplete(ANTIGRAVITY, antigravityExtension(deps.bin ? { bin: deps.bin } : {}), req, deps);
}
