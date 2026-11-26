import { autopilotIn } from '@beluga/core/autopilot/model.js';
import { FULL_AUTOPILOT_INFO, planTitle } from '@beluga/core/plans/model.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { Icon } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { sameFields } from '../lib/stable.js';
import s from './composer.module.css';

/** A chat's Full Autopilot: on here, or through the plan it works for (BLG-981). Flat, so a redraw only follows a real change. */
interface AutopilotHere {
  readonly on: boolean;
  /** On because a plan it works for is: its name, and whether this is the plan's own conversation (which switches it). */
  readonly planTitle?: string;
  readonly planHome?: boolean;
}

export function useAutopilot(channel: string): AutopilotHere & { readonly fixed: boolean; readonly toggle: () => void; readonly item: ActionItem } {
  const api = useApi();
  const here = useApp((st): AutopilotHere => {
    const on = autopilotIn(st, channel);
    return on ? { on: true, ...(on.plan ? { planTitle: planTitle(on.plan), planHome: on.plan.home === channel } : {}) } : { on: false };
  }, sameFields);
  // A plan's worktree or checker follows its plan: only the plan's own conversation (or page) switches it.
  const fixed = here.planTitle !== undefined && !here.planHome;
  const toggle = (): void => {
    if (!fixed) void api.session.setAutopilot(channel, !here.on);
  };
  const item: ActionItem = {
    label: FULL_AUTOPILOT_INFO.label,
    hint: fixed ? `On for the plan “${here.planTitle}”: switch it on the plan’s page` : 'In any mode: a stand-in agent answers your agent’s questions, so it never waits for you',
    icon: 'bot',
    checked: here.on,
    toggle: true,
    disabled: fixed,
    separate: true,
    onSelect: toggle,
  };
  return { ...here, fixed, toggle, item };
}

/** Shown while Full Autopilot is on in this chat: what it means, and one click to take over again. */
export function AutopilotChip({ channel }: { channel: string }) {
  const auto = useAutopilot(channel);
  if (!auto.on) return null;
  const fixed = auto.fixed;
  const label = fixed ? `The plan “${auto.planTitle}” runs on Full Autopilot: a stand-in agent answers for you` : 'Full Autopilot: a stand-in agent answers what your agent asks here. Click to answer yourself again';
  return (
    <Tip label={label}>
      <button type="button" className={cx(s.chip, s.chipOn)} aria-label={fixed ? 'Full Autopilot, from the plan' : 'Turn off Full Autopilot'} aria-pressed="true" disabled={fixed} onClick={auto.toggle}>
        <Icon name="bot" size={12} />
        <span className={s.chipLabel}>Autopilot</span>
        {fixed ? null : <Icon name="x" size={9} />}
      </button>
    </Tip>
  );
}
