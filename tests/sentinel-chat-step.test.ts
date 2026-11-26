import { afterEach, describe, expect, it, vi } from 'vitest';
import { sentinelRunChat } from '../src/core/auto-continue.js';
import { sentinelOfChannel } from '../src/core/sentinel/model.js';
import { type ChatOutcome, type SentinelWake } from '../src/core/sentinel/runner.js';
import { wakeRefusal } from '../src/core/sentinel/wake.js';
import { type DomainState, initialState } from '../src/core/store.js';
import { project, setup, until } from './sentinel-fakes.js';

/** Wake one of your chats (BLG-397): a sentinel sends a prompt into your own chat, waits for that turn and keeps its first line. */

const ME = 'p-me';
const CHAT = `${ME}/ws:w1`;
const wakeStep = (text = 'Check the build') => ({ kind: 'chat' as const, name: 'Wake the chat', to: CHAT, text });

afterEach(() => void vi.useRealTimers());

interface Delivery {
  readonly id: string;
  readonly sentinel: { readonly id: string; readonly name: string };
  readonly run: string;
  readonly step: string;
  readonly to: string;
  readonly text: string;
}

/** Your chats as a sentinel sees them: what it delivered, and a hand on each turn's end. */
function fakeWake(onDeliver?: (d: Delivery) => void) {
  const delivered: Delivery[] = [];
  const ends = new Map<string, (o: ChatOutcome) => void>();
  const flags = { refusal: undefined as string | undefined };
  const wake: SentinelWake = {
    refusal: () => flags.refusal,
    deliver: async (input) => {
      const d = { id: `m${delivered.length + 1}`, ...input };
      delivered.push(d);
      onDeliver?.(d);
      return d.id;
    },
    wait: (id, ms, signal) =>
      new Promise<ChatOutcome>((resolve) => {
        const timer = setTimeout(() => resolve({ state: 'working' }), ms);
        signal.addEventListener('abort', () => resolve({ state: 'working' }), { once: true });
        ends.set(id, (o) => {
          clearTimeout(timer);
          resolve(o);
        });
      }),
  };
  return { wake, delivered, flags, end: (id: string, o: ChatOutcome) => ends.get(id)?.(o) };
}

const withWorktree = (s: ReturnType<typeof setup>) =>
  s.store.dispatch({ type: 'projects', projects: [{ ...project('api', 'bob-api'), workspaces: [{ id: 'w1', name: 'retry', kind: 'worktree', path: '/code/bob-api/w1', branch: 'retry', projectId: 'api' } as never] }] });

describe('a chat step, through the runner', () => {
  it('delivers once, waits for the turn, and the run says the answer’s first line', async () => {
    const w = fakeWake();
    const s = setup({ wake: w.wake });
    const made = s.sentinels.create({ name: 'Nudge', steps: [wakeStep()] });
    const run = s.sentinels.start(made.id, 'you');
    await until(() => w.delivered.length === 1);
    expect(w.delivered[0]).toMatchObject({ sentinel: { id: made.id, name: 'Nudge' }, run: run.id, to: CHAT, text: 'Check the build' });
    w.end('m1', { state: 'answered', answer: 'All green on main.\nDetails follow.' });
    await until(() => s.sentinels.runGet(run.id).run.state === 'done');
    const done = s.sentinels.runGet(run.id).run;
    expect(done.headline).toBe('All green on main.');
    expect(done.steps[0]).toMatchObject({ state: 'done', output: 'All green on main.' });
    expect(w.delivered).toHaveLength(1);
  });

  it('a turn that fails fails the step, with its words', async () => {
    const w = fakeWake();
    const s = setup({ wake: w.wake });
    const run = s.sentinels.start(s.sentinels.create({ name: 'Nudge', steps: [wakeStep()] }).id, 'you');
    await until(() => w.delivered.length === 1);
    w.end('m1', { state: 'failed', answer: 'Out of session.' });
    await until(() => s.sentinels.runGet(run.id).run.state === 'failed');
    expect(s.sentinels.runGet(run.id).run.why).toBe('its turn failed: Out of session.');
  });

  it('a chat that does not take it fails the step', async () => {
    const w = fakeWake();
    const s = setup({ wake: { ...w.wake, deliver: async () => Promise.reject(new Error('chat_archived: that chat is archived.')) } });
    const run = s.sentinels.start(s.sentinels.create({ name: 'Nudge', steps: [wakeStep()] }).id, 'you');
    await until(() => s.sentinels.runGet(run.id).run.state === 'failed');
    expect(s.sentinels.runGet(run.id).run.why).toMatch(/^the chat did not take it: chat_archived/);
  });

  it('a turn that passes the time limit ends the step as failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const w = fakeWake();
    const s = setup({ wake: w.wake });
    const run = s.sentinels.start(s.sentinels.create({ name: 'Nudge', limits: { minutes: 10 }, steps: [wakeStep()] }).id, 'you');
    await vi.advanceTimersByTimeAsync(10);
    expect(w.delivered).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.sentinels.runGet(run.id).run).toMatchObject({ state: 'failed', why: 'timed out' });
    expect(s.sentinels.runGet(run.id).run.steps[0]).toMatchObject({ state: 'failed', why: 'timed out' });
  });

  it('never takes the chat as its conversation: it stays in Unread and in auto-continue', async () => {
    const w = fakeWake();
    const s = setup({ wake: w.wake });
    withWorktree(s);
    const run = s.sentinels.start(s.sentinels.create({ name: 'Nudge', steps: [wakeStep()] }).id, 'you');
    await until(() => w.delivered.length === 1);
    w.end('m1', { state: 'answered', answer: 'Done.' });
    await until(() => s.sentinels.runGet(run.id).run.state === 'done');
    const ended = s.sentinels.runGet(run.id).run;
    expect(ended.steps[0]!.channel).toBeUndefined();
    expect(ended.channel).toBeUndefined();
    expect(sentinelOfChannel(s.store.getState().sentinel, 'ws:w1')).toBeUndefined();
    expect(sentinelRunChat(s.store.getState(), 'ws:w1')).toBe(false);
  });
});

describe('only a chat that is yours alone', () => {
  it('is refused at create', () => {
    const w = fakeWake();
    w.flags.refusal = 'that chat is shared with a contributor, and a sentinel wakes only a chat that is yours alone';
    const s = setup({ wake: w.wake });
    expect(() => s.sentinels.create({ name: 'Nudge', steps: [wakeStep()] })).toThrow(/^That chat is shared with a contributor/);
  });

  it('shared after: the run is refused and the sentinel pauses with the reason', async () => {
    const w = fakeWake();
    const s = setup({ wake: w.wake });
    const made = s.sentinels.create({ name: 'Nudge', steps: [wakeStep()] });
    s.sentinels.pause(made.id, false);
    w.flags.refusal = 'that chat is shared with a contributor, and a sentinel wakes only a chat that is yours alone';
    const run = s.sentinels.start(made.id, 'you');
    await until(() => s.sentinels.runGet(run.id).run.state === 'failed');
    expect(w.delivered).toHaveLength(0);
    expect(s.sentinels.get(made.id)).toMatchObject({ paused: true, pausedWhy: 'Paused: that chat is shared with a contributor, and a sentinel wakes only a chat that is yours alone' });
  });

  it('wakeRefusal: a contributor refuses it; a viewer, or nobody, does not', () => {
    const me = 'me-me-me-me-me-me-me-me-me-me-me0';
    const st = (members: Record<string, Record<string, string>>) => ({ ...initialState('room'), selfId: me, members }) as unknown as DomainState;
    expect(wakeRefusal(st({ w1: { friend: 'contribute' } }), `${me}/ws:w1`)).toMatch(/shared with a contributor/);
    expect(wakeRefusal(st({ w1: { friend: 'contribute' } }), 'ws:w1')).toMatch(/shared with a contributor/);
    expect(wakeRefusal(st({ w1: { friend: 'view' } }), `${me}/ws:w1`)).toBeUndefined();
    expect(wakeRefusal(st({}), `${me}/ws:w1`)).toBeUndefined();
    expect(wakeRefusal(st({}), 'p-me/ws:w1')).toMatch(/not a chat a ref can name/);
    expect(wakeRefusal(st({}), 'friend-friend-friend-friend-frie/ws:theirs')).toMatch(/only your own chats/);
  });
});

describe('where nothing can wake a chat', () => {
  it('refuses a chat step at create, and makes any other sentinel as before', () => {
    const s = setup({});
    expect(() => s.sentinels.create({ name: 'Nudge', steps: [wakeStep()] })).toThrow(/^Waking a chat isn’t available here/);
    expect(s.sentinels.create({ name: 'Plain', steps: [{ kind: 'notify', name: 'Tell me', phone: false }] }).name).toBe('Plain');
  });
});

describe('the chain guard', () => {
  it('a claude-finished sentinel that wakes the same chat does not wake it again', async () => {
    let s!: ReturnType<typeof setup>;
    // The turn the prompt starts, as Beluga shows it: its card carries the sentinel's origin, then it ends.
    const w = fakeWake((d) => {
      const origin = { ref: `${ME}/sentinel:${d.sentinel.id}`, title: d.sentinel.name, agent: { runtime: 'beluga', label: 'Sentinel' }, chainId: `sentinel:${d.sentinel.id}:${d.run}`, hop: 1, messageId: d.id, sentinel: { ...d.sentinel, run: d.run } };
      s.store.dispatch({ type: 'agent_event', owner: ME, requestId: d.id, requester: ME, event: 'started', text: '', ts: Date.now(), channel: 'ws:w1', fromChat: { origin, text: d.text } });
      setTimeout(() => {
        s.store.dispatch({ type: 'agent_event', owner: ME, requestId: d.id, requester: ME, event: 'done', text: 'Done.', ts: Date.now(), channel: 'ws:w1' });
        w.end(d.id, { state: 'answered', answer: 'Done.' });
      }, 5);
    });
    s = setup({ wake: w.wake, triggers: { warmupMs: 0 } });
    withWorktree(s);
    const made = s.sentinels.create({ name: 'Keep going', projectId: 'api', trigger: { kind: 'beluga', what: 'claude-finished', projectId: 'api' }, steps: [wakeStep('Keep going')] });
    s.sentinels.pause(made.id, false);
    const runs = () => s.store.getState().sentinel.runs.filter((r) => r.sentinelId === made.id);
    s.sentinels.start(made.id, 'you');
    await until(() => runs().length === 1 && runs()[0]!.state === 'done');
    await new Promise((r) => setTimeout(r, 50));
    expect(runs()).toHaveLength(1);
    expect(w.delivered).toHaveLength(1);

    // Your own turn ending there still starts it: the guard stops only its own loop.
    s.store.dispatch({ type: 'agent_event', owner: ME, requestId: 'yours', requester: ME, event: 'done', text: 'Done.', ts: Date.now(), channel: 'ws:w1' });
    await until(() => runs().length === 2);
    s.sentinels.stopAll();
  });
});
