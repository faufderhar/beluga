import type { TelemetryLevel } from '@beluga/core/telemetry-store.js';

/**
 * Usage statistics in words: the same three choices everywhere (the end of the onboarding, the ask
 * after an update, Settings › General). What each level sends exactly is in the code
 * (src/telemetry) and in docs/telemetry.md.
 */

export const TELEMETRY_TITLE = 'Help make Beluga better';

export const TELEMETRY_LEAD =
  'Beluga is completely free and open source, and tens of thousands of people use it. We can’t see how it’s used, so your usage statistics are how we make it better for you.';

export const TELEMETRY_FOOT = 'It’s all open source, so you can see exactly what’s sent. Change it any time in Settings.';

export interface LevelChoice {
  readonly level: TelemetryLevel;
  readonly label: string;
  readonly detail: string;
}

export const LEVELS: readonly LevelChoice[] = [
  { level: 'off', label: 'Off', detail: 'Nothing is sent.' },
  { level: 'limited', label: 'Limited', detail: 'Only the very essential data.' },
  { level: 'on', label: 'On', detail: 'How you use Beluga and its statistics, sent anonymously.' },
];

export const levelLabel = (level: TelemetryLevel | undefined): string => LEVELS.find((l) => l.level === level)?.label ?? 'Not chosen';
