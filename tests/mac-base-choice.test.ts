import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A localStorage stand-in (the window's storage). */
function memory(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const load = () => import('../packages/mac/src/chat/base-choice.js');

/** Based on is remembered per project for the next new worktree (BLG-1034, packages/mac/src/chat/base-choice.ts). */
describe('new worktree Based on, per project', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a pick per project, across a restart', async () => {
    vi.stubGlobal('localStorage', memory());
    const { rememberBase, baseChoice } = await load();
    expect(baseChoice('p1')).toBeUndefined();
    rememberBase('p1', 'origin/dev', 'origin/main');
    rememberBase('p2', 'origin/release', 'origin/main');
    vi.resetModules();
    const again = await load();
    expect(again.baseChoice('p1')).toBe('origin/dev');
    expect(again.baseChoice('p2')).toBe('origin/release');
    expect(again.baseChoice('p3')).toBeUndefined();
  });

  it('forgets the pick when the default is picked again', async () => {
    vi.stubGlobal('localStorage', memory());
    const { rememberBase, baseChoice } = await load();
    rememberBase('p1', 'origin/dev', 'origin/main');
    rememberBase('p1', 'origin/main', 'origin/main');
    expect(baseChoice('p1')).toBeUndefined();
  });

  it('ignores and prunes a branch that is gone', async () => {
    vi.stubGlobal('localStorage', memory());
    const { rememberBase, baseChoice, liveBaseChoice, pruneBaseChoice } = await load();
    rememberBase('p1', 'origin/old', 'origin/main');
    // Not known yet: shown as kept.
    expect(liveBaseChoice('p1', undefined)).toBe('origin/old');
    expect(liveBaseChoice('p1', ['origin/main', 'origin/old'])).toBe('origin/old');
    expect(liveBaseChoice('p1', ['origin/main'])).toBeUndefined();
    pruneBaseChoice('p1', ['origin/main', 'origin/dev']);
    expect(baseChoice('p1')).toBeUndefined();
  });

  it('stays bounded and survives bad storage', async () => {
    vi.stubGlobal('localStorage', memory({ 'beluga.worktreeBase': '{not json' }));
    const { rememberBase, baseChoice } = await load();
    expect(baseChoice('p1')).toBeUndefined();
    for (let i = 0; i < 120; i++) rememberBase(`p${i}`, 'origin/dev', 'origin/main');
    expect(baseChoice('p119')).toBe('origin/dev');
    expect(baseChoice('p0')).toBeUndefined();
  });
});
