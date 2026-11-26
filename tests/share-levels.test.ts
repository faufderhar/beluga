import { describe, expect, it } from 'vitest';
import { grantOfLevel, levelOf, levelsFor, mayFork } from '../src/shared/share-levels.js';

/** BLG-1019: one ladder of what a friend can do, over a role and a fork grant. */
describe('share levels', () => {
  it('round-trips each level through its grant', () => {
    for (const l of ['view', 'contribute', 'fork', 'secrets'] as const) {
      const g = grantOfLevel(l);
      expect(levelOf(g.role, g.fork === 'none' ? undefined : g.fork)).toBe(l);
    }
    // Following along never forks, whatever an old grant says.
    expect(levelOf('view', 'secrets')).toBe('view');
  });

  it('offers forks only where there is something to fork', () => {
    expect(levelsFor(false).map((l) => l.label)).toEqual(['Can see', 'Can chat']);
    expect(levelsFor(true).map((l) => l.label)).toEqual(['Can see', 'Can chat', 'Can fork', 'Can fork with secrets']);
  });

  it('a friend may fork when the owner said so, or (an older owner’s Mac) when they work there', () => {
    expect(mayFork({ role: 'contribute', forks: 'none' })).toBe(false);
    expect(mayFork({ role: 'contribute', forks: 'code' })).toBe(true);
    expect(mayFork({ role: 'contribute' })).toBe(true);
    expect(mayFork({ role: 'view' })).toBe(false);
  });
});
