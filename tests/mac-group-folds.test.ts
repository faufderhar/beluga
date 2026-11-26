import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { foldedGroups, foldsToSave, readGroupFolds, renamedGroup, settleGroupFolds } from '../packages/mac/src/lib/group-folds.js';

/** A localStorage stand-in (the window's storage). */
function memory(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    writes: 0,
    getItem: (k: string) => map.get(k) ?? null,
    setItem(k: string, v: string) {
      this.writes += 1;
      map.set(k, v);
    },
  };
}

const KEY = 'beluga.groupFolds.v1';
const work = { name: 'Work', projects: ['/a', '/b'] };
const play = { name: 'Play', projects: ['/c'] };

/** The sidebar's folded groups, kept across launches (packages/mac/src/lib/group-folds.ts). */
describe('group folds', () => {
  it('reads back only a list of names', () => {
    expect(readGroupFolds('["Work","Play"]')).toEqual(['Work', 'Play']);
    expect(readGroupFolds('["Work","Work","",3,null]')).toEqual(['Work']);
    expect(readGroupFolds('{"Work":true}')).toEqual([]);
    expect(readGroupFolds('not json')).toEqual([]);
    expect(readGroupFolds(null)).toEqual([]);
  });

  it('picks the groups out of the other folds', () => {
    const collapsed = ['hidden-projects', 'group:Work', 'archive:p1', 'p1', 'group:', 'group:Play', 'group:Work'];
    expect(foldedGroups(collapsed)).toEqual(['Work', 'Play']);
  });

  it('saves the folded groups that still exist', () => {
    expect(foldsToSave(['group:Work', 'group:Gone', 'hidden-projects'], [work, play])).toEqual(['Work']);
  });

  it('tells a rename from a group that went or came', () => {
    expect(renamedGroup([work, play], [{ ...work, name: 'Jobs' }, play])).toEqual({ from: 'Work', to: 'Jobs' });
    expect(renamedGroup([work, play], [play])).toBeUndefined();
    expect(renamedGroup([play], [work, play])).toBeUndefined();
    expect(renamedGroup([work], [{ name: 'Jobs', projects: ['/z'] }])).toBeUndefined();
  });

  it('carries a fold to the renamed group and leaves the other folds alone', () => {
    const collapsed = ['hidden-projects', 'group:Work', 'p1'];
    expect(settleGroupFolds(collapsed, [work, play], [{ ...work, name: 'Jobs' }, play])).toEqual(['hidden-projects', 'group:Jobs', 'p1']);
  });

  it('drops the fold of a group that is gone', () => {
    expect(settleGroupFolds(['group:Work', 'group:Play', 'p1'], [work, play], [play])).toEqual(['group:Play', 'p1']);
  });

  it('gives the same list back when nothing changes', () => {
    const collapsed = ['group:Work', 'p1'];
    expect(settleGroupFolds(collapsed, [], [work, play])).toBe(collapsed);
    expect(settleGroupFolds(collapsed, [work, play], [work, play])).toBe(collapsed);
  });
});

describe('group folds in storage', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('starts with what was saved and writes only a change', async () => {
    const store = memory({ [KEY]: '["Work"]' });
    vi.stubGlobal('localStorage', store);
    const { loadGroupFolds, saveGroupFolds } = await import('../packages/mac/src/lib/group-folds.js');
    expect(loadGroupFolds()).toEqual(['group:Work']);
    saveGroupFolds(['Work']);
    expect(store.writes).toBe(0);
    saveGroupFolds(['Work', 'Play']);
    saveGroupFolds(['Work', 'Play']);
    expect(store.writes).toBe(1);
    expect(store.map.get(KEY)).toBe('["Work","Play"]');
  });

  it('does without storage', async () => {
    vi.stubGlobal('localStorage', undefined);
    const { loadGroupFolds, saveGroupFolds } = await import('../packages/mac/src/lib/group-folds.js');
    expect(loadGroupFolds()).toEqual([]);
    expect(() => saveGroupFolds(['Work'])).not.toThrow();
  });
});
