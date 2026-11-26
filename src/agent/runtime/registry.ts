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
import { antigravityRuntime } from './antigravity/index.js';
import { acpAgents } from './acp/agents.js';
import { findAcpCommand } from './acp/connection.js';
import { ACP_CAPABILITIES, type AcpAgentEntry, specOf } from './acp/entry.js';
import { genericExtension } from './acp/generic.js';
import { createAcpRuntime } from './acp/runtime.js';
import type { AgentRuntime, RuntimeId, RuntimeStatus } from './types.js';

/** The runtime an agent runs on when none is named. */
export const DEFAULT_RUNTIME: RuntimeId = 'claude';

/** The fixed runtimes ("Your agents"): every Beluga has them. */
const RUNTIMES: ReadonlyMap<RuntimeId, AgentRuntime> = new Map([
  [claudeRuntime.id, claudeRuntime],
  [codexRuntime.id, codexRuntime],
  [openCodeRuntime.id, openCodeRuntime],
  [grokRuntime.id, grokRuntime],
  [copilotRuntime.id, copilotRuntime],
]);

/** One runtime per ACP agent of yours, made once (made again when you change its command). */
const made = new Map<string, { readonly key: string; readonly rt: AgentRuntime }>();
function acpRuntimeOf(entry: AcpAgentEntry): AgentRuntime {
  // Antigravity runs on its own runtime on the ACP core (its extension: quota, questions, /compact…).
  if (entry.id === antigravityRuntime.id) return antigravityRuntime;
  const key = JSON.stringify([entry.label, entry.command, entry.args, entry.env ?? {}]);
  const had = made.get(entry.id);
  if (had?.key === key) return had.rt;
  const rt = createAcpRuntime(specOf(entry), genericExtension(), ACP_CAPABILITIES);
  made.set(entry.id, { key, rt });
  return rt;
}

/** Your ACP agents' runtimes (Settings › Agent › ACP agents): only the ones you added. */
export function acpRuntimes(): AgentRuntime[] {
  return acpAgents.list().map(acpRuntimeOf);
}

/** The runtime an AgentRef names: a fixed one ('claude', 'codex', 'opencode', 'grok', 'copilot'), or an ACP agent you added ('antigravity', 'cursor', 'acp-…'); undefined for one this Beluga doesn't run. */
export function runtimeFor(id: RuntimeId = DEFAULT_RUNTIME): AgentRuntime | undefined {
  const fixed = RUNTIMES.get(id);
  if (fixed) return fixed;
  const entry = acpAgents.get(id);
  return entry ? acpRuntimeOf(entry) : undefined;
}

/** Every runtime but the default one (your ACP agents too), with whether it's ready here (Codex: installed, signed in) and its models. */
export async function otherRuntimes(): Promise<Array<{ readonly id: RuntimeId; readonly label: string } & RuntimeStatus>> {
  const others = [...RUNTIMES.values(), ...acpRuntimes()].filter((rt) => rt.id !== DEFAULT_RUNTIME && rt.status);
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

/** How to sign in to a runtime, as a command for Terminal (Claude Code: `claude auth login`; Codex: `codex login`; OpenCode: `opencode auth login`, a model provider; Copilot: `copilot login`, your GitHub account; an ACP agent: its own, as its entry says (Antigravity: `agy`, which signs in with your Google account on its first start)); undefined for one with no sign-in. */
export function signInCommand(id: RuntimeId): readonly string[] | undefined {
  if (id === claudeRuntime.id) return claudeSignInCommand();
  if (id === codexRuntime.id) return [findCodex() ?? 'codex', 'login'];
  if (id === openCodeRuntime.id) return [findOpenCode() ?? 'opencode', 'auth', 'login'];
  if (id === grokRuntime.id) return [findGrok() ?? 'grok', 'login'];
  if (id === copilotRuntime.id) return [findCopilot() ?? 'copilot', 'login'];
  const entry = acpAgents.get(id);
  const cmd = entry?.signIn?.command;
  if (!entry || !cmd?.length) return undefined;
  // Its own command found where the agent is (an installer's folder the Mac app's PATH lacks).
  return cmd[0] === entry.command ? [findAcpCommand(specOf(entry)) ?? cmd[0]!, ...cmd.slice(1)] : [...cmd];
}
