import { describe, expect, it } from 'vitest';
import { allNeeds } from '../src/companion/needs-you.js';
import { isKnownAction } from '../src/core/known-actions.js';
import { type Action, type DomainState, initialState } from '../src/core/store.js';
import { type SocketLike, SocketClient } from '../src/ipc/socket-client.js';
import { replay, withDefaults } from '../src/ipc/state-compat.js';
import { bellCount, waitingList } from '../packages/mac/src/layout/waiting-model.js';
import { waitFor } from './helpers.js';

/**
 * Several Beluga versions in one cluster: a screen reads the daemons of other computers you
 * paired, and nothing checks their versions match. An older daemon leaves out what it doesn't have;
 * a newer one sends actions this screen's reducer doesn't know, or with a shape it throws on.
 */

const without = (state: DomainState, key: string): DomainState => {
  const copy = { ...state } as Record<string, unknown>;
  delete copy[key];
  return copy as unknown as DomainState;
};
const ALL = Object.keys(initialState('x'));
const NEWER = { type: 'from_a_newer_beluga', what: 1 } as unknown as Action;

describe('an older daemon’s state gets every part this version has', () => {
  it.each(ALL)('a snapshot without `%s` gets it back, empty, and keeps what it sent', (key) => {
    const theirs = { ...without(initialState('peer'), key), ...(key === 'room' ? {} : { room: 'peer' }) } as DomainState;
    const filled = withDefaults(theirs);
    expect((filled as unknown as Record<string, unknown>)[key]).toEqual((initialState('') as unknown as Record<string, unknown>)[key]);
    if (key !== 'room') expect(filled.room).toBe('peer');
    // What the bell reads from every paired computer's state (machines/remote-attention.ts).
    expect(() => bellCount(filled, waitingList(filled))).not.toThrow();
    expect(allNeeds(filled)).toEqual([]);
  });

  it('several parts missing at once, as from a much older daemon', () => {
    const theirs = ALL.slice(ALL.length / 2).reduce(without, initialState('peer'));
    expect(() => allNeeds(withDefaults(theirs))).not.toThrow();
  });

  it('a field missing inside a part: filled, the rest kept', () => {
    const { planShares: _new, ...older } = initialState('peer').team;
    const theirs = { ...initialState('peer'), team: { ...older, enabled: true } } as unknown as DomainState;
    expect(withDefaults(theirs).team).toMatchObject({ enabled: true, planShares: {} });
  });

  it('a complete state is passed through as it is', () => {
    const full = initialState('mac');
    expect(withDefaults(full)).toBe(full);
  });
});

describe('replaying another version’s actions', () => {
  it('an action that replaces a part with an older shape: the part is filled', () => {
    const { planShares: _new, ...older } = initialState('peer').team;
    const { state, outcome } = replay(initialState('peer'), { type: 'team_state', state: { ...older, enabled: true } } as unknown as Action);
    expect(outcome).toBe('ok');
    expect(state.team).toMatchObject({ enabled: true, planShares: {} });
  });

  it('a newer daemon’s action this reducer doesn’t know: skipped, and said so', () => {
    const before = initialState('peer');
    expect(isKnownAction('team_state')).toBe(true);
    expect(isKnownAction('from_a_newer_beluga')).toBe(false);
    expect(replay(before, NEWER)).toEqual({ state: before, outcome: 'unknown' });
  });

  it('one the reducer throws on (its shape changed): nothing applied, and said so', () => {
    const before = initialState('peer');
    const changed = { type: 'peers', peers: 'no longer a list' } as unknown as Action;
    expect(replay(before, changed)).toEqual({ state: before, outcome: 'failed' });
  });
});

/** A daemon on the other end of a socket: its welcome, then whatever the test sends. */
function fakeDaemon() {
  const sent: Array<{ t: string }> = [];
  const socket: SocketLike = {
    readyState: 1,
    send: (data) => void sent.push(JSON.parse(data) as { t: string }),
    close: () => undefined,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const say = (frame: unknown): void => socket.onmessage?.({ data: JSON.stringify(frame) });
  return { socket, sent, say };
}

async function connected(snapshot: DomainState, catchUpMs = 0) {
  const d = fakeDaemon();
  const client = SocketClient.connect({ url: 'ws://peer', token: 't', kind: 'test', version: '0.0.0', connect: () => d.socket, catchUpMs });
  d.socket.onopen?.(undefined);
  d.say({ t: 'welcome', clientId: 'c1', version: 'other', ipc: 1, snapshot, seq: 1, clients: 1 });
  return { ...d, client: await client, resyncs: () => d.sent.filter((f) => f.t === 'resync').length };
}

describe('a screen connected to a daemon of another version', () => {
  it('fills its welcome snapshot', async () => {
    const t = await connected(without(initialState('peer'), 'telemetry'));
    expect(t.client.store.getState().telemetry).toEqual(initialState('x').telemetry);
    t.client.close();
  });

  it('asks for a fresh snapshot at once when its reducer throws on an action, and takes it whole', async () => {
    const t = await connected(initialState('peer'));
    t.say({ t: 'action', seq: 2, action: { type: 'peers', peers: 'no longer a list' } });
    expect(t.resyncs()).toBe(1);
    // Actions out of step meanwhile don't ask again.
    t.say({ t: 'action', seq: 3, action: { type: 'status', status: 'x' } });
    expect(t.resyncs()).toBe(1);
    t.say({ t: 'snapshot', snapshot: without(initialState('fresh'), 'telemetry'), seq: 3 });
    expect(t.client.store.getState()).toMatchObject({ room: 'fresh', telemetry: initialState('x').telemetry });
    t.client.close();
  });

  it('after a newer daemon’s actions it can’t replay, asks for one snapshot for the burst, and keeps up meanwhile', async () => {
    const t = await connected(initialState('peer'));
    t.say({ t: 'action', seq: 2, action: NEWER });
    t.say({ t: 'action', seq: 3, action: NEWER });
    // The ones it knows still apply in order.
    t.say({ t: 'action', seq: 4, action: { type: 'status', status: 'still here' } });
    expect(t.client.store.getState().status).toBe('still here');
    await waitFor(() => t.resyncs() === 1);
    t.say({ t: 'snapshot', snapshot: initialState('fresh'), seq: 4 });
    t.say({ t: 'action', seq: 5, action: NEWER });
    await waitFor(() => t.resyncs() === 2);
    t.client.close();
  });
});
