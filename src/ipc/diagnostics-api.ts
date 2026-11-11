import { z } from 'zod';

/**
 * Problem reports (core/blackbox): the black box, the problems it froze and the end of the log,
 * redacted, in one file to attach to an issue. Only the Mac app makes one. Browser-safe: zod only.
 */

export const DIAGNOSTICS_API = {
  // Settings › About › Report a Problem: write a report into ~/.beluga/logs/reports and say where.
  'diagnostics.report': { args: z.tuple([]) },
  // The window couldn't load a part of itself (a code chunk that stalled or failed, #370): noted in the black box.
  'diagnostics.windowProblem': {
    args: z.tuple([
      z
        .object({
          kind: z.enum(['stalled', 'failed']),
          chunk: z.string().min(1).max(200),
          ms: z.number().min(0).max(86_400_000),
          message: z.string().max(1000),
        })
        .strict(),
    ]),
  },
  // A part of the window threw while drawing (BLG-905): what it was, its error and where it came from, noted in the black box.
  'diagnostics.windowCrash': {
    args: z.tuple([
      z
        .object({
          part: z.string().min(1).max(200),
          message: z.string().max(1000),
          stack: z.string().max(4000).optional(),
        })
        .strict(),
    ]),
  },
} as const;
