import type { RuntimeChoice, RuntimeModel } from './agent-runtimes.js';

/**
 * Which models the chat’s model menu offers (Settings › Agent › Models in chat).
 * A key is `runtime|value`. Model ids can contain `:` and `/`; they do not contain `|`.
 * An empty list means every model, including ones found later. Browser-safe.
 */

/** How many keys a saved list may hold (Settings and the prefs patch). */
export const OPEN_MODELS_MAX = 80;

/** Said on a runtime whose models are all turned off. */
export const CLOSED_WHY = 'Turn a model on in Settings › Agent › Models in chat';

export const modelKey = (runtime: string, value: string): string => `${runtime}|${value}`;

/** The models a runtime lists: Claude’s come from Claude Code; another runtime’s from the runtime, or one Default row. */
export function runtimeModels(runtime: RuntimeChoice, claudeModels: readonly RuntimeModel[]): readonly RuntimeModel[] {
  if (!runtime.available) return [];
  if (runtime.id === 'claude') return claudeModels;
  return runtime.models ?? [{ value: '', label: 'Default', description: `${runtime.label}'s choice` }];
}

/** Models the menu may offer. No list (or an empty one): all of them. */
export function modelsForChat<T extends { value: string }>(models: readonly T[], runtime: string, open: readonly string[] | undefined): T[] {
  if (!open?.length) return [...models];
  const allow = new Set(open);
  return models.filter((m) => allow.has(modelKey(runtime, m.value)));
}

/** One model Settings can turn on, for a runtime that runs here (a model that can’t be picked is left out). */
export interface ChatModelChoice {
  readonly runtime: string;
  readonly runtimeLabel: string;
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly key: string;
}

export function openModelCatalog(runtimes: readonly RuntimeChoice[], claudeModels: readonly RuntimeModel[]): ChatModelChoice[] {
  const out: ChatModelChoice[] = [];
  for (const runtime of runtimes) {
    for (const model of runtimeModels(runtime, claudeModels)) {
      if (model.why) continue;
      out.push({
        runtime: runtime.id,
        runtimeLabel: runtime.label,
        value: model.value,
        label: model.label,
        description: model.description,
        key: modelKey(runtime.id, model.value),
      });
    }
  }
  return out;
}

/**
 * The list to store after toggling `key`.
 * `[]` means every model is open, including ones found later.
 * `undefined`: this would turn off the last model listed here, so the switch does nothing.
 * A key for a model that isn’t listed now is kept, until the list covers every listed model and collapses to `[]`.
 */
export function toggleOpenModel(open: readonly string[] | undefined, key: string, known: readonly string[]): readonly string[] | undefined {
  const knownSet = new Set(known);
  const on = open?.length ? new Set(open) : knownSet;
  const unknowns = (open ?? []).filter((k) => !knownSet.has(k) && k !== key);
  if (on.has(key)) {
    const stay = known.filter((k) => k !== key && on.has(k));
    if (stay.length === 0 && knownSet.has(key)) return undefined;
    return cap(stay, unknowns);
  }
  const stay = known.filter((k) => on.has(k) || k === key);
  const extra = knownSet.has(key) ? [] : [key];
  const next = [...stay, ...extra];
  if (known.length > 0 && known.every((k) => next.includes(k))) return [];
  return cap(next, unknowns);
}

/** Listed models first; leftover keys fill whatever room the cap leaves. */
function cap(stay: readonly string[], unknowns: readonly string[]): readonly string[] {
  if (stay.length >= OPEN_MODELS_MAX) return stay.slice(0, OPEN_MODELS_MAX);
  return [...stay, ...unknowns.slice(0, OPEN_MODELS_MAX - stay.length)];
}
