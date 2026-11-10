import type { AgentRef } from '../protocol.js';
import type { RuntimeChoice, RuntimeModel } from './agent-runtimes.js';
import { modelName } from './agent-label.js';
import { CLOSED_WHY, modelsForChat, runtimeModels } from './open-models.js';

/**
 * The agent picker (BLG-446), as the Mac's composer and the phone show it: runtimes as groups
 * (Claude › Opus, Sonnet…; Codex › …; Local model › …), each with its models and the effort levels
 * they take. Your default agent's group comes first and open; the others sit behind it. A runtime
 * this Mac doesn't run stays, greyed, saying what's missing. Browser-safe.
 */

/** The parts of the app's state the picker reads. */
export interface PickerState {
  readonly runtimes: readonly RuntimeChoice[];
  /** Claude Code's own models (the 'claude' runtime's). */
  readonly models: readonly RuntimeModel[];
  readonly prefs: { readonly model?: string; readonly openModels?: readonly string[] };
  readonly projects: ReadonlyArray<{ readonly workspaces: ReadonlyArray<{ readonly id: string; readonly agent?: AgentRef; readonly model?: string }> }>;
}

export interface PickerModel extends RuntimeModel {
  readonly on: boolean;
}

export interface PickerGroup {
  readonly runtime: string;
  readonly label: string;
  readonly available: boolean;
  readonly why?: string;
  /** Your default agent's runtime. */
  readonly isDefault: boolean;
  /** The runtime this conversation runs on now. */
  readonly current: boolean;
  readonly models: readonly PickerModel[];
}

export interface AgentPicker {
  /** The conversation it picks for (undefined: new conversations). */
  readonly conversation?: string;
  readonly runtime: string;
  /** The picked model's value ('' = the runtime's default). */
  readonly model: string;
  /** The chip: "Opus", or "Codex · GPT-5" for a runtime other than your default. */
  readonly label: string;
  /** Default first, then the rest in Beluga's order. */
  readonly groups: readonly PickerGroup[];
}

/** What picking an entry does: a model of the same runtime is a model change, another runtime an agent change. */
export type PickAction = { readonly kind: 'model'; readonly value: string } | { readonly kind: 'agent'; readonly agent: AgentRef | null };

const DEFAULT_RUNTIME = 'claude';

const workspaceOf = (state: PickerState, channel: string) => {
  const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  return id ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) : undefined;
};

/** The runtime a conversation runs on (its pick, else your default agent's). */
export function runtimeOf(state: PickerState, channel: string, defaultRuntime = DEFAULT_RUNTIME): string {
  return workspaceOf(state, channel)?.agent?.runtime ?? defaultRuntime;
}

function modelsOf(state: PickerState, r: RuntimeChoice): { readonly models: readonly RuntimeModel[]; readonly closed: boolean } {
  const listed = runtimeModels(r, state.models);
  const models = modelsForChat(listed, r.id, state.prefs.openModels);
  return { models, closed: r.available && listed.length > 0 && models.length === 0 };
}

/** `draft`: a new worktree's own pick, before it exists (the New Worktree box). */
export function agentPicker(state: PickerState, channel: string, defaultRuntime = DEFAULT_RUNTIME, draft?: AgentRef): AgentPicker {
  const conversation = channel === 'room' || channel === 'draft' ? undefined : channel;
  const ws = conversation ? workspaceOf(state, conversation) : undefined;
  const pinned = ws?.agent ?? (conversation ? undefined : draft);
  const runtime = pinned?.runtime ?? defaultRuntime;
  const model = (ws ? ws.model : draft?.model) ?? (runtime === defaultRuntime ? state.prefs.model : undefined) ?? '';
  const order = [...state.runtimes].sort((a, b) => Number(b.id === defaultRuntime) - Number(a.id === defaultRuntime));
  const groups = order.map((r): PickerGroup => {
    const { models, closed } = modelsOf(state, r);
    return {
      runtime: r.id,
      label: r.label,
      available: r.available && !closed,
      ...(closed ? { why: CLOSED_WHY } : r.why ? { why: r.why } : {}),
      isDefault: r.id === defaultRuntime,
      current: r.id === runtime,
      models: models.map((m) => ({ ...m, on: r.id === runtime && m.value === model })),
    };
  });
  const group = groups.find((g) => g.current);
  const picked = group?.models.find((m) => m.on);
  const modelWords = picked?.label ?? (model ? modelName(model) : 'Default');
  const label = runtime === defaultRuntime ? modelWords : `${group?.label ?? runtime} · ${modelWords}`;
  return { ...(conversation ? { conversation } : {}), runtime, model, label, groups };
}

/**
 * What picking `model` of `runtime` does here. Same runtime: a model change (no new conversation).
 * Another runtime: an agent change (BLG-447 hands the conversation off). Your default's runtime
 * picked back: the conversation follows your default agent again (null). New conversations only
 * take your default agent's models here; another runtime is the new worktree's own pick.
 */
export function pickAction(picker: AgentPicker, group: Pick<PickerGroup, 'runtime' | 'label' | 'isDefault'>, model: string): PickAction | undefined {
  if (group.runtime === picker.runtime) return { kind: 'model', value: model };
  if (!picker.conversation) return group.isDefault ? { kind: 'model', value: model } : undefined;
  if (group.isDefault) return { kind: 'agent', agent: model ? { runtime: group.runtime, label: group.label, model } : null };
  return { kind: 'agent', agent: { runtime: group.runtime, label: group.label, ...(model ? { model } : {}) } };
}

/**
 * The agent that actually runs in a workspace (BLG-448): its own pick, else the owner's default,
 * with the workspace's model. What a joined or asked worktree shows: the owner's, never the viewer's.
 */
export function placeAgent(ws: { readonly agent?: AgentRef; readonly model?: string }, fallback: AgentRef): AgentRef {
  const base = ws.agent ?? fallback;
  const model = ws.model ?? (ws.agent ? undefined : fallback.model);
  const { model: _m, ...ref } = base;
  return model ? { ...ref, model } : ref;
}

/** The agent and model a conversation runs on now, as an agent (what a task's page shows for its worktree). */
export function pickedAgent(p: Pick<AgentPicker, 'runtime' | 'model' | 'groups'>): AgentRef {
  const group = p.groups.find((g) => g.current);
  return { runtime: p.runtime, label: group?.label ?? p.runtime, ...(p.model ? { model: p.model } : {}) };
}
