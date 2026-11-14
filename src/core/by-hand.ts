import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A message you sent from a screen (the Mac app, the phone), told apart from what Beluga, your
 * agents or a Sentinel send on their own: a run you asked for uses Claude in Chrome as usual, any
 * other asks you first (agent/chrome.ts).
 *
 * The mark is narrow on purpose, so nothing your action sets going later inherits it: it is good
 * for one request to your own agent, carrying the words you sent, within a few minutes (a new
 * worktree's folder is made first). Missing it only means one more question, never a silent use.
 */

interface Hand {
  readonly text: string;
  readonly until: number;
}

/** Long enough for git to make a new worktree's folder before its first message goes. */
export const HAND_MS = 5 * 60_000;

const hand = new AsyncLocalStorage<Hand>();
const spent = new WeakSet<Hand>();

const plain = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Run a screen's send action as yours, with the words you sent. */
export const byYourHand = <T>(text: string, work: () => T, now: number = Date.now()): T => hand.run({ text: plain(text), until: now + HAND_MS }, work);

/** For a run itself: nothing it does (a thread it starts, a message it sends on) is ever yours by hand. */
export const outsideYourHand = <T>(work: () => T): T => hand.exit(work);

/**
 * Whether the request now being sent to your own agent is the one you sent: its words are in
 * yours (or yours in its: "@claude fix it" asks "fix it"; a command wraps what you typed). Once only.
 */
export function takeYourHand(prompt: string, now: number = Date.now()): boolean {
  const mark = hand.getStore();
  if (!mark || spent.has(mark) || now > mark.until) return false;
  const asked = plain(prompt);
  if (!asked || !mark.text || !(mark.text.includes(asked) || asked.includes(mark.text))) return false;
  spent.add(mark);
  return true;
}
