import { describe, expect, it } from 'vitest';
import { InboundBudget } from '../../src/net/mesh/inbound-budget.js';

/** BLG-942: a friend's Beluga can't take this Mac's thread over, however much it sends. */

function rig(opts: { perPersonMs?: number; allMs?: number; burstMs?: number; maxWaiting?: number } = {}) {
  let clock = 0;
  const later: Array<{ fn: () => void; at: number }> = [];
  const busy: Array<[string, number, number]> = [];
  const errors: unknown[] = [];
  const budget = new InboundBudget({
    perPersonMs: 100,
    allMs: 200,
    burstMs: 50,
    sliceMs: 8,
    ...opts,
    now: () => clock,
    later: (fn, ms) => later.push({ fn, at: clock + ms }),
    onBusy: (p, w, d) => busy.push([p, w, d]),
    onError: (e) => errors.push(e),
  });
  /** A frame that takes `ms` of the thread. */
  const frame = (log: string[], name: string, ms: number, fail = false) => () => {
    clock += ms;
    log.push(name);
    if (fail) throw new Error(`broke on ${name}`);
  };
  /** Time passes; what was put off runs when it's due. */
  const pass = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      later.sort((a, b) => a.at - b.at);
      const next = later[0];
      if (!next || next.at > until) break;
      later.shift();
      clock = Math.max(clock, next.at);
      next.fn();
    }
    clock = Math.max(clock, until);
  };
  return { budget, frame, pass, busy, errors, now: () => clock };
}

describe('each person’s share of the thread', () => {
  it('handles cheap frames at once, every one', () => {
    const { budget, frame } = rig();
    const log: string[] = [];
    for (let n = 0; n < 100; n++) budget.take('ata', frame(log, `a${n}`, 0.1));
    expect(log).toHaveLength(100);
    expect(budget.waitingFor('ata')).toBe(0);
  });

  it('puts a costly friend’s frames in turn, in order, while another friend’s still go at once', () => {
    const { budget, frame, pass, busy } = rig();
    const log: string[] = [];
    for (let n = 0; n < 40; n++) budget.take('loop', frame(log, `l${n}`, 10));
    // Their burst (50 ms) went at once; the rest wait.
    const now = log.length;
    expect(now).toBeLessThan(10);
    expect(budget.waitingFor('loop')).toBe(40 - now);
    expect(busy[0]).toEqual(['loop', 1, 0]);

    // Kay's frame isn't held up behind them.
    budget.take('kay', frame(log, 'k0', 1));
    expect(log.at(-1)).toBe('k0');

    // Theirs come in turn as their share fills: all of them, in the order sent, at about their rate.
    pass(4_000);
    const theirs = log.filter((x) => x.startsWith('l'));
    expect(theirs).toEqual(Array.from({ length: 40 }, (_, n) => `l${n}`));
    expect(budget.waitingFor('loop')).toBe(0);
  });

  it('a frame that arrives while theirs wait waits behind them (order is kept)', () => {
    const { budget, frame, pass } = rig();
    const log: string[] = [];
    for (let n = 0; n < 10; n++) budget.take('ata', frame(log, `a${n}`, 20));
    pass(10_000);
    budget.take('ata', frame(log, 'late', 0.1));
    expect(log.at(-1)).toBe('late');
    expect(log.filter((x) => x.startsWith('a'))).toEqual(Array.from({ length: 10 }, (_, n) => `a${n}`));
  });

  it('an urgent frame (a call ringing) goes at once, ahead of theirs that wait, and still costs their share (BLG-950)', () => {
    const { budget, frame, pass } = rig({ maxWaiting: 5 });
    const log: string[] = [];
    // A teammate's board backlog: past their share, and past the cap.
    for (let n = 0; n < 30; n++) budget.take('loop', frame(log, `l${n}`, 30));
    const waiting = budget.waitingFor('loop');
    expect(waiting).toBe(5);

    budget.urgent('loop', frame(log, 'ring', 0.5));
    expect(log.at(-1)).toBe('ring');
    // Not added to their queue, and theirs keep their order behind it.
    expect(budget.waitingFor('loop')).toBe(waiting);
    pass(10_000);
    const after = log.slice(log.indexOf('ring') + 1);
    expect(after).toEqual([...after].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
    expect(budget.waitingFor('loop')).toBe(0);
  });

  it('an urgent frame costs their share like any other', () => {
    const { budget, frame } = rig();
    const log: string[] = [];
    // Their whole burst (50 ms) spent by urgent frames: the next ordinary one waits.
    budget.urgent('ata', frame(log, 'sig', 60));
    budget.take('ata', frame(log, 'ops', 1));
    expect(log).toEqual(['sig']);
    expect(budget.waitingFor('ata')).toBe(1);
  });

  it('nothing is handled once stopped, urgent or not', () => {
    const { budget, frame } = rig();
    const log: string[] = [];
    budget.stop();
    budget.urgent('ata', frame(log, 'ring', 1));
    expect(log).toEqual([]);
  });

  it('lets go of what passes the cap, and says so', () => {
    const { budget, frame, busy } = rig({ maxWaiting: 5 });
    const log: string[] = [];
    for (let n = 0; n < 30; n++) budget.take('loop', frame(log, `l${n}`, 30));
    expect(budget.waitingFor('loop')).toBe(5);
    expect(busy.some(([, , dropped]) => dropped > 0)).toBe(true);
  });

  it('a frame that fails in turn doesn’t stop the ones after it', () => {
    const { budget, frame, pass, errors } = rig();
    const log: string[] = [];
    for (let n = 0; n < 6; n++) budget.take('ata', frame(log, `a${n}`, 20, n === 3));
    pass(5_000);
    expect(log).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    expect(errors).toHaveLength(1);
  });

  it('everyone together has a share too, so many busy friends still leave time for you', () => {
    const { budget, frame, pass, now } = rig({ perPersonMs: 300, allMs: 200, burstMs: 50 });
    const log: string[] = [];
    // Four friends sending 2 s of work each.
    for (const p of ['a', 'b', 'c', 'd']) for (let n = 0; n < 400; n++) budget.take(p, frame(log, `${p}${n}`, 5));
    const start = now();
    const before = log.length;
    pass(2_000);
    const spent = (log.length - before) * 5;
    // About the shared 200 ms a second, not 4 × 300: the other 80% of the thread stayed yours.
    expect(spent / ((now() - start) / 1000)).toBeLessThan(230);
    expect(spent / ((now() - start) / 1000)).toBeGreaterThan(150);
    // And they took turns: each got some.
    for (const p of ['a', 'b', 'c', 'd']) expect(log.some((x) => x.startsWith(p) && Number(x.slice(1)) > 5)).toBe(true);
  });
});
