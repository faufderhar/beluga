import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NoticeEvent, Notifier } from '../src/core/notify.js';
import { type DomainState, type LogItem, Store, initialState } from '../src/core/store.js';
import type { PendingQuestion } from '../src/core/collab-store.js';
import { TriageService } from '../src/core/triage/service.js';
import { Board } from '../src/core/board/board.js';
import type { Issue } from '../src/core/board/model.js';
import { normalizeBody } from '../src/core/plans/edit.js';
import type { Plan } from '../src/core/plans/model.js';
import { categoryOf } from '../src/core/triage/model.js';
import { triageFacts } from '../src/core/triage/facts.js';
import { PHONE } from '../src/companion/coverage.js';
import { encodeFailure } from '../src/shared/run-failure.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import type { WorktreeEvent } from '../src/core/workspace-controller.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const CH = 'ws:w1';

const ws = (id: string, more: Partial<Workspace> = {}): Workspace => ({ id, projectId: 'p1', projectRoot: '/tmp/app', name: id, path: `/tmp/app-${id}`, kind: 'worktree', createdAt: NOW - HOUR, external: false, ...more }) as Workspace;
const project = (...workspaces: Workspace[]): Project => ({ id: 'p1', name: 'app', root: '/tmp/app', base: 'main', workspaces }) as Project;
const me = { peerId: 'me', name: 'rob' } as NonNullable<DomainState['self']>;
const question = (qid: string, channel = CH): PendingQuestion => ({ qid, requestId: qid, owner: 'me', channel, picked: {}, question: { kind: 'question', questions: [{ question: 'Which?', header: '', options: [], multiSelect: false }] } });

let dir: string;
let file: string;
let notices: NoticeEvent[];
let services: TriageService[];

function makeStore(on = true, projects: readonly Project[] = [project(ws('w1'), ws('w2'))]): Store {
  const store = new Store({ ...initialState('room', 'ask', { chatCategories: on }), projects, self: me, selfId: 'me' });
  return store;
}

function start(store: Store, history: (id: string) => readonly LogItem[] = () => []): TriageService {
  const service = new TriageService({ store, file, notify: (e) => notices.push(e), history, now: () => Date.now() });
  services.push(service);
  return service;
}

const category = (store: Store, key = CH) => categoryOf(store.getState().triage[key], triageFacts(store.getState(), key));
const chat = (store: Store, from: string, text: string, more: { byAgent?: boolean; channel?: string } = {}) => store.dispatch({ type: 'chat', id: `c${Date.now()}${text}`, from, text, ts: Date.now(), byAgent: more.byAgent ?? false, channel: more.channel ?? CH });
const run = (store: Store, event: 'started' | 'text' | 'done' | 'error', requestId = 'r1', channel = CH) => store.dispatch({ type: 'agent_event', owner: 'me', requestId, requester: 'me', event, text: 'hi', ts: Date.now(), channel });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  dir = mkdtempSync(path.join(os.tmpdir(), 'triage-'));
  file = path.join(dir, 'triage.json');
  notices = [];
  services = [];
});

afterEach(() => {
  for (const s of services) s.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('saving', () => {
  it('state survives a restart', () => {
    const store = makeStore();
    const service = start(store);
    service.settle(CH);
    service.snooze('ws:w2', NOW + HOUR);
    service.stop();

    const again = makeStore();
    start(again);
    expect(again.getState().triage[CH]?.settled?.why).toBe('you');
    expect(again.getState().triage['ws:w2']?.snoozed?.until).toBe(NOW + HOUR);
  });

  it('saves soon after a change, with an atomic write', () => {
    const store = makeStore();
    start(store).settle(CH);
    vi.advanceTimersByTime(1_500);
    expect(JSON.parse(readFileSync(file, 'utf8')).chats[CH].settled.why).toBe('you');
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('removes entries of deleted conversations at load, and keeps a friend’s chat', () => {
    writeFileSync(file, JSON.stringify({ chats: { [CH]: { lastAt: 1 }, 'ws:gone': { lastAt: 1 }, 'ws:friend': { lastAt: 1, shared: true } } }));
    const store = makeStore();
    start(store);
    expect(Object.keys(store.getState().triage).sort()).toEqual(['ws:friend', CH, 'ws:w2']);
  });

  it('waits for the projects before it removes anything', () => {
    writeFileSync(file, JSON.stringify({ chats: { [CH]: { settled: { at: 1, why: 'you' } }, 'ws:gone': { lastAt: 1 } } }));
    const store = makeStore(true, []);
    start(store);
    expect(store.getState().triage[CH]).toBeDefined();
    store.dispatch({ type: 'projects', projects: [project(ws('w1'))] });
    expect(store.getState().triage['ws:gone']).toBeUndefined();
    expect(store.getState().triage[CH]?.settled?.why).toBe('you');
  });

  it('a broken file or record costs only itself', () => {
    writeFileSync(file, '{ nope');
    const one = makeStore();
    start(one);
    expect(one.getState().triage[CH]?.settled).toBeUndefined();

    writeFileSync(file, JSON.stringify({ chats: { [CH]: { settled: { at: 'x' } }, 'ws:w2': { settled: { at: 1, why: 'idle' } } } }));
    const two = makeStore();
    start(two);
    expect(two.getState().triage[CH]?.settled).toBeUndefined();
    expect(two.getState().triage['ws:w2']?.settled?.why).toBe('idle');
  });

  it('seeds lastAt once from the last history item, or createdAt when empty', () => {
    const history = vi.fn((id: string) => (id === 'w1' ? ([{ id: 'x', type: 'system', channel: CH, text: '', ts: NOW - 5, level: 'info' }] as LogItem[]) : []));
    const store = makeStore();
    start(store, history);
    expect(store.getState().triage[CH]?.lastAt).toBe(NOW - 5);
    expect(store.getState().triage['ws:w2']?.lastAt).toBe(NOW - HOUR);
    history.mockClear();
    store.dispatch({ type: 'projects', projects: [project(ws('w1'), ws('w2'))] });
    expect(history).not.toHaveBeenCalled();
  });
});

describe('the setting', () => {
  it('off: no transition, no file and no timer', () => {
    const store = makeStore(false);
    const service = start(store);
    expect(vi.getTimerCount()).toBe(0);
    chat(store, 'bob', 'hi @rob');
    run(store, 'started');
    run(store, 'done');
    store.dispatch({ type: 'question_add', question: question('q1') });
    vi.advanceTimersByTime(10 * 60_000);
    expect(store.getState().triage).toEqual({});
    expect(existsSync(file)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(notices).toEqual([]);
    expect(() => service.settle(CH)).toThrow(/off/);
    expect(() => service.unsettle(CH)).toThrow(/off/);
    expect(() => service.setAutoSettle(CH, false)).toThrow(/off/);
  });

  it('off: Remind Me Later still works, and only what ends it reaches the record', () => {
    const store = makeStore(false);
    const service = start(store);
    service.snooze(CH, NOW + HOUR);
    vi.advanceTimersByTime(1_500);
    expect(JSON.parse(readFileSync(file, 'utf8')).chats[CH].snoozed.until).toBe(NOW + HOUR);
    // Another chat's news writes nothing, and nothing settles.
    chat(store, 'bob', 'hi', { channel: 'ws:w2' });
    run(store, 'started', 'r2', 'ws:w2');
    run(store, 'done', 'r2', 'ws:w2');
    expect(store.getState().triage['ws:w2']).toBeUndefined();
    // Its time comes: one reminder.
    vi.advanceTimersByTime(HOUR);
    expect(store.getState().triage[CH]?.snoozed).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'needsYou', tag: 'woke', title: 'Reminder: w1', body: 'You asked to be reminded about it', channel: CH });
    // Nothing put off: no timer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('off: your message or Show Again Now ends it early, with no reminder', () => {
    const store = makeStore(false);
    const service = start(store);
    service.snooze(CH, NOW + HOUR);
    chat(store, 'me', 'back to this');
    expect(store.getState().triage[CH]?.snoozed).toBeUndefined();
    service.snooze('ws:w2', NOW + HOUR);
    service.wake('ws:w2');
    expect(store.getState().triage['ws:w2']?.snoozed).toBeUndefined();
    vi.advanceTimersByTime(2 * HOUR);
    expect(notices).toEqual([]);
  });

  it('off: a new question brings it back', () => {
    const store = makeStore(false);
    start(store).snooze(CH, NOW + HOUR);
    store.dispatch({ type: 'question_add', question: question('q1') });
    expect(store.getState().triage[CH]?.snoozed).toBeUndefined();
  });

  it('turning it off stops the timer, and on again restores what was stored', () => {
    const store = makeStore();
    start(store).settle(CH);
    store.dispatch({ type: 'prefs', prefs: { chatCategories: false } });
    // It saves once (when each chat was last active is left out), then nothing waits.
    vi.advanceTimersByTime(1_500);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).chats[CH].lastAt).toBeUndefined();
    store.dispatch({ type: 'prefs', prefs: { chatCategories: true } });
    expect(store.getState().triage[CH]?.settled?.why).toBe('you');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('turning it on seeds the time again, so an old time does not count', () => {
    const store = makeStore();
    start(store);
    store.dispatch({ type: 'prefs', prefs: { chatCategories: false } });
    vi.setSystemTime(NOW + 100 * HOUR);
    chat(store, 'bob', 'while off');
    store.dispatch({ type: 'prefs', prefs: { chatCategories: true } });
    expect(store.getState().triage[CH]?.lastAt).toBe(NOW + 100 * HOUR);
  });
});

describe('messages and turns', () => {
  const settled = (store: Store, service: TriageService) => {
    service.settle(CH);
    expect(category(store)).toBe('settled');
  };
  const snoozed = (store: Store, service: TriageService) => {
    service.snooze(CH, NOW + HOUR);
    expect(category(store)).toBe('snoozed');
  };

  it('own message and turn start move a settled chat to Working', () => {
    const store = makeStore();
    settled(store, start(store));
    chat(store, 'me', 'go on');
    expect(store.getState().triage[CH]?.settled).toBeUndefined();
    run(store, 'started');
    expect(category(store)).toBe('working');
  });

  it('a turn that starts by itself moves a settled chat to Working', () => {
    const store = makeStore();
    settled(store, start(store));
    run(store, 'started');
    expect(category(store)).toBe('working');
  });

  it('a person moves a settled chat to Active', () => {
    const store = makeStore();
    settled(store, start(store));
    chat(store, 'bob', 'hello');
    expect(category(store)).toBe('active');
  });

  it('a system notice leaves a settled chat alone', () => {
    const store = makeStore();
    settled(store, start(store));
    const before = store.getState().triage;
    store.dispatch({ type: 'system', text: 'note', channel: CH });
    expect(store.getState().triage).toBe(before);
  });

  it('your own message ends a snooze with no Back', () => {
    const store = makeStore();
    snoozed(store, start(store));
    chat(store, 'me', 'wait');
    expect(category(store)).toBe('active');
    expect(store.getState().triage[CH]?.backAt).toBeUndefined();
  });

  it('a mention ends a snooze with Back', () => {
    const store = makeStore();
    snoozed(store, start(store));
    chat(store, 'bob', 'look @rob please');
    expect(category(store)).toBe('active');
    expect(store.getState().triage[CH]?.backAt).toBe(NOW);
  });

  it('a person without a mention, agent text and a turn end leave a snooze', () => {
    const store = makeStore();
    snoozed(store, start(store));
    chat(store, 'bob', 'hello @robert');
    chat(store, 'me', 'text', { byAgent: true });
    run(store, 'started');
    run(store, 'done');
    expect(category(store)).toBe('snoozed');
    expect(store.getState().unread[CH]).toBeGreaterThan(0);
  });

  it('a new question ends a snooze; one open when you snoozed does not', () => {
    const store = makeStore();
    store.dispatch({ type: 'question_add', question: question('q1') });
    const service = start(store);
    service.snooze(CH, NOW + HOUR);
    expect(store.getState().triage[CH]?.snoozed?.seen).toEqual(['q1']);
    expect(category(store)).toBe('snoozed');
    store.dispatch({ type: 'question_add', question: question('q2') });
    expect(store.getState().triage[CH]?.snoozed).toBeUndefined();
    expect(store.getState().triage[CH]?.backAt).toBe(NOW);
  });

  it('your answer ends a snooze with no Back; a question that timed out does not', () => {
    const store = makeStore();
    store.dispatch({ type: 'question_add', question: question('q1') });
    store.dispatch({ type: 'question_add', question: question('q2') });
    start(store).snooze(CH, NOW + HOUR);
    store.dispatch({ type: 'question_remove', qid: 'q1', unanswered: true });
    expect(store.getState().triage[CH]?.snoozed).toBeDefined();
    store.dispatch({ type: 'question_remove', qid: 'q2' });
    expect(store.getState().triage[CH]?.snoozed).toBeUndefined();
    expect(store.getState().triage[CH]?.backAt).toBeUndefined();
  });

  it('a run that fails after the snooze ends it; an older failure does not', () => {
    const store = makeStore();
    run(store, 'started');
    run(store, 'error');
    vi.setSystemTime(NOW + 1_000);
    start(store).snooze(CH, NOW + HOUR);
    run(store, 'text', 'r0', 'ws:w2');
    expect(category(store)).toBe('snoozed');
    vi.setSystemTime(NOW + 2_000);
    run(store, 'started', 'r2');
    run(store, 'error', 'r2');
    expect(store.getState().triage[CH]?.snoozed).toBeUndefined();
    expect(store.getState().triage[CH]?.backAt).toBe(NOW + 2_000);
  });

  it('a usage-limit stop that Beluga continues leaves a snooze; with auto-continue off it ends it', () => {
    const limit = (store: Store, requestId: string) => {
      run(store, 'started', requestId);
      store.dispatch({ type: 'agent_event', owner: 'me', requestId, requester: 'me', event: 'error', text: encodeFailure({ kind: 'usage_limit', detail: 'limit' }, NOW), ts: Date.now(), channel: CH });
    };
    const store = makeStore();
    start(store).snooze(CH, NOW + HOUR);
    vi.setSystemTime(NOW + 500);
    limit(store, 'r1');
    expect(category(store)).toBe('snoozed');

    const off = makeStore();
    off.dispatch({ type: 'prefs', prefs: { autoContinue: false } });
    start(off).snooze(CH, NOW + HOUR);
    vi.setSystemTime(NOW + 1_000);
    limit(off, 'r2');
    expect(off.getState().triage[CH]?.snoozed).toBeUndefined();
    expect(off.getState().triage[CH]?.backAt).toBe(NOW + 1_000);
  });

  it('the automatic Continue after a usage limit leaves a snooze; on a settled chat its turn gives Working', () => {
    const store = makeStore();
    const service = start(store);
    service.snooze(CH, NOW + HOUR);
    service.automatic(() => chat(store, 'me', 'Continue where you left off.'));
    expect(category(store)).toBe('snoozed');

    service.settle('ws:w2');
    service.automatic(() => chat(store, 'me', 'Continue where you left off.', { channel: 'ws:w2' }));
    expect(category(store, 'ws:w2')).toBe('settled');
    run(store, 'started', 'r2', 'ws:w2');
    expect(category(store, 'ws:w2')).toBe('working');

    chat(store, 'me', 'Continue where you left off.');
    expect(category(store)).toBe('active');
  });

  it('activity stores lastAt and clears holdIdle', () => {
    const store = makeStore();
    const service = start(store);
    service.settle(CH);
    service.unsettle(CH);
    expect(store.getState().triage[CH]?.holdIdle).toBe(true);
    vi.setSystemTime(NOW + 5);
    chat(store, 'bob', 'hello');
    expect(store.getState().triage[CH]?.holdIdle).toBeUndefined();
    expect(store.getState().triage[CH]?.lastAt).toBe(NOW + 5);
  });

  it('what has no category gets no record', () => {
    const store = makeStore(true, [project(ws('w1'), ws('m', { kind: 'main' }), ws('old', { archived: true }))]);
    start(store);
    const before = store.getState().triage;
    chat(store, 'bob', 'hi', { channel: 'room' });
    chat(store, 'bob', 'hi', { channel: 'mac:assistant:1' });
    chat(store, 'bob', 'hi', { channel: 'ws:m' });
    chat(store, 'bob', 'hi', { channel: 'ws:old' });
    expect(store.getState().triage).toBe(before);
  });
});

describe('the wake timer', () => {
  it('a snooze longer than the idle days wakes to Active with Back, and the idle days start again', () => {
    const store = makeStore();
    const service = start(store);
    store.dispatch({ type: 'projects', projects: store.getState().projects });
    service.snooze(CH, NOW + 7 * 24 * HOUR);
    vi.advanceTimersByTime(7 * 24 * HOUR + 2 * 60_000);
    expect(category(store)).toBe('active');
    expect(store.getState().triage[CH]?.backAt).toBeDefined();
    expect(notices).toHaveLength(1);
    vi.advanceTimersByTime(4 * 24 * HOUR);
    expect(category(store)).toBe('settled');
  });

  it('ends a snooze on time, with Back and one notice', () => {
    const store = makeStore();
    start(store).snooze(CH, NOW + 45_000);
    vi.advanceTimersByTime(44_000);
    expect(category(store)).toBe('snoozed');
    vi.advanceTimersByTime(2_000);
    expect(category(store)).toBe('active');
    expect(store.getState().triage[CH]?.backAt).toBe(NOW + 45_000);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'needsYou', tag: 'woke', channel: CH });
    vi.advanceTimersByTime(120_000);
    expect(notices).toHaveLength(1);
  });

  it('a snooze that ended while the daemon was stopped wakes at startup, with one notice', () => {
    writeFileSync(file, JSON.stringify({ chats: { [CH]: { snoozed: { at: NOW - 2 * HOUR, until: NOW - HOUR, seen: [] }, lastAt: NOW - 3 * HOUR } } }));
    const store = makeStore();
    start(store);
    expect(store.getState().triage[CH]?.snoozed).toBeUndefined();
    expect(store.getState().triage[CH]?.backAt).toBe(NOW);
    expect(notices).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(notices).toHaveLength(1);
  });

  it('uses the quiet kind when you turned Needs You off', () => {
    const store = makeStore();
    store.dispatch({ type: 'prefs', prefs: { notify: { ...store.getState().prefs.notify, needsYou: false } } });
    start(store).snooze(CH, NOW + 1_000);
    vi.advanceTimersByTime(1_500);
    expect(notices[0]?.kind).toBe('background');
  });

  it('wakes while a turn runs: Working with Back', () => {
    const store = makeStore();
    const service = start(store);
    service.snooze(CH, NOW + HOUR);
    run(store, 'started');
    service.wake(CH);
    expect(category(store)).toBe('working');
    expect(store.getState().triage[CH]?.backAt).toBe(NOW);
    expect(notices).toEqual([]);
  });

  it('opening a woken chat clears the Back state', () => {
    const store = makeStore();
    start(store).snooze(CH, NOW + 1_000);
    vi.advanceTimersByTime(1_500);
    expect(store.getState().triage[CH]?.backAt).toBeDefined();
    store.dispatch({ type: 'attention', attention: { shown: [CH], visible: [CH], files: false, front: true } });
    expect(store.getState().triage[CH]?.backAt).toBeUndefined();
    expect(store.getState().triage[CH]?.lastAt).toBeDefined();
  });
});

describe('Remind Me Later from before BLG-770', () => {
  const forgot: string[][] = [];
  const startWith = (store: Store): TriageService => {
    const service = new TriageService({ store, file, notify: (e) => notices.push(e), history: () => [], now: () => Date.now(), forgetReminders: (ids) => forgot.push([...ids]) });
    services.push(service);
    return service;
  };
  beforeEach(() => void forgot.splice(0));

  it('a time still ahead becomes a snooze, once, and is cleared on the worktree', () => {
    for (const on of [true, false]) {
      forgot.splice(0);
      rmSync(file, { force: true });
      const at = Date.now() + HOUR;
      const store = makeStore(on, [project(ws('w1', { remindAt: at }), ws('w2'), ws('old', { remindAt: at, archived: true }))]);
      startWith(store);
      expect(store.getState().triage[CH]?.snoozed?.until).toBe(at);
      expect(forgot).toEqual([['w1', 'old']]);
      // The record still says so until the clear publishes: carried once.
      store.dispatch({ type: 'projects', projects: store.getState().projects });
      expect(forgot).toHaveLength(1);
      vi.advanceTimersByTime(HOUR + 1_000);
      expect(notices.at(-1)).toMatchObject({ title: 'Reminder: w1', channel: CH });
    }
  });

  it('one that came due while Beluga was closed reminds you at start', () => {
    const store = makeStore(false, [project(ws('w1', { remindAt: NOW - HOUR }), ws('w2'))]);
    startWith(store);
    vi.advanceTimersByTime(1);
    expect(store.getState().triage[CH]?.snoozed).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: 'Reminder: w1' });
  });

  it('keeps a snooze you set since', () => {
    writeFileSync(file, JSON.stringify({ chats: { [CH]: { snoozed: { at: NOW, until: NOW + 5 * HOUR, seen: [] } } } }));
    const store = makeStore(true, [project(ws('w1', { remindAt: NOW + HOUR }), ws('w2'))]);
    startWith(store);
    expect(store.getState().triage[CH]?.snoozed?.until).toBe(NOW + 5 * HOUR);
    expect(forgot).toEqual([['w1']]);
  });
});

describe('the reminder', () => {
  it('says what waits there: a conflict, failing checks, news', () => {
    const store = makeStore(false);
    start(store).snooze(CH, NOW + HOUR);
    store.dispatch({ type: 'conflicts', id: 'w1', files: ['a.ts'] });
    store.dispatch({ type: 'pr', id: 'w1', pr: { number: 3, url: 'u', state: 'OPEN', title: 't', draft: false, checks: 'failing' } });
    chat(store, 'bob', 'news');
    vi.advanceTimersByTime(HOUR + 1_000);
    expect(notices[0]?.body).toBe('A merge conflict to resolve · Checks failed on its pull request · 1 new message');
  });
});

describe('notifications', () => {
  const inbox = (store: Store) => store.getState().inbox.map((n) => n.title);

  const unread = (store: Store) => store.getState().inbox.filter((n) => !n.read).map((n) => n.title);

  for (const on of [true, false]) {
    it(`a turn finishing in a chat put off till later is quiet (already read, no desktop); a question in it is not (categories ${on ? 'on' : 'off'})`, () => {
      const store = makeStore(on);
      const desktop: string[] = [];
      const notifier = new Notifier({ store, desktop: (n) => desktop.push(n.title) });
      start(store).snooze(CH, NOW + HOUR);
      run(store, 'started');
      run(store, 'done');
      vi.advanceTimersByTime(5_000);
      expect(inbox(store)).toHaveLength(1);
      expect(unread(store)).toEqual([]);
      expect(desktop).toEqual([]);
      store.dispatch({ type: 'question_add', question: question('q1') });
      expect(unread(store)).toHaveLength(1);
      notifier.stop();
    });
  }
});

describe('the API', () => {
  it('refuses a snooze in the past and settling a working chat', () => {
    const store = makeStore();
    const service = start(store);
    expect(() => service.snooze(CH, NOW - 1)).toThrow(/future/);
    run(store, 'started');
    expect(() => service.settle(CH)).toThrow(/working/);
  });

  it('settling clears unread', () => {
    const store = makeStore();
    const service = start(store);
    chat(store, 'bob', 'hello');
    expect(store.getState().unread[CH]).toBe(1);
    service.settle(CH);
    expect(store.getState().unread[CH]).toBeUndefined();
  });

  it('refuses a chat with no category', () => {
    expect(() => start(makeStore()).settle('room')).toThrow(/no category/);
  });

  it('turns auto-settle off and on for one chat', () => {
    const store = makeStore();
    const service = start(store);
    service.setAutoSettle(CH, false);
    expect(store.getState().triage[CH]?.autoSettle).toBe(false);
    service.setAutoSettle(CH, true);
    expect(store.getState().triage[CH]?.autoSettle).toBeUndefined();
  });

  it('every method is the phone’s', () => {
    for (const m of ['triage.settle', 'triage.unsettle', 'triage.snooze', 'triage.wake', 'triage.setAutoSettle'] as const) expect(PHONE[m]).toBe('phone');
  });
});

describe('auto-settle', () => {
  const DAY = 24 * HOUR;
  const pr = (number: number, state: 'OPEN' | 'CLOSED' | 'MERGED') => ({ number, url: 'u', state, title: 't', draft: false, checks: 'none' as const });
  const setPr = (store: Store, number: number, state: 'OPEN' | 'CLOSED' | 'MERGED' = 'MERGED', id = 'w1') => store.dispatch({ type: 'pr', id, pr: pr(number, state) });

  describe('on merge', () => {
    it('a PR that becomes MERGED settles the chat with its number', () => {
      const store = makeStore();
      start(store);
      setPr(store, 7, 'OPEN');
      expect(category(store)).toBe('active');
      setPr(store, 7);
      expect(store.getState().triage[CH]?.settled).toEqual({ at: NOW, why: 'pr_merged', pr: 7 });
      expect(store.getState().triage[CH]?.settledPr).toBe(7);
    });

    it('a closed PR does not settle the chat', () => {
      const store = makeStore();
      start(store);
      setPr(store, 7, 'CLOSED');
      expect(category(store)).toBe('active');
    });

    it('a merge during a turn settles the chat when the turn ends', () => {
      const store = makeStore();
      start(store);
      run(store, 'started');
      setPr(store, 7);
      expect(category(store)).toBe('working');
      run(store, 'done');
      expect(category(store)).toBe('settled');
    });

    it('a merge while a question is open settles the chat once it is answered', () => {
      const store = makeStore();
      start(store);
      store.dispatch({ type: 'question_add', question: question('q1') });
      setPr(store, 7);
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
      store.dispatch({ type: 'question_remove', qid: 'q1' });
      expect(category(store)).toBe('settled');
    });

    it('a merge settles a snoozed chat', () => {
      const store = makeStore();
      start(store).snooze(CH, NOW + HOUR);
      setPr(store, 7);
      expect(store.getState().triage[CH]?.snoozed).toBeUndefined();
      expect(category(store)).toBe('settled');
    });

    it('a question open before the snooze holds the merge settle until you answer it', () => {
      const store = makeStore();
      store.dispatch({ type: 'question_add', question: question('q1') });
      start(store).snooze(CH, NOW + HOUR);
      setPr(store, 7);
      expect(category(store)).toBe('snoozed');
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
      expect(store.getState().triage[CH]?.settledPr).toBeUndefined();
      store.dispatch({ type: 'question_remove', qid: 'q1' });
      expect(category(store)).toBe('settled');
      expect(store.getState().triage[CH]?.settled).toEqual({ at: NOW, why: 'pr_merged', pr: 7 });
      expect(store.getState().triage[CH]?.settledPr).toBe(7);
    });

    it('a question opened after the snooze still ends the snooze', () => {
      const store = makeStore();
      start(store).snooze(CH, NOW + HOUR);
      store.dispatch({ type: 'question_add', question: question('q1') });
      expect(store.getState().triage[CH]?.snoozed).toBeUndefined();
      expect(store.getState().triage[CH]?.backAt).toBe(NOW);
      setPr(store, 7);
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
    });

    it('after Un-settle the same PR does not settle again; a new number does', () => {
      const store = makeStore();
      const service = start(store);
      setPr(store, 7);
      service.unsettle(CH);
      setPr(store, 7);
      run(store, 'started');
      run(store, 'done');
      vi.advanceTimersByTime(2 * 60_000);
      expect(category(store)).toBe('active');
      setPr(store, 8);
      expect(store.getState().triage[CH]?.settled?.pr).toBe(8);
    });

    it('a PR you continued past does not settle', () => {
      const store = makeStore(true, [project(ws('w1', { prDone: 7 }))]);
      start(store);
      setPr(store, 7);
      expect(category(store)).toBe('active');
    });

    it('a restart and the first enable settle what merged meanwhile', () => {
      const store = makeStore(false);
      setPr(store, 7);
      start(store);
      expect(store.getState().triage).toEqual({});
      store.dispatch({ type: 'prefs', prefs: { chatCategories: true } });
      expect(category(store)).toBe('settled');
    });

    it('settleOnMerge off stops it', () => {
      const store = makeStore();
      store.dispatch({ type: 'prefs', prefs: { settleOnMerge: false } });
      start(store);
      setPr(store, 7);
      expect(category(store)).toBe('active');
    });

    it('autoSettle false on the chat stops it', () => {
      const store = makeStore();
      start(store).setAutoSettle(CH, false);
      setPr(store, 7);
      expect(category(store)).toBe('active');
    });
  });

  describe('a plan row', () => {
    const KEY = 'plan:p';
    const HOME = 'ws:home';
    const body = normalizeBody({ title: 'P', goal: 'g', milestones: [{ id: 'one', title: 'One', tasks: [{ id: 'a', title: 'A', issueId: 'ia' }] }] });
    const plan = (over: Partial<Plan> = {}): Plan => ({ id: 'p', projectId: 'p1', home: HOME, status: 'active', body, draftRev: 1, autonomy: 'gated', maxParallel: 3, paused: false, testsAt: 'end', runs: {}, activity: [], createdAt: 0, updatedAt: 0, ...over });
    const issue = { id: 'ia', key: 'X-1', number: 1, projectId: 'p1', title: 'A', status: 'in_progress', priority: 'medium', labels: [], blockedBy: [], related: [], rank: 0, brief: {}, revisions: [], worktrees: ['w1'] } as unknown as Issue;
    const planStore = (on = true, over: Partial<Plan> = {}): Store => {
      const base = makeStore(on, [project(ws('w1'), ws('home'))]).getState();
      return new Store({ ...base, board: { ...base.board, issues: [issue] }, plans: { ...base.plans, plans: [plan(over)] } });
    };
    /** Every milestone passed, so the plan is done, and its own PR merged: how it really looks when that PR merges. */
    const merged = (store: Store, number = 9) => store.dispatch({ type: 'plan_put', plan: plan({ status: 'done', pr: pr(number, 'MERGED') }) });

    it('the plan’s own PR merging settles the row with its number', () => {
      const store = planStore();
      start(store);
      store.dispatch({ type: 'plan_put', plan: plan({ pr: pr(9, 'OPEN') }) });
      expect(store.getState().triage[KEY]?.settled).toBeUndefined();
      merged(store);
      expect(store.getState().triage[KEY]?.settled).toEqual({ at: NOW, why: 'pr_merged', pr: 9 });
      expect(store.getState().triage[KEY]?.settledPr).toBe(9);
    });

    it('a merge during a turn in the plan settles the row when the turn ends', () => {
      const store = planStore();
      start(store);
      run(store, 'started', 'r1', HOME);
      merged(store);
      expect(store.getState().triage[KEY]?.settled).toBeUndefined();
      run(store, 'done', 'r1', HOME);
      expect(store.getState().triage[KEY]?.settled?.pr).toBe(9);
    });

    it('a merge with an open question settles the row once it is answered', () => {
      const store = planStore();
      start(store);
      store.dispatch({ type: 'question_add', question: question('q1', HOME) });
      merged(store);
      expect(store.getState().triage[KEY]?.settled).toBeUndefined();
      store.dispatch({ type: 'question_remove', qid: 'q1' });
      expect(store.getState().triage[KEY]?.settled?.pr).toBe(9);
    });

    it('after Un-settle the same plan PR does not settle again', () => {
      const store = planStore();
      const service = start(store);
      merged(store);
      service.unsettle(KEY);
      merged(store);
      store.dispatch({ type: 'plan_put', plan: plan({ status: 'done', pr: pr(9, 'MERGED'), updatedAt: 1 }) });
      vi.advanceTimersByTime(2 * 60_000);
      expect(store.getState().triage[KEY]?.settled).toBeUndefined();
    });

    it('a task worktree’s PR merging leaves the plan row unsettled', () => {
      const store = planStore();
      start(store);
      setPr(store, 7);
      vi.advanceTimersByTime(2 * 60_000);
      expect(store.getState().triage[KEY]?.settled).toBeUndefined();
      expect(store.getState().triage[CH]).toBeUndefined();
    });

    it('a worktree with its own row still settles from its PR', () => {
      const store = planStore();
      store.dispatch({ type: 'projects', projects: [project(ws('w1'), ws('home'), ws('w2'))] });
      start(store);
      setPr(store, 7, 'MERGED', 'w2');
      expect(store.getState().triage['ws:w2']?.settled?.pr).toBe(7);
    });

    it('a plan with no own PR does not settle on merge', () => {
      const store = planStore();
      start(store);
      store.dispatch({ type: 'plan_put', plan: plan({ status: 'done' }) });
      expect(store.getState().triage[KEY]?.settled).toBeUndefined();
    });

    it('settleOnMerge off and autoSettle false stop it', () => {
      const off = planStore();
      off.dispatch({ type: 'prefs', prefs: { settleOnMerge: false } });
      start(off);
      merged(off);
      expect(off.getState().triage[KEY]?.settled).toBeUndefined();

      const chat = planStore();
      start(chat).setAutoSettle(KEY, false);
      merged(chat);
      expect(chat.getState().triage[KEY]?.settled).toBeUndefined();
    });

    it('with chatCategories off a plan PR merge makes no transition and writes no file', () => {
      const store = planStore(false);
      start(store);
      merged(store);
      vi.advanceTimersByTime(2 * 60_000);
      expect(store.getState().triage).toEqual({});
      expect(existsSync(file)).toBe(false);
    });
  });

  describe('merged here', () => {
    const merged = (store: Store) => {
      let emit: (e: { kind: 'merged'; id: string }) => void = () => undefined;
      const service = new TriageService({ store, file, notify: (e) => notices.push(e), history: () => [], onWorktree: (l) => ((emit = l), () => undefined) });
      services.push(service);
      return { service, merge: () => emit({ kind: 'merged', id: 'w1' }) };
    };

    it('settles the chat with why merged_here', () => {
      const store = makeStore();
      merged(store).merge();
      expect(store.getState().triage[CH]?.settled?.why).toBe('merged_here');
    });

    it('during a turn it waits for the turn to end', () => {
      const store = makeStore();
      const { merge } = merged(store);
      run(store, 'started');
      merge();
      expect(category(store)).toBe('working');
      run(store, 'done');
      expect(store.getState().triage[CH]?.settled?.why).toBe('merged_here');
      expect(store.getState().triage[CH]?.mergedHere).toBeUndefined();
    });

    it('settleOnMerge off stops it', () => {
      const store = makeStore();
      store.dispatch({ type: 'prefs', prefs: { settleOnMerge: false } });
      merged(store).merge();
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
    });
  });

  describe('idle', () => {
    const idleStore = () => {
      const store = makeStore();
      const service = start(store);
      return { store, service };
    };
    const pass = (days = 4) => {
      vi.setSystemTime(NOW + days * DAY);
      vi.advanceTimersByTime(61_000);
    };

    it('settles after N days with why idle', () => {
      const { store } = idleStore();
      pass();
      expect(store.getState().triage[CH]?.settled?.why).toBe('idle');
    });

    it('not before N days', () => {
      const { store } = idleStore();
      pass(2);
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
    });

    it('a worktree with no known time counts from when the setting turned on, not from 0', () => {
      const store = makeStore(false, [project(ws('w1', { createdAt: 0 }))]);
      start(store);
      store.dispatch({ type: 'prefs', prefs: { chatCategories: true } });
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
      expect(store.getState().triage[CH]?.lastAt).toBe(NOW);
      pass(2);
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
      pass();
      expect(store.getState().triage[CH]?.settled?.why).toBe('idle');
    });

    it('a worktree found while the setting is on counts from when it was first seen', () => {
      const store = makeStore();
      start(store);
      vi.setSystemTime(NOW + DAY);
      store.dispatch({ type: 'projects', projects: [project(ws('w1'), ws('found', { createdAt: 0 }))] });
      expect(store.getState().triage['ws:found']?.lastAt).toBe(NOW + DAY);
      expect(store.getState().triage['ws:found']?.settled).toBeUndefined();
    });

    it('a saved lastAt of 0 is not a time: it is seeded again', () => {
      writeFileSync(file, JSON.stringify({ chats: { [CH]: { lastAt: 0 } } }));
      const store = makeStore(true, [project(ws('w1', { createdAt: 0 }))]);
      start(store);
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
      expect(store.getState().triage[CH]?.lastAt).toBe(NOW);
    });

    it('a chat with a real old time still settles at the first enable', () => {
      const store = makeStore(false, [project(ws('w1', { createdAt: NOW - 10 * DAY }))]);
      start(store);
      store.dispatch({ type: 'prefs', prefs: { chatCategories: true } });
      expect(store.getState().triage[CH]?.settled?.why).toBe('idle');
    });

    it('0 days means never', () => {
      const { store } = idleStore();
      store.dispatch({ type: 'prefs', prefs: { settleIdleDays: 0 } });
      pass(100);
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
    });

    it('a running turn stops it', () => {
      const { store } = idleStore();
      run(store, 'started');
      pass();
      expect(category(store)).toBe('working');
    });

    it('a raised hand stops it', () => {
      const { store } = idleStore();
      store.dispatch({ type: 'question_add', question: question('q1') });
      pass();
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
    });

    it('unread stops it', () => {
      const { store } = idleStore();
      chat(store, 'bob', 'hello');
      pass();
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
    });

    it('a snooze stops it', () => {
      const { store, service } = idleStore();
      service.snooze(CH, NOW + 100 * DAY);
      pass();
      expect(category(store)).toBe('snoozed');
    });

    it('holdIdle stops it, until new activity', () => {
      const { store, service } = idleStore();
      service.settle(CH);
      service.unsettle(CH);
      pass();
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
      chat(store, 'me', 'back');
      store.dispatch({ type: 'attention', attention: { shown: [CH], visible: [CH], files: false, front: true } });
      store.dispatch({ type: 'attention', attention: { shown: [], visible: [], files: false, front: true } });
      pass(9);
      expect(store.getState().triage[CH]?.settled?.why).toBe('idle');
    });

    it('a pending Remind Me Later stops it', () => {
      const { store } = idleStore();
      store.dispatch({ type: 'projects', projects: [project(ws('w1', { remindAt: NOW + 7 * DAY }), ws('w2'))] });
      pass();
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
      expect(store.getState().triage['ws:w2']?.settled?.why).toBe('idle');
    });

    it('autoSettle false stops it', () => {
      const { store, service } = idleStore();
      service.setAutoSettle(CH, false);
      pass();
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
    });

    it('an open PR stops it; a closed one does not', () => {
      const { store } = idleStore();
      setPr(store, 7, 'OPEN');
      pass();
      expect(store.getState().triage[CH]?.settled).toBeUndefined();
      setPr(store, 7, 'CLOSED');
      expect(store.getState().triage[CH]?.settled?.why).toBe('idle');
    });
  });

  describe('archive settled chats', () => {
    let archived: string[];
    const serve = (store: Store) => {
      const service = new TriageService({ store, file, notify: () => undefined, history: () => [], now: () => Date.now(), archive: (id) => (archived.push(id), Promise.resolve(true)) });
      services.push(service);
      return service;
    };
    const archiveStore = () => {
      const store = makeStore();
      return { store, service: serve(store) };
    };
    const after = (days: number) => {
      vi.setSystemTime(NOW + days * DAY);
      vi.advanceTimersByTime(61_000);
    };
    const settledLongAgo = { settled: { at: NOW - 30 * DAY, why: 'you' } };
    beforeEach(() => {
      archived = [];
    });

    it('a chat settled for more than the days (14 by default) is archived', () => {
      const { store, service } = archiveStore();
      expect(store.getState().prefs.archiveSettledDays).toBe(14);
      service.settle(CH);
      after(13);
      expect(archived).toEqual([]);
      after(15);
      expect(archived).toEqual(['w1']);
    });

    it('it is archived once, also while the archive runs', () => {
      const { service } = archiveStore();
      service.settle(CH);
      after(15);
      after(16);
      expect(archived).toEqual(['w1']);
    });

    it('the days follow the setting', () => {
      const { store, service } = archiveStore();
      store.dispatch({ type: 'prefs', prefs: { archiveSettledDays: 2 } });
      service.settle(CH);
      service.settle('ws:w2');
      after(3);
      expect(archived.sort()).toEqual(['w1', 'w2']);
    });

    it('0 days means never', () => {
      const { store, service } = archiveStore();
      store.dispatch({ type: 'prefs', prefs: { archiveSettledDays: 0 } });
      service.settle(CH);
      after(400);
      expect(archived).toEqual([]);
    });

    it('a chat that is not settled stays', () => {
      const { store } = archiveStore();
      store.dispatch({ type: 'prefs', prefs: { settleIdleDays: 0 } });
      after(30);
      expect(archived).toEqual([]);
    });

    it('a chat un-settled before the days stays', () => {
      const { service } = archiveStore();
      service.settle(CH);
      after(10);
      service.unsettle(CH);
      after(30);
      expect(archived).not.toContain('w1');
    });

    it('nothing is archived while the categories are off', () => {
      writeFileSync(file, JSON.stringify({ chats: { [CH]: settledLongAgo } }));
      serve(makeStore(false));
      after(1);
      expect(archived).toEqual([]);
    });

    it('a friend’s chat and a plan’s row are never archived', () => {
      writeFileSync(file, JSON.stringify({ chats: { 'ws:f1': { ...settledLongAgo, shared: true }, 'plan:p': settledLongAgo } }));
      const base = makeStore().getState();
      const plan = { id: 'p', projectId: 'p1', home: 'ws:w1', status: 'done', body: normalizeBody({ title: 'P', goal: 'g', milestones: [] }), draftRev: 1, autonomy: 'gated', maxParallel: 3, paused: false, testsAt: 'end', runs: {}, activity: [], createdAt: 0, updatedAt: 0 } as Plan;
      serve(new Store({ ...base, shared: [{ id: 'f1' }] as unknown as DomainState['shared'], plans: { ...base.plans, plans: [plan] } }));
      after(1);
      expect(archived).toEqual([]);
    });

    it('a chat you restore is not archived again: it is back in the Inbox', () => {
      const store = makeStore();
      let tell: (event: WorktreeEvent) => void = () => undefined;
      const service = new TriageService({ store, file, notify: () => undefined, history: () => [], now: () => Date.now(), archive: (id) => (archived.push(id), Promise.resolve(true)), onWorktree: (l) => ((tell = l), () => undefined) });
      services.push(service);
      service.settle(CH);
      after(15);
      expect(archived).toEqual(['w1']);
      tell({ kind: 'restored', id: 'w1' });
      expect(category(store)).toBe('active');
      service.stop();
      serve(store);
      after(16);
      expect(archived).toEqual(['w1']);
    });

    it('a chat whose turn runs waits for the turn to end', () => {
      const { store } = archiveStore();
      run(store, 'started');
      // A snoozed chat settled by you keeps settled while its turn runs.
      store.dispatch({ type: 'triage_set', channel: CH, record: { settled: { at: NOW, why: 'you' } } });
      after(15);
      expect(archived).toEqual([]);
      run(store, 'done');
      store.dispatch({ type: 'triage_set', channel: CH, record: { settled: { at: NOW, why: 'you' } } });
      vi.advanceTimersByTime(61_000);
      expect(archived).toEqual(['w1']);
    });
  });

  describe('tasks stay independent', () => {
    const withTask = () => {
      const store = makeStore();
      const board = new Board({ store, dir: null, projectName: () => 'app' });
      const made = board.create({ projectId: 'p1', title: 'Do it' }, { kind: 'beluga' });
      const issue = board.linkWorktree(made.id, 'w1', { branch: 'do-it', name: 'w1' }, { kind: 'beluga' });
      expect(store.getState().board.issues.find((i) => i.id === issue.id)?.worktrees).toEqual(['w1']);
      return { store, board, issue };
    };
    const statusOf = (store: Store, id: string) => store.getState().board.issues.find((i) => i.id === id)?.status;

    it('settling, snoozing and un-settling leave the task status unchanged', () => {
      const { store, issue } = withTask();
      const before = statusOf(store, issue.id);
      const service = start(store);
      service.settle(CH);
      service.unsettle(CH);
      service.snooze(CH, NOW + HOUR);
      expect(statusOf(store, issue.id)).toBe(before);
    });

    it('a task moved to Done by hand leaves the chat unsettled', () => {
      const { store, board, issue } = withTask();
      start(store);
      board.update(issue.id, { status: 'done' }, { kind: 'beluga' });
      expect(statusOf(store, issue.id)).toBe('done');
      expect(category(store)).toBe('active');
    });

    it('src/core/triage does not import the board at runtime', () => {
      for (const f of ['model', 'facts', 'service', 'auto-settle', 'launch']) {
        const src = readFileSync(path.resolve(`src/core/triage/${f}.ts`), 'utf8');
        expect(src).not.toMatch(/^import (?!type)[^'"]*from '[^']*board\//m);
      }
    });
  });
});
