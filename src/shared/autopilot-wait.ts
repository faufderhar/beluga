/**
 * How long work on Autopilot waits for your answer before your agent carries on without it
 * (BLG-998). Only Autopilot gives up: Step by Step, Check-ins and plain chats wait until you answer,
 * and Full Autopilot has a stand-in answer at once. In minutes; 0: Autopilot waits for you too.
 * Data only, so the Settings window can use it.
 */

/** Five minutes: what every question waited before it waited for you. */
export const AUTOPILOT_WAIT_DEFAULT = 5;
/** Never give up: Autopilot waits for your answer like the other modes. */
export const AUTOPILOT_WAIT_NEVER = 0;
export const AUTOPILOT_WAIT_MAX = 24 * 60;

/** The choices Settings offers (any whole number of minutes up to a day works too). */
export const AUTOPILOT_WAIT_CHOICES: readonly number[] = [1, 5, 15, 30, 60, 240, AUTOPILOT_WAIT_NEVER];

export const AUTOPILOT_WAIT_WHERE = 'Settings › Agent › Autopilot';

/** A saved value Beluga can use: 0, or whole minutes up to a day; anything else reads as the default. */
export function autopilotWaitMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return AUTOPILOT_WAIT_DEFAULT;
  return value >= 0 && value <= AUTOPILOT_WAIT_MAX ? value : AUTOPILOT_WAIT_DEFAULT;
}

/** "1 minute", "15 minutes", "1 hour", "4 hours", "Until you answer". */
export function autopilotWaitWords(minutes: number): string {
  if (minutes === AUTOPILOT_WAIT_NEVER) return 'Until you answer';
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
