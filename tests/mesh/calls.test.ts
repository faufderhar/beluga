import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallService, meshLinks } from '../../src/core/calls/service.js';
import { dmConversation, groupConversation } from '../../src/net/mesh/views.js';
import { type CallView, type CallsView, GONE_MS, RING_MS } from '../../src/shared/calls.js';
import { type Crowd, LOSES_A_MESSAGE_ON_WINDOWS, type Person, befriend, crowd, settle } from './helpers.js';

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

interface Phone {
  readonly calls: CallService;
  view: CallsView;
  readonly rings: Array<{ call: CallView; on: boolean }>;
  readonly signals: Array<{ to: string | undefined; from: string; data: string }>;
  readonly toasts: string[];
  /** The screen asking (a Mac window's client id, or `phone:…`). */
  screen: string | undefined;
  clock: number;
}

/** A call service on someone's mesh, with its timers in the test's hands. */
function phone(p: Person): Phone {
  const me: Phone = { calls: undefined as unknown as CallService, view: {}, rings: [], signals: [], toasts: [], screen: 'mac-1', clock: Date.now() };
  (me as { calls: CallService }).calls = new CallService({
    links: meshLinks(p.mesh),
    manual: true,
    now: () => me.clock,
    publish: (v) => (me.view = v),
    signal: (to, s) => me.signals.push({ to, from: s.from, data: s.data }),
    ring: (call, on) => me.rings.push({ call, on }),
    toast: (t) => me.toasts.push(t),
    client: () => me.screen,
  });
  return me;
}

describe('calls between friends (BLG-706)', () => {
  it('rings, answers, passes setup between windows, mutes and hangs up', async () => {
    const ann = await net.add('ann');
    const bob = await net.add('bob');
    await befriend(ann, bob);
    const a = phone(ann);
    const b = phone(bob);
    const toBob = dmConversation(bob.identity.peerId);
    const toAnn = dmConversation(ann.identity.peerId);

    const started = a.calls.start(toBob);
    expect(started.mine).toBe('in');
    await settle(() => b.view[toAnn]?.mine === 'ringing');
    expect(b.view[toAnn]!.ringBy).toBe(ann.identity.peerId);
    expect(b.rings.at(-1)?.on).toBe(true);

    // Bob answers from his phone: the call waits for his Mac's window to say it makes his side.
    b.screen = 'phone:abc';
    b.calls.join(toAnn);
    expect(b.view[toAnn]!.mine).toBe('in');
    b.screen = 'mac-2';
    b.calls.set(toAnn, {});
    await settle(() => a.view[toBob]?.people.length === 2);
    expect(a.view[toBob]!.id).toBe(b.view[toAnn]!.id);

    // WebRTC setup goes window to window, to the screen that makes the call.
    expect(a.calls.signal(toBob, bob.identity.peerId, '{"sdp":"offer"}')).toBe(true);
    await settle(() => b.signals.length > 0);
    expect(b.signals[0]).toEqual({ to: 'mac-2', from: ann.identity.peerId, data: '{"sdp":"offer"}' });

    b.calls.set(toAnn, { muted: true });
    await settle(() => a.view[toBob]?.people.find((p) => p.peerId === bob.identity.peerId)?.muted);

    // Bob hangs up: Ann was the last one in, so the call is over for her too.
    b.calls.leave(toAnn);
    await settle(() => a.view[toBob] === undefined);
    expect(a.toasts.at(-1)).toBe('The call ended');
    a.calls.stop();
    b.calls.stop();
  }, 60_000);

  it('rings even while everything else from the caller’s Mac waits its turn (BLG-950)', async () => {
    // Fen's Mac is behind on everything Gil's sends (a teammate's board loop, say): once jammed,
    // each frame costs a second of Fen's thread and what waits is never worked through.
    let jammed = false;
    let clock = 0;
    const held: Array<() => void> = [];
    const gil = await net.add('gil');
    const fen = await net.add('fen', {
      inbound: {
        perPersonMs: 1,
        allMs: 1,
        now: () => (jammed ? (clock += 1_000) : clock),
        later: (fn, ms) => (jammed ? void held.push(fn) : void (ms > 0 ? setTimeout(fn, ms) : setImmediate(fn))),
      },
    });
    await befriend(gil, fen);
    const g = phone(gil);
    const f = phone(fen);
    const toFen = dmConversation(fen.identity.peerId);
    const toGil = dmConversation(gil.identity.peerId);

    jammed = true;
    const sent = [gil.mesh.sendDm(fen.identity.peerId, 'one'), gil.mesh.sendDm(fen.identity.peerId, 'two')];
    const arrived = (): number => sent.filter((s) => fen.mesh.conversation(toGil).some((m) => m.id === s.id)).length;

    g.calls.start(toFen);
    await settle(() => f.view[toGil]?.mine === 'ringing');
    expect(f.view[toGil]!.ringBy).toBe(gil.identity.peerId);
    // The ring went ahead of Gil's messages: at least one of them still waits its turn.
    expect(arrived()).toBeLessThan(2);

    // Once it eases, the rest comes too.
    jammed = false;
    clock += 3_600_000;
    for (const fn of held.splice(0)) fn();
    await settle(() => arrived() === 2);
    g.calls.stop();
    f.calls.stop();
  }, 60_000);

  it.skipIf(LOSES_A_MESSAGE_ON_WINDOWS)('a declined direct call ends for the caller; an unanswered one stops ringing', async () => {
    const cy = await net.add('cy');
    const dee = await net.add('dee');
    await befriend(cy, dee);
    const c = phone(cy);
    const d = phone(dee);
    const toDee = dmConversation(dee.identity.peerId);
    const toCy = dmConversation(cy.identity.peerId);

    c.calls.start(toDee);
    await settle(() => d.view[toCy]?.mine === 'ringing');
    d.calls.decline(toCy);
    await settle(() => c.view[toDee] === undefined);
    expect(c.toasts.at(-1)).toMatch(/can’t talk right now/);

    c.calls.start(toDee);
    await settle(() => d.view[toCy]?.mine === 'ringing');
    d.clock += RING_MS + 1;
    d.calls.tick();
    expect(d.rings.at(-1)?.on).toBe(false);
    c.clock += RING_MS + 1;
    c.calls.tick();
    expect(c.toasts.at(-1)).toMatch(/didn’t answer/);
    expect(c.view[toDee]).toBeUndefined();
    c.calls.stop();
    d.calls.stop();
  }, 60_000);

  // Two people dialling at once is BLG-728's case: on Windows' runners a message now and then never comes.
  it.skipIf(LOSES_A_MESSAGE_ON_WINDOWS)('a channel call: two people starting at once end up in the same call, and a closed window leaves it', async () => {
    const eve = await net.add('eve');
    const fay = await net.add('fay');
    const gil = await net.add('gil');
    await befriend(eve, fay);
    await befriend(eve, gil);
    await befriend(fay, gil);
    const group = eve.mesh.createGroup('standup', [fay.identity.peerId, gil.identity.peerId]);
    await settle(() => fay.group(group.id)?.active && gil.group(group.id)?.active);
    const conv = groupConversation(group.id);
    const e = phone(eve);
    const f = phone(fay);
    const g = phone(gil);
    // Both press Call before hearing the other.
    e.calls.start(conv);
    f.calls.start(conv);
    await settle(() => e.view[conv]?.people.length === 2 && f.view[conv]?.people.length === 2 && e.view[conv]?.id === f.view[conv]?.id);
    await settle(() => g.view[conv]?.people.length === 2);
    expect(g.view[conv]!.id).toBe(e.view[conv]!.id);

    g.calls.join(conv);
    await settle(() => e.view[conv]?.people.length === 3 && f.view[conv]?.people.length === 3);

    // Gil's window goes away (nothing says it's still there): he's out of the call.
    g.clock += GONE_MS + 1;
    g.calls.tick();
    expect(g.view[conv]?.mine).not.toBe('in');
    await settle(() => e.view[conv]?.people.length === 2);
    for (const x of [e, f, g]) x.calls.stop();
  }, 60_000);

  it('ignores call frames from someone outside the conversation', async () => {
    const hal = await net.add('hal');
    const ivy = await net.add('ivy');
    await befriend(hal, ivy);
    const i = phone(ivy);
    i.calls.receive(hal.identity.peerId, { k: 'ring', call: '0123456789abcdef', g: 'f'.repeat(32), at: 1, state: { muted: false, sharing: false, joinedAt: 1 } });
    i.calls.receive(hal.identity.peerId, { k: 'nonsense' });
    expect(i.view).toEqual({});
    i.calls.stop();
  }, 30_000);
});
