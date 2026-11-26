import { type AcpBackendOptions, createAcpBackend } from '../acp/runner.js';
import type { AgentBackend } from '../../types.js';
import { antigravityExtension } from './extension.js';
import { ANTIGRAVITY } from './spec.js';

export interface AgyBackendOptions extends AcpBackendOptions {
  /** Where Antigravity keeps its conversations (its own notes, a plan or a task list, are written there). */
  readonly dataDir?: string;
}

/**
 * Runs turns on Antigravity through `agy acp`, the CLI's own ACP server signed in with your Google
 * account, on the ACP core (acp/runner.ts) with what Antigravity does past ACP (extension.ts): its
 * instructions in its system prompt, its thinking levels, its ask_question, /compact and its quota.
 */
export function createAgyBackend(opts: AgyBackendOptions): AgentBackend {
  return createAcpBackend(ANTIGRAVITY, antigravityExtension({ ...(opts.dataDir ? { dataDir: opts.dataDir } : {}), ...(opts.bin ? { bin: opts.bin } : {}) }), opts);
}
