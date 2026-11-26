import { type AssistantChat, assistantChatOf } from '../../../../src/shared/assistant.js';
import { type ChatSchedule, type OnceTrigger, type ScheduleTrigger, type SentinelDraft, type Trigger, clockText, scheduleSentence } from '../../../../src/core/sentinel/model.js';

/**
 * The /schedule sheet's model (BLG-400): a sentinel with one trigger and one chat step that wakes
 * the chat it was made in. Also how a chat's schedules read (spent, the sidebar's clock). Pure: the
 * sheet, the Info panel and tests/mac-schedule-sheet.test.ts read it.
 */

const NAME_MAX = 48;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The sentinel the sheet makes: its trigger, and one chat step to this chat (`ref`), in its project when it has one. */
export function scheduleDraft({ trigger, prompt, ref, projectId }: { trigger: Trigger; prompt: string; ref: string; projectId?: string }): SentinelDraft {
  return {
    name: scheduleName(prompt),
    icon: 'calendar',
    ...(projectId ? { projectId } : {}),
    trigger,
    steps: [{ kind: 'chat', name: 'Wake this chat', to: ref, text: prompt.trim() }],
  };
}

/** 'In N hours': a once trigger at now + N hours, up to the next minute, and a minute ahead at least. */
export function onceIn(hours: number, now: number): OnceTrigger {
  const at = Math.ceil(Math.max(now + hours * HOUR, now + MINUTE) / MINUTE) * MINUTE;
  return { kind: 'once', at: isoLocal(at), missed: 'catch-up' };
}

/** The next whole hour on the Mac's clock: where a new Once moment starts. */
export function nextWholeHour(now: number): number {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  return d.getTime() + HOUR;
}

/** A Once moment still ahead of now (a past one is refused at create). */
export const onceAhead = (t: OnceTrigger, now: number): boolean => new Date(t.at).getTime() > now;

/** A moment as an ISO date and time with the Mac's offset ("2026-11-12T19:30:00+01:00"), as a once trigger keeps it. */
export function isoLocal(ts: number): string {
  const d = new Date(ts);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The schedule's name: its prompt's first line, cut short. */
export function scheduleName(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!.trim();
  if (!line) return 'Chat schedule';
  return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1)}…` : line;
}

/**
 * The message box's Schedule mode (BLG-1023): '/schedule' turns the box into one, and its When chip
 * offers these, in plain words. Each is a trigger worked out from now; Custom… opens the full sheet.
 */
export const SCHEDULE_PRESETS = ['in-1h', 'in-3h', 'evening', 'tomorrow', 'daily', 'weekdays', 'weekly'] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];
/** What the box picks when it turns into a schedule. */
export const FIRST_PRESET: SchedulePreset = 'tomorrow';

const MORNING = '09:00';
const EVENING = 18;
const WEEKDAYS = [1, 2, 3, 4, 5] as const;
const DAY_WORDS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** The presets that make sense now: 'This evening' only before 5 PM. */
export function schedulePresets(now: number): SchedulePreset[] {
  return SCHEDULE_PRESETS.filter((p) => p !== 'evening' || new Date(now).getHours() < EVENING - 1);
}

/** A preset's name in the When menu. */
export function presetLabel(p: SchedulePreset, now: number): string {
  switch (p) {
    case 'in-1h':
      return 'In an hour';
    case 'in-3h':
      return 'In 3 hours';
    case 'evening':
      return 'This evening';
    case 'tomorrow':
      return 'Tomorrow morning';
    case 'daily':
      return 'Every morning';
    case 'weekdays':
      return 'Every weekday morning';
    case 'weekly':
      return `Every ${DAY_WORDS[new Date(now).getDay()]}`;
  }
}

/** Whether a preset sends once or again and again (the menu's two groups). */
export const presetRepeats = (p: SchedulePreset): boolean => p === 'daily' || p === 'weekdays' || p === 'weekly';

/** A preset as the trigger it makes, from now. A moment the Mac slept through still runs when it wakes. */
export function presetTrigger(p: SchedulePreset, now: number): OnceTrigger | ScheduleTrigger {
  switch (p) {
    case 'in-1h':
      return onceIn(1, now);
    case 'in-3h':
      return onceIn(3, now);
    case 'evening':
      return { kind: 'once', at: isoLocal(atHour(now, 0, EVENING)), missed: 'catch-up' };
    case 'tomorrow':
      return { kind: 'once', at: isoLocal(atHour(now, 1, 9)), missed: 'catch-up' };
    case 'daily':
      return { kind: 'schedule', every: 'day', at: MORNING, missed: 'catch-up' };
    case 'weekdays':
      return { kind: 'schedule', every: 'week', at: MORNING, days: [...WEEKDAYS], missed: 'catch-up' };
    case 'weekly':
      return { kind: 'schedule', every: 'week', at: MORNING, days: [new Date(now).getDay()], missed: 'catch-up' };
  }
}

/**
 * When a trigger sends, as the end of a sentence ("Sends this here …"): "today at 15:31",
 * "tomorrow at 9:00", "on Fri 27 Nov at 9:00", or a repeating schedule's own words ("every day at 9:00").
 */
export function whenWords(t: OnceTrigger | ScheduleTrigger, now: number): string {
  if (t.kind === 'schedule') {
    const words = scheduleSentence(t);
    return words.charAt(0).toLowerCase() + words.slice(1);
  }
  const d = new Date(t.at);
  if (Number.isNaN(d.getTime())) return 'once';
  const clock = clockText(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
  const days = Math.round((dayStart(d.getTime()) - dayStart(now)) / (24 * HOUR));
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  return `on ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${clock}`;
}

/** The clock time a preset lands on, for the menu's right side ("15:31", "Tue 9:00"). */
export function presetHint(p: SchedulePreset, now: number): string {
  const t = presetTrigger(p, now);
  if (t.kind === 'schedule') return clockText(t.at);
  const d = new Date(t.at);
  const clock = clockText(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
  return dayStart(d.getTime()) === dayStart(now) ? clock : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${clock}`;
}

/** `hour`:00 on the day `days` after now's, on the Mac's clock. */
function atHour(now: number, days: number, hour: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

const dayStart = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The prompt after '/schedule' ('' for none), or undefined when the words aren't that command. */
export function scheduleCommand(text: string): string | undefined {
  const m = /^\/schedule(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? (m[1] ?? '').trim() : undefined;
}

/**
 * A chat a schedule can wake: one of your worktree or project chats, or a Your Mac chat (not a shared
 * one). Not a Your Mac chat Beluga made for itself (`auto`: a sentinel run's), from `macChats`.
 */
export function canSchedule(channel: string, shared: boolean, macChats: ReadonlyArray<Pick<AssistantChat, 'id' | 'auto'>> = []): boolean {
  if (shared) return false;
  if (channel.startsWith('ws:')) return true;
  const chat = assistantChatOf(channel);
  return chat !== undefined && !macChats.some((c) => c.id === chat && c.auto);
}

/** A one-time schedule that already ran: on, with no next time and no run going. It reads as off. */
export const scheduleSpent = (row: ChatSchedule): boolean => row.trigger.kind === 'once' && row.nextAt === undefined && !row.paused && !row.running;

/** A chat's schedules as its sidebar row's clock says them: how many, and whether all are off (or spent). None: no clock. */
export function scheduleMark(rows: readonly ChatSchedule[]): { readonly count: number; readonly paused: boolean } | undefined {
  return rows.length ? { count: rows.length, paused: rows.every((r) => r.paused || scheduleSpent(r)) } : undefined;
}

const pad = (n: number): string => String(n).padStart(2, '0');
