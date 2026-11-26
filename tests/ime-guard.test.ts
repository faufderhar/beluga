import { describe, expect, it } from 'vitest';
import { installImeGuard, swallowsImeEnter } from '../packages/mac/src/lib/ime-guard.js';

/** A target inside the terminal (xterm's helper textarea) or anywhere else. */
const inTerminal = { closest: (sel: string) => (sel === '.xterm' ? {} : null) };
const elsewhere = { closest: () => null };

describe('the IME guard on the window', () => {
  it('swallows Enter that picks an IME’s words: keyCode 229 (WebKit) or isComposing', () => {
    expect(swallowsImeEnter({ key: 'Enter', keyCode: 229, isComposing: false, target: elsewhere as never })).toBe(true);
    expect(swallowsImeEnter({ key: 'Enter', keyCode: 13, isComposing: true, target: elsewhere as never })).toBe(true);
  });

  it('swallows the other keys while composing too (Tab, arrows, Escape), as the boxes that checked for themselves did', () => {
    expect(swallowsImeEnter({ key: 'ArrowDown', keyCode: 229, isComposing: true, target: elsewhere as never })).toBe(true);
    expect(swallowsImeEnter({ key: 'Escape', keyCode: 229, target: elsewhere as never })).toBe(true);
    expect(swallowsImeEnter({ key: 'Tab', keyCode: 9, isComposing: true, target: elsewhere as never })).toBe(true);
  });

  it('leaves letters to the page even with keyCode 229 (shortcuts keep working)', () => {
    expect(swallowsImeEnter({ key: 'j', keyCode: 229, isComposing: false, target: elsewhere as never })).toBe(false);
    expect(swallowsImeEnter({ key: 'Backspace', keyCode: 229, isComposing: true, target: elsewhere as never })).toBe(false);
  });

  it('leaves plain keys to the boxes', () => {
    expect(swallowsImeEnter({ key: 'Enter', keyCode: 13, isComposing: false, target: elsewhere as never })).toBe(false);
    expect(swallowsImeEnter({ key: 'ArrowDown', keyCode: 40, isComposing: false, target: elsewhere as never })).toBe(false);
    expect(swallowsImeEnter({ key: 'Escape', keyCode: 27, target: elsewhere as never })).toBe(false);
  });

  it('leaves the terminal alone: xterm reads keyCode 229 itself', () => {
    expect(swallowsImeEnter({ key: 'Enter', keyCode: 229, target: inTerminal as never })).toBe(false);
    expect(swallowsImeEnter({ key: 'Enter', keyCode: 229, target: null })).toBe(true);
  });

  it('listens on the window in the capture phase and only stops propagation (never preventDefault)', () => {
    const added: Array<[string, (e: KeyboardEvent) => void, unknown]> = [];
    const removed: unknown[] = [];
    const off = installImeGuard({ addEventListener: (t: string, f: never, o: unknown) => void added.push([t, f, o]), removeEventListener: (_t: string, f: unknown) => void removed.push(f) } as never);
    expect(added).toHaveLength(1);
    const [type, guard, capture] = added[0]!;
    expect([type, capture]).toEqual(['keydown', true]);
    const calls: string[] = [];
    const ev = (keyCode: number) => ({ key: 'Enter', keyCode, isComposing: false, target: elsewhere, stopImmediatePropagation: () => calls.push(`stop:${keyCode}`), preventDefault: () => calls.push(`prevent:${keyCode}`) }) as unknown as KeyboardEvent;
    guard(ev(229));
    guard(ev(13));
    expect(calls).toEqual(['stop:229']);
    off();
    expect(removed).toEqual([guard]);
  });
});
