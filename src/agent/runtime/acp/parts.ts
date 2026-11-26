import { type RunEnd, RunFailedError, classifyRun, resetFromText } from '../../../shared/run-failure.js';
import type { StdioServerConfig } from '../../tool-host.js';
import { CodexRpcError } from '../codex/rpc.js';
import type { AcpMcpServer, ConfigOption, SessionResponse } from '../opencode/acp.js';
import type { RuntimeStatus } from '../types.js';

/** Claude's aliases and a Beluga default mean nothing to an ACP agent: those run on its own choice. */
const CLAUDE_ALIASES = /^(default|opus|sonnet|haiku|best|opusplan)(\[1m\])?$/i;

/** A model an ACP agent may know (`gemini-3.8-flash`), or undefined for its own. */
export function acpModel(model: string | undefined): string | undefined {
  if (!model || CLAUDE_ALIASES.test(model.trim()) || model.includes('[') || model.includes('/')) return undefined;
  return model.trim();
}

/** A session mode's value by what it's for: `plan`, or `default` (asks before edits and commands, so Beluga judges each). */
export function modeValue(options: readonly ConfigOption[], name: 'plan' | 'default'): string | undefined {
  return options.find((o) => o.id === 'mode')?.options.find((o) => o.value === name)?.value;
}

/** A run's end from what failed: an ACP error (its code kept), or a message. */
export const acpEnd = (err: unknown, stderr: readonly string[]): RunEnd & { readonly cause: unknown } => ({ error: err instanceof Error ? err.message : String(err), stderr, cause: err });

/** ACP's error code for "sign in first" (`auth_required`). */
export const ACP_AUTH_REQUIRED = -32000;
/** Words for "nobody is signed in", when an agent says so without ACP's code. */
export const ACP_SIGNED_OUT = /auth(entication)?[ _]required|not (logged|signed) in|unauthenticated|log ?in (with|first)|\b401\b|invalid_grant/i;

/** Signed out, as an ACP error says it: by its code, else its words. */
export const acpSignedOut = (err: unknown): boolean => (err instanceof CodexRpcError && err.code === ACP_AUTH_REQUIRED) || ACP_SIGNED_OUT.test(err instanceof Error ? err.message : String(err));

/**
 * A failed run, told as the runtime's own (not Claude Code's): a sign-in (ACP's own code), your
 * plan's limit (`limit`: the agent's own words for it, never a stderr line's), else as every
 * runtime's is (classifyRun).
 */
export function acpFailure(end: RunEnd & { readonly cause?: unknown }, runtime: string, limit?: RegExp): Error {
  const failure = classifyRun(end);
  const said = [end.error, end.result].filter(Boolean).join('\n');
  if (acpSignedOut(end.cause ?? said)) return new RunFailedError({ kind: 'signed_out', detail: failure.detail, runtime });
  if (limit?.test(said)) {
    const resetsAt = resetFromText(said);
    return new RunFailedError({ kind: 'usage_limit', ...(resetsAt ? { resetsAt } : {}), detail: failure.detail, runtime });
  }
  return new RunFailedError({ ...failure, runtime });
}

/** What an agent is told after a turn it ended silently on a declined step: why, and to answer. */
export const declinedNote = (why: readonly string[]): string => `Beluga declined that step: ${[...new Set(why)].join(' ')} Carry on without it: answer the person now, saying what you couldn't do.`;

/** The session's options a picker reads: its models, and the thinking levels the current one takes. */
export function modelRows(options: readonly ConfigOption[] | undefined): RuntimeStatus['models'] {
  const model = options?.find((o) => o.id === 'model' || o.category === 'model');
  const levels = options?.find((o) => o.id === 'thought_level' || o.category === 'thought_level')?.options.map((o) => o.value) ?? [];
  return (model?.options ?? []).map((o) => ({ value: o.value, label: o.name, description: o.description ?? '', ...(o.value === model?.currentValue && levels.length ? { efforts: levels } : {}) }));
}

/**
 * What an ACP agent's session says about its models and modes, in either shape: ACP's
 * `configOptions` (a select per option: model, mode, thought_level) or the older `models` /
 * `modes` (availableModels + currentModelId, set with session/set_model; availableModes +
 * currentModeId, set with session/set_mode). Beluga reads both, and sets each the way it came.
 */
export interface AcpSession extends SessionResponse {
  readonly models?: { readonly availableModels?: ReadonlyArray<{ readonly modelId: string; readonly name?: string; readonly description?: string | null }>; readonly currentModelId?: string };
  readonly modes?: { readonly availableModes?: ReadonlyArray<{ readonly id: string; readonly name?: string; readonly description?: string | null }>; readonly currentModeId?: string };
}

/** The agent's own choice, first in a generic agent's list: '' runs on whatever model it's set to. */
export const OWN_MODEL = { value: '', label: 'Default', description: 'The model the agent is set to' } as const;

/** A session's models as picker rows, from its options or its older `models`; with `own`, the agent's own choice first. */
export function sessionModelRows(s: AcpSession | undefined, own = false): RuntimeStatus['models'] {
  const rows = s?.configOptions?.some((o) => o.id === 'model' || o.category === 'model')
    ? modelRows(s.configOptions)
    : (s?.models?.availableModels ?? []).map((m) => ({ value: m.modelId, label: m.name ?? m.modelId, description: m.description ?? '' }));
  return own ? [OWN_MODEL, ...rows.filter((r) => r.value)] : rows;
}

/**
 * Which mode a session calls `name`, in either shape: `plan`, or the mode that asks before each
 * command and write (`default`, else one named for working: agent, code, build). Never one that
 * doesn't ask (accept-edits, auto): Beluga would judge nothing.
 */
export function acpMode(s: AcpSession, name: 'plan' | 'default'): { readonly via: 'config' | 'modes'; readonly value: string } | undefined {
  const words = name === 'plan' ? [/^plan$/i, /#plan$/i, /\bplan\b/i] : [/^default$/i, /^(agent|code|build|ask)$/i, /#(agent|code|default|build)$/i];
  const config = s.configOptions?.find((o) => o.id === 'mode' || o.category === 'mode');
  if (config) {
    for (const w of words) {
      const hit = config.options.find((o) => w.test(o.value) || w.test(o.name));
      if (hit) return { via: 'config', value: hit.value };
    }
    return undefined;
  }
  for (const w of words) {
    const hit = s.modes?.availableModes?.find((m) => w.test(m.id) || (m.name ? w.test(m.name) : false));
    if (hit) return { via: 'modes', value: hit.id };
  }
  return undefined;
}

/** Beluga's tool suites as ACP's stdio MCP servers (every agent takes these). */
export function stdioServers(servers: Readonly<Record<string, StdioServerConfig>>): AcpMcpServer[] {
  return Object.entries(servers).map(([name, s]) => ({ name, command: s.command, args: [...s.args], env: Object.entries(s.env).map(([k, value]) => ({ name: k, value })) }));
}

/** Beluga's instructions for a run, ahead of a new conversation's first message: for an agent with no system prompt of its own to add to. */
export function withInstructions(instructions: string, prompt: string): string {
  return instructions.trim() ? `<beluga-instructions>\n${instructions.trim()}\n</beluga-instructions>\n\n${prompt}` : prompt;
}

/**
 * Waits until nothing has been heard for `quietMs` (`last`: when something last was), and never
 * longer than `capMs` in all: a loaded session's history that's still coming in is in before the
 * first turn goes.
 */
export async function settled(last: () => number, quietMs = 200, capMs = 2_000, now: () => number = Date.now): Promise<void> {
  const until = now() + capMs;
  while (now() < until && now() - last() < quietMs) await new Promise((resolve) => setTimeout(resolve, 25));
}
