import { z } from 'zod';

/**
 * Usage statistics (see core/telemetry-store.ts): the level you chose (Off, Limited, On), the ask
 * after an update. Whether this build can send, your level and whether the
 * ask is due are in the shared state's `telemetry`. Browser-safe: zod only.
 */

const level = z.enum(['off', 'limited', 'on']);

export const TELEMETRY_API = {
  // A level chosen at the end of the onboarding (Skip keeps Limited) or in Settings.
  'telemetry.choose': { args: z.tuple([level, z.enum(['onboarding', 'settings'])]) },
  // The ask answered: share (at that level), later (in a few days or a few merges), never (No thanks).
  'telemetry.answer': { args: z.tuple([z.enum(['share', 'later', 'never']), level]) },
  // A project (its folder) left out of usage statistics, or back in: its runs send nothing (its Settings).
  'telemetry.exclude': { args: z.tuple([z.string().min(1).max(4096), z.boolean()]) },
  // A moment a screen reports, by name only (onboarding steps, the ask shown), at a level that sends.
  'telemetry.mark': { args: z.tuple([z.enum(['onboarding_step', 'onboarding_done', 'ask_shown']), z.string().max(40).optional()]) },
} as const;
