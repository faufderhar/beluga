import { type AgentRef, CLAUDE_AGENT } from '../protocol.js';
import { RUNTIME_NAMES, modelName } from '../shared/agent-label.js';
import { clampThreshold, contextWindowFor } from '../shared/context-usage.js';
import { fallbackFor } from '../shared/runtime-fallbacks.js';

/**
 * What the context meter says for one conversation: that agent's model and window, and whether
 * Beluga will compact it. Settings' model is Claude's, so a Grok or Codex chat must not inherit it.
 * Browser-safe.
 */

export interface ContextFactsState {
  readonly context: Readonly<Record<string, { readonly model?: string; readonly window?: number } | undefined>>;
  readonly projects: ReadonlyArray<{
    readonly name: string;
    readonly workspaces: ReadonlyArray<{
      readonly id: string;
      readonly model?: string;
      readonly agent?: { readonly runtime: string; readonly model?: string };
    }>;
  }>;
  readonly prefs: {
    readonly model?: string;
    readonly autoCompact: boolean;
    readonly autoCompactAt: number;
    readonly defaultAgent?: AgentRef;
    readonly projectAgents?: Readonly<Record<string, AgentRef>>;
  };
  readonly models: readonly { readonly value: string; readonly label: string }[];
  readonly runtimes: readonly { readonly id: string; readonly label?: string; readonly models?: readonly { readonly value: string; readonly label: string }[] }[];
}

export interface ContextFacts {
  readonly runtime: string;
  readonly modelId?: string;
  /** How the meter names the model. Claude with no pick says "Default"; another runtime says its own name. */
  readonly modelLabel: string;
  /** The window to print. Absent when this runtime hasn't reported one (never Claude's 200k guess). */
  readonly window?: number;
  readonly autoCompact: string;
  readonly autoCompactTitle?: string;
  /** Settings' threshold, clamped. The bar uses it only when `autoCompactMark`. */
  readonly threshold: number;
  /** The bar's mark: only when Beluga itself will send /compact. */
  readonly autoCompactMark: boolean;
}

const agentFor = (prefs: ContextFactsState['prefs'], project?: string): AgentRef => (project ? prefs.projectAgents?.[project] : undefined) ?? prefs.defaultAgent ?? CLAUDE_AGENT;

function place(state: ContextFactsState, channel: string): { readonly runtime: string; readonly agent: { readonly runtime: string; readonly model?: string }; readonly ws?: ContextFactsState['projects'][number]['workspaces'][number] } {
  const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  for (const project of state.projects) {
    const ws = id ? project.workspaces.find((w) => w.id === id) : undefined;
    if (!ws) continue;
    const agent = ws.agent ?? agentFor(state.prefs, project.name);
    return { runtime: agent.runtime, agent, ws };
  }
  const agent = agentFor(state.prefs);
  return { runtime: agent.runtime, agent };
}

function labelOf(state: ContextFactsState, runtime: string, modelId: string | undefined): string {
  if (!modelId) return runtime === 'claude' ? 'Default' : (RUNTIME_NAMES[runtime] ?? state.runtimes.find((r) => r.id === runtime)?.label ?? runtime);
  const list = runtime === 'claude' ? state.models : (state.runtimes.find((r) => r.id === runtime)?.models ?? []);
  return list.find((m) => m.value === modelId)?.label ?? modelName(modelId);
}

function compactOf(runtime: string, on: boolean, at: number): Pick<ContextFacts, 'autoCompact' | 'autoCompactTitle' | 'autoCompactMark'> {
  // A runtime with its own compact (Codex) is left to do that. Beluga's percent is not its threshold.
  if (fallbackFor(runtime, 'compact')) {
    return { autoCompact: runtime === 'codex' ? 'Codex compacts this chat itself' : 'This agent compacts this chat itself', autoCompactMark: false };
  }
  if (runtime === 'grok') {
    if (!on) {
      return {
        autoCompact: 'Off in Beluga',
        autoCompactTitle: 'Beluga will not send /compact. Grok Build may still compact this chat on its own.',
        autoCompactMark: false,
      };
    }
    return {
      autoCompact: `Beluga at ${at}%`,
      autoCompactTitle: 'Beluga sends /compact at this point. Grok Build may also compact this chat on its own.',
      autoCompactMark: true,
    };
  }
  return on ? { autoCompact: `At ${at}%`, autoCompactTitle: `Auto-compacts at ${at}%`, autoCompactMark: true } : { autoCompact: 'Off', autoCompactMark: false };
}

/** The model's window, name and compact line for `channel`. */
export function contextFacts(state: ContextFactsState, channel: string): ContextFacts {
  const { runtime, agent, ws } = place(state, channel);
  const info = state.context[channel];
  const modelId = info?.model || ws?.model || agent.model || (runtime === 'claude' ? state.prefs.model : undefined);
  const reported = info?.window && info.window > 0 ? info.window : undefined;
  const at = clampThreshold(state.prefs.autoCompactAt);
  return {
    runtime,
    ...(modelId ? { modelId } : {}),
    modelLabel: labelOf(state, runtime, modelId),
    ...(reported || runtime === 'claude' ? { window: reported ?? contextWindowFor(modelId) } : {}),
    threshold: at,
    ...compactOf(runtime, state.prefs.autoCompact, at),
  };
}
