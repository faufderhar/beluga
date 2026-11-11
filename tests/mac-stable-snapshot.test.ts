import { describe, expect, it } from 'vitest';
import { type Snapshot, readSnapshot, sameDeep } from '../packages/mac/src/lib/stable.js';

/**
 * A store read holds still while the store does (packages/mac/src/lib/stable.ts, BLG-905): React
 * reads a snapshot again and again and redraws for good when two reads of an unchanged store
 * differ. That froze the window grey when the bell's list was deeper than its compare could see.
 */

type State = { readonly items: ReadonlyArray<{ readonly a: { readonly b: { readonly c: { readonly d: { readonly e: { readonly f: { readonly g: number } } } } } } }> };
const state = (g: number): State => ({ items: [{ a: { b: { c: { d: { e: { f: { g } } } } } } }] });
const pick = (s: State): State["items"] => structuredClone(s.items);

describe('a store read that holds still', () => {
  it('reads the same value from the same state, even when the compare can never tell', () => {
    const s = state(1);
    // Deeper than sameDeep looks: it says "changed" every time.
    expect(sameDeep(pick(s), pick(s))).toBe(false);
    let last: Snapshot<State, ReturnType<typeof pick>> | undefined;
    const reads = Array.from({ length: 5 }, () => (last = readSnapshot(last, s, pick, sameDeep)).value);
    expect(new Set(reads).size).toBe(1);
  });

  it('with no compare at all, too', () => {
    const s = state(1);
    const first = readSnapshot(undefined, s, pick);
    expect(readSnapshot(first, s, pick).value).toBe(first.value);
  });

  it('keeps the last value when the compare finds a new state’s the same', () => {
    const first = readSnapshot(undefined, { n: 1, other: 'x' }, (s: { n: number; other: string }) => ({ n: s.n }), (a, b) => a.n === b.n);
    expect(readSnapshot(first, { n: 1, other: 'y' }, first.pick, (a, b) => a.n === b.n).value).toBe(first.value);
  });

  it('reads again for a new state or a new pick', () => {
    const first = readSnapshot(undefined, state(1), pick);
    const next = readSnapshot(first, state(2), pick);
    expect(next.value).not.toBe(first.value);
    expect(next.value[0]!.a.b.c.d.e.f.g).toBe(2);
    const other = (s: State) => s.items.length;
    expect(readSnapshot(next, next.state, other as never).value).toBe(1);
  });
});
