import { describe, expect, it } from 'vitest';
import { placeBar, skipsBar, worthABar, SKIP_SELECTOR } from '../packages/mac/src/lib/selection-bar.js';

const viewport = { width: 1200, height: 800 };
const bar = { width: 200, height: 32 };

describe('the bar beside selected text', () => {
  it('sits just above the selection, centred on where the pointer let go', () => {
    const at = placeBar({ left: 300, top: 400, right: 700, bottom: 420 }, 600, bar, viewport);
    expect(at).toEqual({ left: 500, top: 400 - 8 - 32, below: false });
  });

  it('goes under the selection when there is no room above it', () => {
    const at = placeBar({ left: 300, top: 20, right: 700, bottom: 40 }, 500, bar, viewport);
    expect(at.below).toBe(true);
    expect(at.top).toBe(48);
  });

  it('stays inside the window at either edge', () => {
    expect(placeBar({ left: 0, top: 400, right: 50, bottom: 420 }, 10, bar, viewport).left).toBe(8);
    expect(placeBar({ left: 1100, top: 400, right: 1195, bottom: 420 }, 1195, bar, viewport).left).toBe(1200 - 200 - 8);
    // A selection filling the window: under it would leave the window, so it keeps to the bottom edge.
    expect(placeBar({ left: 0, top: 0, right: 1200, bottom: 800 }, 600, bar, viewport).top).toBe(800 - 32 - 8);
  });

  it('needs real text, not a click or a lone space', () => {
    expect(worthABar('')).toBe(false);
    expect(worthABar(' a ')).toBe(false);
    expect(worthABar('ok')).toBe(true);
    expect(worthABar('a whole sentence')).toBe(true);
  });

  it('leaves fields, terminals, menus and opted-out places alone', () => {
    const inside = (match: string | undefined) => ({ closest: (sel: string) => (match && sel === SKIP_SELECTOR ? {} : null) });
    expect(skipsBar(inside('textarea'))).toBe(true);
    expect(skipsBar(inside(undefined))).toBe(false);
    expect(skipsBar(null)).toBe(true);
    for (const part of ['input', 'textarea', '.xterm', '[role="menu"]', '[data-no-selection-bar]']) expect(SKIP_SELECTOR).toContain(part);
  });
});
