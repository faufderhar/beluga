import type { ConvView } from './link/protocol';

/**
 * A chat's schedules in words (1.57, BLG-401): the ••• sheet's summary, and which ones already ran
 * their one time. Plain: no React Native.
 */

type Schedule = NonNullable<ConvView['schedules']>[number];

/** The sheet's row in the conversation's ••• sheet: how many, and how many are on when not all. */
export function schedulesSummary(schedules: readonly Schedule[] | undefined): string {
  if (!schedules?.length) return '';
  const on = schedules.filter((s) => !s.paused && !scheduleSpent(s)).length;
  return `${schedules.length} ${schedules.length === 1 ? 'schedule' : 'schedules'}${on < schedules.length ? ` · ${on} on` : ''}`;
}

/**
 * A schedule with nothing left to do: on, with no next time and no run going. On a Mac with
 * Sentinel on, that is a one-time schedule that already ran. It reads as done, not on.
 */
export const scheduleSpent = (s: Pick<Schedule, 'paused' | 'running' | 'nextAt'>): boolean => !s.paused && !s.running && s.nextAt === undefined;
