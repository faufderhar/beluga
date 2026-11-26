import type { AgentRef } from '@beluga/protocol.js';
import { planForHome } from '@beluga/core/plans/model.js';
import { agentName } from '@beluga/shared/agent-label.js';
import { runtimeHere } from '@beluga/shared/runtime-fallbacks.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { Icon } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { agentOnlyItems } from '../components/agent-options.js';
import { useApi, useApp } from '../lib/beluga.js';
import s from './composer.module.css';

const sameAgent = (a: AgentRef | undefined, b: AgentRef | undefined): boolean => a?.runtime === b?.runtime && a?.model === b?.model && a?.label === b?.label;

/**
 * Plan here, build with another agent (BLG-982), from the composer's mode menu: under Plan First
 * and Advanced Planning, "Builder ▸" picks who does the work once you approve the plan. The agent
 * in this chat plans; with the Same Agent, it builds too.
 *
 * BLG-1023: the row says who builds ("Builder: Codex") and a pick keeps the menu open, so the choice
 * shows where it was made; a chip beside the mode says it once the menu closes, with × to undo it.
 * Only when there is someone else to pick: with one usable agent the row isn't there at all.
 */
export function useBuildWith(channel: string): { readonly builder?: AgentRef; readonly show: boolean; readonly clear: () => void; readonly item: ActionItem } {
  const api = useApi();
  const runtimes = useApp((st) => st.runtimes);
  // The agent planning here: the chat's own, else this Mac's default.
  const planner = useApp((st) => runtimeHere(st.projects.flatMap((p) => p.workspaces).find((w) => `ws:${w.id}` === channel)?.agent, st.self));
  // A plan already here: its builder; else what's picked for the next plan made here.
  const builder = useApp((st) => {
    const plan = planForHome(st.plans, channel);
    return plan && plan.status !== 'done' ? plan.agent : st.buildWith[channel];
  }, sameAgent);
  const pick = (agent: AgentRef | null): void => void api.session.setBuildWith(channel, agent);
  // Others to pick: the usable agents besides the one planning here.
  const others = runtimes.filter((r) => r.available && r.id !== planner);
  const show = others.length > 0 || builder !== undefined;
  const item: ActionItem = {
    label: `Builder: ${builder ? agentName(builder) : 'Same Agent'}`,
    hint: 'Who does the work once you approve the plan',
    icon: 'wrench',
    separate: true,
    submenu: [
      { label: 'Same Agent', hint: 'The agent here plans and builds', checked: !builder, stay: true, onSelect: () => pick(null) },
      // Just the agents, no models: the builder starts on its default; the chat's own picker changes that later.
      ...agentOnlyItems(others, builder, pick).map((row, i) => ({ ...row, stay: true, ...(i === 0 ? { separate: true } : {}) })),
    ],
    onSelect: () => undefined,
  };
  return { ...(builder ? { builder } : {}), show, clear: () => pick(null), item };
}

/** Beside the mode while another agent will build what's planned here: who, and × to have the agent here build it. */
export function BuildWithChip({ builder, clear }: { builder: AgentRef; clear: () => void }) {
  const name = agentName(builder);
  return (
    <Tip label={`${name} does the work once you approve the plan. Click to have the agent here build it too`}>
      <button type="button" className={cx(s.chip, s.chipOn)} aria-label={`Built by ${name}: have the agent here build it instead`} onClick={clear}>
        <Icon name="wrench" size={12} />
        <span className={s.chipLabel}>Built by {name}</span>
        <Icon name="x" size={9} />
      </button>
    </Tip>
  );
}
