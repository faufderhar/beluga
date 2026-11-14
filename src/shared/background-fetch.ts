/**
 * How often Beluga fetches each project's remote on its own (#479): the project home's "fetched …
 * ago", and how far behind main is. In minutes; 0: never on its own (Fetch and Update main still
 * fetch when you click them). Someone whose git keys sit in a vault that asks each time they're
 * used turns it down or off. Data only, so the Settings window can use it too.
 */

/** Every 15 minutes: what Beluga always did. */
export const FETCH_EVERY_DEFAULT = 15;
/** Shorter than this would only knock on the remote's door; longer than a day isn't "background". */
export const FETCH_EVERY_MIN = 5;
export const FETCH_EVERY_MAX = 24 * 60;

/** The choices Settings offers (any whole number of minutes in range works too). */
export const FETCH_EVERY_CHOICES: readonly number[] = [0, 5, 15, 30, 60, 240];

/** A saved value Beluga can use: 0, or minutes in range; anything else reads as the default. */
export function fetchEveryMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return FETCH_EVERY_DEFAULT;
  if (value === 0) return 0;
  return value >= FETCH_EVERY_MIN && value <= FETCH_EVERY_MAX ? value : FETCH_EVERY_DEFAULT;
}

/** "Never", "Every 15 minutes", "Every hour", "Every 4 hours". */
export function fetchEveryWords(minutes: number): string {
  if (minutes === 0) return 'Never';
  if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}
