import { z } from 'zod';

/**
 * Supporting Beluga (see core/support-store.ts): answering the ask that came with a merge, a star
 * on GitHub after the third. The count and whether it's due are in the shared state's `support`.
 * Only the Mac app shows it. Browser-safe: zod only.
 */

export const SUPPORT_API = {
  // You answered the ask: yes (opened GitHub to star it), later (Maybe Later, or closed it), never (old screens' Don't Ask Again).
  'support.answer': { args: z.tuple([z.enum(['star']), z.enum(['yes', 'later', 'never'])]) },
} as const;
