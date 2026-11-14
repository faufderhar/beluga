import { describe, expect, it } from 'vitest';
import { friendNamed, inviteRoute, newChannelLine, parseInvite } from '../src/shared/invite-route.js';
import { suggest } from '../src/ui/suggest.js';
import { channelSuggestions } from '../packages/mac/src/network/chat-model.js';
import { inviteFor, invitePlace } from '../packages/mac/src/lib/invite-model.js';
import { NO_NETWORK } from '../src/core/network-store.js';
import type { FriendView, GroupView } from '../src/net/mesh/views.js';
import type { AppState } from '../src/core/store.js';
import type { Session } from '../src/core/session.js';
import { runCommand } from '../src/core/commands.js';
import { handoffPeople, shareRowDetail, worktreeShareRows } from '../src/ui/worktree-share.js';

/** `/invite` (BLG-203): on its own it adds a friend; with friends named, it adds them to what's on screen. */

const id = (c: string): string => c.repeat(32);
const friend = (name: string): FriendView => ({ peerId: id(name[0]!), name, online: true, presence: { state: 'online' }, addedAt: 0, unread: 0 });
const ata = friend('ata');
const bo = friend('Bo Lin');
const cy = friend('cy');
const friends = [ata, bo, cy];

describe('reading /invite', () => {
  it('takes names with or without @, commas and "and"', () => {
    expect(parseInvite('/invite')).toEqual({ names: [] });
    expect(parseInvite('  /invite   ')).toEqual({ names: [] });
    expect(parseInvite('/invite @')).toEqual({ names: [] });
    expect(parseInvite('/invite @ata')).toEqual({ names: ['ata'] });
    expect(parseInvite('/invite @ata, @BoLin and cy.')).toEqual({ names: ['ata', 'BoLin', 'cy'] });
    expect(parseInvite('/invite @ata @ata')).toEqual({ names: ['ata'] });
    expect(parseInvite('/inviteme')).toBeUndefined();
    expect(parseInvite('please /invite @ata')).toBeUndefined();
    expect(parseInvite('/INVITE @ata')).toEqual({ names: ['ata'] });
  });

  it('knows friends by their @handle or their name, any case', () => {
    expect(friendNamed('BoLin', friends)?.peerId).toBe(bo.peerId);
    expect(friendNamed('bolin', friends)?.peerId).toBe(bo.peerId);
    expect(friendNamed('ATA', friends)?.peerId).toBe(ata.peerId);
    expect(friendNamed('zed', friends)).toBeUndefined();
  });
});

describe('where /invite @name goes', () => {
  const group = { kind: 'group' as const, groupId: 'g'.repeat(32), name: 'design', members: [ata.peerId], admin: true, active: true };

  it('on its own: Add a Friend, wherever you are', () => {
    expect(inviteRoute({ kind: 'none' }, [], friends)).toEqual({ kind: 'add_friend' });
    expect(inviteRoute(group, [], friends)).toEqual({ kind: 'add_friend' });
  });

  it('in a channel: adds the ones not in it yet (admins only)', () => {
    expect(inviteRoute(group, ['ata', 'cy'], friends)).toEqual({ kind: 'add_members', groupId: group.groupId, group: 'design', friends: [{ ...cy }] });
    expect(inviteRoute(group, ['ata'], friends)).toEqual({ kind: 'error', text: 'ata is already in design' });
    expect(inviteRoute({ ...group, admin: false }, ['cy'], friends)).toEqual({ kind: 'error', text: 'Only an admin of design can add people' });
    expect(inviteRoute({ ...group, active: false }, ['cy'], friends)).toEqual({ kind: 'error', text: 'You’re no longer in design' });
  });

  it('in a DM: offers a new channel with the three of you', () => {
    const route = inviteRoute({ kind: 'dm', peerId: ata.peerId, name: 'ata' }, ['BoLin'], friends);
    expect(route).toEqual({ kind: 'new_channel', with: [{ peerId: ata.peerId, name: 'ata' }, bo] });
    expect(route.kind === 'new_channel' ? newChannelLine(route.with) : '').toBe('New channel with you, ata and Bo Lin');
    expect(inviteRoute({ kind: 'dm', peerId: ata.peerId, name: 'ata' }, ['ata'], friends)).toEqual({ kind: 'error', text: 'You’re already talking with ata' });
  });

  it('in a worktree or a project: shares it with them', () => {
    expect(inviteRoute({ kind: 'workspace', workspaceId: 'w1', projectId: 'p1', name: 'add-auth' }, ['cy'], friends)).toEqual({ kind: 'share', friends: [cy], workspaceId: 'w1', projectId: 'p1', where: 'add-auth' });
    expect(inviteRoute({ kind: 'project', projectId: 'p1', name: 'beluga' }, ['ata', 'cy'], friends)).toEqual({ kind: 'share', friends: [ata, cy], projectId: 'p1', where: 'beluga' });
  });

  it('someone who isn’t a friend, or nowhere to add them, says so', () => {
    expect(inviteRoute(group, ['zed'], friends)).toEqual({ kind: 'error', text: 'zed isn’t your friend yet. Type /invite on its own to send a friend link' });
    expect(inviteRoute(group, ['zed', 'yo'], friends)).toMatchObject({ kind: 'error', text: expect.stringMatching(/^zed and yo aren’t your friends yet/) });
    expect(inviteRoute({ kind: 'none' }, ['ata'], friends)).toMatchObject({ kind: 'error', text: expect.stringMatching(/^Open the chat, channel, project or worktree to add ata to/) });
  });
});

describe('what the Mac sees on screen', () => {
  const g: GroupView = { id: 'f'.repeat(32), name: 'design', members: [{ peerId: ata.peerId, name: 'ata', online: true, presence: { state: 'online' }, admin: true, self: false }], admin: true, active: true, unread: 0, requests: [], createdAt: 0 } as unknown as GroupView;
  const state = (view: AppState['view']): Pick<AppState, 'view' | 'projects' | 'network'> => ({
    view,
    projects: [{ id: 'p1', name: 'beluga', root: '/p', workspaces: [{ id: 'w1', name: 'add-auth', projectId: 'p1' }] }] as unknown as AppState['projects'],
    network: { ...NO_NETWORK, enabled: true, friends, groups: [g] },
  });

  it('reads the DM, the channel, the worktree and the project in view', () => {
    expect(invitePlace(state({ kind: 'conversation', id: `dm:${ata.peerId}` }))).toEqual({ kind: 'dm', peerId: ata.peerId, name: 'ata' });
    expect(invitePlace(state({ kind: 'conversation', id: `group:${g.id}` }))).toEqual({ kind: 'group', groupId: g.id, name: 'design', members: [ata.peerId], admin: true, active: true });
    expect(invitePlace(state({ kind: 'workspace', id: 'w1', tab: 'chat' } as AppState['view']))).toEqual({ kind: 'workspace', workspaceId: 'w1', projectId: 'p1', name: 'add-auth' });
    expect(invitePlace(state({ kind: 'project', id: 'p1' }))).toEqual({ kind: 'project', projectId: 'p1', name: 'beluga' });
    expect(invitePlace(state({ kind: 'overview' } as AppState['view']))).toEqual({ kind: 'none' });
  });

  it('routes what was typed, and leaves other words alone', () => {
    expect(inviteFor('/invite', state({ kind: 'overview' } as AppState['view']))).toEqual({ kind: 'add_friend' });
    expect(inviteFor('/invite @cy', state({ kind: 'conversation', id: `group:${g.id}` }))).toMatchObject({ kind: 'add_members', friends: [{ peerId: cy.peerId }] });
    expect(inviteFor('hello @cy', state({ kind: 'overview' } as AppState['view']))).toBeUndefined();
    expect(inviteFor('/invitation', state({ kind: 'overview' } as AppState['view']))).toBeUndefined();
  });
});

describe('completing friends after /invite', () => {
  it('in the chat box: /invite, then your friends by @handle', () => {
    const ctx = { peers: [], selfId: id('k'), friends: friends.map((f) => ({ name: f.name, online: true })) };
    expect(suggest('/inv', ctx)[0]).toMatchObject({ label: '/invite [@friend]', value: '/invite ' });
    expect(suggest('/invite ', ctx).map((s) => s.value)).toEqual(['/invite @ata', '/invite @BoLin', '/invite @cy']);
    expect(suggest('/invite @b', ctx).map((s) => [s.label, s.enter])).toEqual([['@BoLin', 'submit']]);
  });

  it('in a DM’s or channel’s box: /invite, then friends who aren’t in it', () => {
    const people = [{ peerId: ata.peerId, name: 'ata' }];
    expect(channelSuggestions('/in', { people, friends }).map((s) => [s.label, s.value])).toEqual([['/invite', '/invite @']]);
    expect(channelSuggestions('/invite @', { people, friends }).map((s) => s.value)).toEqual(['/invite @BoLin', '/invite @cy']);
    expect(channelSuggestions('/invite @c', { people, friends }).map((s) => s.label)).toEqual(['cy']);
  });
});

describe('/invite @friend in a worktree, read by the daemon (BLG-340)', () => {
  const peerAta = { peerId: ata.peerId, name: 'ata', agent: true };
  const fake = (network: boolean) => {
    const calls: { net: unknown[]; room: unknown[]; toasts: string[] } = { net: [], room: [], toasts: [] };
    const state = {
      projects: [{ id: 'p1', name: 'beluga', root: '/p', workspaces: [{ id: 'w1', name: 'add-auth', projectId: 'p1' }] }],
      network: { ...NO_NETWORK, enabled: network, friends },
      peers: [peerAta],
    };
    const session = {
      store: { getState: () => state },
      toast: (text: string) => calls.toasts.push(text),
      intend: () => undefined,
      sharing: {
        ...(network ? { friends: {} } : {}),
        shareWithFriend: (share: unknown) => calls.net.push(share),
        invite: (wsId: string, peerId: string, role: string) => calls.room.push([wsId, peerId, role]),
      },
    } as unknown as Session;
    return { session, calls };
  };

  it('shares it over the network, room or not', () => {
    const { session, calls } = fake(true);
    runCommand(session, 'invite', ['@cy'], 'ws:w1');
    expect(calls.net).toEqual([{ peerId: cy.peerId, workspaceId: 'w1', projectId: 'p1', role: 'contribute' }]);
    expect(calls.room).toEqual([]);
    expect(calls.toasts).toEqual([]);
  });

  it('with the network off, someone in your room still gets it through the room', () => {
    const { session, calls } = fake(false);
    runCommand(session, 'invite', ['@ata', '@cy'], 'ws:w1');
    expect(calls.room).toEqual([['w1', ata.peerId, 'contribute']]);
    expect(calls.toasts).toEqual(['Turn on the Beluga network in Settings › Network to share add-auth with cy']);
  });
});

describe('who a worktree’s Share sheet lists (BLG-340)', () => {
  const self = { peerId: id('k'), name: 'kayra' };
  const base = {
    self,
    projects: [{ id: 'p1', name: 'beluga', workspaces: [{ id: 'w1' }, { id: 'w2' }] }],
    network: { ...NO_NETWORK, enabled: true, friends },
    peers: [self, { peerId: id('z'), name: 'zed', guest: true }],
    members: {},
    projectShares: {},
  } as unknown as Parameters<typeof worktreeShareRows>[0];

  it('every friend, over the network, and room people who aren’t friends', () => {
    expect(worktreeShareRows(base, 'w1').map((r) => [r.name, r.via, r.access])).toEqual([
      ['ata', 'network', 'none'],
      ['Bo Lin', 'network', 'none'],
      ['cy', 'network', 'none'],
      ['zed', 'room', 'none'],
    ]);
  });

  it('what each has: one worktree, the whole project, or through the room', () => {
    const state = {
      ...base,
      members: { w1: { [ata.peerId]: 'view' } },
      projectShares: { p1: { [bo.peerId]: { role: 'contribute' }, [cy.peerId]: { role: 'view', only: ['w2'] } } },
    } as unknown as typeof base;
    const rows = worktreeShareRows(state, 'w1');
    expect(rows.slice(0, 3).map((r) => [r.name, r.via, r.access, r.wholeProject])).toEqual([
      ['ata', 'room', 'view', false],
      ['Bo Lin', 'network', 'contribute', true],
      ['cy', 'network', 'none', false],
    ]);
    expect(shareRowDetail(rows[1]!, false)).toBe('Works with your agent across the whole project');
    expect(shareRowDetail(rows[2]!, false)).toBe('Not in this worktree');
    // A chat's Share sheet says chat, never worktree.
    expect(shareRowDetail(rows[2]!, false, 'chat')).toBe('Not in this chat');
    expect(shareRowDetail(rows[2]!, true, 'chat')).toBe('In your room, not in this chat');
  });

  it('a friend shared with over the network is a member too, and still changed and removed over the network (BLG-623)', () => {
    const state = {
      ...base,
      members: { w1: { [ata.peerId]: 'view' } },
      projectShares: { p1: { [ata.peerId]: { role: 'view', only: ['w1'] } } },
    } as unknown as typeof base;
    expect(worktreeShareRows(state, 'w1').slice(0, 1).map((r) => [r.name, r.via, r.access, r.wholeProject])).toEqual([['ata', 'network', 'view', false]]);
  });
});

describe('who a worktree can be handed to (BLG-341)', () => {
  const self = { peerId: id('k'), name: 'kayra' };
  const old = { ...cy, beluga: { version: '0.6.1+mac.1.4.0', can: ['share.project'] } };
  const state = (enabled: boolean) => ({
    self,
    peers: [self, { peerId: ata.peerId, name: 'ata', agent: true }, { peerId: id('z'), name: 'zed', agent: false }],
    network: { ...NO_NETWORK, enabled, friends: [ata, { ...bo, online: false }, old] },
  }) as unknown as Parameters<typeof handoffPeople>[0];

  it('room people with their Claude, then friends over the network; an old Beluga says why', () => {
    expect(handoffPeople(state(true)).map((p) => [p.name, p.via, p.online, p.why])).toEqual([
      ['ata', 'room', true, undefined],
      ['Bo Lin', 'network', false, undefined],
      ['cy', 'network', true, "cy's Beluga 1.4.0 can't open handoffs yet. Ask cy to update Beluga."],
    ]);
  });

  it('with the network off, only the room', () => {
    expect(handoffPeople(state(false)).map((p) => p.name)).toEqual(['ata']);
  });
});
