import { describe, expect, it } from 'vitest';
import { grantScope } from '../src/core/friend-share/service.js';
import { NO_NETWORK } from '../src/core/network-store.js';
import type { FriendView } from '../src/net/mesh/views.js';
import { sharedWithWords, worktreeSharedWith, worktreeShareRows } from '../src/ui/worktree-share.js';

const id = (c: string): string => c.repeat(32);
const friend = (name: string): FriendView => ({ peerId: id(name[0]!), name, online: true, presence: { state: 'online' }, addedAt: 0, unread: 0 });
const bran = friend('bran');
const mia = friend('mia');

describe('what a friend has after a share (one worktree stays one worktree)', () => {
  it('a worktree adds itself to what they have, and the whole project stays whole', () => {
    expect(grantScope(undefined, { workspaceId: 'w1' })).toEqual(['w1']);
    expect(grantScope({ role: 'view', only: ['w1'] }, { workspaceId: 'w2' })).toEqual(['w1', 'w2']);
    expect(grantScope({ role: 'view' }, { workspaceId: 'w2' })).toBeUndefined();
  });

  it('changing their access from the project’s sheet keeps them to their worktrees', () => {
    // Before: no worktree named meant the whole project, so every new worktree went to them too.
    expect(grantScope({ role: 'view', only: ['w1'] }, {})).toEqual(['w1']);
  });

  it('the whole project only when asked, or when it’s their first share of it', () => {
    expect(grantScope({ role: 'view', only: ['w1'] }, { whole: true })).toBeUndefined();
    expect(grantScope(undefined, {})).toBeUndefined();
  });
});

describe('the sidebar’s shared mark on a worktree', () => {
  const self = { peerId: id('k'), name: 'kayra' };
  const base = {
    self,
    projects: [{ id: 'p1', name: 'beluga', workspaces: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] }],
    network: { ...NO_NETWORK, enabled: true, friends: [bran, mia] },
    peers: [self, { peerId: id('z'), name: 'zed' }],
    members: {},
    projectShares: {},
  } as unknown as Parameters<typeof worktreeShareRows>[0];

  it('nobody: no mark', () => {
    expect(worktreeSharedWith(base, 'w1')).toEqual([]);
  });

  it('a friend with one worktree marks that one only, never a new one', () => {
    const state = { ...base, projectShares: { p1: { [bran.peerId]: { role: 'contribute', only: ['w1'] } } } } as unknown as typeof base;
    expect(worktreeSharedWith(state, 'w1')).toEqual([{ peerId: bran.peerId, name: 'bran', role: 'contribute' }]);
    expect(worktreeSharedWith(state, 'w3')).toEqual([]);
  });

  it('the whole project marks every worktree; someone from the room marks theirs', () => {
    const state = { ...base, members: { w2: { [id('z')]: 'view' } }, projectShares: { p1: { [mia.peerId]: { role: 'view' } } } } as unknown as typeof base;
    expect(worktreeSharedWith(state, 'w3').map((p) => p.name)).toEqual(['mia']);
    expect(worktreeSharedWith(state, 'w2').map((p) => p.name)).toEqual(['mia', 'zed']);
  });

  it('a member nobody here knows still counts', () => {
    const state = { ...base, members: { w1: { [id('q')]: 'view' } } } as unknown as typeof base;
    expect(worktreeSharedWith(state, 'w1')).toEqual([{ peerId: id('q'), name: 'someone', role: 'view' }]);
  });

  it('says who in a few words', () => {
    expect(sharedWithWords([{ name: 'Bran' }])).toBe('Shared with Bran');
    expect(sharedWithWords([{ name: 'Bran' }, { name: 'Mia' }])).toBe('Shared with Bran and Mia');
    expect(sharedWithWords([{ name: 'Bran' }, { name: 'Mia' }, { name: 'Zed' }])).toBe('Shared with Bran and 2 others');
  });
});
