import { describe, expect, it } from 'vitest';
import { layoutGraph, segmentPath } from '../packages/mac/src/views/history/graph.js';
import { authorColor, branchChoices, commitPage, initials, pillsOf, timeAgo } from '../packages/mac/src/views/history/history-model.js';
import { defaultLineOf, mainLineOf } from '../packages/mac/src/views/project/home-model.js';
import type { ProjectSync } from '../src/workspaces/types.js';

/** The History view's graph and words (Mac), and the project home's line about main. */

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe('layoutGraph', () => {
  it('a straight line stays in one lane', () => {
    const g = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(g.width).toBe(1);
    expect(g.rows[0]!.segments).toEqual([{ from: 0, to: 0, fromY: 'mid', toY: 'bottom', color: 0 }]);
    expect(g.rows[1]!.segments).toEqual([
      { from: 0, to: 0, fromY: 'top', toY: 'mid', color: 0 },
      { from: 0, to: 0, fromY: 'mid', toY: 'bottom', color: 0 },
    ]);
    // The first commit ends the line.
    expect(g.rows[2]!.segments).toEqual([{ from: 0, to: 0, fromY: 'top', toY: 'mid', color: 0 }]);
  });

  it('a merge reaches over to a second lane, which joins back at the branch point', () => {
    // m merges f into main: m(b, f), b(a), f(a), a.
    const g = layoutGraph([c('m', 'b', 'f'), c('b', 'a'), c('f', 'a'), c('a')]);
    const [m, b, f, a] = g.rows;
    expect(m).toMatchObject({ lane: 0, merge: true });
    expect(m!.segments).toContainEqual({ from: 0, to: 1, fromY: 'mid', toY: 'bottom', color: 1 });
    expect(b!.lane).toBe(0);
    expect(b!.segments).toContainEqual({ from: 1, to: 1, fromY: 'top', toY: 'bottom', color: 1 });
    expect(f!.lane).toBe(1);
    expect(f!.color).toBe(1);
    // Both lanes wait for a: they meet at its node.
    expect(a!.lane).toBe(0);
    expect(a!.segments).toEqual([
      { from: 0, to: 0, fromY: 'top', toY: 'mid', color: 0 },
      { from: 1, to: 0, fromY: 'top', toY: 'mid', color: 1 },
    ]);
    expect(g.width).toBe(2);
  });

  it('separate branch tips get their own lanes and colors; freed lanes are reused', () => {
    const g = layoutGraph([c('x', 'a'), c('y', 'a'), c('a', 'r'), c('z', 'r'), c('r')]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 1, 0, 1, 0]);
    expect(new Set(g.rows.slice(0, 2).map((r) => r.color)).size).toBe(2);
    expect(g.rows[3]!.color).not.toBe(g.rows[1]!.color);
  });

  it('a parent not loaded yet (the next page) keeps its lane running to the bottom', () => {
    const g = layoutGraph([c('b', 'a')]);
    expect(g.rows[0]!.segments).toEqual([{ from: 0, to: 0, fromY: 'mid', toY: 'bottom', color: 0 }]);
  });

  it('draws straight lines and curves', () => {
    expect(segmentPath({ from: 0, to: 0, fromY: 'top', toY: 'bottom', color: 0 }, 30, 14, 10)).toBe('M10 0V30');
    expect(segmentPath({ from: 0, to: 1, fromY: 'mid', toY: 'bottom', color: 0 }, 30, 14, 10)).toBe('M10 15C10 22.5 24 22.5 24 30');
  });
});

describe('history words', () => {
  it('avatars: initials and a steady color, no network', () => {
    expect(initials('Mia Chen')).toBe('MC');
    expect(initials('kay')).toBe('K');
    expect(initials('dependabot[bot]')).toBe('D');
    expect(initials('jean-luc picard')).toBe('JP');
    expect(initials('')).toBe('?');
    expect(authorColor('Mia@Studio.dev')).toBe(authorColor('mia@studio.dev'));
  });

  it('times', () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    expect(timeAgo(now - 10_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(timeAgo(now - 30 * 3_600_000, now)).toBe('yesterday');
    expect(timeAgo(now - 4 * 86_400_000, now)).toBe('4 d ago');
    expect(timeAgo(now - 15 * 86_400_000, now)).toBe('2 wk ago');
    expect(timeAgo(Date.parse('2025-03-04T12:00:00Z'), now)).toMatch(/2025/);
  });

  it('pills: HEAD first, your worktrees highlighted, the upstream marked', () => {
    const wt = new Map([['klaud/add-auth', { id: 'w1', name: 'add-auth' }]]);
    const pills = pillsOf(
      [
        { name: 'v1', kind: 'tag' },
        { name: 'origin/main', kind: 'remote' },
        { name: 'main', kind: 'branch' },
        { name: 'HEAD', kind: 'head' },
        { name: 'klaud/add-auth', kind: 'branch' },
        { name: 'origin/feat', kind: 'remote' },
      ],
      { worktrees: wt, upstream: 'origin/main', current: 'main' },
    );
    expect(pills.map((p) => [p.label, p.tone])).toEqual([
      ['HEAD → main', 'head'],
      ['klaud/add-auth', 'worktree'],
      ['origin/main', 'upstream'],
      ['origin/feat', 'remote'],
      ['v1', 'tag'],
    ]);
    expect(pills[1]!.worktree).toEqual({ id: 'w1', name: 'add-auth' });
  });

  it('branch choices and GitHub commit pages', () => {
    const ch = branchChoices({ current: 'main', branches: ['main', 'feat/x'], remotes: ['origin/main'], tags: ['v1'] });
    expect(ch.all.map((x) => x.label)).toEqual(['All Branches', 'Current (main)']);
    expect(ch.local.map((x) => x.value)).toEqual(['main', 'feat/x']);
    expect(ch.remote.map((x) => x.value)).toEqual(['origin/main']);
    expect(commitPage('https://github.com/kay/app/', 'abc')).toBe('https://github.com/kay/app/commit/abc');
  });
});

describe('the project home’s line about the default branch', () => {
  const sync = (over: Partial<ProjectSync> = {}): ProjectSync => ({ branch: 'main', upstream: 'origin/main', remote: 'origin', local: true, ahead: 0, behind: 0, current: 'main', onDefault: true, dirty: 0, ...over });

  it('is about main, even when the folder is on another branch', () => {
    expect(defaultLineOf(sync())).toEqual({ label: 'Up to date with origin/main', tone: 'ok', branch: 'main' });
    expect(defaultLineOf(sync({ behind: 3, dirty: 1 }))).toEqual({ label: '3 behind origin/main', tone: 'info', canUpdate: true, branch: 'main', dirty: '1 uncommitted change in main' });
    expect(defaultLineOf(sync({ current: 'feat/panel-first', onDefault: false, behind: 59, dirty: 2 }))).toEqual({
      label: '59 behind origin/main',
      tone: 'info',
      canUpdate: true,
      branch: 'main',
      dirty: '2 uncommitted changes in the main folder',
      elsewhere: 'The main folder is on feat/panel-first',
    });
    expect(defaultLineOf(sync({ branch: 'master', upstream: 'origin/master', ahead: 2, behind: 1 }))).toMatchObject({ label: '2 commits not pushed · 1 behind origin/master', tone: 'info', canUpdate: true, canPush: true, branch: 'master' });
    expect(defaultLineOf(sync({ local: false, onDefault: false, current: 'dev' }))).toMatchObject({ label: 'Only on origin/main so far', canUpdate: true, elsewhere: 'The main folder is on dev' });
    expect(defaultLineOf(sync({ upstream: undefined }))).toMatchObject({ label: 'Not tracking a remote branch', tone: 'muted' });
    expect(defaultLineOf(sync({ current: undefined, onDefault: false })).elsewhere).toBe('The main folder is on a detached HEAD');
    expect(mainLineOf(undefined, sync({ behind: 1 })).canUpdate).toBe(true);
  });
});
