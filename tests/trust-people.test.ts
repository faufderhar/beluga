import { describe, expect, it, vi } from 'vitest';
import { TRUST_INFO, defaultTrust, reachOf, requesterTrust, trustOf } from '../src/core/trust.js';
import { People, type PeopleDeps } from '../src/core/people.js';
import { Store, initialState, reduce, type DomainState, type Policy } from '../src/core/store.js';
import type { Settings } from '../src/core/settings.js';
import type { PeerInfo } from '../src/protocol.js';

const peer = (peerId: string, name = peerId): PeerInfo => ({ peerId, name, agent: true, shares: [] });
const SELF = 'self-peer-id';
const BOB = 'bob-peer-id';
const ANN = 'ann-peer-id';

const withSelf = (policy: Policy = 'ask'): DomainState => reduce(initialState('r', policy), { type: 'welcome', self: peer(SELF, 'kay') });

describe('trust', () => {
  it('defaultTrust maps policy to a level', () => {
    expect(defaultTrust({ policy: 'deny' })).toBe('blocked');
    expect(defaultTrust({ policy: 'auto' })).toBe('trusted');
    expect(defaultTrust({ policy: 'ask' })).toBe('ask');
  });

  it('you always fully trust yourself, whatever the policy or levels', () => {
    const s = reduce(withSelf('deny'), { type: 'trust_level', peerId: SELF, level: 'blocked' });
    expect(trustOf(s, SELF)).toBe('full');
  });

  it('requesterTrust gives the same answers as trustOf and reachOf', () => {
    const s = reduce(reduce(withSelf('auto'), { type: 'trust_level', peerId: BOB, level: 'blocked' }), { type: 'trust_level', peerId: ANN, level: 'full' });
    for (const id of [SELF, BOB, ANN, 'someone-else']) expect(requesterTrust(s, id)).toEqual({ level: trustOf(s, id), reach: reachOf(s, id) });
  });

  it('an explicit level beats the policy default', () => {
    const s = reduce(withSelf('auto'), { type: 'trust_level', peerId: BOB, level: 'blocked' });
    expect(trustOf(s, BOB)).toBe('blocked');
    expect(trustOf(s, ANN)).toBe('trusted');
    expect(trustOf(withSelf('deny'), ANN)).toBe('blocked');
  });

  it('works before you know who you are', () => {
    const s = initialState('r');
    expect(s.self).toBeUndefined();
    expect(trustOf(s, BOB)).toBe('ask');
  });

  it('a friend who is not in the room keeps the trust you saved for them', () => {
    // Bran posts in a shared worktree through the friends network: never a room peer, so no live level.
    const s = reduce(withSelf('ask'), { type: 'remembered', people: { [BOB]: { name: 'Bran', trust: 'full' } } });
    expect(trustOf(s, BOB)).toBe('full');
    expect(reachOf(s, BOB)).toBe('full');
    // A level chosen in the room now still wins over the saved one.
    expect(trustOf(reduce(s, { type: 'trust_level', peerId: BOB, level: 'ask' }), BOB)).toBe('ask');
    expect(trustOf(s, ANN)).toBe('ask');
  });

  it('reachOf: full trust reaches everywhere, else your access choice, default folder', () => {
    let s = withSelf();
    expect(reachOf(s, BOB)).toBe('folder');
    expect(reachOf(s, SELF)).toBe('full');
    s = reduce(s, { type: 'access', peerId: BOB, scope: 'full' });
    expect(reachOf(s, BOB)).toBe('full');
    s = reduce(s, { type: 'access', peerId: ANN, scope: 'folder' });
    s = reduce(s, { type: 'trust_level', peerId: ANN, level: 'full' });
    expect(reachOf(s, ANN)).toBe('full');
    s = reduce(s, { type: 'trust_level', peerId: ANN, level: 'trusted' });
    expect(reachOf(s, ANN)).toBe('folder');
  });

  it('has a label for every level', () => {
    expect(Object.keys(TRUST_INFO).sort()).toEqual(['ask', 'blocked', 'full', 'trusted']);
    for (const info of Object.values(TRUST_INFO)) expect(info.label && info.short && info.detail).toBeTruthy();
  });
});

const setup = (saved: Settings['people'] = {}) => {
  const store = new Store(withSelf());
  const save = vi.fn<PeopleDeps['save']>();
  const toast = vi.fn<PeopleDeps['toast']>();
  const deps: PeopleDeps = { store, selfId: () => SELF, saved, save, toast };
  const people = new People(deps);
  const join = (...ps: PeerInfo[]) => {
    const before = store.getState().peers;
    const after = [...before, ...ps];
    store.dispatch({ type: 'peers', peers: after });
    people.onPeers(before, after);
  };
  return { store, save, toast, people, join };
};

describe('People', () => {
  it('publishes saved choices on start without mutating the input', () => {
    const saved = { [BOB]: { name: 'bob', trust: 'trusted' as const } };
    const { store, people } = setup(saved);
    expect(store.getState().remembered).toEqual(saved);
    expect(people.remembered).toEqual(saved);
    people.forget(BOB);
    expect(saved).toEqual({ [BOB]: { name: 'bob', trust: 'trusted' } });
  });

  it('re-applies saved levels when someone joins (no prompt)', () => {
    const { store, join } = setup({ [BOB]: { name: 'bob', trust: 'full' } });
    join(peer(BOB, 'bob'));
    expect(store.getState().levels[BOB]).toBe('full');
    expect(store.getState().trustPrompts).toEqual([]);
  });

  it('asks about unknown people, once', () => {
    const { store, join, people } = setup();
    join(peer(ANN, 'ann'));
    expect(store.getState().trustPrompts).toEqual([ANN]);
    expect(store.getState().levels[ANN]).toBeUndefined();
    // Already-known peers are not prompted again.
    const spy = vi.spyOn(store, 'dispatch');
    const now = store.getState().peers;
    people.onPeers(now, now);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores yourself joining', () => {
    const { store, join } = setup({ [SELF]: { name: 'kay', trust: 'blocked' } });
    join(peer(SELF, 'kay'));
    expect(store.getState().trustPrompts).toEqual([]);
    expect(store.getState().levels[SELF]).toBeUndefined();
  });

  it('handles several joiners at once', () => {
    const { store, join } = setup({ [BOB]: { name: 'bob', trust: 'blocked' } });
    join(peer(BOB), peer(ANN));
    expect(store.getState().levels).toEqual({ [BOB]: 'blocked' });
    expect(store.getState().trustPrompts).toEqual([ANN]);
  });

  it('setTrust applies, hides the prompt, saves with the name, publishes and toasts', () => {
    const { store, join, people, save, toast } = setup();
    join(peer(ANN, 'ann'));
    people.setTrust(ANN, 'trusted');
    const s = store.getState();
    expect(s.levels[ANN]).toBe('trusted');
    expect(s.trustPrompts).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({ [ANN]: { name: 'ann', trust: 'trusted' } });
    expect(s.remembered).toEqual({ [ANN]: { name: 'ann', trust: 'trusted' } });
    expect(people.remembered).toEqual({ [ANN]: { name: 'ann', trust: 'trusted' } });
    expect(toast).toHaveBeenCalledWith(`ann: ${TRUST_INFO.trusted.label}. ${TRUST_INFO.trusted.detail}`, 'success');
  });

  it('setTrust quietly skips the toast and truncates long names to 32', () => {
    const { join, people, save, toast } = setup();
    const long = 'x'.repeat(40);
    join(peer(BOB, long));
    people.setTrust(BOB, 'blocked', true);
    expect(toast).not.toHaveBeenCalled();
    expect(save.mock.calls[0]![0][BOB]).toEqual({ name: 'x'.repeat(32), trust: 'blocked' });
  });

  it('setTrust for someone not present saves a short-id name', () => {
    const { people, save } = setup();
    people.setTrust(BOB, 'ask', true);
    expect(save).toHaveBeenLastCalledWith({ [BOB]: { name: BOB.slice(0, 6), trust: 'ask' } });
  });

  it('setTrust keeps other saved people', () => {
    const { people, save } = setup({ [ANN]: { name: 'ann', trust: 'full' } });
    people.setTrust(BOB, 'trusted', true);
    expect(save).toHaveBeenLastCalledWith({ [ANN]: { name: 'ann', trust: 'full' }, [BOB]: { name: BOB.slice(0, 6), trust: 'trusted' } });
  });

  it('setTrust on yourself does nothing', () => {
    const { store, people, save, toast } = setup();
    const before = store.getState();
    people.setTrust(SELF, 'blocked');
    expect(store.getState()).toBe(before);
    expect(save).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('forget removes the saved choice, persists, and clears the level', () => {
    const { store, join, people, save } = setup({ [BOB]: { name: 'bob', trust: 'trusted' }, [ANN]: { name: 'ann', trust: 'ask' } });
    join(peer(BOB));
    expect(store.getState().levels[BOB]).toBe('trusted');
    people.forget(BOB);
    expect(save).toHaveBeenLastCalledWith({ [ANN]: { name: 'ann', trust: 'ask' } });
    expect(store.getState().remembered).toEqual({ [ANN]: { name: 'ann', trust: 'ask' } });
    expect(store.getState().levels[BOB]).toBeUndefined();
    expect(people.remembered).not.toHaveProperty(BOB);
  });

  it('forgotten people get prompted next time they join', () => {
    const { store, join, people } = setup({ [BOB]: { name: 'bob', trust: 'trusted' } });
    people.forget(BOB);
    join(peer(BOB));
    expect(store.getState().trustPrompts).toEqual([BOB]);
  });

  it('dismissPrompt hides the card without saving', () => {
    const { store, join, people, save } = setup();
    join(peer(ANN), peer(BOB));
    people.dismissPrompt(ANN);
    expect(store.getState().trustPrompts).toEqual([BOB]);
    expect(save).not.toHaveBeenCalled();
  });
});
