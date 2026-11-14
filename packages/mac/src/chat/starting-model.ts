/**
 * When "Claude is starting…" shows under a message you sent (flight.ts). It's drawn under your
 * message, so it waits until that message is in the chat and has landed: shown at Return, the line
 * came first and your message popped in above it once the daemon had it (BLG-949).
 */

export interface Starting {
  readonly channel: string;
  /** Claude cards in the conversation when you sent it: one more means Claude has started. */
  readonly cardsBefore: number;
  /** Your newest message there when you sent it: a newer one is the one you just sent. */
  readonly lastMineBefore: string | undefined;
  readonly at: number;
}

/** What the conversation shows now. */
export interface StartingNow {
  readonly channel: string;
  readonly cards: number;
  /** Your newest message in the conversation. */
  readonly lastMine: string | undefined;
  /** Your messages still flying into this conversation's chat. */
  readonly landing: number;
}

export function startingShows(s: Starting | undefined, now: StartingNow): boolean {
  if (!s || s.channel !== now.channel) return false;
  if (now.cards > s.cardsBefore) return false;
  return now.lastMine !== undefined && now.lastMine !== s.lastMineBefore && now.landing === 0;
}

interface Said {
  readonly type: string;
  readonly id: string;
  readonly from?: string;
}

/** The id of your newest message among a conversation's items. */
export function lastMineIn(items: readonly Said[], selfId: string): string | undefined {
  // Not findLast: the Mac app's lib is ES2022.
  for (let i = items.length - 1; i >= 0; i--) {
    const l = items[i]!;
    if (l.type === 'chat' && l.from === selfId) return l.id;
  }
  return undefined;
}
