import { describe, expect, it } from 'vitest';
import { channelSuggestions, mentionedAsk, mergeAsk } from '../packages/mac/src/network/chat-model.js';
import type { FriendView, MemberView, MessageView } from '../src/net/mesh/views.js';
import {
  acceptError,
  addableFriends,
  continues,
  conversationOf,
  dayLabel,
  expiryLabel,
  findInvitation,
  idleStep,
  rememberIdleAway,
  wasIdleAway,
  membersLine,
  mergeMessages,
  openFriendInvitation,
  hostToBefriend,
  incomingOffers,
  notFriendsYet,
  offerSent,
  roomBits,
  presenceFor,
  statusText,
  belugaLine,
  presenceLine,
  readCode,
  selfLine,
  shownState,
  sortFriends,
  sortMembers,
  timeLeft,
  totalUnread,
  unreadSince,
  keepsFollowing,
  untilOf,
} from '../packages/mac/src/network/net-model.js';

/** The Mac app's friends, groups and status screens: what they say and decide (packages/mac/src/network/net-model.ts). */

const id = (c: string): string => c.repeat(32);
const friend = (name: string, extra: Partial<FriendView> = {}): FriendView => ({ peerId: id(name[0]!), name, online: true, presence: { state: 'online' }, addedAt: 0, unread: 0, ...extra });
const member = (name: string, extra: Partial<MemberView> = {}): MemberView => ({ peerId: id(name[0]!), name, online: true, presence: { state: 'online' }, admin: false, self: false, ...extra });
const msg = (from: string, ts: number, extra: Partial<MessageView> = {}): MessageView => ({ id: `${from}${ts}`, conversation: 'dm:x', from, name: from, text: 'hi', ts, mine: false, ...extra });

describe('conversations', () => {
  it('reads dm:<peer> and group:<id>, and nothing else', () => {
    expect(conversationOf(`dm:${id('a')}`)).toEqual({ kind: 'dm', peerId: id('a') });
    expect(conversationOf(`group:${'f'.repeat(32)}`)).toEqual({ kind: 'group', groupId: 'f'.repeat(32) });
    expect(conversationOf('ws:w1')).toBeUndefined();
    expect(conversationOf('group:nope')).toBeUndefined();
  });

  it('runs messages together by author within a few minutes on one day', () => {
    expect(continues(msg('a', 0), msg('a', 60_000))).toBe(true);
    expect(continues(msg('a', 0), msg('b', 60_000))).toBe(false);
    expect(continues(msg('a', 0), msg('a', 10 * 60_000))).toBe(false);
    expect(continues(msg('a', 0, { status: 'locked' }), msg('a', 1))).toBe(false);
    expect(continues(undefined, msg('a', 0))).toBe(false);
  });

  it('merges earlier history with the latest messages once each', () => {
    const a = msg('a', 1);
    const b = msg('a', 2);
    const c = msg('a', 3);
    expect(mergeMessages([a, b], [b, c]).map((m) => m.ts)).toEqual([1, 2, 3]);
  });

  it('marks what came in since you last read: their last messages, up to where you came in (BLG-573)', () => {
    const list = [msg('a', 1), msg('me', 2, { mine: true }), msg('a', 3), msg('b', 4), msg('me', 5, { mine: true })];
    expect([...unreadSince(list, 2)]).toEqual(['a3', 'b4']);
    expect([...unreadSince(list, 0)]).toEqual([]);
    expect([...unreadSince(list, 9)]).toEqual(['a1', 'a3', 'b4']);
    // What arrives while you're here was read as it came: the marks stay where you came in.
    const later = [...list, msg('a', 6)];
    expect([...unreadSince(later, 2, 'me5')]).toEqual(['a3', 'b4']);
    expect([...unreadSince(later, 2, 'gone')]).toEqual(['b4', 'a6']);
  });

  it('keeps following the bottom until you scroll up, not when what grows under it pushes it (BLG-573)', () => {
    const at = (top: number, height = 1000, client = 400) => ({ top, height, client });
    expect(keepsFollowing(true, 600, at(600))).toBe(true);
    // A picture loaded under the bottom: the log grew, scrollTop didn't move.
    expect(keepsFollowing(true, 600, at(600, 1300))).toBe(true);
    // You scrolled up.
    expect(keepsFollowing(true, 600, at(500))).toBe(false);
    expect(keepsFollowing(false, 500, at(520))).toBe(false);
    // Back at the bottom.
    expect(keepsFollowing(false, 500, at(580))).toBe(true);
  });

  it('labels days like Messages', () => {
    const now = new Date(2026, 9, 18, 15).getTime();
    expect(dayLabel(now - 60_000, now)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 17, 23).getTime(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 0, 2).getTime(), now)).not.toMatch(/2026/);
    expect(dayLabel(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/);
  });
});

describe('presence', () => {
  it('shows someone offline unless connected and visible', () => {
    expect(shownState({ online: false, presence: { state: 'away' } })).toBe('offline');
    expect(shownState({ online: true, presence: { state: 'dnd' } })).toBe('dnd');
    expect(shownState({ online: true, presence: { state: 'offline' } })).toBe('offline');
  });

  it('says the status with the note, but not an offline person’s note', () => {
    expect(presenceLine({ online: true, presence: { state: 'away', note: 'in a meeting' } })).toBe('Away · in a meeting');
    expect(presenceLine({ online: false, presence: { state: 'away', note: 'in a meeting' } })).toBe('Offline');
  });

  it('puts the status emoji before the note, and says it alone when there is no note', () => {
    expect(presenceLine({ online: true, presence: { state: 'online', emoji: '🐋', note: 'Beluga' } })).toBe('Online · 🐋 Beluga');
    expect(presenceLine({ online: true, presence: { state: 'away', emoji: '🌮' } })).toBe('Away · 🌮');
    expect(presenceLine({ online: false, presence: { state: 'away', emoji: '🌮' } })).toBe('Offline');
    expect(selfLine({ state: 'online', emoji: ' 🎧 ', note: 'focus' })).toBe('Online · 🎧 focus');
    expect(statusText({})).toBe('');
  });

  it('says who needs to update instead of just offline, and which Beluga they’re on', () => {
    expect(presenceLine({ online: false, presence: { state: 'offline' }, update: 'them' })).toBe('Offline to you · their Beluga needs an update');
    expect(presenceLine({ online: false, presence: { state: 'offline' }, update: 'you' })).toBe('Update Beluga to reach them');
    expect(belugaLine({ beluga: { version: '0.6.2+mac.1.2.0', can: [] } })).toBe('1.2.0');
    expect(belugaLine({})).toBe('An older version (it doesn’t say)');
    expect(belugaLine({ beluga: { version: '0.6.2+mac.1.1.0', can: [] }, update: 'them' })).toBe('1.1.0 · they need to update to reach you');
  });

  it('says your own choice, how long it lasts and your note', () => {
    const now = new Date(2026, 9, 18, 15, 0).getTime();
    expect(selfLine({ state: 'offline' }, now)).toBe('Appear Offline');
    expect(selfLine({ state: 'dnd', until: now + 30 * 60_000, note: 'focus' }, now)).toMatch(/^Do Not Disturb until 3:30\s?PM · focus$/);
    expect(selfLine({ state: 'dnd', until: untilOf('tomorrow', now)! }, now)).toMatch(/until tomorrow, 9:00\s?AM/);
  });

  it('builds a status: durations only for non-Online, notes trimmed', () => {
    const now = 1_000_000;
    expect(presenceFor('online', { note: '  hi ', duration: 'hour' }, now)).toEqual({ state: 'online', note: 'hi' });
    expect(presenceFor('dnd', { duration: 'hour' }, now)).toEqual({ state: 'dnd', until: now + 3_600_000 });
    expect(presenceFor('online', { emoji: ' 🐋 ', note: 'Beluga' }, now)).toEqual({ state: 'online', note: 'Beluga', emoji: '🐋' });
    expect(presenceFor('online', { emoji: '', note: 'Beluga' }, now)).toEqual({ state: 'online', note: 'Beluga' });
    expect(presenceFor('away', {}, now)).toEqual({ state: 'away' });
    expect(presenceFor('away', { note: 'x'.repeat(200) }, now).note).toHaveLength(140);
  });

  it('goes Away when idle (only from Online) and back when you return (only if it did that)', () => {
    const online = { state: 'online' as const };
    const away = { state: 'away' as const };
    expect(idleStep({ presence: online, idleMs: 11 * 60_000, autoAway: false })).toBe('away');
    expect(idleStep({ presence: online, idleMs: 60_000, autoAway: false })).toBeUndefined();
    expect(idleStep({ presence: { state: 'dnd' }, idleMs: 60 * 60_000, autoAway: false })).toBeUndefined();
    expect(idleStep({ presence: away, idleMs: 1_000, autoAway: true })).toBe('online');
    expect(idleStep({ presence: away, idleMs: 1_000, autoAway: false })).toBeUndefined();
    expect(idleStep({ presence: away, idleMs: 20 * 60_000, autoAway: true })).toBeUndefined();
    // A mark left from before (or the core not caught up yet) never keeps an idle Online from going Away.
    expect(idleStep({ presence: online, idleMs: 11 * 60_000, autoAway: true })).toBe('away');
    expect(idleStep({ presence: online, idleMs: 1_000, autoAway: true })).toBeUndefined();
  });

  it('remembers an idle Away across reloads, and forgets it when you pick a status', () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
    expect(wasIdleAway(store)).toBe(false);
    rememberIdleAway(true, store);
    expect(wasIdleAway(store)).toBe(true);
    expect(idleStep({ presence: { state: 'away' }, idleMs: 1_000, autoAway: wasIdleAway(store) })).toBe('online');
    rememberIdleAway(false, store);
    expect(wasIdleAway(store)).toBe(false);
    // No storage, or storage that throws: no mark, never a crash.
    expect(wasIdleAway(undefined)).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => undefined };
    expect(() => rememberIdleAway(true, broken)).not.toThrow();
    expect(wasIdleAway(broken)).toBe(false);
  });
});

describe('invitations', () => {
  it('finds a link or a code in pasted text', () => {
    const secret = 'A'.repeat(22);
    expect(findInvitation(`hey, use klaud://add#${secret} tonight`)).toEqual({ text: `klaud://add#${secret}`, group: false });
    expect(findInvitation(`klaud://join#${secret}`)).toEqual({ text: `klaud://join#${secret}`, group: true });
    expect(findInvitation('klaud://add?code=K7QM-4XPA-R2TD')).toEqual({ text: 'klaud://add?code=K7QM-4XPA-R2TD', group: false });
    // New links say beluga://; klaud:// ones from before the rename still count.
    expect(findInvitation(`use beluga://add#${secret} tonight`)).toEqual({ text: `beluga://add#${secret}`, group: false });
    expect(findInvitation('beluga://join?code=K7QM-4XPA-R2TD')).toEqual({ text: 'beluga://join?code=K7QM-4XPA-R2TD', group: true });
    expect(findInvitation(' k7qm-4xpa-r2td ')).toEqual({ text: 'k7qm-4xpa-r2td', group: false });
    expect(findInvitation('hello there')).toBeUndefined();
    // A room invite (klaud://join/<invite>) isn't a network invitation.
    expect(findInvitation('klaud://join/https%3A%2F%2Fx#abc')).toBeUndefined();
  });

  it('reads codes the forgiving way', () => {
    expect(readCode('K7QM-4XPA-R2TD')).toBe('K7QM4XPAR2TD');
    expect(readCode('k7qm 4xpa r2td')).toBe('K7QM4XPAR2TD');
    expect(readCode('O1IL-0000-0000')).toBe('011100000000');
    expect(readCode('K7QM-4XPA-R2')).toBeUndefined();
    expect(readCode('UUUU-UUUU-UUUU')).toBeUndefined();
  });

  it('says how long an invitation lasts', () => {
    expect(expiryLabel(0, 1)).toBe('Expired');
    expect(expiryLabel(60_000, 0)).toBe('Expires in 1 minute');
    expect(expiryLabel(59 * 60_000, 0)).toBe('Expires in 59 minutes');
    expect(expiryLabel(24 * 3_600_000, 0)).toBe('Expires in 24 hours');
    expect(expiryLabel(7 * 24 * 3_600_000, 0)).toBe('Expires in 7 days');
    expect(timeLeft(3_600_000, 0)).toBe('1 hour');
    expect(timeLeft(0, 1)).toBe('no longer');
  });

  it('shows the newest unused friend invitation still open', () => {
    const inv = (n: string, expiresAt: number, extra: object = {}) => ({ id: n, kind: 'friend' as const, code: n, link: n, expiresAt, uses: 0, codeExpiresAt: expiresAt, codeLink: n, ...extra });
    expect(openFriendInvitation([inv('a', 10), inv('b', 20), inv('c', 30, { uses: 1 }), inv('d', 40, { kind: 'group' })], 5)?.id).toBe('b');
    expect(openFriendInvitation([inv('a', 10)], 11)).toBeUndefined();
    // One made for someone in your room (BLG-202) isn't yours to hand out.
    expect(openFriendInvitation([inv('a', 10, { for: id('z') }), inv('b', 20)], 5)?.id).toBe('b');
    expect(openFriendInvitation([inv('a', 10, { for: id('z') })], 5)).toBeUndefined();
  });

  it('turns accept errors into plain words', () => {
    expect(acceptError('Something went wrong: Nobody is waiting for that invitation.')).toMatch(/expired or was already used/);
    expect(acceptError("That's your own invitation")).toMatch(/your own invitation/);
    expect(acceptError('Pairing timed out')).toBe('Pairing timed out');
    // A network that couldn't connect isn't an expired invitation: the core's words, code and all.
    const unreachable = "Found whoever made that invitation, but your two networks couldn't connect directly (HOLEPUNCH_ABORTED). The invitation still works: try again.";
    expect(acceptError(`Something went wrong: ${unreachable}`)).toBe(unreachable);
  });
});

describe('lists', () => {
  it('orders friends by name, steadily', () => {
    expect(sortFriends([friend('mia'), friend('Bob'), friend('ann')]).map((f) => f.name)).toEqual(['ann', 'Bob', 'mia']);
  });

  it('says who is in a group', () => {
    expect(membersLine([member('bob'), member('mia'), member('kay', { self: true })])).toBe('bob, mia and you');
    expect(membersLine([member('kay', { self: true })])).toBe('you');
    expect(membersLine([member('ann'), member('bob'), member('cat'), member('dan'), member('kay', { self: true })])).toBe('ann, bob, cat and 2 others');
  });

  it('puts you, then admins, then everyone by name', () => {
    expect(sortMembers([member('zed'), member('amy'), member('bob', { admin: true }), member('kay', { self: true })]).map((m) => m.name)).toEqual(['kay', 'bob', 'amy', 'zed']);
  });

  it('offers only friends who are not in the group yet, and counts unread', () => {
    const group = { members: [member('bob')] };
    expect(addableFriends([friend('bob'), friend('mia')], group).map((f) => f.name)).toEqual(['mia']);
    expect(totalUnread({ friends: [friend('bob', { unread: 2 })], groups: [{ unread: 3, active: true }, { unread: 9, active: false }] as never })).toBe(5);
  });
});

describe('@ and / in a channel', () => {
  const people = [
    { peerId: 'p-mia', name: 'Mia' },
    { peerId: 'p-bob', name: 'Bob Stone' },
  ];

  it('lists your Claude, each member’s Claude, everyone’s, then the people', () => {
    const list = channelSuggestions('hi @', { people });
    expect(list.map((s) => s.label)).toEqual(['Your agent', 'Mia’s agent', 'Bob Stone’s agent', 'Everyone’s agent', 'Mia', 'Bob Stone']);
    expect(list.find((s) => s.label === 'Mia’s agent')?.value).toBe('hi @claude:Mia ');
    expect(list.find((s) => s.label === 'Bob Stone')?.value).toBe('hi @BobStone ');
    expect(channelSuggestions('@cl', { people }).map((s) => s.label)).toEqual(['Your agent', 'Mia’s agent', 'Bob Stone’s agent', 'Everyone’s agent']);
    expect(channelSuggestions('@mi', { people }).map((s) => s.label)).toEqual(['Mia’s agent', 'Mia']);
    // Alone: only your Claude.
    expect(channelSuggestions('@', { people: [] }).map((s) => s.label)).toEqual(['Your agent']);
    expect(channelSuggestions('no mention', { people })).toEqual([]);
  });

  it('lists the channel’s commands for / at the start', () => {
    expect(channelSuggestions('/', { people }).map((s) => s.command ?? s.label)).toEqual(['claude', 'claudes', 'files', '/invite']);
    expect(channelSuggestions('/', { people, admin: true }).map((s) => s.command)).toContain('add-people');
    expect(channelSuggestions('/', { people: [] }).map((s) => s.command ?? s.label)).toEqual(['claude', 'files', '/invite']);
    expect(channelSuggestions('/f', { people }).map((s) => s.label)).toEqual(['/files']);
    expect(channelSuggestions('/files now', { people })).toEqual([]);
  });

  it('turns mentions into whose Claude is asked; plain @name is the person', () => {
    expect(mentionedAsk('@claude what’s up?', 'me', people)).toEqual(['me']);
    expect(mentionedAsk('hey @claude:mia, and @claude:BobStone.', 'me', people)).toEqual(['p-mia', 'p-bob']);
    expect(mentionedAsk('@claudes ship it?', 'me', people)).toBe('all');
    expect(mentionedAsk('@Mia lunch?', 'me', people)).toBeUndefined();
    expect(mentionedAsk('see `@claude` and\n```\n@claudes\n```', 'me', people)).toBeUndefined();
    expect(mentionedAsk('mail@claude.ai', 'me', people)).toBeUndefined();
  });

  it('merges the button with the mentions', () => {
    expect(mergeAsk(['me'], ['p-mia', 'me'])).toEqual(['me', 'p-mia']);
    expect(mergeAsk(undefined, 'all')).toBe('all');
    expect(mergeAsk(['me'], undefined)).toEqual(['me']);
    expect(mergeAsk(undefined, undefined)).toBeUndefined();
  });
});

describe('one people list (BLG-202)', () => {
  const peer = (name: string, extra: { agent?: boolean; guest?: boolean; host?: boolean } = {}) => ({ peerId: id(name[0]!), name, ...extra });
  const offer = (name: string, dir: 'in' | 'out', extra: { at?: number; expiresAt?: number } = {}) => ({ peerId: id(name[0]!), name, dir, at: extra.at ?? 1, expiresAt: extra.expiresAt ?? 1_000 });

  it('a friend in your room keeps one row, with the room bits on it', () => {
    const peers = [peer('kay'), peer('ata', { agent: true }), peer('gus', { guest: true })];
    expect(roomBits(peers, id('a'), id('a'))).toEqual({ here: true, claude: true, following: true, index: 1 });
    expect(roomBits(peers, id('k'), undefined)).toEqual({ here: true, claude: false, following: false, index: 0 });
    // Not in the room, or only a guest there: no room bits.
    expect(roomBits(peers, id('m'), undefined)).toBeUndefined();
    expect(roomBits(peers, id('g'), undefined)).toBeUndefined();
  });

  it('lists people in your room who aren’t friends yet: never you, friends or guests', () => {
    const peers = [peer('kay'), peer('zoe'), peer('ata'), peer('gus', { guest: true }), peer('hal'), peer('bob')];
    const out = notFriendsYet(peers, { selfId: id('k'), friends: [friend('bob')], guests: { [id('h')]: {} } });
    expect(out.map((p) => [p.name, p.index])).toEqual([
      ['ata', 2],
      ['zoe', 1],
    ]);
  });

  it('friend requests: yours waiting, and theirs oldest first', () => {
    const offers = [offer('mia', 'in', { at: 5 }), offer('ata', 'out', { expiresAt: 100 }), offer('bob', 'in', { at: 2 })];
    expect(incomingOffers(offers).map((o) => o.name)).toEqual(['bob', 'mia']);
    expect(incomingOffers(undefined)).toEqual([]);
    expect(offerSent(offers, id('a'), 50)).toBe(true);
    expect(offerSent(offers, id('a'), 200)).toBe(false);
    expect(offerSent(offers, id('m'), 50)).toBe(false);
  });

  it('after joining by an old room link, offers the host as a friend, once', () => {
    const peers = [peer('kay', { host: true }), peer('ata')];
    const base = { peers, selfId: id('a'), friends: [] as FriendView[], dismissed: new Set<string>() };
    expect(hostToBefriend(base)?.name).toBe('kay');
    expect(hostToBefriend({ ...base, friends: [friend('kay')] })).toBeUndefined();
    expect(hostToBefriend({ ...base, dismissed: new Set([id('k')]) })).toBeUndefined();
    expect(hostToBefriend({ ...base, offers: [offer('kay', 'out')] })).toBeUndefined();
    expect(hostToBefriend({ ...base, offers: [offer('kay', 'in')] })).toBeUndefined();
    // You're the host, or you came with a project link: nobody to offer.
    expect(hostToBefriend({ ...base, selfId: id('k') })).toBeUndefined();
    expect(hostToBefriend({ ...base, peers: [peer('kay', { host: true }), peer('ata', { guest: true })] })).toBeUndefined();
  });
});
