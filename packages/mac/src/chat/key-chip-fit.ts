// A key chip in the chat box (`$NAME`, BLG-965) is drawn over the room its words take: its icon and
// padding are wider than the "$" they stand in for, so a short name ran past its room and over the
// space after it ("$RTL_API_KEY and" read as "RTL_API_KEYand"). Measured after each layout: a name
// that doesn't fit is drawn a little smaller (--fit), so the chip ends just before its room does.
import { type RefObject, useLayoutEffect } from 'react';

/** Room left between the chip and the next word. */
const GAP_PX = 2;
/** Never smaller than this (of the chip's own size): past it a hair of overlap reads better than tiny text. */
const MIN_FIT = 0.74;

/** Fit every key chip in the layer to its room. */
function fitAll(layer: HTMLElement): void {
  for (const chip of layer.querySelectorAll<HTMLElement>('[data-key-chip]')) {
    const room = chip.parentElement?.firstElementChild;
    const name = chip.lastElementChild as HTMLElement | null;
    if (!room || !name || room === chip) continue;
    chip.style.removeProperty('--fit');
    const roomWidth = room.getBoundingClientRect().width;
    // Natural sizes: offsetWidth isn't touched by the grow-in animation's scale.
    const chipWidth = chip.offsetWidth;
    const nameWidth = name.scrollWidth;
    const fits = roomWidth - GAP_PX;
    if (chipWidth <= fits || nameWidth <= 0) continue;
    const fit = Math.max(MIN_FIT, (fits - (chipWidth - nameWidth)) / nameWidth);
    chip.style.setProperty('--fit', fit.toFixed(3));
  }
}

/** Keep the key chips in `layer` inside their rooms; again once web fonts have loaded. */
export function useKeyChipFit(layer: RefObject<HTMLElement | null>, pieces: unknown): void {
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el || !el.querySelector('[data-key-chip]')) return;
    fitAll(el);
    let live = true;
    void document.fonts?.ready.then(() => live && layer.current && fitAll(layer.current));
    return () => {
      live = false;
    };
  }, [layer, pieces]);
}
