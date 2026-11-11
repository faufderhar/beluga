import { claudeRuntime } from './claude/index.js';
import { claudeSignInCommand, claudeStatus } from './claude/status.js';
import { codexRuntime } from './codex/index.js';
import { findCodex } from './codex/app-server.js';
import { openCodeRuntime } from './opencode/index.js';
import { findOpenCode } from './opencode/connection.js';
import { grokRuntime } from './grok/index.js';
import { findGrok } from './grok/connection.js';
import { copilotRuntime } from './copilot/index.js';
import { findCopilot } from './copilot/connection.js';
import type { AgentRuntime, RuntimeId, RuntimeStatus } from './types.js';

/** The runtime an agent runs on when none is named. */
export const DEFAULT_RUNTIME: RuntimeId = 'claude';

const RUNTIMES: ReadonlyMap<RuntimeId, AgentRuntime> = new Map([
  [claudeRuntime.id, claudeRuntime],
  [codexRuntime.id, codexRuntime],
  [openCodeRuntime.id, openCodeRuntime],
  [grokRuntime.id, grokRuntime],
  [copilotRuntime.id, copilotRuntime],
]);

/** The runtime an AgentRef names ('claude', 'codex', 'opencode', 'grok', 'copilot'); undefined for one this Beluga doesn't know. */
export function runtimeFor(id: RuntimeId = DEFAULT_RUNTIME): AgentRuntime | undefined {
  return RUNTIMES.get(id);
}

/** Every runtime but the default one, with whether it's ready here (Codex: installed, signed in) and its models. */
export async function otherRuntimes(): Promise<Array<{ readonly id: RuntimeId; readonly label: string } & RuntimeStatus>> {
  const others = [...RUNTIMES.values()].filter((rt) => rt.id !== DEFAULT_RUNTIME && rt.status);
  return Promise.all(others.map(async (rt) => ({ id: rt.id, label: rt.label, ...(await rt.status!()) })));
}

/**
 * Every runtime that can say whether it's ready here, Claude Code included (BLG-507: signed in?),
 * asked all at once. One that fails to answer is left out (it keeps what it said before).
 */
export async function runtimeStatuses(deps: { readonly claude?: () => Promise<RuntimeStatus>; readonly others?: typeof otherRuntimes } = {}): Promise<Array<{ readonly id: RuntimeId } & RuntimeStatus>> {
  const [claude, others] = await Promise.all([(deps.claude ?? (() => claudeStatus()))().catch(() => undefined), (deps.others ?? otherRuntimes)().catch(() => [])]);
  return [...(claude ? [{ id: claudeRuntime.id, ...claude }] : []), ...others];
}

/** How to sign in to a runtime, as a command for Terminal (Claude Code: `claude auth login`; Codex: `codex login`; OpenCode: `opencode auth login`, a model provider; Copilot: `copilot login`, your GitHub account); undefined for one with no sign-in. */
export function signInCommand(id: RuntimeId): readonly string[] | undefined {
  if (id === claudeRuntime.id) return claudeSignInCommand();
  if (id === codexRuntime.id) return [findCodex() ?? 'codex', 'login'];
  if (id === openCodeRuntime.id) return [findOpenCode() ?? 'opencode', 'auth', 'login'];
  if (id === grokRuntime.id) return [findGrok() ?? 'grok', 'login'];
  if (id === copilotRuntime.id) return [findCopilot() ?? 'copilot', 'login'];
  return undefined;
}
