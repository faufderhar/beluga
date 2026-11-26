import { describe, expect, it } from 'vitest';
import { AutoContinue, resumeOf } from '../src/core/auto-continue.js';
import { ChatSendService } from '../src/core/chat-links/service.js';
import type { SentinelWake } from '../src/core/sentinel/runner.js';
import type { SentinelDraft } from '../src/core/sentinel/model.js';
import { wakeRefusal } from '../src/core/sentinel/wake.js';
import { type DomainState, Store, initialState } from '../src/core/store.js';
import { CONTINUE_PROMPT, encodeFailure } from '../src/shared/run-failure.js';
import { LIMIT_MARGIN_MS } from '../src/shared/auto-continue.js';
import type { BodyOf } from '../src/protocol.js';
import { setup, until } from './sentinel-fakes.js';

/**
 * The three use cases of "Chat schedules on Sentinel", end to end through the daemon's own parts on a
 * fake clock: Sentinels ticks the trigger, its chat step goes through ChatSendService into your chat,
 * the chat's turn ends on the store, and AutoContinue reads the same store.
 * (1) "Send XYZ every day at 9:00". (2) "Send XYZ in 5 hours". (3) A woken chat that stops on the
 * usage limit is told to continue once it resets, under auto-continue's own guards.
 */

const ME = 'me-me-me-me-me-me-me-me-me-me-me0';
const CHAT = `${ME}/ws:w1`;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Thursday 12 Nov 2026, 08:00 local. */
const T0 = new Date(2026, 10, 12, 8, 0).getTime();

type TurnEnd = { readonly kind: 'done'; readonly text: string } | { readonly kind: 'limit'; readonly resetsAt?: number };

/**
 * A world on a fake clock. Each prompt that reaches the chat starts a turn; `end` says how that turn
 * ends (by default: answered at once). `ask` is what AutoContinue sends on.
 */
function world(end: (prompt: string) => TurnEnd = () => ({ kind: 'done', text: 'Sent.' }), experiments: readonly string[] = []) {
  let now = T0;
  const base = initialState('room', 'auto');
  const store = new Store({
    ...base,
    selfId: ME,
    projectsLoaded: true,
    prefs: { ...base.prefs, experiments },
    projects: [{ id: 'api', name: 'bob-api', root: '/code/bob-api', base: 'main', workspaces: [{ id: 'w1', name: 'Daily status', projectId: 'api', projectRoot: '/code/bob-api', path: '/code/bob-api/w1', kind: 'worktree', branch: 'beluga/w1', createdAt: 0 }] }],
  } as unknown as DomainState);
  const prompts: Array<{ readonly prompt: string; readonly requestId: string; readonly by: 'sentinel' | 'auto-continue' }> = [];
  /** A turn in ws:w1: it starts, then ends as `end` says. */
  const turn = (requestId: string, prompt: string, extra: Record<string, unknown> = {}): void => {
    store.dispatch({ type: 'agent_event', owner: ME, requestId, requester: ME, event: 'started', text: '', ts: now, channel: 'ws:w1', ...extra } as never);
    const how = end(prompt);
    queueMicrotask(() => {
      if (how.kind === 'done') store.dispatch({ type: 'agent_event', owner: ME, requestId, requester: ME, event: 'done', text: how.text, ts: now, channel: 'ws:w1' });
      else store.dispatch({ type: 'agent_event', owner: ME, requestId, requester: ME, event: 'error', text: encodeFailure({ kind: 'usage_limit', detail: 'You’ve hit your limit', ...(how.resetsAt ? { resetsAt: how.resetsAt } : {}) }, now), ts: now, channel: 'ws:w1' });
    });
  };
  const sends = new ChatSendService({
    store,
    selfId: () => ME,
    queuedFromChats: () => 0,
    deliver: async (body: BodyOf<'agent_request'>) => {
      prompts.push({ prompt: body.prompt, requestId: body.requestId, by: 'sentinel' });
      turn(body.requestId, body.prompt, { fromChat: { origin: body.origin, text: body.prompt } });
      return { delivery: 'started' };
    },
    deliverTo: () => false,
    permissionRank: () => 0,
    agentIn: () => ({ runtime: 'claude', label: 'Claude' }),
    terminalDriving: () => false,
    load: () => undefined,
    system: () => undefined,
    askChain: async () => true,
    cancelChain: () => undefined,
    now: () => now,
  });
  // As the daemon wires it (core/sentinel/launch.ts wake()).
  const wake: SentinelWake = {
    refusal: (to) => wakeRefusal(store.getState(), to),
    deliver: async (input) => (await sends.deliverFromSentinel({ sentinel: input.sentinel, run: input.run, step: input.step, channel: input.to, text: input.text })).messageId,
    wait: (messageId, ms, signal) => sends.outcome(messageId, ms, signal),
  };
  const s = setup({ store, selfId: () => ME, now: () => now, wake });
  let asks = 0;
  const auto = new AutoContinue({
    store,
    now: () => now,
    ask: (prompt) => {
      const requestId = `continue-${++asks}`;
      prompts.push({ prompt, requestId, by: 'auto-continue' });
      turn(requestId, prompt);
      return requestId;
    },
  });
  /** A sentinel that wakes the chat, turned on (as /schedule makes it). */
  const schedule = (trigger: SentinelDraft['trigger'], text = 'Send XYZ') => {
    const made = s.sentinels.create({ name: text, trigger, steps: [{ kind: 'chat', name: 'Wake the chat', to: CHAT, text }] });
    s.sentinels.pause(made.id, false);
    return made.id;
  };
  const runsOf = (id: string) => s.sentinels.runsOf(id).filter((r) => r.state !== 'skipped');
  /** The clock moves to `t`; Sentinel's and auto-continue's ticks run, and what they started settles. */
  const at = async (t: number): Promise<void> => {
    now = t;
    s.sentinels.tick();
    auto.tick();
    await new Promise((r) => setTimeout(r, 5));
  };
  return { store, s, auto, prompts, schedule, runsOf, at, now: () => now };
}

describe('use case 1: "Send XYZ every day at 9:00"', () => {
  it('wakes the chat at 9:00 each day, never before, and the run keeps the answer', async () => {
    const w = world(() => ({ kind: 'done', text: 'Status sent.' }));
    const id = w.schedule({ kind: 'schedule', every: 'day', at: '09:00', missed: 'skip' });
    expect(w.s.sentinels.state().nextAt[id]).toBe(new Date(2026, 10, 12, 9, 0).getTime());

    await w.at(new Date(2026, 10, 12, 8, 59).getTime());
    expect(w.prompts).toHaveLength(0);

    await w.at(new Date(2026, 10, 12, 9, 0, 20).getTime());
    await until(() => w.runsOf(id)[0]?.state === 'done');
    expect(w.prompts).toEqual([expect.objectContaining({ prompt: 'Send XYZ', by: 'sentinel' })]);
    expect(w.runsOf(id)[0]).toMatchObject({ state: 'done', headline: 'Status sent.' });
    expect(w.s.sentinels.state().nextAt[id]).toBe(new Date(2026, 10, 13, 9, 0).getTime());

    // Later that day: nothing more.
    await w.at(new Date(2026, 10, 12, 18, 0).getTime());
    expect(w.prompts).toHaveLength(1);

    // The next day at 9:00: once more.
    await w.at(new Date(2026, 10, 13, 9, 0, 20).getTime());
    await until(() => w.runsOf(id).length === 2 && w.runsOf(id).every((r) => r.state === 'done'));
    expect(w.prompts.map((p) => p.prompt)).toEqual(['Send XYZ', 'Send XYZ']);
    w.s.sentinels.stopAll();
    w.auto.stop();
  });
});

describe('chat schedules need no switch', () => {
  it('a daily wake goes with no experiment saved', async () => {
    const w = world(undefined, []);
    const id = w.schedule({ kind: 'schedule', every: 'day', at: '09:00', missed: 'skip' });
    await w.at(new Date(2026, 10, 12, 9, 0, 20).getTime());
    await until(() => w.runsOf(id)[0]?.state === 'done');
    expect(w.prompts).toHaveLength(1);
    w.s.sentinels.stopAll();
    w.auto.stop();
  });

  it('an old Beluga’s off mark for the experiment is ignored', async () => {
    const w = world(undefined, ['-chat-schedules']);
    const id = w.schedule({ kind: 'schedule', every: 'day', at: '09:00', missed: 'skip' });
    await w.at(new Date(2026, 10, 12, 9, 0, 20).getTime());
    await until(() => w.runsOf(id)[0]?.state === 'done');
    expect(w.prompts).toHaveLength(1);
    w.s.sentinels.stopAll();
    w.auto.stop();
  });
});

describe('use case 2: "Send XYZ in 5 hours"', () => {
  it('wakes the chat once, five hours on, and never again', async () => {
    const w = world();
    const at = T0 + 5 * HOUR;
    const id = w.schedule({ kind: 'once', at: new Date(at).toISOString(), missed: 'catch-up' });
    expect(w.s.sentinels.state().nextAt[id]).toBe(at);

    await w.at(at - MIN);
    expect(w.prompts).toHaveLength(0);

    await w.at(at + 20_000);
    await until(() => w.runsOf(id)[0]?.state === 'done');
    expect(w.prompts).toEqual([expect.objectContaining({ prompt: 'Send XYZ', by: 'sentinel' })]);
    expect(w.s.sentinels.state().nextAt[id]).toBeUndefined();

    await w.at(at + 24 * HOUR);
    expect(w.runsOf(id)).toHaveLength(1);
    expect(w.prompts).toHaveLength(1);
    w.s.sentinels.stopAll();
    w.auto.stop();
  });
});

describe('use case 3: a woken chat stops on the usage limit; auto-continue resumes it', () => {
  const RESET = T0 + 3 * HOUR;

  /** A daily 9:00 wake whose turn stops on the limit; the continue turn then answers. */
  const limited = (resetsAt: number | undefined = RESET) => world((prompt) => (prompt === CONTINUE_PROMPT ? { kind: 'done', text: 'Done.' } : { kind: 'limit', ...(resetsAt ? { resetsAt } : {}) }));

  async function wokenAndStopped(w: ReturnType<typeof limited>) {
    const id = w.schedule({ kind: 'schedule', every: 'day', at: '09:00', missed: 'skip' });
    await w.at(new Date(2026, 10, 12, 9, 0, 20).getTime());
    await until(() => w.runsOf(id)[0]?.state === 'failed');
    return id;
  }

  it('the run fails on the stop; the chat is sent on once the limit resets, once', async () => {
    const w = limited(new Date(2026, 10, 12, 12, 0).getTime());
    const id = await wokenAndStopped(w);
    expect(w.runsOf(id)[0]!.why).toMatch(/^its turn failed/);
    // The card says when Beluga continues it: the woken chat is no sentinel run's chat.
    const resumeAt = new Date(2026, 10, 12, 12, 0).getTime() + LIMIT_MARGIN_MS;
    expect(resumeOf(w.store.getState(), 'ws:w1', w.now())).toMatchObject({ at: resumeAt });

    await w.at(resumeAt - MIN);
    expect(w.prompts.filter((p) => p.by === 'auto-continue')).toHaveLength(0);

    await w.at(resumeAt + 1000);
    expect(w.prompts.filter((p) => p.by === 'auto-continue')).toEqual([expect.objectContaining({ prompt: CONTINUE_PROMPT })]);
    expect(w.store.getState().log.some((l) => l.type === 'system' && l.channel === 'ws:w1' && /Your usage limit reset/.test(l.text))).toBe(true);

    // Each stop is sent on once.
    await w.at(resumeAt + 10 * MIN);
    expect(w.prompts.filter((p) => p.by === 'auto-continue')).toHaveLength(1);
    w.s.sentinels.stopAll();
    w.auto.stop();
  });

  it('respects the guards: off in this chat, nothing is sent', async () => {
    const w = limited(new Date(2026, 10, 12, 12, 0).getTime());
    await wokenAndStopped(w);
    w.store.dispatch({ type: 'prefs', prefs: { ...w.store.getState().prefs, autoContinueOff: ['ws:w1'] } } as never);
    expect(resumeOf(w.store.getState(), 'ws:w1', w.now())).toBeUndefined();
    await w.at(new Date(2026, 10, 12, 12, 5).getTime());
    expect(w.prompts.filter((p) => p.by === 'auto-continue')).toHaveLength(0);
    w.s.sentinels.stopAll();
    w.auto.stop();
  });

  it('respects the guards: off everywhere, nothing is sent', async () => {
    const w = limited(new Date(2026, 10, 12, 12, 0).getTime());
    await wokenAndStopped(w);
    w.store.dispatch({ type: 'prefs', prefs: { ...w.store.getState().prefs, autoContinue: false } } as never);
    await w.at(new Date(2026, 10, 12, 12, 5).getTime());
    expect(w.prompts.filter((p) => p.by === 'auto-continue')).toHaveLength(0);
    w.s.sentinels.stopAll();
    w.auto.stop();
  });

  it('respects the loop guard: a continue that stops again on a guessed reset is not sent on again', async () => {
    // No reset named: auto-continue guesses one (30 minutes on), and a second stop is left to you.
    const w = world(() => ({ kind: 'limit' }));
    await wokenAndStopped(w);
    const nine = new Date(2026, 10, 12, 9, 0, 20).getTime();
    await w.at(nine + 32 * MIN);
    expect(w.prompts.filter((p) => p.by === 'auto-continue')).toHaveLength(1);
    // The continue turn stopped on the limit again: no second send, however long it waits.
    await w.at(nine + 70 * MIN);
    await w.at(nine + 3 * HOUR);
    expect(w.prompts.filter((p) => p.by === 'auto-continue')).toHaveLength(1);
    w.s.sentinels.stopAll();
    w.auto.stop();
  });

  it('too late (Beluga was off past the window): left to you', async () => {
    const w = limited(new Date(2026, 10, 12, 12, 0).getTime());
    await wokenAndStopped(w);
    await w.at(new Date(2026, 10, 12, 19, 0).getTime());
    expect(w.prompts.filter((p) => p.by === 'auto-continue')).toHaveLength(0);
    w.s.sentinels.stopAll();
    w.auto.stop();
  });
});
