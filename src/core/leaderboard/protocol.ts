import { z } from 'zod';
import { BOARD_DAYS, type BoardDays } from '../../shared/leaderboard.js';

/**
 * What a friend's Mac sends for the leaderboard (BLG-904), inside a `stats` link frame: its day
 * sums, nothing else. Checked here before anything is kept; a frame that doesn't fit is dropped whole.
 */

export const BOARD_PROTO = 1;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const count = (max: number) => z.number().int().min(0).max(max);
/** More than anyone types or merges in a day, and a day of a few hundred agents in parallel. */
const DayTuple = z.tuple([count(100_000_000), count(10_000), count(1_000 * 86_400_000)]);

export const BoardFrame = z.object({
  v: z.literal(BOARD_PROTO),
  /** When they were counted (the sender's clock). */
  at: z.number().int().min(0),
  days: z
    .record(z.string().regex(DAY_KEY), DayTuple)
    .refine((d) => Object.keys(d).length <= BOARD_DAYS + 7, 'Too many days'),
});
export type BoardFrame = z.infer<typeof BoardFrame>;

/** A frame as it came, or undefined when it doesn't fit. */
export function parseBoardFrame(raw: unknown): { readonly at: number; readonly days: BoardDays } | undefined {
  const parsed = BoardFrame.safeParse(raw);
  return parsed.success ? { at: parsed.data.at, days: parsed.data.days } : undefined;
}

export const boardFrame = (days: BoardDays, at: number): BoardFrame => ({ v: BOARD_PROTO, at, days: days as BoardFrame['days'] });
