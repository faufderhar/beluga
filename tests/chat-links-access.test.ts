import { describe, expect, it } from 'vitest';
import { type ChatAction, chatAccess, chatAccessOf } from '../src/core/chat-links/access.js';
import { type DomainState, initialState } from '../src/core/store.js';

const ME = 'me-me-me-me-me-me-me-me-me-me-me0';
const FRIEND = 'friend-friend-friend-friend-frie';
const GUEST = 'guest-guest-guest-guest-guest-gu';
const ACTIONS: readonly ChatAction[] = ['read', 'send'];

const facts = { self: ME, requester: ME, channel: 'ws:wt-1', ownership: 'own', exists: true } as const;

function stateWith(extra: Partial<Record<keyof DomainState, unknown>> = {}): DomainState {
  return {
    ...initialState('room'),
    selfId: ME,
    projectsLoaded: true,
    projects: [{ id: 'p1', name: 'Beluga', root: '/p', workspaces: [{ id: 'wt-1', name: 'add-auth', projectId: 'p1', projectRoot: '/p', path: '/p/wt-1', kind: 'worktree', createdAt: 0 }] }],
    shared: [
      { owner: FRIEND, id: 'view-1', name: 'Their view', project: 'x', role: 'view', share: 's' },
      { owner: FRIEND, id: 'work-1', name: 'Their work', project: 'x', role: 'contribute', share: 's' },
    ],
    ...extra,
  } as unknown as DomainState;
}

describe('chatAccess, your own run', () => {
  it.each(ACTIONS)('may %s your own chat, from this computer', (action) => {
    expect(chatAccess({ ...facts, action })).toEqual({ allow: true, source: 'local' });
  });

  it.each(ACTIONS)('gets not_found when it would %s a removed chat of yours', (action) => {
    expect(chatAccess({ ...facts, exists: false, action })).toEqual({ allow: false, code: 'not_found' });
  });
});

describe('chatAccess, a run someone else asked for', () => {
  const others = [
    ['friend', FRIEND],
    ['guest', GUEST],
  ] as const;

  describe.each(others)('from a %s', (_who, requester) => {
    it.each(ACTIONS)('may not %s your chat', (action) => {
      expect(chatAccess({ ...facts, requester, action })).toEqual({ allow: false, code: 'requester_refused' });
    });

    it.each(ACTIONS)('may not %s a chat it contributes to', (action) => {
      expect(chatAccess({ ...facts, requester, ownership: 'shared', role: 'contribute', action })).toEqual({ allow: false, code: 'requester_refused' });
    });

    it('learns nothing about what exists: every chat gets the same answer', () => {
      const answers = [{ ...facts }, { ...facts, exists: false }, { ...facts, ownership: 'unknown' as const }, { ...facts, channel: 'room' }].map((f) => chatAccess({ ...f, requester, action: 'read' }));
      expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    });
  });
});

describe('chatAccess, a chat shared with you', () => {
  const shared = { ...facts, ownership: 'shared', channel: 'ws:work-1' } as const;

  it.each(['view', 'contribute'] as const)('reads only the local mirror, with role %s', (role) => {
    expect(chatAccess({ ...shared, role, action: 'read' })).toEqual({ allow: true, source: 'mirror' });
  });

  it('sends with role contribute, and the owner still decides', () => {
    expect(chatAccess({ ...shared, role: 'contribute', action: 'send' })).toEqual({ allow: true, source: 'mirror', ownerDecides: true });
  });

  it('may not send with role view', () => {
    expect(chatAccess({ ...shared, role: 'view', action: 'send' })).toEqual({ allow: false, code: 'view_only' });
  });

  it('may not send with no known role', () => {
    expect(chatAccess({ ...shared, action: 'send' })).toEqual({ allow: false, code: 'view_only' });
  });
});

describe('chatAccess, a chat that is not shared with you', () => {
  it.each(ACTIONS)('%s gives the same refusal as a chat that does not exist', (action) => {
    const notShared = chatAccess({ ...facts, ownership: 'unknown', action });
    expect(notShared).toEqual({ allow: false, code: 'not_found' });
    expect(notShared).toEqual(chatAccess({ ...facts, exists: false, action }));
  });
});

describe('chatAccess, what has no address', () => {
  it.each(['room', 'dm:friend', 'group:abc', 'draft:1'])('%s is not addressable', (channel) => {
    for (const action of ACTIONS) expect(chatAccess({ ...facts, channel, action })).toEqual({ allow: false, code: 'not_addressable' });
  });
});

describe('chatAccessOf, from the state', () => {
  const ask = (state: DomainState, requester: string, ref: string, action: ChatAction = 'read') => chatAccessOf(state, { requester, ref, action });

  it('allows your own run on your own chat', () => {
    expect(ask(stateWith(), ME, `${ME}/ws:wt-1`, 'send')).toEqual({ allow: true, source: 'local' });
  });

  it('refuses a friend run on your own chat', () => {
    expect(ask(stateWith(), FRIEND, `${ME}/ws:wt-1`)).toEqual({ allow: false, code: 'requester_refused' });
  });

  it('refuses a guest run on your own chat', () => {
    expect(ask(stateWith(), GUEST, `${ME}/ws:wt-1`)).toEqual({ allow: false, code: 'requester_refused' });
  });

  it('takes the role of a shared chat from what was shared', () => {
    expect(ask(stateWith(), ME, `${FRIEND}/ws:view-1`)).toEqual({ allow: true, source: 'mirror' });
    expect(ask(stateWith(), ME, `${FRIEND}/ws:view-1`, 'send')).toEqual({ allow: false, code: 'view_only' });
    expect(ask(stateWith(), ME, `${FRIEND}/ws:work-1`, 'send')).toEqual({ allow: true, source: 'mirror', ownerDecides: true });
  });

  it('gives a not-shared chat and a missing chat the same refusal', () => {
    const notShared = ask(stateWith(), ME, `${FRIEND}/ws:private`);
    const missing = ask(stateWith(), ME, `${ME}/ws:gone`);
    expect(notShared).toEqual({ allow: false, code: 'not_found' });
    expect(missing).toEqual(notShared);
  });

  it('gives not_addressable for a room ref and for text that is no ref', () => {
    expect(ask(stateWith(), ME, `${ME}/room`)).toEqual({ allow: false, code: 'not_addressable' });
    expect(ask(stateWith(), ME, 'hello')).toEqual({ allow: false, code: 'not_addressable' });
  });

  describe('at full trust', () => {
    const full = stateWith({ levels: { [FRIEND]: 'full', [GUEST]: 'full' }, access: { [FRIEND]: 'full' }, remembered: { [FRIEND]: { trust: 'full' } } });

    it('still refuses a friend run on your chat', () => {
      for (const action of ACTIONS) expect(ask(full, FRIEND, `${ME}/ws:wt-1`, action)).toEqual({ allow: false, code: 'requester_refused' });
    });

    it('still refuses a guest run on your chat', () => {
      expect(ask(full, GUEST, `${ME}/ws:wt-1`)).toEqual({ allow: false, code: 'requester_refused' });
    });

    it('still gives not_found for a chat of theirs that is not shared', () => {
      for (const action of ACTIONS) expect(ask(full, ME, `${FRIEND}/ws:private`, action)).toEqual({ allow: false, code: 'not_found' });
    });

    it('does not widen role view', () => {
      expect(ask(full, ME, `${FRIEND}/ws:view-1`, 'send')).toEqual({ allow: false, code: 'view_only' });
    });
  });
});
