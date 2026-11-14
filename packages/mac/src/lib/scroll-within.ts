/**
 * Scroll a row or a line into view by moving only the list or page it scrolls in. The browser's
 * scrollIntoView also scrolls every clipped box around it, up to the window's own root, and a
 * box with `overflow: hidden` has no scrollbar to bring it back: the whole app ends up shifted
 * up under the title bar for good.
 */

export type Block = 'nearest' | 'center';

/**
 * The nearest box around `el` that scrolls up and down: overflow auto or scroll, with more to
 * show than it has room for (a code block's `overflow-x: auto` makes its y auto too, yet it never scrolls).
 */
export function scrollBox(el: HTMLElement): HTMLElement | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return undefined;
}

/** Where a box scrolled to `scrollTop` should go so the span [top, bottom) (relative to its view) shows. */
export function scrollTopFor(scrollTop: number, view: number, top: number, bottom: number, block: Block): number {
  if (block === 'center') return Math.max(0, scrollTop + top - (view - (bottom - top)) / 2);
  if (top < 0) return scrollTop + top;
  if (bottom > view) return scrollTop + Math.min(top, bottom - view);
  return scrollTop;
}

/** Bring `el` into view inside its own scrolling box only; nothing around that box moves. */
export function scrollWithin(el: Element | null | undefined, block: Block = 'nearest'): void {
  if (!(el instanceof HTMLElement)) return;
  const box = scrollBox(el);
  if (!box) return;
  const frame = box.getBoundingClientRect();
  const at = el.getBoundingClientRect();
  const top = scrollTopFor(box.scrollTop, box.clientHeight, at.top - frame.top - box.clientTop, at.bottom - frame.top - box.clientTop, block);
  if (top !== box.scrollTop) box.scrollTop = top;
}

/**
 * The window itself never scrolls: everything scrolls in its own list or page. When something
 * reaches past the window's bottom edge for a moment, a reveal (a focus, a caret, a line brought
 * into view) can still scroll the whole window, and `body { overflow: hidden }` leaves no way back:
 * the title bar slides out of sight. Whatever scrolls it, it goes straight back.
 */
export function pinWindow(win: Pick<Window, 'addEventListener' | 'scrollX' | 'scrollY' | 'scrollTo'> = window): void {
  win.addEventListener('scroll', () => {
    if (win.scrollX || win.scrollY) win.scrollTo(0, 0);
  });
}
