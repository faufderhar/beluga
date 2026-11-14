/**
 * The bar that pops up beside text you select (BLG-917): where it goes, and where it doesn't
 * belong. Kept apart from the component so it can be tested without a window.
 */

/** A box on screen, in the window's pixels. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Placement {
  readonly left: number;
  readonly top: number;
  /** Under the selection (no room above it). */
  readonly below: boolean;
}

/** The gap between the selection and the bar, and how close it may come to the window's edge. */
const GAP = 8;
const MARGIN = 8;

/** Fewer characters than this is a stray click, not a selection. */
const MIN_CHARS = 2;

/**
 * Where the bar goes: centred on where the pointer let go, just above the selection, or just
 * under it when there's no room above. Always inside the window.
 */
export function placeBar(selection: Box, pointerX: number, bar: Size, viewport: Size): Placement {
  const maxLeft = Math.max(MARGIN, viewport.width - bar.width - MARGIN);
  const left = Math.min(maxLeft, Math.max(MARGIN, Math.round(pointerX - bar.width / 2)));
  const above = selection.top - GAP - bar.height;
  if (above >= MARGIN) return { left, top: Math.round(above), below: false };
  const under = Math.min(viewport.height - bar.height - MARGIN, selection.bottom + GAP);
  return { left, top: Math.round(Math.max(MARGIN, under)), below: true };
}

/** What a selection needs to be for the bar: some real text, not a click or a lone space. */
export function worthABar(text: string): boolean {
  return text.trim().length >= MIN_CHARS;
}

/** Something that can look up its ancestors (an element). */
export interface Closest {
  closest(selector: string): unknown;
}

/**
 * Places that keep their own selection handling: what you type into (fields, the composer,
 * the file editor), terminals, open menus and dialogs' own text fields, and anything that opts
 * out with data-no-selection-bar.
 */
export const SKIP_SELECTOR = ['input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])', '.xterm', '[role="menu"]', '[data-no-selection-bar]'].join(', ');

export function skipsBar(el: Closest | null | undefined): boolean {
  return !el || el.closest(SKIP_SELECTOR) != null;
}
