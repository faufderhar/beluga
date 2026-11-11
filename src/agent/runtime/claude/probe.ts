import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';

const PROBE_MS = 30_000;

/**
 * Whether this build's Agent SDK can run a Claude Code binary (claude-code-updates.ts): it starts,
 * says hello the SDK's way and lists its models. No message is sent, nothing is kept.
 */
export async function claudeCodeWorks(bin: string, deps: { readonly query?: typeof query } = {}): Promise<boolean> {
  const idle = (async function* () {
    await new Promise(() => undefined);
  })() as AsyncIterable<never>;
  const q = (deps.query ?? query)({ prompt: idle, options: { cwd: os.tmpdir(), settingSources: [], pathToClaudeCodeExecutable: bin } });
  try {
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), PROBE_MS).unref());
    const models = await Promise.race([q.supportedModels(), timeout]);
    return Array.isArray(models) && models.length > 0;
  } catch {
    return false;
  } finally {
    q.close();
  }
}
