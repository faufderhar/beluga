import { z } from 'zod';

/**
 * A chat's address (shared/chat-ref.ts): what it is now, on this computer. Browser-safe.
 */

export const CHATS_API = {
  // A ref as text (`<owner>/<channel>`) → ResolvedChat (core/chat-links/resolve.ts); null for a malformed ref.
  'chats.resolve': { args: z.tuple([z.string().max(200)]) },
  // A ref of one of your own chats → ChatSnapshot (core/chat-links/transcript.ts): a copy to send with a message, after you say Share copy; null when it is not yours.
  'chats.snapshot': { args: z.tuple([z.string().max(400)]) },
} as const;
