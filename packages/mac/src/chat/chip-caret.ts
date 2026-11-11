/**
 * A chip in the message box (a pasted image, a worktree's link) is drawn over words the box still
 * holds, see-through. Those words are one piece: the caret never stops inside them, a selection
 * that cuts into them takes all of them, and Backspace or Delete next to one takes it whole (BLG-887).
 * Pure: use-chip-caret.ts applies it to the box.
 */

/** Where a chip's words are in the box's text. */
export interface ChipSpan {
  readonly start: number;
  readonly end: number;
}

/** A selection in the box: where it began, and the end that moves. */
export interface BoxSelection {
  readonly anchor: number;
  readonly focus: number;
}

const inside = (spans: readonly ChipSpan[], at: number): ChipSpan | undefined => spans.find((s) => s.start < at && at < s.end);

const nearest = (s: ChipSpan, at: number): number => (at - s.start <= s.end - at ? s.start : s.end);

/**
 * The selection moved off the inside of any chip. `from`: where its moving end was before (a key
 * moved it): it goes on past the chip in the way it was going. Without it (a click), a caret goes
 * to the chip's nearer edge and a selection grows to take the whole chip.
 */
export function snapToChips(spans: readonly ChipSpan[], sel: BoxSelection, from?: number): BoxSelection {
  if (!spans.length) return sel;
  const going = from === undefined || from === sel.focus ? 0 : Math.sign(sel.focus - from);
  const f = inside(spans, sel.focus);
  if (sel.anchor === sel.focus) {
    if (!f) return sel;
    const at = going > 0 ? f.end : going < 0 ? f.start : nearest(f, sel.focus);
    return { anchor: at, focus: at };
  }
  const forward = sel.focus > sel.anchor;
  const a = inside(spans, sel.anchor);
  const anchor = a ? (forward ? a.start : a.end) : sel.anchor;
  const focus = f ? (going > 0 ? f.end : going < 0 ? f.start : forward ? f.end : f.start) : sel.focus;
  return { anchor, focus };
}

/**
 * What Backspace or Delete should take when the caret is at a chip's edge: the chip's words (the
 * box then deletes them as it would any selection, so ⌘Z brings them back). Undefined: as usual.
 */
export function chipToDelete(spans: readonly ChipSpan[], start: number, end: number, key: 'Backspace' | 'Delete'): ChipSpan | undefined {
  if (start !== end) return undefined;
  return spans.find((s) => (key === 'Backspace' ? s.start < start && start <= s.end : s.start <= start && start < s.end));
}

/** The selection as the box keeps it (start before end, and which way it runs). */
export function boxRange(sel: BoxSelection): { start: number; end: number; direction: 'forward' | 'backward' } {
  return sel.focus < sel.anchor ? { start: sel.focus, end: sel.anchor, direction: 'backward' } : { start: sel.anchor, end: sel.focus, direction: 'forward' };
}
