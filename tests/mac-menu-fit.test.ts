import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Mac app's own tsc checks these modules
const { fitSide } = (await import('../packages/mac/src/components/SpecMenu.js' as string)) as any;

/** Menus show whole (packages/mac/src/components/SpecMenu.tsx): the side a dropdown opens on. */
describe('where a dropdown opens', () => {
  const view = { width: 1200, height: 800 };
  const button = (top: number, left = 200) => ({ top, bottom: top + 24, left, right: left + 24 });

  it('opens below when it fits there', () => expect(fitSide(button(100), 400, view)).toBe('bottom'));
  it('opens above when only that fits', () => expect(fitSide(button(600), 400, view)).toBe('top'));
  it('opens beside, on the roomier side, when neither fits', () => {
    expect(fitSide(button(380, 200), 600, view)).toBe('right');
    expect(fitSide(button(380, 1000), 600, view)).toBe('left');
  });
});

