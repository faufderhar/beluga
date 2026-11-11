import type { MessageVia } from '../protocol.js';
import { chatOf } from '../core/chat/launch.js';
import { answerFriendOffer, sendFriendOffer } from '../core/friend-offers.js';
import { networkEnabled, networkOf, networkStatus, networkSwitchOf } from '../core/network.js';
import { revealInFinder, systemOpen } from '../core/os-open.js';
import type { ChatFile, MessageView } from '../net/mesh/views.js';
import { saveSettings } from '../core/settings.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';
import { localMentions, portableMentions, sharedTasks } from '../core/team/mentions.js';

/** What each `network.*` method does (see network-api.ts). Results are plain views: no keys, no secrets. */

type NetworkMethod = Extract<Method, `network.${string}`>;
type NetworkHandlers = { readonly [M in NetworkMethod]: (s: Session, ...args: Args<M>) => unknown };

const net = networkOf;

/** Turn the network on or off for this Beluga now, and next time. */
async function setEnabled(s: Session, on: boolean): Promise<ReturnType<typeof networkStatus>> {
  const sw = networkSwitchOf(s);
  if (!sw) throw new Error('Only the Beluga app (its daemon) can be on the network');
  saveSettings({ network: on });
  const effective = networkEnabled({ network: on });
  await sw.set(effective);
  if (effective !== on) throw new Error(on ? 'BELUGA_NETWORK=0 keeps the network off for this Beluga' : 'BELUGA_NETWORK=1 keeps the network on for this Beluga');
  return networkStatus(s);
}

/** Write in a conversation: the files must be here (added first), so friends can get them from you. */
/** The people a conversation is with (`dm:<peer>`, `group:<id>`), not you. */
function peersOf(s: Session, conversation: string): string[] {
  if (conversation.startsWith('dm:')) return [conversation.slice(3)];
  const group = s.store.getState().network.groups.find((g) => `group:${g.id}` === conversation);
  return group ? group.members.filter((m) => !m.self).map((m) => m.peerId) : [];
}

/** Your words as they go out: the tasks you share with them carry their ids (core/team/mentions.ts). */
function outgoing(s: Session, conversation: string, text: string): string {
  // A bare network (no board, no team: tests, the terminal's): the words as written.
  if (!s.store) return text;
  const st = s.store.getState();
  return portableMentions(text, sharedTasks(st.board.issues, st.team, peersOf(s, conversation)));
}

/** Older messages as this Mac reads them: a team task by its own key. */
function incoming(s: Session, list: readonly MessageView[]): MessageView[] {
  if (!s.store) return [...list];
  const issues = s.store.getState().board.issues;
  return list.map((m) => ({ ...m, text: localMentions(m.text, issues) }));
}

export function post(s: Session, conversation: string, body: { text: string; files?: readonly ChatFile[] | undefined; ask?: 'all' | readonly string[] | undefined }, via?: MessageVia) {
  const chat = chatOf(s);
  const files = (body.files ?? []).map((f) => {
    if (!chat.files.store.has(f.sha)) throw new Error(`${f.name} isn’t ready to send: add it again`);
    return chat.files.info(f.sha) ?? f;
  });
  const extras = { ...(files.length ? { files } : {}), ...(body.ask ? { ask: { to: body.ask } } : {}), ...(via ? { via } : {}) };
  return chat.mesh.post(conversation, outgoing(s, conversation, body.text), Object.keys(extras).length ? extras : undefined);
}


export const NETWORK_HANDLERS = {
  'network.status': (s) => networkStatus(s),
  'network.setEnabled': (s, on) => setEnabled(s, on),
  'network.friends.list': (s) => net(s).summary().friends,
  'network.friends.invite': (s) => net(s).createInvite(),
  'network.friends.accept': (s, text) => net(s).accept(text),
  'network.friends.cancelInvite': (s, id) => net(s).cancelInvite(id),
  'network.friends.remove': (s, peerId) => net(s).removeFriend(peerId),
  'network.friends.addFromRoom': (s, peerId) => sendFriendOffer(s, net(s), peerId),
  'network.friends.answerOffer': (s, peerId, accept) => answerFriendOffer(s, accept ? net(s) : undefined, peerId, accept),
  'network.dm.send': (s, peerId, text) => net(s).sendDm(peerId, outgoing(s, `dm:${peerId}`, text)),
  'network.dm.history': (s, peerId, page) => incoming(s, net(s).dmHistory(peerId, { ...(page?.before !== undefined ? { before: page.before } : {}), ...(page?.limit !== undefined ? { limit: page.limit } : {}) })),
  'network.groups.list': (s) => net(s).summary().groups,
  'network.groups.create': (s, name, members) => net(s).createGroup(name, members ?? []),
  'network.groups.send': (s, groupId, text) => net(s).sendGroup(groupId, outgoing(s, `group:${groupId}`, text)),
  'network.groups.history': (s, groupId, page) => incoming(s, net(s).groupHistory(groupId, { ...(page?.before !== undefined ? { before: page.before } : {}), ...(page?.limit !== undefined ? { limit: page.limit } : {}) })),
  'network.groups.addMember': (s, groupId, peerId) => net(s).addMember(groupId, peerId),
  'network.groups.removeMember': (s, groupId, peerId) => net(s).removeMember(groupId, peerId),
  'network.groups.setAdmin': (s, groupId, peerId, admin) => net(s).setAdmin(groupId, peerId, admin),
  'network.groups.leave': (s, groupId) => net(s).leaveGroup(groupId),
  'network.groups.delete': (s, groupId) => net(s).deleteGroup(groupId),
  'network.groups.rename': (s, groupId, name) => net(s).renameGroup(groupId, name),
  'network.groups.invite': (s, groupId, opts) => net(s).groupInvite(groupId, opts?.auto ? { auto: true } : {}),
  'network.groups.join': (s, text) => net(s).accept(text),
  'network.groups.approve': (s, groupId, peerId) => net(s).approve(groupId, peerId),
  'network.groups.decline': (s, groupId, peerId) => net(s).decline(groupId, peerId),
  'network.presence.set': (s, presence) => net(s).setPresence({ state: presence.state, ...(presence.note !== undefined ? { note: presence.note } : {}), ...(presence.emoji !== undefined ? { emoji: presence.emoji } : {}), ...(presence.until !== undefined ? { until: presence.until } : {}) }),
  'network.presence.get': (s) => net(s).getPresence(),
  'network.avatar.set': (s, b64) => net(s).setAvatar(b64 === null ? undefined : Buffer.from(b64, 'base64')),
  'network.avatar.get': (s, sha) => net(s).avatar(sha),
  // Read on a screen of yours (the phone's open conversation): read, and Seen unless you turned that off (BLG-798).
  'network.read': (s, conversation) => {
    net(s).markRead(conversation);
    if (s.store.getState().prefs.readReceipts !== false) net(s).markSeen(conversation);
  },
  'network.messages.delete': (s, conversation, id, opts) => net(s).deleteMessage(conversation, id, opts?.everyone ?? false),
  'network.messages.edit': (s, conversation, id, text) => net(s).editMessage(conversation, id, text),
  'network.messages.react': (s, conversation, id, emoji, on) => net(s).react(conversation, id, emoji, on),
  'network.clear': (s, conversation) => net(s).clearConversation(conversation),
  'network.post': (s, conversation, body) => post(s, conversation, body),
  'network.files.add': (s, paths) => chatOf(s).files.share(paths),
  'network.files.addData': (s, name, b64, part) => (part ? chatOf(s).files.sharePart(name, Buffer.from(b64, 'base64'), part) : chatOf(s).files.shareData(name, Buffer.from(b64, 'base64'))),
  'network.files.download': (s, sha, conversation) => chatOf(s).files.download(sha, conversation),
  'network.files.cancel': (s, sha) => chatOf(s).files.cancel(sha),
  'network.files.open': (s, sha) => systemOpen(chatOf(s).files.pathOf(sha)),
  'network.files.reveal': (s, sha) => revealInFinder(chatOf(s).files.pathOf(sha)),
  'network.files.saveTo': (s, sha, target) => chatOf(s).files.saveTo(sha, target),
  'network.files.preview': (s, sha) => chatOf(s).files.preview(sha),
  'network.channels.main': (s) => chatOf(s).main.ensure(),
} satisfies NetworkHandlers;
