import { useEffect, useState, type ReactNode } from 'react';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Kbd, Tip, cx } from '../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import type { Args } from '@beluga/ipc/api.js';
import { FIRST_PRESET, type SchedulePreset, presetHint, presetLabel, presetRepeats, presetTrigger, scheduleDraft, schedulePresets, whenWords } from './schedule-model.js';
import s from './composer.module.css';

/**
 * The message box as a schedule (BLG-1023): '/schedule', the mode menu's Schedule, or the
 * Info panel's Schedules + turn the box into one. A banner says when it will send, the When chip
 * picks from plain presets (Custom… opens the full sheet), and Schedule makes the sentinel, on.
 * esc, or backspace in an empty box, goes back to an ordinary message.
 */

/** The Info panel's Schedules + asks the box of this chat to turn into a schedule. */
export const SCHEDULE_EVENT = 'beluga:schedule';
export const askToSchedule = (channel: string): void => void document.dispatchEvent(new CustomEvent(SCHEDULE_EVENT, { detail: channel }));

/** The preset picked last, so the next schedule starts there. */
let lastPreset: SchedulePreset = FIRST_PRESET;

export interface ScheduleMode {
  readonly on: boolean;
  enter(): void;
  leave(): void;
  /** Make the schedule from these words → whether it was made (a refusal is a toast; the words stay). */
  schedule(words: string): Promise<boolean>;
  readonly banner: ReactNode;
  readonly chip: ReactNode;
  /** The Schedule button, in place of Send. */
  button(ready: boolean, send: () => void, sendKeys: string): ReactNode;
  /** The mode menu's way in. */
  readonly item: ActionItem | undefined;
}

export function useScheduleMode({ channel, can, words, clear }: { channel: string; can: boolean; words: () => string; clear: () => void }): ScheduleMode {
  const api = useApi();
  const { client } = useBeluga();
  const self = useApp((st) => st.selfId);
  const projectId = useApp((st) => (channel.startsWith('ws:') ? findWorkspace(st.projects, channel.slice(3))?.projectId : undefined));
  const [inChat, setInChat] = useState<string | undefined>(undefined);
  const [preset, setPresetState] = useState<SchedulePreset>(lastPreset);
  const on = can && inChat === channel;
  const now = Date.now();
  // 'This evening' passed while the box waited: tomorrow morning instead.
  const picked = schedulePresets(now).includes(preset) ? preset : FIRST_PRESET;

  const enter = (): void => {
    setInChat(channel);
    document.dispatchEvent(new Event('beluga:focus-composer'));
  };
  const leave = (): void => setInChat(undefined);
  const pick = (p: SchedulePreset): void => {
    lastPreset = p;
    setPresetState(p);
  };

  useEffect(() => {
    if (!can) return undefined;
    const onAsk = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === channel) enter();
    };
    document.addEventListener(SCHEDULE_EVENT, onAsk);
    return () => document.removeEventListener(SCHEDULE_EVENT, onAsk);
  }, [can, channel]);

  const schedule = async (prompt: string): Promise<boolean> => {
    if (!self || !prompt.trim()) return false;
    const trigger = presetTrigger(picked, Date.now());
    try {
      const made = await api.sentinel.create(scheduleDraft({ trigger, prompt, ref: `${self}/${channel}`, ...(projectId ? { projectId } : {}) }) as Args<'sentinel.create'>[0]);
      // You made it by hand, so it starts on (an agent's starts paused).
      await api.sentinel.pause(made.id, false);
      toast(client, `Scheduled: sends here ${whenWords(trigger, Date.now())}`, 'success');
      setInChat(undefined);
      return true;
    } catch (err) {
      toast(client, `Couldn’t schedule it: ${err instanceof Error ? err.message.replace(/^Error: /, '') : String(err)}`, 'error');
      return false;
    }
  };

  const custom = (): void => {
    const prompt = words().trim();
    // Made there: the words it took leave the box, and the box is a message again.
    openSheet({
      kind: 'schedule',
      channel,
      ...(prompt ? { prompt } : {}),
      onMade: () => {
        setInChat(undefined);
        clear();
      },
    });
  };

  const presets = schedulePresets(now);
  const items: ActionItem[] = [
    ...presets.map((p, i) => ({
      label: presetLabel(p, now),
      hint: presetHint(p, now),
      checked: p === picked,
      ...(i > 0 && presetRepeats(p) && !presetRepeats(presets[i - 1]!) ? { separate: true } : {}),
      onSelect: () => pick(p),
    })),
    { label: 'Custom…', hint: 'Another time, or how often', icon: 'calendar', separate: true, onSelect: custom },
  ];

  const banner = (
    <div className={s.planBanner} role="status">
      <span className={s.planTag}>
        <Icon name="clock" size={11} />
        Schedule
      </span>
      <span className={s.planHint}>Sends this here {whenWords(presetTrigger(picked, now), now)}, as if you wrote it then</span>
      <span className={s.flex} />
      <span className={s.planKeys}>
        <Kbd>esc</Kbd> to leave
      </span>
    </div>
  );

  const chip = (
    <ActionsDropdown align="start" items={items}>
      <button type="button" className={cx(s.chip, s.chipOn)} aria-label={`When: ${presetLabel(picked, now)}`} title="When it sends">
        <Icon name="clock" size={12} />
        <span className={s.chipLabel}>{presetLabel(picked, now)}</span>
        <Icon name="chevronDown" size={9} />
      </button>
    </ActionsDropdown>
  );

  const button = (ready: boolean, send: () => void, sendKeys: string): ReactNode => (
    <Tip label={`Schedule it: sends here ${whenWords(presetTrigger(picked, now), now)}`} keys={sendKeys}>
      <button type="button" className={cx(s.split, s.answer, ready && s.splitReady)} onClick={send} disabled={!ready} aria-label="Schedule">
        <Icon name="clock" size={12} />
        <span className={s.chipLabel}>Schedule</span>
      </button>
    </Tip>
  );

  // One of the modes in the box's mode menu, beside Act and the plans.
  const item: ActionItem | undefined = can ? { label: 'Schedule', hint: 'Send it later, or again and again', checked: on, onSelect: enter } : undefined;

  return { on, enter, leave, schedule, banner, chip, button, item };
}
