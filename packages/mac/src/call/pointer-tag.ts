/**
 * The tag beside someone's pointer over a shared screen (BLG-912): their face always, their name
 * only while they're doing something. A click, or moving off after a rest, opens it; resting a
 * moment folds it back into the face. A pointer at rest jitters a little (a hand on the mouse), so
 * once folded it takes a real move to open again. Pure: times are performance.now, spots are
 * fractions of the picture.
 */

export interface PointerTag {
  /** When they last did something that keeps the name open (ms). */
  readonly at: number;
  /** Where the pointer was when that happened: a fold is undone by moving clearly away from it. */
  readonly x: number;
  readonly y: number;
  /** When they last clicked (ms), for the face's little pop. */
  readonly clickAt?: number;
}

/** The name folds away after this long without a click or a move. */
export const TAG_IDLE_MS = 1_500;
/** Folded, it opens again only for a move this far (a fraction of the picture's diagonal-ish span). */
export const TAG_WAKE_MOVE = 0.015;

/** A new pointer: open, here. */
export const newTag = (x: number, y: number, now: number): PointerTag => ({ at: now, x, y });

/** Whether the name shows now. */
export const tagOpen = (t: PointerTag, now: number): boolean => now - t.at < TAG_IDLE_MS;

/** Open, a move smaller than this isn't one: the same spot sent again keeps nothing open. */
export const TAG_STILL_MOVE = 0.002;

/** The pointer is at `x`, `y` now. Open: moving keeps it open. Folded: only a clear move opens it. */
export function tagMoved(t: PointerTag, x: number, y: number, now: number): PointerTag {
  if (Math.hypot(x - t.x, y - t.y) < (tagOpen(t, now) ? TAG_STILL_MOVE : TAG_WAKE_MOVE)) return t;
  return { ...t, at: now, x, y };
}

/** They clicked (where they are): the name opens and the face pops. */
export const tagClicked = (t: PointerTag, now: number): PointerTag => ({ ...t, at: Math.max(t.at, now), clickAt: now });
