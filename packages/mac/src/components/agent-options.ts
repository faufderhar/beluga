import { useCallback, useMemo } from 'react';
import { type AgentRef, CLAUDE_AGENT } from '@beluga/protocol.js';
import type { RuntimeChoice } from '@beluga/shared/agent-runtimes.js';
import { agentChoices, agentForChoice, choiceForAgent } from '@beluga/ui/agent-choice.js';
import { runtimeMark } from '@beluga/shared/agent-marks.js';
import { agentName } from '@beluga/shared/agent-label.js';
import { useApp } from '../lib/beluga.js';
import { useMyAgent } from '../lib/agent-words.js';
import type { SelectEntry, SelectOption } from './select-parts.js';
import type { ActionItem } from './SpecMenu.js';

/** The pop-up value for "your agent" (whatever your default is when the work starts). */
export const YOUR_AGENT = '';

/**
 * Who does a piece of work (BLG-497), as pop-up entries: "Your agent (Claude)" first (value '',
 * following your default), then every agent and model you can pick, a section per runtime, each
 * with its runtime's mark beside the name. One not set up here stays greyed, saying why. Values
 * are agentChoices' `runtime:model` (agentForChoice turns one into an AgentRef).
 */
export function useAgentEntries(): SelectEntry<string>[] {
  const runtimes = useApp((s) => s.runtimes);
  const models = useApp((s) => s.models);
  const mine = useMyAgent();
  return useMemo(() => {
    const options = agentChoices(runtimes, models);
    const groups = [...new Set(options.map((o) => o.group))];
    const yours: SelectOption<string> = { value: YOUR_AGENT, label: `Your agent (${agentName(mine)})`, icon: runtimeMark(mine.runtime), description: 'Whatever your default agent is when the work starts' };
    return [
      yours,
      ...groups.map((group) => ({
        section: group,
        options: options
          .filter((o) => o.group === group)
          .map((o): SelectOption<string> => ({ value: o.value, label: o.label, icon: o.mark, ...(o.disabled ? { disabled: true } : {}), ...(o.why ? { description: o.why } : {}) })),
      })),
    ];
  }, [runtimes, models, mine]);
}

/**
 * The same list as a ••• submenu's rows (BLG-498): a line above each runtime's section, the agent
 * now in use checked (none: your agent). `pick` gets the row's value (YOUR_AGENT or `runtime:model`).
 */
export function agentMenuItems(entries: readonly SelectEntry<string>[], current: AgentRef | undefined, pick: (value: string) => void): ActionItem[] {
  const now = current ? choiceForAgent(current) : YOUR_AGENT;
  const item = (o: SelectOption<string>, separate: boolean): ActionItem => ({
    label: o.label,
    ...(typeof o.icon === 'string' ? { icon: o.icon } : {}),
    ...(o.disabled ? { disabled: true } : {}),
    ...(o.description && o.disabled ? { hint: o.description } : {}),
    ...(separate ? { separate: true } : {}),
    checked: o.value === now,
    onSelect: () => pick(o.value),
  });
  return entries.flatMap((e) => ('section' in e ? e.options.map((o, i) => item(o, i === 0)) : [item(e, false)]));
}

/**
 * "Start with ▸" (BLG-506): the same list as rows of a split button's menu or a submenu, each
 * `${verb} <agent>` with its mark (no verb: the names alone, for a submenu that says it), one not
 * set up here greyed with why. `current`: who the main
 * button starts with (checked; none: your agent). `pick` gets the agent, or undefined for your agent.
 */
export function useStartWith(): (current: AgentRef | undefined, pick: (agent: AgentRef | undefined) => void, verb?: string) => ActionItem[] {
  const entries = useAgentEntries();
  const runtimes = useApp((s) => s.runtimes);
  return useCallback(
    (current, pick, verb = 'Start with') =>
      agentMenuItems(entries, current, (v) => pick(v === YOUR_AGENT ? undefined : agentForChoice(v, runtimes))).map((it) => (verb ? { ...it, label: `${verb} ${it.label.startsWith('Your agent') ? `y${it.label.slice(1)}` : it.label}` } : it)),
    [entries, runtimes],
  );
}

/**
 * Just the agents, one row each with its mark (Claude, Codex, OpenCode…), no models: for a menu
 * that asks who does a part of the work (Build With ▸). The agent runs its
 * default model; its own model picker changes that later. One not set up here is greyed, saying why.
 * `current` is checked by its runtime; `pick` gets the agent.
 */
export function agentOnlyItems(runtimes: readonly RuntimeChoice[], current: AgentRef | undefined, pick: (agent: AgentRef) => void): ActionItem[] {
  const known = runtimes.length ? runtimes : [{ id: CLAUDE_AGENT.runtime, label: CLAUDE_AGENT.label, available: true }];
  return known.map((r) => ({
    label: r.label,
    icon: runtimeMark(r.id),
    ...(r.available ? {} : { disabled: true, ...(r.why ? { hint: r.why } : {}) }),
    checked: current?.runtime === r.id,
    onSelect: () => pick({ runtime: r.id, label: r.label }),
  }));
}
