import { describe, expect, it } from 'vitest';
import type { View } from '../src/core/store.js';
import {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  type NavEntry,
  type NavHistory,
  type PanelSnapshot,
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  pageKey,
  prune,
  recordable,
  samePage,
  updateCurrent,
  visit,
} from '../packages/mac/src/lib/nav-history.js';
import { type AliveState, pageAlive, restorePatch } from '../packages/mac/src/lib/nav-pages.js';

/** Back and forward between pages (Mac): a browser's history, with each page's panels kept. */

const PANELS: PanelSnapshot = { sidebar: true, inspector: true, bottomOpen: true, drawer: false, topTab: 'info', bottomTab: 'terminal' };
const ws = (id: string): View => ({ kind: 'workspace', id, tab: 'chat' });
const at = (view: View, panels: Partial<PanelSnapshot> = {}): NavEntry => ({ view, panels: { ...PANELS, ...panels } });
const overview: View = { kind: 'overview' };
const tasks: View = { kind: 'tasks' };
const search: View = { kind: 'search' };
const alive = (): boolean => true;
const kinds = (list: readonly NavEntry[]): string[] => list.map((e) => pageKey(e.view));

/** Freeze it all the way down: anything that writes into history throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Visit each in turn from an empty history. */
const walk = (...entries: NavEntry[]): NavHistory => entries.reduce(visit, EMPTY_HISTORY);

describe('which page a view is', () => {
  it('a worktree is the same page whatever tab was asked for (the window always shows its chat)', () => {
    expect(samePage(ws('w1'), { kind: 'workspace', id: 'w1', tab: 'files' })).toBe(true);
    expect(samePage(ws('w1'), ws('w2'))).toBe(false);
  });

  it('a page’s own params tell pages apart', () => {
    expect(samePage({ kind: 'project', id: 'p' }, { kind: 'project', id: 'p', page: 'history' })).toBe(false);
    expect(samePage({ kind: 'tasks', projectId: 'p' }, { kind: 'tasks', projectId: 'q' })).toBe(false);
    expect(samePage({ kind: 'plan', id: 'x' }, { kind: 'plan', id: 'x' })).toBe(true);
    expect(samePage(overview, search)).toBe(false);
  });

  it('a draft’s way back is not part of it, and drafts are not kept in history', () => {
    expect(samePage({ kind: 'draft', projectId: 'p', back: overview }, { kind: 'draft', projectId: 'p', back: tasks })).toBe(true);
    expect(recordable({ kind: 'draft', projectId: 'p', back: overview })).toBe(false);
    expect(recordable({ kind: 'draft_worktree', projectId: 'p', back: overview })).toBe(false);
    expect(recordable(overview)).toBe(true);
  });
});

describe('going somewhere', () => {
  it('the first page is where you are, with nothing to go back to', () => {
    const h = visit(EMPTY_HISTORY, at(overview));
    expect(h.current?.view).toEqual(overview);
    expect(h.back).toEqual([]);
    expect(canGoBack(h, alive)).toBe(false);
    expect(canGoForward(h, alive)).toBe(false);
  });

  it('a new page puts the one you left (and its panels) on the back stack', () => {
    const h = visit(visit(EMPTY_HISTORY, at(overview, { topTab: 'scratch' })), at(tasks));
    expect(kinds(h.back)).toEqual([pageKey(overview)]);
    expect(h.back[0]!.panels.topTab).toBe('scratch');
    expect(h.current?.view).toEqual(tasks);
    expect(canGoBack(h, alive)).toBe(true);
  });

  it('the page you are already on is not pushed again, but its latest view and panels are kept', () => {
    const h = walk(at(overview), at(ws('w1')));
    const again = visit(h, at({ kind: 'workspace', id: 'w1', tab: 'files' }, { inspector: false }));
    expect(again.back).toHaveLength(1);
    expect(again.current?.panels.inspector).toBe(false);
    expect(again.current?.view).toEqual({ kind: 'workspace', id: 'w1', tab: 'files' });
  });

  it('the same page with nothing new is the very same history', () => {
    const h = walk(at(overview), at(tasks));
    expect(visit(h, at(tasks))).toBe(h);
  });

  it('a new page clears forward', () => {
    const h = walk(at(overview), at(tasks), at(search));
    const back = goBack(h, alive).history;
    expect(back.forward).toHaveLength(1);
    const next = visit(back, at(ws('w1')));
    expect(next.forward).toEqual([]);
    expect(kinds(next.back)).toEqual([pageKey(overview), pageKey(tasks)]);
  });

  it('leaving a draft does not keep it', () => {
    const draft: View = { kind: 'draft', projectId: 'p', back: overview };
    const h = walk(at(overview), at(draft), at(ws('w1')));
    expect(kinds(h.back)).toEqual([pageKey(overview)]);
  });

  it('keeps at most HISTORY_LIMIT pages to go back to, dropping the oldest', () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = visit(h, at(ws(`w${i}`)));
    expect(h.back).toHaveLength(HISTORY_LIMIT);
    // 70 visits leave w0…w68 behind: the newest 50 are w19…w68.
    expect(h.back[0]!.view).toEqual(ws('w19'));
    expect(h.back[HISTORY_LIMIT - 1]!.view).toEqual(ws(`w${HISTORY_LIMIT + 18}`));
    expect(h.current?.view).toEqual(ws(`w${HISTORY_LIMIT + 19}`));
  });

  it('the forward stack is capped too', () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = visit(h, at(ws(`w${i}`)));
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = goBack(h, alive).history;
    expect(h.forward.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(h.back).toEqual([]);
  });
});

describe('back and forward', () => {
  it('with nothing behind or ahead, nothing moves', () => {
    const h = walk(at(overview));
    const back = goBack(h, alive);
    expect(back.to).toBeUndefined();
    expect(back.history.current?.view).toEqual(overview);
    const fwd = goForward(h, alive);
    expect(fwd.to).toBeUndefined();
    expect(fwd.history.current?.view).toEqual(overview);
    expect(goBack(EMPTY_HISTORY, alive).to).toBeUndefined();
    expect(goForward(EMPTY_HISTORY, alive).to).toBeUndefined();
  });

  it('back goes to the page before, and forward returns', () => {
    const h = walk(at(overview), at(tasks), at(search));
    const b = goBack(h, alive);
    expect(b.to?.view).toEqual(tasks);
    expect(b.history.current?.view).toEqual(tasks);
    expect(kinds(b.history.back)).toEqual([pageKey(overview)]);
    expect(kinds(b.history.forward)).toEqual([pageKey(search)]);
    const f = goForward(b.history, alive);
    expect(f.to?.view).toEqual(search);
    expect(kinds(f.history.back)).toEqual([pageKey(overview), pageKey(tasks)]);
    expect(f.history.forward).toEqual([]);
  });

  it('back and forward add no entries: going to and fro leaves the same stacks', () => {
    let h = walk(at(overview), at(tasks), at(search));
    for (let i = 0; i < 10; i++) h = goForward(goBack(h, alive).history, alive).history;
    expect(kinds(h.back)).toEqual([pageKey(overview), pageKey(tasks)]);
    expect(h.forward).toEqual([]);
    expect(h.current?.view).toEqual(search);
    // All the way back and all the way forward again.
    h = goBack(goBack(h, alive).history, alive).history;
    expect(h.current?.view).toEqual(overview);
    expect(canGoBack(h, alive)).toBe(false);
    expect(kinds(h.forward)).toEqual([pageKey(tasks), pageKey(search)]);
    h = goForward(goForward(h, alive).history, alive).history;
    expect(h.current?.view).toEqual(search);
    expect(canGoForward(h, alive)).toBe(false);
  });

  it('a page’s panels are what it had when you left it, and come back with it', () => {
    const h = walk(at(overview, { sidebar: false, topTab: 'scratch' }), at(ws('w1'), { inspector: true, topTab: 'info' }));
    const b = goBack(h, alive, { ...PANELS, inspector: false, topTab: 'files', drawer: true });
    expect(b.to?.panels).toMatchObject({ sidebar: false, topTab: 'scratch' });
    // What w1 had when you left it (not what it had when you first came).
    expect(b.history.forward[0]!.panels).toMatchObject({ inspector: false, topTab: 'files', drawer: true });
    const f = goForward(b.history, alive, { ...PANELS, sidebar: true, bottomTab: 'background' });
    expect(f.to?.panels).toMatchObject({ inspector: false, topTab: 'files', drawer: true });
    expect(f.history.back[0]!.panels).toMatchObject({ sidebar: true, bottomTab: 'background' });
  });

  it('updateCurrent keeps the page’s latest panels (the same history when nothing changed)', () => {
    const h = walk(at(overview));
    const u = updateCurrent(h, { ...PANELS, sidebar: false });
    expect(u.current?.panels.sidebar).toBe(false);
    expect(updateCurrent(u, { ...PANELS, sidebar: false })).toBe(u);
    expect(updateCurrent(EMPTY_HISTORY, PANELS)).toBe(EMPTY_HISTORY);
  });

  it('back from a draft goes back without keeping the draft ahead', () => {
    const draft: View = { kind: 'draft', projectId: 'p', back: overview };
    const b = goBack(walk(at(overview), at(draft)), alive);
    expect(b.to?.view).toEqual(overview);
    expect(b.history.forward).toEqual([]);
  });
});

describe('pages that are gone', () => {
  const gone = (id: string) => (view: View) => !(view.kind === 'workspace' && view.id === id);

  it('back skips a page that is gone, and forgets it', () => {
    const h = walk(at(overview), at(ws('dead')), at(tasks));
    const b = goBack(h, gone('dead'));
    expect(b.to?.view).toEqual(overview);
    expect(b.history.back).toEqual([]);
    expect(kinds(b.history.forward)).toEqual([pageKey(tasks)]);
  });

  it('forward skips one too', () => {
    let h = walk(at(overview), at(tasks), at(ws('dead')), at(search));
    h = goBack(goBack(goBack(h, alive).history, alive).history, alive).history;
    expect(h.current?.view).toEqual(overview);
    const f = goForward(goForward(h, alive).history, gone('dead'));
    expect(f.to?.view).toEqual(search);
    expect(kinds(f.history.back)).toEqual([pageKey(overview), pageKey(tasks)]);
    expect(f.history.forward).toEqual([]);
  });

  it('when every page behind is gone, nothing moves and Back is off', () => {
    const h = walk(at(ws('dead')), at(tasks));
    expect(canGoBack(h, gone('dead'))).toBe(false);
    const b = goBack(h, gone('dead'));
    expect(b.to).toBeUndefined();
    expect(b.history.current?.view).toEqual(tasks);
    expect(b.history.back).toEqual([]);
  });

  it('a gone page that would lead back to where you are is skipped too (no step that goes nowhere)', () => {
    // tasks → dead → tasks: with dead gone, back from tasks would be tasks again.
    const h = walk(at(overview), at(tasks), at(ws('dead')), at(tasks));
    const b = goBack(h, gone('dead'));
    expect(b.to?.view).toEqual(overview);
  });

  it('prune drops gone pages and the repeats they leave, and keeps history the same when nothing is gone', () => {
    const h = walk(at(overview), at(tasks), at(ws('dead')), at(tasks), at(search));
    const p = prune(h, gone('dead'));
    expect(kinds(p.back)).toEqual([pageKey(overview), pageKey(tasks)]);
    expect(prune(p, alive)).toBe(p);
    expect(prune(EMPTY_HISTORY, alive)).toBe(EMPTY_HISTORY);
  });

  it('prune drops a page behind or ahead that is the one you are on', () => {
    // overview → tasks → dead → tasks: with dead gone, the tasks behind is where you are.
    const p = prune(walk(at(overview), at(tasks), at(ws('dead')), at(tasks)), gone('dead'));
    expect(kinds(p.back)).toEqual([pageKey(overview)]);
    // And ahead: back to tasks with dead and tasks again ahead of it.
    let h = walk(at(overview), at(tasks), at(ws('dead')), at(tasks), at(search));
    h = goBack(goBack(goBack(h, alive).history, alive).history, alive).history;
    expect(h.current?.view).toEqual(tasks);
    expect(kinds(prune(h, gone('dead')).forward)).toEqual([pageKey(search)]);
  });
});

describe('history is never changed in place', () => {
  it('every step returns new stacks and leaves the old ones as they were', () => {
    const h = deepFreeze(walk(at(overview), at(tasks), at(search)));
    const snapshot = JSON.stringify(h);
    const steps = [visit(h, at(ws('w1'))), goBack(h, alive).history, goForward(goBack(h, alive).history, alive).history, updateCurrent(h, { ...PANELS, drawer: true }), prune(h, () => false)];
    expect(steps.every((s) => s !== h)).toBe(true);
    expect(JSON.stringify(h)).toBe(snapshot);
  });
});

describe('whether a page is still there', () => {
  const state = (over: Partial<AliveState> = {}): AliveState => ({
    projects: [
      {
        id: 'p',
        workspaces: [
          { id: 'w1', archived: false },
          { id: 'old', archived: true },
        ],
      },
    ],
    board: { enabled: true, issues: [{ id: 't1' }] },
    plans: { plans: [{ id: 'plan1' }] },
    sentinel: { items: [{ id: 's1' }] },
    peers: [{ peerId: 'me' }],
    ...over,
  });

  it('a worktree: there and not archived', () => {
    expect(pageAlive(state(), ws('w1'))).toBe(true);
    expect(pageAlive(state(), ws('old'))).toBe(false);
    expect(pageAlive(state(), ws('nope'))).toBe(false);
  });

  it("the room's group chat: only while someone else is in the room (BLG-871)", () => {
    expect(pageAlive(state(), { kind: 'room' })).toBe(false);
    expect(pageAlive(state({ peers: [{ peerId: 'me' }, { peerId: 'bob' }] }), { kind: 'room' })).toBe(true);
  });

  it('a project, and the pages of a project', () => {
    expect(pageAlive(state(), { kind: 'project', id: 'p' })).toBe(true);
    expect(pageAlive(state(), { kind: 'project', id: 'gone' })).toBe(false);
    expect(pageAlive(state(), { kind: 'tasks', projectId: 'gone' })).toBe(false);
    expect(pageAlive(state(), { kind: 'issues', projectId: 'p' })).toBe(true);
    expect(pageAlive(state(), { kind: 'gh_run', projectId: 'gone', runId: 1 })).toBe(false);
    expect(pageAlive(state(), { kind: 'draft', projectId: 'gone', back: overview })).toBe(false);
    // Sentinel's "Your Mac" is no project.
    expect(pageAlive(state(), { kind: 'sentinel', projectId: 'mac' })).toBe(true);
    // Unset: the one you were last in.
    expect(pageAlive(state(), { kind: 'tasks' })).toBe(true);
  });

  it('a task, a plan and a sentinel', () => {
    expect(pageAlive(state(), { kind: 'task', id: 't1' })).toBe(true);
    expect(pageAlive(state(), { kind: 'task', id: 'deleted' })).toBe(false);
    expect(pageAlive(state({ board: { enabled: false, issues: [] } }), { kind: 'task', id: 't1' })).toBe(false);
    expect(pageAlive(state(), { kind: 'plan', id: 'plan1' })).toBe(true);
    expect(pageAlive(state(), { kind: 'plan', id: 'gone' })).toBe(false);
    expect(pageAlive(state(), { kind: 'sentinel_page', id: 's1' })).toBe(true);
    expect(pageAlive(state(), { kind: 'sentinel_page', id: 'gone' })).toBe(false);
  });

  it('places that are always there', () => {
    for (const v of [overview, tasks, search, { kind: 'usage' }] as View[]) expect(pageAlive(state(), v)).toBe(true);
  });
});

describe('putting a page’s panels back', () => {
  const prefs = { sidebar: true, inspector: true, bottomOpen: true, drawer: false, panelTabs: { 'ws:other': 'files' as const, app: 'info' as const } };

  it('the sidebar, the panel, its bottom pane, the drawer and the tabs (scratch, info…) for that page', () => {
    const patch = restorePatch(prefs, ws('w1'), { sidebar: false, inspector: false, bottomOpen: false, drawer: true, topTab: 'scratch', bottomTab: 'background' });
    expect(patch).toEqual({
      sidebar: false,
      inspector: false,
      bottomOpen: false,
      drawer: true,
      panelTabs: { 'ws:other': 'files', app: 'info', 'ws:w1': 'scratch', 'ws:w1|bottom': 'background' },
    });
    // Nothing written into the prefs it was given.
    expect(prefs.panelTabs).toEqual({ 'ws:other': 'files', app: 'info' });
  });

  it('a page without a panel or a drawer leaves those as they are', () => {
    // Tasks has the whole window (no panel), but the drawer under it.
    const patch = restorePatch(prefs, tasks, { sidebar: false, inspector: false, bottomOpen: false, drawer: true, topTab: 'scratch' });
    expect(patch).toEqual({ sidebar: false, drawer: true });
    expect(restorePatch(prefs, { kind: 'terminal' }, { ...PANELS, drawer: true })).not.toHaveProperty('drawer');
  });

  it('nothing to change, nothing in the patch', () => {
    expect(restorePatch(prefs, overview, { sidebar: true, inspector: true, bottomOpen: true, drawer: false, topTab: 'info' })).toEqual({});
  });
});
