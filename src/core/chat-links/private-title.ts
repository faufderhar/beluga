import type { ChatOrigin } from '../../protocol.js';
import { parseChatRef } from '../../shared/chat-ref.js';

/**
 * A private chat's title stays private (BLG-305): a message from it into a chat you share shows
 * "a private chat" to the people there who cannot read the source chat.
 */

export const PRIVATE_TITLE = 'a private chat';

/** Who may read which chat, as the owner of the target chat knows it. */
export interface SourceReaders {
  readonly selfId: string;
  /** May `peer` see this channel of yours? */
  readonly canSee: (peer: string, channel: string) => boolean;
}

/** The origin as `viewer` sees it: the source's title only when they can read the source. */
export function originSeenBy(origin: ChatOrigin, viewer: string, readers: SourceReaders): ChatOrigin {
  return readsSource(origin, viewer, readers) ? origin : { ...origin, title: PRIVATE_TITLE };
}

/** The origin as everyone in a chat sees it: the source's title only when they all can read it. */
export function originSeenByAll(origin: ChatOrigin, viewers: readonly string[], readers: SourceReaders): ChatOrigin {
  return viewers.every((v) => readsSource(origin, v, readers)) ? origin : { ...origin, title: PRIVATE_TITLE };
}

function readsSource(origin: ChatOrigin, viewer: string, readers: SourceReaders): boolean {
  if (viewer === readers.selfId) return true;
  const ref = parseChatRef(origin.ref);
  if (!ref) return false;
  if (viewer === ref.owner) return true;
  return ref.owner === readers.selfId && readers.canSee(viewer, ref.channel);
}
