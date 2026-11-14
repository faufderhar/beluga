import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store, initialState, reduce, type Action, type DomainState } from '../src/core/store.js';
import { AttentionRegistry } from '../src/core/attention.js';
import { ClientStore } from '../src/client/client-store.js';
import { Notifier, detectNotices, enabled, placeName, planOfChannel, type NoticeEvent } from '../src/core/notify.js';
import type { Issue } from '../src/core/board/model.js';
import { needsYou } from '../src/companion/needs-you.js';
import type { Plan, PlanBody } from '../src/core/plans/model.js';
import type { PeerInfo } from '../src/protocol.js';
import type { Project } from '../src/workspaces/types.js';
import type { PendingQuestion, SharedWorkspace } from '../src/core/collab-store.js';

const me: PeerInfo = { peerId: 'me', name: 'kay', agent: true, shares: [] };
const bob: PeerInfo = { peerId: 'b', name: 'bob', agent: true, shares: [] };
const cat: PeerInfo = { peerId: 'c', name: 'cat', agent: false, shares: [] };

const project: Project = {
  id: 'p1',
  name: 'app',
  root: '/tmp/app',
  base: 'main',
  workspaces: [{ id: 'w1', projectId: 'p1', projectRoot: '/tmp/app', name: 'add-auth', path: '/tmp/app-w1', kind: 'worktree', createdAt: 0, external: false }],
};

const apply = (s: DomainState, ...actions: Action[]): DomainState => actions.reduce(reduce, s);
const base = (): DomainState =>
  apply(initialState('room'), { type: 'peers', peers: [me, bob] }, { type: 'welcome', self: me }, { type: 'projects', projects: [project] });

const ev = (owner: string, requester: string, event: 'started' | 'text' | 'done' | 'error' | 'denied', text = '', channel = 'ws:w1'): Action => ({
  type: 'agent_event',
  owner,
  requestId: 'r1',
  requester,
  event,
  text,
  ts: 1,
  channel,
});

const question = (qid: string, kind: 'plan' | 'question', channel = 'ws:w1'): PendingQuestion => ({
  qid,
  requestId: 'r1',
  owner: 'me',
  channel,
  picked: {},
  question: kind === 'plan' ? { kind: 'plan', plan: 'do it' } : { kind: 'question', questions: [{ question: '**Which** db?\nmore', header: '', options: [], multiSelect: false }] },
});

const sharedWs = (role: 'view' | 'contribute', owner = 'b'): SharedWorkspace => ({ owner, id: 'sw1', name: 'api-fix', project: 'api', role, share: 'api' });

describe('placeName', () => {
  it('names the room, workspaces, shared workspaces, and unknowns', () => {
    const solo = apply(initialState('room'), { type: 'peers', peers: [me] });
    expect(placeName(solo, 'room')).toBe('your chat');
    expect(placeName(base(), 'room')).toBe('the group chat');
    expect(placeName(base(), 'ws:w1')).toBe('add-auth');
    const s = apply(base(), { type: 'shared_add', ws: sharedWs('view') });
    expect(placeName(s, 'ws:sw1')).toBe('api-fix');
    expect(placeName(base(), 'ws:nope')).toBe('a workspace');
    expect(placeName(base(), 'mac:assistant')).toBe('Your Mac');
  });
});

describe('detectNotices: runs', () => {
  it('returns nothing when nothing changed', () => {
    const s = base();
    expect(detectNotices(s, s)).toEqual([]);
  });

  it('announces your Claude finishing with the first meaningful line', () => {
    const running = apply(base(), ev('me', 'me', 'started'));
    const done = apply(running, ev('me', 'me', 'done', '\n# **All** tests pass\nsecond line'));
    expect(detectNotices(running, done)).toEqual([{ kind: 'done', title: 'Claude finished in add-auth', body: 'All tests pass', channel: 'ws:w1' }]);
  });

  it('uses "Done" for an empty final text and truncates long lines', () => {
    const running = apply(base(), ev('me', 'me', 'started'));
    expect(detectNotices(running, apply(running, ev('me', 'me', 'done', '')))[0]?.body).toBe('Done');
    const long = 'x'.repeat(200);
    const body = detectNotices(running, apply(running, ev('me', 'me', 'done', long)))[0]?.body ?? '';
    expect(body).toHaveLength(140);
    expect(body.endsWith('…')).toBe(true);
  });

  it("announces a friend's Claude working for you, but not for someone else", () => {
    const withCat = apply(base(), { type: 'peers', peers: [me, bob, cat] });
    const forMe = apply(withCat, ev('b', 'me', 'started', '', 'room'));
    expect(detectNotices(forMe, apply(forMe, ev('b', 'me', 'done', 'ok', 'room')))).toEqual([
      { kind: 'done', title: "bob's Claude finished in the group chat", body: 'ok', channel: 'room' },
    ]);
    const catRun = apply(withCat, ev('b', 'c', 'started', '', 'room'));
    expect(detectNotices(catRun, apply(catRun, ev('b', 'c', 'done', 'ok', 'room')))).toEqual([]);
  });

  it('reports errors and denials as problems', () => {
    const running = apply(base(), ev('me', 'me', 'started'));
    expect(detectNotices(running, apply(running, ev('me', 'me', 'error', 'API overloaded')))).toEqual([
      { kind: 'problems', title: 'Claude stopped in add-auth', body: 'API overloaded', channel: 'ws:w1' },
    ]);
    expect(detectNotices(running, apply(running, ev('me', 'me', 'denied', '')))[0]).toMatchObject({ kind: 'problems', body: 'denied' });
  });

  it('ignores quiet errors you caused yourself', () => {
    const running = apply(base(), ev('me', 'me', 'started'));
    for (const text of ['Interrupted by a newer message', 'Cancelled by owner', 'Stopped by owner.']) {
      expect(detectNotices(running, apply(running, ev('me', 'me', 'error', text)))).toEqual([]);
    }
  });

  it('ignores runs that were already final or are new in this step', () => {
    const done = apply(base(), ev('me', 'me', 'started'), ev('me', 'me', 'done', 'a'));
    // Already final before: a repeated done is not announced again.
    expect(detectNotices(done, apply(done, ev('me', 'me', 'done', 'b')))).toEqual([]);
    // A run that appears already-final (e.g. loaded history) is not announced.
    const s = base();
    expect(detectNotices(s, apply(s, ev('me', 'me', 'done', 'x')))).toEqual([]);
    // Still running: nothing.
    const running = apply(s, ev('me', 'me', 'started'));
    expect(detectNotices(running, apply(running, ev('me', 'me', 'text', 'thinking')))).toEqual([]);
  });

  it('ignores chat-only log changes when it is not about you', () => {
    const s = apply(base(), { type: 'peers', peers: [me, bob, cat] });
    expect(detectNotices(s, apply(s, { type: 'chat', id: 'c1', from: 'b', text: 'hi', ts: 1, byAgent: false }))).toEqual([]);
  });
});

describe('detectNotices: needs you', () => {
  it('announces new approvals only', () => {
    const s0 = base();
    const s1 = apply(s0, { type: 'approval_add', approval: { id: 'a1', kind: 'tool', title: 'Run npm test?', detail: '`npm test`\nin /app' } });
    expect(detectNotices(s0, s1)).toEqual([{ kind: 'needsYou', tag: 'approval', ref: 'a1', title: 'Run npm test?', body: 'npm test' }]);
    const s2 = apply(s1, { type: 'approval_add', approval: { id: 'a2', kind: 'request', title: 'bob asks', detail: '' } });
    expect(detectNotices(s1, s2)).toEqual([{ kind: 'needsYou', tag: 'approval', ref: 'a2', title: 'bob asks', body: '' }]);
    expect(detectNotices(s2, apply(s2, { type: 'approval_remove', id: 'a1' }))).toEqual([]);
  });

  it('tells questions and plans apart', () => {
    const s0 = base();
    const s1 = apply(s0, { type: 'question_add', question: question('q1', 'question') });
    expect(detectNotices(s0, s1)).toEqual([{ kind: 'needsYou', tag: 'question', ref: 'q1', title: 'Claude asks in add-auth', body: 'Which db?', channel: 'ws:w1' }]);
    const s2 = apply(s1, { type: 'question_add', question: question('q2', 'plan', 'room') });
    expect(detectNotices(s1, s2)).toEqual([
      { kind: 'needsYou', tag: 'plan', ref: 'q2', title: 'Claude has a plan for the group chat', body: 'Approve it, or say what to change', channel: 'room' },
    ]);
    expect(detectNotices(s2, apply(s2, { type: 'question_remove', qid: 'q1' }))).toEqual([]);
  });
});

describe('detectNotices: conflicts', () => {
  it('announces a new conflict once, listing up to three files', () => {
    const s0 = base();
    const s1 = apply(s0, { type: 'conflicts', id: 'w1', files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] });
    expect(detectNotices(s0, s1)).toEqual([
      { kind: 'problems', tag: 'conflict', title: 'Merge conflict in add-auth', body: '4 file(s): a.ts, b.ts, c.ts', channel: 'ws:w1' },
    ]);
    // Still conflicted (different files): not announced again.
    expect(detectNotices(s1, apply(s1, { type: 'conflicts', id: 'w1', files: ['a.ts'] }))).toEqual([]);
    // Resolved: nothing.
    expect(detectNotices(s1, apply(s1, { type: 'conflicts', id: 'w1', files: [] }))).toEqual([]);
  });
});

describe('detectNotices: people', () => {
  it('stays quiet for the first peer list and before you are in', () => {
    const fresh = apply(initialState('room'), { type: 'welcome', self: me });
    expect(detectNotices(fresh, apply(fresh, { type: 'peers', peers: [me, bob] }))).toEqual([]);
    const noSelf = apply(initialState('room'), { type: 'peers', peers: [me] });
    expect(detectNotices(noSelf, apply(noSelf, { type: 'peers', peers: [me, bob] }))).toEqual([]);
  });

  it('announces people joining afterwards, with or without their Claude', () => {
    const s0 = base();
    const s1 = apply(s0, { type: 'peers', peers: [me, bob, cat] });
    expect(detectNotices(s0, s1)).toEqual([{ kind: 'people', tag: 'joined', title: 'cat joined', body: 'Say hi in the group chat', channel: 'room' }]);
    const dan: PeerInfo = { peerId: 'd', name: 'dan', agent: true, shares: [] };
    expect(detectNotices(s1, apply(s1, { type: 'peers', peers: [me, bob, cat, dan] }))[0]?.body).toBe('They brought their Claude');
  });

  it('announces people leaving while you are still in the room', () => {
    const s1 = apply(base(), { type: 'status', status: 'connected' }, { type: 'peers', peers: [me, bob, cat] });
    expect(detectNotices(s1, apply(s1, { type: 'peers', peers: [me, cat] }))).toEqual([
      { kind: 'people', tag: 'left', title: 'bob left', body: 'Their Claude left with them', channel: 'room' },
    ]);
    expect(detectNotices(s1, apply(s1, { type: 'peers', peers: [me] })).map((e) => e.title)).toEqual(['bob left', 'cat left']);
    // Losing the room yourself (or not connected) is not news about each person.
    expect(detectNotices(s1, apply(s1, { type: 'peers', peers: [] }))).toEqual([]);
    expect(detectNotices(s1, apply(s1, { type: 'status', status: 'disconnected' }, { type: 'peers', peers: [me] }))).toEqual([]);
  });

  it('never announces yourself joining', () => {
    const solo = apply(initialState('room'), { type: 'welcome', self: me }, { type: 'peers', peers: [bob] });
    expect(detectNotices(solo, apply(solo, { type: 'peers', peers: [bob, me] }))).toEqual([]);
  });

  it('announces shared-workspace invites by role, once', () => {
    const s0 = base();
    const s1 = apply(s0, { type: 'shared_add', ws: sharedWs('contribute') });
    expect(detectNotices(s0, s1)).toEqual([
      { kind: 'people', tag: 'invited', title: 'bob invited you to api-fix', body: 'You can work there with their Claude', channel: 'ws:sw1' },
    ]);
    // Re-sent invite (role change) for the same workspace: not new.
    expect(detectNotices(s1, apply(s1, { type: 'shared_add', ws: sharedWs('view') }))).toEqual([]);
    const s2 = apply(s0, { type: 'shared_add', ws: sharedWs('view', 'zz') });
    expect(detectNotices(s0, s2)).toEqual([{ kind: 'people', tag: 'invited', title: 'Someone invited you to api-fix', body: 'You can follow along', channel: 'ws:sw1' }]);
  });
});

describe('enabled', () => {
  it('reads per-kind toggles', () => {
    const prefs = { ...initialState('room').prefs.notify, pr: false };
    expect(enabled(prefs, 'pr')).toBe(false);
    expect(enabled(prefs, 'done')).toBe(true);
  });

  it('quiets sentinels on their own, but not what one needs from you', () => {
    const prefs = { ...initialState('room').prefs.notify, sentinels: false };
    expect(enabled(prefs, 'done', 'sentinel')).toBe(false);
    expect(enabled(prefs, 'problems', 'sentinel')).toBe(false);
    expect(enabled(prefs, 'needsYou', 'sentinel')).toBe(true);
    expect(enabled(prefs, 'done')).toBe(true);
    expect(enabled({ ...prefs, sentinels: true, done: false }, 'done', 'sentinel')).toBe(false);
  });
});

describe('Notifier', () => {
  let store: Store;
  let screen: ClientStore;
  let desktop: ReturnType<typeof vi.fn<(n: { title: string; body: string; sound: boolean }) => void>>;
  let notifier: Notifier;

  /** A store with one screen attached, showing the room (the way the terminal UI starts). */
  const start = (state: DomainState = base(), burstMs?: number): void => {
    store = new Store(state);
    const attention = new AttentionRegistry(store);
    desktop = vi.fn<(n: { title: string; body: string; sound: boolean }) => void>();
    notifier = new Notifier({ store, desktop, burstMs });
    screen = new ClientStore(store, (a) => attention.set('screen', a));
  };
  const finishRun = (requestId: string, channel: string, text = 'ok'): void => {
    store.dispatch({ ...(ev('me', 'me', 'started', '', channel) as Extract<Action, { type: 'agent_event' }>), requestId });
    store.dispatch({ ...(ev('me', 'me', 'done', text, channel) as Extract<Action, { type: 'agent_event' }>), requestId });
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    notifier?.stop();
    vi.useRealTimers();
  });

  it('adds to the inbox and raises one desktop notification', () => {
    start();
    finishRun('r1', 'ws:w1', 'shipped');
    expect(store.getState().inbox).toMatchObject([{ kind: 'done', title: 'Claude finished in add-auth', body: 'shipped', channel: 'ws:w1', read: false }]);
    expect(desktop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(desktop).toHaveBeenCalledTimes(1);
    expect(desktop).toHaveBeenCalledWith({ title: 'Claude finished in add-auth', body: 'shipped', sound: true, tone: { kind: 'mac', id: 'Glass' }, volume: 0.7, channel: 'ws:w1' });
  });

  it('stays quiet about the conversation you are looking at, unless away', () => {
    start();
    screen.dispatch({ type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    finishRun('r1', 'ws:w1');
    vi.runAllTimers();
    expect(store.getState().inbox).toEqual([]);
    expect(desktop).not.toHaveBeenCalled();

    screen.dispatch({ type: 'away', away: true });
    finishRun('r2', 'ws:w1');
    vi.runAllTimers();
    expect(store.getState().inbox).toHaveLength(1);
    expect(desktop).toHaveBeenCalledTimes(1);
  });

  describe('a long run ending in the conversation you are looking at', () => {
    const at = (requestId: string, event: 'queued' | 'started' | 'done', ts: number, text = 'ok'): void =>
      store.dispatch({ type: 'agent_event', owner: 'me', requestId, requester: 'me', event, text, ts, channel: 'ws:w1' });
    const watching = (state?: DomainState): void => {
      start(state);
      screen.dispatch({ type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    };

    it('reaches the desktop, not the bell', () => {
      watching();
      at('r1', 'started', 1_000);
      at('r1', 'done', 1_000 + 25_000, 'shipped');
      vi.runAllTimers();
      expect(store.getState().inbox).toEqual([]);
      expect(desktop).toHaveBeenCalledTimes(1);
      expect(desktop.mock.calls[0]![0]).toMatchObject({ title: 'Claude finished in add-auth', body: 'shipped', channel: 'ws:w1' });
    });

    it('stays quiet for a quick one, while more waits its turn, and when switched off', () => {
      watching();
      at('r1', 'started', 1_000);
      at('r1', 'done', 5_000);
      at('r2', 'started', 10_000);
      at('r3', 'queued', 11_000);
      at('r2', 'done', 40_000);
      vi.runAllTimers();
      expect(desktop).not.toHaveBeenCalled();

      at('r3', 'started', 41_000);
      at('r3', 'done', 70_000);
      vi.runAllTimers();
      expect(desktop).toHaveBeenCalledTimes(1);

      store.dispatch({ type: 'prefs', prefs: { notify: { ...store.getState().prefs.notify, doneHere: false } } });
      at('r4', 'started', 80_000);
      at('r4', 'done', 120_000);
      vi.runAllTimers();
      expect(desktop).toHaveBeenCalledTimes(1);
    });
  });

  it('respects per-kind toggles and the desktop switch', () => {
    start(apply(base(), { type: 'prefs', prefs: { notify: { ...initialState('room').prefs.notify, done: false } } }));
    finishRun('r1', 'ws:w1');
    vi.runAllTimers();
    expect(store.getState().inbox).toEqual([]);

    store.dispatch({ type: 'prefs', prefs: { notify: { ...store.getState().prefs.notify, done: true, desktop: false } } });
    finishRun('r2', 'ws:w1');
    vi.runAllTimers();
    expect(store.getState().inbox).toHaveLength(1);
    expect(desktop).not.toHaveBeenCalled();
  });

  it('combines a burst into one desktop notification with a combined title', () => {
    start(apply(base(), { type: 'prefs', prefs: { notify: { ...initialState('room').prefs.notify, sound: { kind: 'none' } } } }));
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) finishRun(id, 'ws:w1', id);
    vi.advanceTimersByTime(0);
    expect(desktop).toHaveBeenCalledTimes(1);
    const arg = desktop.mock.calls[0]![0];
    expect(arg.title).toBe('5 updates in Beluga');
    expect(arg.body.split(' · ')).toHaveLength(4);
    expect(arg.sound).toBe(false);
    expect(store.getState().inbox).toHaveLength(5);
  });

  it('waits out the burst window before the next desktop notification', () => {
    start(base(), 1000);
    finishRun('r1', 'ws:w1');
    vi.advanceTimersByTime(0);
    expect(desktop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    finishRun('r2', 'ws:w1');
    store.dispatch({ type: 'conflicts', id: 'w1', files: ['a.ts'] });
    vi.advanceTimersByTime(799);
    expect(desktop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(desktop).toHaveBeenCalledTimes(2);
    expect(desktop.mock.calls[1]![0]).toMatchObject({ title: '2 updates in Beluga' });
  });

  it('marks notices read when you open their conversation or come back', () => {
    start();
    finishRun('r1', 'ws:w1');
    finishRun('r2', 'room');
    // r2 is about the room, which you are looking at.
    expect(store.getState().inbox).toHaveLength(1);
    screen.dispatch({ type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    expect(store.getState().inbox[0]?.read).toBe(true);

    screen.dispatch({ type: 'away', away: true });
    store.dispatch({ type: 'question_add', question: question('q1', 'question') });
    expect(store.getState().inbox[0]).toMatchObject({ channel: 'ws:w1', read: false });
    screen.dispatch({ type: 'away', away: false });
    expect(store.getState().inbox[0]?.read).toBe(true);
  });

  it('does not mark notices read while away', () => {
    start();
    screen.dispatch({ type: 'away', away: true });
    finishRun('r1', 'ws:w1');
    screen.dispatch({ type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    expect(store.getState().inbox[0]?.read).toBe(false);
  });

  it('notify() raises a direct notice; notices without a channel always show', () => {
    start();
    const e: NoticeEvent = { kind: 'pr', title: 'PR #3 opened', body: 'add-auth' };
    notifier.notify(e);
    vi.runAllTimers();
    expect(store.getState().inbox[0]).toMatchObject({ kind: 'pr', title: 'PR #3 opened' });
    expect(desktop).toHaveBeenCalledWith({ title: 'PR #3 opened', body: 'add-auth', sound: true, tone: { kind: 'mac', id: 'Glass' }, volume: 0.7 });
  });

  it('stops listening after stop()', () => {
    start();
    notifier.stop();
    finishRun('r1', 'ws:w1');
    vi.runAllTimers();
    expect(store.getState().inbox).toEqual([]);
    expect(desktop).not.toHaveBeenCalled();
  });
});

describe('the Beluga network: messages from friends and groups', () => {
  type Net = DomainState['network'];
  const selfNet = { peerId: 'me'.padEnd(32, 'x'), name: 'kay', presence: { state: 'online' as const }, appearOffline: false };
  const msg = (id: string, conversation: string, text: string, extra: Partial<Net['messages'][string][number]> = {}) => ({ id, conversation, from: 'b'.padEnd(32, 'x'), name: 'bob', text, ts: 1_000_000, mine: false, ...extra });
  const on = (messages: Net['messages'] = {}, self = selfNet): DomainState => ({
    ...base(),
    network: { enabled: true, self, friends: [], groups: [{ id: 'g1', name: 'launch', members: [], admin: false, active: true, unread: 0, requests: [], createdAt: 0 }], invitations: [], pendingJoins: [], messages },
  });
  const withMessages = (s: DomainState, messages: Net['messages']): DomainState => ({ ...s, network: { ...s.network, messages } });

  it('announces a direct message by who sent it, and a group message by where', () => {
    const prev = on();
    const next = withMessages(prev, { 'dm:b': [msg('1', 'dm:b', 'lunch?')], 'group:g1': [msg('2', 'group:g1', 'ship it @kay')] });
    expect(detectNotices(prev, next, 1_000_000)).toEqual([
      { kind: 'mentions', tag: 'message', title: 'bob', body: 'lunch?', channel: 'dm:b' },
      { kind: 'mentions', tag: 'mention', title: 'bob mentioned you in launch', body: 'ship it @kay', channel: 'group:g1' },
    ]);
  });

  it('leaves out your own, unreadable, old and first-load messages', () => {
    const prev = on();
    const next = withMessages(prev, { 'dm:b': [msg('1', 'dm:b', 'mine', { mine: true }), msg('2', 'dm:b', '', { status: 'locked' }), msg('3', 'dm:b', 'old', { ts: 1_000_000 - 13 * 3_600_000 })] });
    expect(detectNotices(prev, next, 1_000_000)).toEqual([]);
    const off = { ...prev, network: { ...prev.network, enabled: false } };
    expect(detectNotices(off, withMessages(off, { 'dm:b': [msg('4', 'dm:b', 'hi')] }), 1_000_000)).toEqual([]);
  });

  it('is quiet (inbox only) on Do Not Disturb or while appearing offline', () => {
    const dnd = on({}, { ...selfNet, presence: { state: 'dnd' } as never });
    expect(detectNotices(dnd, withMessages(dnd, { 'dm:b': [msg('1', 'dm:b', 'hi')] }), 1_000_000)[0]).toMatchObject({ quiet: true });
    const hidden = on({}, { ...selfNet, appearOffline: true });
    expect(detectNotices(hidden, withMessages(hidden, { 'dm:b': [msg('1', 'dm:b', 'hi')] }), 1_000_000)[0]).toMatchObject({ quiet: true });
  });

  it('a quiet notice goes to the inbox without a desktop notification', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const store = new Store(on({}, { ...selfNet, presence: { state: 'dnd' } as never }));
      const desktop = vi.fn();
      const notifier = new Notifier({ store, desktop });
      store.dispatch({ type: 'net_message', message: msg('1', 'dm:b', 'hi') });
      vi.runAllTimers();
      expect(store.getState().inbox).toMatchObject([{ title: 'bob', channel: 'dm:b' }]);
      expect(desktop).not.toHaveBeenCalled();
      notifier.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows in the window, with its sound, while Beluga is in front (even set to notify only when away)', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const state = on();
      const store = new Store({ ...state, attention: { ...state.attention, front: true }, prefs: { ...state.prefs, notify: { ...state.prefs.notify, onlyAway: true } } });
      const desktop = vi.fn();
      const notifier = new Notifier({ store, desktop });
      store.dispatch({ type: 'net_message', message: msg('1', 'dm:b', 'lunch?') });
      vi.runAllTimers();
      expect(store.getState().inbox).toMatchObject([{ title: 'bob', channel: 'dm:b', read: false }]);
      expect(desktop).toHaveBeenCalledTimes(1);
      expect(desktop.mock.calls[0]![0]).toMatchObject({ title: 'bob', body: 'lunch?', channel: 'dm:b', sound: true, banner: true });

      // A burst is one banner.
      store.dispatch({ type: 'net_message', message: msg('2', 'dm:b', 'one') });
      store.dispatch({ type: 'net_message', message: msg('3', 'group:g1', 'two', { conversation: 'group:g1' }) });
      vi.runAllTimers();
      expect(desktop).toHaveBeenCalledTimes(2);
      expect(desktop.mock.calls[1]![0]).toMatchObject({ title: '2 new messages', banner: true });
      notifier.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('plans: you hear from the plan, not each task', () => {
  const issue = (over: Partial<Issue> = {}): Issue => ({
    id: 'i12',
    key: 'KLD-12',
    number: 12,
    projectId: 'p1',
    title: 'Login form',
    status: 'in_progress',
    priority: 'medium',
    labels: [],
    blockedBy: [],
    related: [],
    rank: 0,
    brief: {},
    revisions: [],
    worktrees: ['w1'],
    proof: [],
    activity: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: { kind: 'beluga' },
    origin: 'plan',
    plan: { id: 'pl1', milestone: 'm1', task: 't1' },
    ...over,
  });
  const body: PlanBody = {
    title: 'Auth',
    goal: 'Sign in',
    milestones: [
      { id: 'm1', title: 'API', criteria: ['tests pass'], tasks: [{ id: 't1', title: 'Login form', acceptance: [], blockedBy: [], issueId: 'i12' }] },
      { id: 'm2', title: 'UI', criteria: [], tasks: [{ id: 't2', title: 'Screen', acceptance: [], blockedBy: ['t1'] }] },
    ],
  };
  const plan = (over: Partial<Plan> = {}): Plan => ({
    id: 'pl1',
    projectId: 'p1',
    home: 'ws:home',
    status: 'active',
    body,
    draftRev: 1,
    autonomy: 'autopilot',
    maxParallel: 3,
    paused: false,
    testsAt: 'end',
    runs: {},
    activity: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });
  const inPlan = (p: Plan = plan(), i: Issue = issue()): DomainState =>
    apply(base(), { type: 'board_init', state: { enabled: true, issues: [i], projects: {}, autoTasks: false } }, { type: 'plans_init', state: { enabled: true, plans: [p], style: '' } });

  it('planOfChannel finds the plan of a task worktree, and of its home', () => {
    const s = inPlan();
    expect(planOfChannel(s, 'ws:w1')).toMatchObject({ plan: { id: 'pl1' }, issue: { key: 'KLD-12' }, task: 't1' });
    expect(planOfChannel(s, 'ws:home')).toMatchObject({ plan: { id: 'pl1' } });
    expect(planOfChannel(s, 'ws:home')?.issue).toBeUndefined();
    expect(planOfChannel(s, 'ws:other')).toBeUndefined();
    expect(planOfChannel(s, 'room')).toBeUndefined();
  });

  it('a task finishing inside a plan goes quietly into the inbox, under the plan', () => {
    const running = apply(inPlan(), ev('me', 'me', 'started'));
    expect(detectNotices(running, apply(running, ev('me', 'me', 'done', 'shipped')))).toEqual([
      { kind: 'done', title: 'Auth · KLD-12: Claude finished in add-auth', body: 'shipped', channel: 'ws:w1', plan: 'pl1', planTask: 't1', quiet: true },
    ]);
  });

  it('outside plans nothing changes, and turning the setting off brings per-task notices back', () => {
    const running = apply(inPlan(), ev('me', 'me', 'started', '', 'ws:w2'));
    expect(detectNotices(running, apply(running, ev('me', 'me', 'done', 'ok', 'ws:w2')))).toEqual([{ kind: 'done', title: 'Claude finished in a workspace', body: 'ok', channel: 'ws:w2' }]);
    const off = apply(inPlan(), { type: 'prefs', prefs: { notify: { ...inPlan().prefs.notify, planMilestones: false } } });
    const run2 = apply(off, ev('me', 'me', 'started'));
    expect(detectNotices(run2, apply(run2, ev('me', 'me', 'done', 'ok')))).toEqual([{ kind: 'done', title: 'Claude finished in add-auth', body: 'ok', channel: 'ws:w1' }]);
  });

  it("a task's Claude asking is still news, titled by the plan", () => {
    const s = inPlan();
    expect(detectNotices(s, apply(s, { type: 'question_add', question: question('q1', 'question') }))).toEqual([
      { kind: 'needsYou', tag: 'question', ref: 'q1', title: 'Auth · KLD-12 asks: Which db?', body: 'Answer it to keep the plan going', channel: 'ws:w1', plan: 'pl1', planTask: 't1' },
    ]);
  });

  it('a milestone passing is one notice that says what is next', () => {
    const before = inPlan();
    const after = apply(before, { type: 'plan_put', plan: plan({ runs: { m1: { passedAt: 5, passedBy: { kind: 'beluga' } } } }) });
    expect(detectNotices(before, after)).toEqual([{ kind: 'done', tag: 'milestone', title: 'Auth: “API” passed', body: 'Next: “UI”', channel: 'ws:home', plan: 'pl1', key: 'plan:pl1:m1:passed:5' }]);
  });

  it('a failed check, a milestone waiting for you, and the plan finishing each notify', () => {
    const done = issue({ status: 'in_review' });
    const gated = plan({ autonomy: 'gated' });
    const before = inPlan(gated);
    const waiting = apply(before, { type: 'board_issue', issue: done });
    expect(detectNotices(before, waiting)).toMatchObject([{ kind: 'needsYou', tag: 'milestone', title: 'Auth: “API” is ready for you' }]);
    const failed = apply(waiting, { type: 'plan_put', plan: plan({ autonomy: 'gated', runs: { m1: { checkAsked: 1, check: { at: 2, by: { kind: 'beluga' }, verdict: 'fail', notes: 'Two tests fail' } } } }) });
    expect(detectNotices(waiting, failed)).toMatchObject([{ kind: 'problems', tag: 'milestone', title: 'Auth: “API” didn’t pass its check', body: 'Two tests fail' }]);
    const finished = apply(failed, { type: 'plan_put', plan: plan({ status: 'done', doneAt: 9 }) }, { type: 'board_issue', issue: issue({ status: 'in_review', pr: { number: 3, url: '', state: 'OPEN', title: 'x', draft: false, checks: 'passing' } }) });
    expect(detectNotices(failed, finished)).toEqual([{ kind: 'done', tag: 'milestone', title: 'Auth is done', body: 'Its pull request is ready to merge', channel: 'ws:home', plan: 'pl1', key: 'plan:pl1:done:9' }]);
  });

  it('a task stopping again after Beluga woke it, or a milestone past every rescue step, is yours: it says why', () => {
    const before = inPlan();
    const woken = apply(before, { type: 'plan_put', plan: plan({ watch: { t1: { at: 3, reason: 'it ended its turn without handing off', line: 'KLD-12 stopped', wokeAt: 2 } } }) });
    expect(detectNotices(before, woken)).toEqual([]);
    const twice = apply(woken, { type: 'plan_put', plan: plan({ watch: { t1: { at: 4, reason: 'it ended its turn without handing off', line: 'KLD-12 stopped', wokeAt: 2, needsYou: true } } }) });
    expect(detectNotices(woken, twice)).toEqual([
      { kind: 'needsYou', tag: 'milestone', title: 'Auth: “Login form” stopped twice', body: 'it ended its turn without handing off. Resume it, or open its chat', channel: 'ws:home', plan: 'pl1', need: 'plan:pl1:stalled:t1', key: 'plan:pl1:t1:stalled:4' },
    ]);
    // What it said last (usually what it waits on you for) is what the notification says.
    const asking = apply(woken, { type: 'plan_put', plan: plan({ watch: { t1: { at: 5, reason: 'it ended its turn without handing off', line: 'KLD-12 stopped', wokeAt: 2, needsYou: true, said: 'Put the .env in /opt/app on the server, then I deploy.' } } }) });
    expect(detectNotices(woken, asking)).toMatchObject([
      { kind: 'needsYou', title: 'Auth: “Login form” needs you', body: 'It says: “Put the .env in /opt/app on the server, then I deploy.” Do what it asks, then Resume it', need: 'plan:pl1:stalled:t1' },
    ]);
    // On the phone (its card and its push), what it said comes without code, as Claude's answers do.
    const withCode = apply(woken, { type: 'plan_put', plan: plan({ watch: { t1: { at: 5, reason: 'r', line: 'KLD-12 stopped', wokeAt: 2, needsYou: true, said: 'Run this on the server:\n```sh\nexport DB_PASSWORD=hunter2\n```\nthen I deploy.' } } }) });
    const card = needsYou(withCode).find((n) => n.id === 'plan:pl1:stalled:t1');
    expect(card?.detail).toMatch(/^It says: “Run this on the server:.*then I deploy\.” Do what it asks, then Resume it\.$/);
    expect(card?.detail).not.toContain('hunter2');
    const rescued = apply(before, { type: 'plan_put', plan: plan({ rescue: { m1: { sig: 's', tries: 3, at: 7, tried: ['woke KLD-12', 'restarted it'], yours: true } } }) });
    expect(detectNotices(before, rescued)).toMatchObject([{ kind: 'needsYou', title: 'Auth: stuck on “API”', body: 'Beluga tried: woke KLD-12; restarted it', need: 'plan:pl1:rescue:m1' }]);
    const conflict = { at: 8, dir: '/wt/merge', merging: 'klaud/a', key: 'KLD-12', files: ['src/a.ts'] };
    const merging = apply(before, { type: 'plan_put', plan: plan({ merging: { m1: { at: 7, by: { kind: 'beluga' }, conflict } } }) });
    expect(detectNotices(before, merging)).toEqual([]);
    const stuckMerge = apply(merging, { type: 'plan_put', plan: plan({ merging: { m1: { at: 7, by: { kind: 'beluga' }, conflict: { ...conflict, stuck: true } } } }) });
    expect(detectNotices(merging, stuckMerge)).toMatchObject([{ kind: 'needsYou', tag: 'conflict', title: 'Auth: merging “API” hit a conflict Claude couldn’t fix', body: 'KLD-12 conflicts in src/a.ts: fix it in /wt/merge and it passes' }]);
    // Still stuck is not news again.
    expect(detectNotices(rescued, apply(rescued, { type: 'plan_put', plan: plan({ rescue: { m1: { sig: 's', tries: 3, at: 7, tried: ['woke KLD-12', 'restarted it'], yours: true } } }) }))).toEqual([]);
  });

  it('plans already there when you start are not news', () => {
    const s = base();
    expect(detectNotices(s, inPlan(plan({ runs: { m1: { passedAt: 5 } } })))).toEqual([]);
  });

  describe('Notifier', () => {
    beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
    afterEach(() => vi.useRealTimers());

    it('no desktop note for a task finishing; one for a milestone passing, and never twice', () => {
      const store = new Store(inPlan());
      const desktop = vi.fn();
      const notifier = new Notifier({ store, desktop, burstMs: 0 });
      store.dispatch(ev('me', 'me', 'started'));
      store.dispatch(ev('me', 'me', 'done', 'shipped'));
      vi.advanceTimersByTime(10);
      expect(desktop).not.toHaveBeenCalled();
      expect(store.getState().inbox).toMatchObject([{ title: 'Auth · KLD-12: Claude finished in add-auth', plan: 'pl1', read: true }]);

      const passed = plan({ runs: { m1: { passedAt: 5 } } });
      store.dispatch({ type: 'plan_put', plan: passed });
      vi.advanceTimersByTime(10);
      expect(desktop).toHaveBeenCalledTimes(1);
      expect(desktop.mock.calls[0]?.[0]).toMatchObject({ title: 'Auth: “API” passed', body: 'Next: “UI”', sound: true });
      // The same state sent again (a restart, a re-sent plan) says nothing new.
      store.dispatch({ type: 'plan_put', plan: plan() });
      store.dispatch({ type: 'plan_put', plan: passed });
      vi.advanceTimersByTime(10);
      expect(desktop).toHaveBeenCalledTimes(1);
      expect(store.getState().inbox.filter((n) => n.tag === 'milestone')).toHaveLength(1);
      notifier.stop();
    });

    it("a direct notice about a plan task's pull request is quiet; a question in it rings, titled by the plan", () => {
      const store = new Store(inPlan());
      const desktop = vi.fn();
      const notifier = new Notifier({ store, desktop, burstMs: 0 });
      notifier.notify({ kind: 'pr', title: 'PR #3 was merged', body: 'add-auth', channel: 'ws:w1' });
      vi.advanceTimersByTime(10);
      expect(desktop).not.toHaveBeenCalled();
      store.dispatch({ type: 'question_add', question: question('q1', 'question') });
      vi.advanceTimersByTime(10);
      expect(desktop).toHaveBeenCalledTimes(1);
      expect(desktop.mock.calls[0]?.[0]).toMatchObject({ title: 'Auth · KLD-12 asks: Which db?', channel: 'ws:w1' });
      notifier.stop();
    });
  });
});

describe('a notice about something that waits for you (BLG-255)', () => {
  it('is read once that request is answered, wherever it was answered', () => {
    const store = new Store(base());
    const notifier = new Notifier({ store, desktop: vi.fn() });
    store.dispatch({ type: 'net_offer', offer: { peerId: 'rae', name: 'rae', dir: 'in', at: 5, expiresAt: Date.now() + 60_000 } });
    notifier.notify({ kind: 'needsYou', tag: 'invited', title: 'rae wants to add you as a friend', body: '', need: 'friend:rae' });
    expect(store.getState().inbox).toMatchObject([{ need: 'friend:rae', read: false }]);
    // Something else changes: still waiting, still unread.
    store.dispatch({ type: 'net_offer', offer: { peerId: 'zed', name: 'zed', dir: 'in', at: 6, expiresAt: Date.now() + 60_000 } });
    expect(store.getState().inbox[0]!.read).toBe(false);
    store.dispatch({ type: 'net_offer_gone', peerId: 'rae', dir: 'in' });
    expect(store.getState().inbox[0]!.read).toBe(true);
    notifier.stop();
  });
});

describe('a task comment that mentions you (BLG-419)', () => {
  const NOW = 10_000_000;
  const task: Issue = {
    id: 'i7',
    key: 'KLD-7',
    number: 7,
    projectId: 'p1',
    title: 'Login form',
    status: 'todo',
    priority: 'none',
    labels: [],
    blockedBy: [],
    related: [],
    rank: 0,
    brief: {},
    revisions: [],
    worktrees: [],
    proof: [],
    activity: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: { kind: 'beluga' },
    origin: 'manual',
  };
  const comment = (id: string, body: string, by: Issue['activity'][number]['by'] = { kind: 'person', id: 'b', name: 'bob' }, at = NOW) => ({ id, at, by, kind: 'comment' as const, text: 'commented', body });
  const board = (s: DomainState, i: Issue): DomainState => apply(s, { type: 'board_issue', issue: i });
  const start = (): DomainState => apply(base(), { type: 'identity', selfId: 'me', isHost: false }, { type: 'board_init', state: { enabled: true, issues: [task], projects: {}, autoTasks: false } });

  it('tells you who mentioned you, on which task, and opens the task', () => {
    const prev = start();
    const next = board(prev, { ...task, activity: [comment('a1', '@kay can you look at this?'), comment('a2', 'no mention here')] });
    expect(detectNotices(prev, next, NOW)).toEqual([{ kind: 'mentions', tag: 'mention', title: 'bob mentioned you on KLD-7', body: '@kay can you look at this?', channel: 'task:i7', key: 'task-mention:a1' }]);
  });

  it('stays quiet for your own comments, Claude’s notes, someone else’s name and old comments', () => {
    const prev = start();
    const next = board(prev, {
      ...task,
      activity: [
        comment('a1', '@kay note to self', { kind: 'person', id: 'me', name: 'kay' }),
        { ...comment('a2', '@kay done'), kind: 'note' as const },
        comment('a3', '@kayla look'),
        comment('a4', '@kay old', undefined, NOW - 13 * 60 * 60_000),
      ],
    });
    expect(detectNotices(prev, next, NOW)).toEqual([]);
  });
});
