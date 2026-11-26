import type { AgentRef } from '../../../../src/protocol.js';
import { choiceForAgent } from '../../../../src/ui/agent-choice.js';

/**
 * A plan's Agents menu (header): Planner ▸ / Builder ▸ / Checker ▸, each a row per agent with its
 * models in a submenu of its own (Claude ▸ Default Model, Opus 5.5, Haiku 5.5…). No React here,
 * so tests load it (tests/fork-plan-settings.test.ts).
 */

/** A picker's option (components/select-parts.tsx's SelectOption): `runtime:model`, its label, its icon's name. */
interface Choice<I extends string> {
  readonly value: string;
  readonly label: string;
  readonly icon?: I | object;
  readonly disabled?: boolean;
  readonly description?: string;
}
type Entry<I extends string> = Choice<I> | { readonly section: string; readonly options: readonly Choice<I>[] };

/** A menu row (components/SpecMenu.tsx's ActionItem). */
export interface MenuRow<I extends string> {
  readonly label: string;
  readonly hint?: string;
  readonly icon?: I;
  readonly disabled?: boolean;
  readonly separate?: boolean;
  readonly checked?: boolean;
  readonly submenu?: readonly MenuRow<I>[];
  readonly onSelect: () => void;
}

/**
 * The pickers' agents and models (useAgentEntries' sections) as menu rows: a row per agent, its
 * models a submenu. An agent with no models to pick, or not set up here, is a plain row. The agent
 * in use is checked, and so is its model. `pick` gets the row's value (`runtime:model`).
 */
export function agentModelItems<I extends string>(entries: readonly Entry<I>[], current: AgentRef | undefined, pick: (value: string) => void): MenuRow<I>[] {
  const now = current ? choiceForAgent(current) : undefined;
  const runtimeOf = (v: string): string => v.slice(0, v.indexOf(':'));
  const row = (o: Choice<I>, label = o.label): MenuRow<I> => ({
    label,
    ...(typeof o.icon === 'string' ? { icon: o.icon } : {}),
    ...(o.disabled ? { disabled: true } : {}),
    ...(o.description && o.disabled ? { hint: o.description } : {}),
    checked: o.value === now,
    onSelect: () => pick(o.value),
  });
  return entries.flatMap((e, i): MenuRow<I>[] => {
    if (!('section' in e)) return [];
    const [agent, ...models] = e.options;
    if (!agent) return [];
    const separate = i === 0 || !('section' in entries[i - 1]!) ? { separate: true } : {};
    // Checked by its runtime: a model it no longer lists (or one picked before it was set up) still marks it.
    const inUse = now !== undefined && runtimeOf(now) === runtimeOf(agent.value);
    // Picking it again keeps the model it has: one this agent doesn't list now isn't dropped.
    if (!models.length || agent.disabled) return [{ ...row(agent), ...separate, checked: inUse, onSelect: () => pick(inUse ? now : agent.value) }];
    const prefix = `${agent.label} · `;
    return [
      {
        ...row(agent, e.section),
        ...separate,
        checked: inUse,
        submenu: [row(agent, 'Default Model'), ...models.map((m, j) => ({ ...row(m, m.label.startsWith(prefix) ? m.label.slice(prefix.length) : m.label), ...(j === 0 ? { separate: true } : {}) }))],
        onSelect: () => undefined,
      },
    ];
  });
}
