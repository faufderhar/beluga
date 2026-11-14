/**
 * A graph this big (a busy board, BLG-931) draws only what's in view, and lighter as you zoom out:
 * below LIGHT_BELOW its cards drop their soft shadow and inner hairlines and their status stops
 * pulsing. They're too small to see there, and with hundreds of cards in view they made every frame
 * of a pan or a pinch slow in WebKit. Above it, nothing changes.
 */
export const BUSY_FROM = 80;
export const LIGHT_BELOW = 0.6;

export type Detail = 'full' | 'light';

/** How much a graph of `nodes` draws at `zoom` (the canvas's data-detail): nothing to say for a small one. */
export function detailAt(nodes: number, zoom: number): Detail | undefined {
  if (nodes < BUSY_FROM) return undefined;
  return zoom < LIGHT_BELOW ? 'light' : 'full';
}
