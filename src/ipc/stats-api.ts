import { z } from 'zod';

/**
 * Your stats in the Usage tab (BLG-755, core/stats/): what the daemon counted, and what only the
 * Mac sees (pastes and dictation). Browser-safe: zod only.
 */

const Channel = z.string().max(200).optional();
/** A PNG of about 9 MB at most, as base64. */
const MAX_PNG_B64 = 12_000_000;

export const STATS_API = {
  // Everything counted, by day, project and agent, with pull requests → StatsSnapshot.
  'stats.get': { args: z.tuple([]) },
  // You and your friends on prompt characters, merged PRs and agent time, a day at a time → LeaderboardView (BLG-904).
  'stats.leaderboard': { args: z.tuple([]) },
  // You pasted text into the composer (its length only), or dictated for `ms`.
  'stats.note': {
    args: z.tuple([
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('paste'), chars: z.number().int().min(1).max(10_000_000), channel: Channel }).strict(),
        z.object({ kind: z.literal('dictation'), ms: z.number().int().min(1).max(3_600_000), channel: Channel }).strict(),
      ]),
    ]),
  },
  // Save the image of your stats the Mac made (a PNG, base64) where you chose in the Save panel.
  'stats.saveImage': { args: z.tuple([z.string().min(16).max(MAX_PNG_B64), z.string().min(2).max(1024)]) },
} as const;
