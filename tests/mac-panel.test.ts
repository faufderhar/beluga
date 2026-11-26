import { describe, expect, it } from 'vitest';
import type { View } from '../src/core/store.js';
import {
  DRAWER_MAX,
  PANEL_MIN,
  REMEMBERED_LAYOUTS,
  REMEMBERED_TABS,
  SHOWN_MAX,
  clampPanelWidth,
  clampShare,
  drawerFits,
  DEFAULT_LAYOUT,
  centerKey,
  centerSlots,
  homeGroup,
  layoutKey,
  normalizeLayout,
  viewsOf,
  migratePrefs,
  panelDigit,
  panelKey,
  panelFits,
  panelTabsFor,
  placeInCenter,
  rememberLayout,
  rememberShown,
  shownIn,
  slotsFor,
  splitsSideways,
  startGroups,
  terminalUnderChat,
  usableLayout,
} from '../packages/mac/src/lib/panel-model.js';
import { ancestorsOf, foundRows, nameRanges, treeRows, type Entry } from '../packages/mac/src/layout/panel/tree.js';

const ws: View = { kind: 'workspace', id: 'w1', tab: 'chat' };
const room: View = { kind: 'room' };

describe('the right panel’s dock', () => {
  it('starts with what Claude made on top and what runs below; History is Changes’ second view', () => {
    const all = panelTabsFor(ws, 'worktree');
    expect(slotsFor(all)).toEqual(['changes', 'files', 'scratch', 'info', 'terminal', 'background']);
    expect(startGroups(slotsFor(all))).toEqual({ top: ['changes', 'files', 'scratch', 'info'], bottom: ['terminal', 'background'] });
    expect(viewsOf('changes', all)).toEqual(['changes', 'history']);
    expect(viewsOf('history', all)).toEqual(['changes', 'history']);
    // A project's home has History in Changes' place (and its main folder's Files); a chat has no Changes at all.
    const project = panelTabsFor({ kind: 'project', id: 'p' });
    expect(startGroups(slotsFor(project))).toEqual({ top: ['changes', 'files', 'info'], bottom: ['terminal'] });
    expect(viewsOf('changes', project)).toEqual(['history']);
    expect(startGroups(slotsFor(panelTabsFor(ws, 'chat'))).top).toEqual(['files', 'scratch', 'info']);
    // Nothing for the top: what runs is the only group.
    expect(startGroups(['terminal'])).toEqual({ top: ['terminal'], bottom: [] });
  });

  it('the two panes you had before the dock are how it starts', () => {
    const yours = normalizeLayout({ top: ['files', 'terminal'], bottom: ['info', 'changes'] });
    expect(startGroups(slotsFor(panelTabsFor(ws, 'worktree')), yours)).toEqual({ top: ['files', 'terminal', 'scratch'], bottom: ['info', 'changes', 'background'] });
  });

  it('a saved start layout is made whole: every tab once, nothing unknown', () => {
    expect(normalizeLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout({ top: ['terminal', 'nope', 'terminal'], bottom: ['terminal', 'files'] })).toEqual({ top: ['terminal', 'changes', 'scratch', 'info', 'phone'], bottom: ['files', 'background'] });
  });

  it('views with the same tabs share one arrangement', () => {
    expect(layoutKey(panelTabsFor(ws, 'worktree'))).toBe('changes+files+scratch+info+terminal+background');
    expect(layoutKey(panelTabsFor(ws, 'main'))).toBe(layoutKey(panelTabsFor(ws, 'worktree')));
    expect(layoutKey(panelTabsFor(room))).toBe(layoutKey(panelTabsFor({ kind: 'overview' })));
    expect(layoutKey(panelTabsFor(ws, 'chat'))).not.toBe(layoutKey(panelTabsFor(ws, 'worktree')));
    // History is in Changes' place: a project's page has that place too.
    expect(layoutKey(panelTabsFor({ kind: 'project', id: 'p' }))).toBe('changes+files+info+terminal');
  });

  it('a tab that joins later goes beside the tabs it starts with, or gets a group of its own', () => {
    // Scratch (turned on in Settings) joins the group with Changes and Info, wherever you put it.
    expect(homeGroup('scratch', [['terminal', 'background'], ['changes', 'files', 'info']])).toBe(1);
    expect(homeGroup('background', [['changes', 'terminal'], ['files']])).toBe(0);
    // No tab it starts beside is in the dock: a group of its own.
    expect(homeGroup('terminal', [['changes', 'files']])).toBe(-1);
  });

  it('each group shows the tab you showed last there, else Changes when there are changes, else Info', () => {
    const all = panelTabsFor(ws, 'worktree');
    const top = ['changes', 'files', 'scratch', 'info'] as const;
    const bottom = ['terminal', 'background'] as const;
    expect(shownIn(top, [], all, true)).toBe('changes');
    expect(shownIn(top, [], all, false)).toBe('info');
    expect(shownIn(bottom, [], all, true)).toBe('terminal');
    // What you showed last, group by group: the latest of each group's own tabs.
    const recent = ['files', 'background', 'scratch'] as const;
    expect(shownIn(top, recent, all, true)).toBe('scratch');
    expect(shownIn(bottom, recent, all, true)).toBe('background');
    // Moved together, the latest of them all shows.
    expect(shownIn([...top, ...bottom], recent, all, true)).toBe('scratch');
    // History is Changes' second view: remembered as itself, shown in Changes' place.
    expect(shownIn(top, ['files', 'history'], all, false)).toBe('history');
    expect(shownIn(['changes'], ['history'], all, false)).toBe('history');
    expect(shownIn(['changes'], [], all, false)).toBe('changes');
    // A remembered tab the view doesn't have is passed over (a chat has no Changes; a project's page only History).
    expect(shownIn(['changes', 'files', 'info'], ['changes'], panelTabsFor({ kind: 'project', id: 'p' }), true)).toBe('info');
    expect(shownIn(['changes'], ['changes'], panelTabsFor({ kind: 'project', id: 'p' }), true)).toBe('history');
  });

  it('remembers the tabs you showed per workspace, one list for the rest, and forgets the oldest', () => {
    expect(panelKey(ws)).toBe('ws:w1');
    expect(panelKey(room)).toBe('app');
    let map = {};
    for (let i = 0; i < REMEMBERED_TABS + 5; i++) map = rememberShown(map, `ws:${i}`, 'files');
    expect(Object.keys(map)).toHaveLength(REMEMBERED_TABS);
    expect(map).not.toHaveProperty('ws:0');
    expect(Object.keys(rememberShown(map, 'ws:3', 'info')).pop()).toBe('ws:3');
    // The latest last, each tab once; Changes and History are one place.
    let shown = rememberShown({}, 'ws:a', 'files');
    shown = rememberShown(shown, 'ws:a', 'changes');
    shown = rememberShown(shown, 'ws:a', 'files');
    expect(shown['ws:a']).toEqual(['changes', 'files']);
    expect(rememberShown(shown, 'ws:a', 'history')['ws:a']).toEqual(['files', 'history']);
    for (const t of ['changes', 'files', 'terminal', 'info', 'scratch', 'background', 'phone', 'history'] as const) shown = rememberShown(shown, 'ws:a', t);
    expect(shown['ws:a']!.length).toBeLessThanOrEqual(SHOWN_MAX);
  });

  it('keeps an arrangement per set of tabs, the oldest forgotten, and only ones Dockview can read', () => {
    const layout = { grid: { root: { type: 'branch', data: [] }, width: 384, height: 800, orientation: 'VERTICAL' }, panels: { changes: { id: 'changes' }, terminal: { id: 'terminal' } } };
    expect(usableLayout(layout)).toBe(true);
    expect(usableLayout(undefined)).toBe(false);
    expect(usableLayout({ top: ['changes'], bottom: [] })).toBe(false);
    expect(usableLayout({ ...layout, panels: {} })).toBe(false);
    expect(usableLayout({ ...layout, panels: { nope: { id: 'nope' } } })).toBe(false);
    let map: Record<string, unknown> = {};
    for (let i = 0; i < REMEMBERED_LAYOUTS + 3; i++) map = rememberLayout(map, `k${i}`, layout);
    expect(Object.keys(map)).toHaveLength(REMEMBERED_LAYOUTS);
    expect(map).not.toHaveProperty('k0');
    expect(Object.keys(rememberLayout(map, 'k5', layout)).pop()).toBe('k5');
  });
});

describe('the center’s dock: the chat, and the tabs you put beside it', () => {
  const all = panelTabsFor(ws, 'worktree');
  const key = 'changes+files+scratch+info+terminal+background';

  it('a tab is in the panel until you move it beside the chat, per set of tabs', () => {
    expect(centerSlots({}, key, slotsFor(all))).toEqual([]);
    let map = placeInCenter({}, key, 'files', true);
    map = placeInCenter(map, key, 'terminal', true);
    map = placeInCenter(map, key, 'files', true);
    expect(map[key]).toEqual(['terminal', 'files']);
    // In the dock's own order, and only tabs this view has (a chat has no Changes).
    expect(centerSlots(map, key, slotsFor(all))).toEqual(['files', 'terminal']);
    expect(centerSlots(map, key, ['terminal', 'info'])).toEqual(['terminal']);
    expect(centerSlots(map, 'info+terminal', ['terminal', 'info'])).toEqual([]);
    // Back in the panel; with none left the set is forgotten.
    map = placeInCenter(map, key, 'files', false);
    expect(map[key]).toEqual(['terminal']);
    expect(placeInCenter(map, key, 'terminal', false)).toEqual({});
  });

  it('beside the chat, the chat shows until you pick a tab, and again when you pick it back', () => {
    expect(shownIn(['main', 'files'], [], all, true)).toBe('main');
    expect(shownIn(['main', 'files'], ['files'], all, true)).toBe('files');
    expect(shownIn(['main', 'files'], ['files', 'main'], all, true)).toBe('main');
    // A group of its own beside the chat shows its own tabs as ever.
    expect(shownIn(['files', 'terminal'], ['main'], all, false)).toBe('files');
    expect(rememberShown({ 'ws:a': ['files', 'main'] }, 'ws:a', 'files')['ws:a']).toEqual(['main', 'files']);
  });

  it('its arrangement is kept beside the panel’s, and may hold the chat', () => {
    expect(centerKey(key)).toBe(`center:${key}`);
    const layout = { grid: { root: { type: 'branch', data: [] }, width: 800, height: 800, orientation: 'HORIZONTAL' }, panels: { main: { id: 'main' }, files: { id: 'files' } } };
    expect(usableLayout(layout)).toBe(true);
  });
});

describe('the right panel’s tabs', () => {
  it('a plan’s page has no panel: its chat is its right side', () => {
    expect(panelFits({ kind: 'plan', id: 'p1' })).toBe(false);
    expect(panelTabsFor({ kind: 'plan', id: 'p1' })).toEqual([]);
    expect(panelFits(ws)).toBe(true);
  });
  it('the Tasks board, a task’s page and the plans have the whole window', () => {
    expect(panelFits({ kind: 'task', id: 't1' })).toBe(false);
    expect(panelFits({ kind: 'plans' })).toBe(false);
    // Usage is a page of its own to look at: the whole window (BLG-759).
    expect(panelFits({ kind: 'usage' })).toBe(false);
    expect(panelTabsFor({ kind: 'task', id: 't1' })).toEqual([]);
    expect(panelFits({ kind: 'tasks' })).toBe(false);
    expect(panelTabsFor({ kind: 'tasks' })).toEqual([]);
  });
  it('a workspace has every tab; a chat has no Changes; a friend’s workspace Info and its Scratch; the Terminal view only Info', () => {
    expect(panelTabsFor(ws, 'worktree')).toEqual(['changes', 'files', 'terminal', 'info', 'history', 'scratch', 'background']);
    expect(panelTabsFor({ kind: 'project', id: 'p' })).toEqual(['files', 'terminal', 'info', 'history']);
    expect(panelTabsFor(ws, 'chat')).toEqual(['files', 'terminal', 'info', 'scratch', 'background']);
    expect(panelTabsFor({ kind: 'shared', owner: 'o', id: 'x', tab: 'chat' })).toEqual(['info', 'scratch']);
    expect(panelTabsFor({ kind: 'terminal' })).toEqual(['info']);
    expect(panelTabsFor(room)).toEqual(['terminal', 'info']);
  });
  it('with a phone paired, its mirror is a tab beside Your Mac only, never a project’s chat, the Phone page or a plan', () => {
    expect(panelTabsFor(ws, 'worktree', true)).not.toContain('phone');
    expect(panelTabsFor(ws, 'chat', true)).not.toContain('phone');
    expect(panelTabsFor(room, undefined, true)).not.toContain('phone');
    expect(panelTabsFor({ kind: 'assistant' }, undefined, true)).toEqual(['terminal', 'info', 'scratch', 'phone']);
    expect(panelTabsFor({ kind: 'assistant' })).toEqual(['terminal', 'info', 'scratch']);
    expect(panelTabsFor({ kind: 'phone' }, undefined, true)).toEqual(['terminal', 'info']);
    expect(panelTabsFor({ kind: 'plan', id: 'p1' }, undefined, true)).toEqual([]);
    expect(startGroups(slotsFor(panelTabsFor({ kind: 'assistant' }, undefined, true))).top).toEqual(['scratch', 'info', 'phone']);
  });

  it('has fixed ⌥⌘ digits', () => {
    expect(['changes', 'files', 'terminal', 'info', 'history', 'scratch', 'background'].map((t) => panelDigit(t as 'changes'))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('is never narrower than the minimum nor wider than 60% of the window, and leaves the center its room', () => {
    expect(clampPanelWidth(100, 1440)).toBe(PANEL_MIN);
    // A wide window: 60% of it.
    expect(clampPanelWidth(4000, 2560)).toBe(1536);
    // Narrower: the center keeps its 480 (CENTER_MIN) first, beside the sidebar too.
    expect(clampPanelWidth(2000, 1440)).toBe(864);
    expect(clampPanelWidth(2000, 1440, 240)).toBe(720);
    expect(clampPanelWidth(2000, 1280, 248)).toBe(552);
    expect(clampPanelWidth(400, 1440)).toBe(400);
    // A tiny window still gets the minimum.
    expect(clampPanelWidth(400, 400)).toBe(PANEL_MIN);
    expect(clampShare(Number.NaN, 0.2, 0.7)).toBe(0.2);
  });

  it('the terminal is under the chat where you keep it there, and wherever the panel has no Terminal tab', () => {
    const tabs = panelTabsFor(ws, 'worktree');
    expect(terminalUnderChat('panel', tabs, ws)).toBe(false);
    expect(terminalUnderChat('drawer', tabs, ws)).toBe(true);
    // The Tasks board has no panel: ⌘J still opens a terminal under it.
    expect(terminalUnderChat('panel', panelTabsFor({ kind: 'tasks' }), { kind: 'tasks' })).toBe(true);
    // Never over the Terminal view or a friend's workspace.
    expect(terminalUnderChat('drawer', panelTabsFor({ kind: 'terminal' }), { kind: 'terminal' })).toBe(false);
    expect(terminalUnderChat('drawer', ['info', 'scratch'], { kind: 'shared', owner: 'o', id: 'x', tab: 'chat' })).toBe(false);
  });

  it('a list and what you picked in it: the preview under the list in a narrow tab, beside it with room for both', () => {
    expect(splitsSideways(384)).toBe(false);
    expect(splitsSideways(559)).toBe(false);
    expect(splitsSideways(560)).toBe(true);
    expect(splitsSideways(0)).toBe(false);
  });

  it('the drawer goes under anything but the Terminal view and a friend’s workspace', () => {
    expect(drawerFits(ws)).toBe(true);
    expect(drawerFits(room)).toBe(true);
    expect(drawerFits({ kind: 'terminal' })).toBe(false);
    expect(drawerFits({ kind: 'shared', owner: 'o', id: 'x', tab: 'chat' })).toBe(false);
  });
});

describe('preferences from earlier versions', () => {
  it('a terminal docked beside the chat becomes the panel’s Terminal tab', () => {
    expect(migratePrefs({ dock: 'right', dockSize: 0.5, sidebar: true })).toEqual({ termIn: 'panel', drawerSize: 0.5, sidebar: true });
  });

  it('one docked under the chat becomes the open drawer at the same height', () => {
    expect(migratePrefs({ dock: 'bottom', dockSize: 0.9 })).toEqual({ termIn: 'drawer', drawer: true, drawerSize: DRAWER_MAX });
  });

  it('a closed dock keeps the defaults, and new preferences are left alone', () => {
    expect(migratePrefs({ dock: 'off', dockSize: 0.42 })).toEqual({ drawerSize: 0.42 });
    const current = { termIn: 'drawer', drawer: false };
    expect(migratePrefs(current)).toBe(current);
  });

  it('the tab each of the two panes remembered is what its place shows in the dock', () => {
    const before = { panelTabs: { 'ws:a': 'files', 'ws:a|bottom': 'background', app: 'info', 'ws:b|bottom': 'nope' }, sidebar: true };
    expect(migratePrefs(before)).toEqual({ sidebar: true, panelShown: { 'ws:a': ['files', 'background'], app: ['info'] } });
    // Already brought over: what's remembered now stays.
    expect(migratePrefs({ panelTabs: { app: 'info' }, panelShown: { app: ['files'] } })).toEqual({ panelShown: { app: ['files'] } });
  });
});

describe('the Files tab’s tree', () => {
  const fs: Record<string, Entry[]> = {
    '': [
      { name: 'src', dir: true },
      { name: 'node_modules', dir: true },
      { name: 'README.md', dir: false, size: 10 },
    ],
    src: [
      { name: 'lib', dir: true },
      { name: 'server.ts', dir: false, size: 5 },
    ],
    'src/lib': [{ name: 'auth.ts', dir: false }],
    node_modules: [{ name: 'server-thing', dir: true }],
  };
  it('shows opened folders under their parent, with a loading row for one on its way', () => {
    const rows = treeRows((p) => (p === 'src/lib' ? undefined : fs[p]), new Set(['src', 'src/lib']));
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.kind === 'loading' ? '…' : r.name}`)).toEqual(['src', '  lib', '    …', '  server.ts', 'node_modules', 'README.md']);
    expect(rows[0]).toMatchObject({ dir: true, open: true });
  });

  it('lays the files a name search found out as a tree, folders first, with the match marked in the name', () => {
    const rows = foundRows([
      { path: 'src/server.ts', ranges: [[4, 7]] },
      { path: 'README.md', ranges: [[0, 3]] },
      { path: 'src/lib/auth.ts', ranges: [[0, 3]] },
    ]);
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}`)).toEqual(['src', '  lib', '    auth.ts', '  server.ts', 'README.md']);
    expect(rows.every((r) => !r.dir || r.open)).toBe(true);
    expect(rows.find((r) => r.name === 'server.ts')?.marks).toEqual([[0, 3]]);
    // A match only in the folders above: nothing to mark in the name.
    expect(rows.find((r) => r.name === 'auth.ts')?.marks).toEqual([]);
  });

  it('clips a path’s matches to its name', () => {
    expect(nameRanges('a/bc/def.ts', [[2, 8]])).toEqual([[0, 3]]);
    expect(nameRanges('top.ts', [[1, 2]])).toEqual([[1, 2]]);
  });

  it('knows the folders above a path', () => {
    expect(ancestorsOf('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestorsOf('top.ts')).toEqual([]);
  });
});
