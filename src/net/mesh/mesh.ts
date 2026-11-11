/// <reference path="./modules.d.ts" />
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type DHT from 'hyperdht';
import type { BootstrapNode } from 'hyperdht';
import type { Identity } from '../crypto.js';
import { AvatarBook } from './avatars.js';
import { type Dm, DmBook, type DmChange } from './dms.js';
import { DmReactions } from './dm-reactions.js';
import { type Reaction, type ReactionEvent, reactionChange, reactionsOf } from '../../shared/reactions.js';
import { reactNote, splitReactions } from './groups/reactions.js';
import { type BelugaInfo, type Feature, MESH_FEATURES } from './features.js';
import { checkMessage, parseExtras, wireNote } from './extras.js';
import { readJson, writeJson } from './files.js';
import { FriendBook } from './friends.js';
import { MAX_TEXT, type ReadMessage } from './groups/engine.js';
import { GroupHub } from './groups/hub.js';
import { InvitationBook, type InvitationRecord, newInvitation, parseTicket } from './invitations.js';
import { type MeshKeys, meshKeys } from './keys.js';
import { type MailChannel, Mailbox, type MailboxOptions } from './mailbox.js';
import { CLOSE, type MeshLink } from './link.js';
import { type Contacts, DEFAULT_TIMING, LinkManager, type LinkManagerOptions, type Timing } from './links.js';
import { type ViewContext, dmView, friendView, groupMessageView, groupView, invitationView } from './mesh-views.js';
import { PairingHost, pairWith } from './pairing.js';
import { ONLINE, current, loadPresence, savePresence, shown } from './presence.js';
import { type Entry, NameSchema, type Profile } from './schemas.js';
import { type ChatExtras, type ChatFile, type FriendView, type GroupView, type InvitationView, type MessageView, type NetworkSummary, type Presence, dmConversation, groupConversation } from './views.js';
import { type LinkMessage, PROTO } from './wire.js';
import { isLate } from '../patient-timer.js';
import type { AgentRef } from '../../protocol.js';

/**
 * Your Mac on the Beluga network: no server and no host. It listens at an address derived from
 * your identity, stays linked to your friends and the people in your groups (end-to-end
 * encrypted Noise links over the Hyperswarm DHT, relayed through a member's Mac when a direct
 * route can't be made), keeps your groups' logs in step, holds messages for friends who are
 * offline, and tells people your status.
 *
 * Files under `dir` (normally ~/.beluga): friends.json, invitations.json, outbox.json, dms/,
 * groups/, avatars/, presence.json, reads.json. Keys never leave this process; what screens see is views.ts.
 */

export interface MeshOptions {
  readonly identity: Identity;
  readonly name: string;
  readonly dir: string;
  /** DHT bootstrap nodes (tests: a local testnet). Default: the public Hyperswarm network. */
  readonly bootstrap?: readonly BootstrapNode[];
  readonly host?: string;
  readonly timing?: Partial<Timing>;
  /** Relay tunnels for others and use them when direct links fail (default on). */
  readonly relay?: boolean;
  /** Tests: act as if there were no direct route to these people. */
  readonly blocked?: (peerId: string) => boolean;
  /** This Beluga's version, said in every hello (core/version.ts). */
  readonly app?: string;
  /** Where frames wait for a friend you're never online with at the same time (mailbox.ts); none: only links. */
  readonly mailbox?: MailboxOptions;
}

/** What using an invitation got you. */
export type Accepted = { readonly kind: 'friend'; readonly peerId: string; readonly name: string } | { readonly kind: 'group'; readonly groupId: string; readonly name: string; readonly status: 'joined' | 'waiting' };

interface MeshEvents {
  /** Anything in the summary changed (people, presence, groups, invitations). */
  change: [];
  /** A message arrived, was sent, or changed status. */
  message: [MessageView];
  /** A message was deleted from a conversation (here, or by its author for both of you). */
  unsent: [string, string];
  /** A message's reactions changed (conversation, message id, its chips now: BLG-702). */
  reacted: [string, string, readonly Reaction[]];
  /** A conversation was cleared on this Mac. */
  cleared: [string];
  /** A gateway frame from a friend (core/gateway checks and answers it). */
  gateway: [string, unknown];
  /** A sharing frame from a friend (core/friend-share checks it): shared projects, their worktrees' conversations, shared folders. */
  share: [string, unknown];
  /** A team boards frame from a friend (core/team checks it): which repos you share, the board, shared plans. */
  team: [string, unknown];
  /** A call frame from someone you're linked to (core/calls checks it, and that you share its conversation). */
  call: [string, unknown];
  /** A leaderboard frame from a friend (core/leaderboard checks it): their day sums. */
  stats: [string, unknown];
  /** A link to someone came up (what waited for them can go now). */
  link: [string];
  /** Someone's Claude started or stopped answering message `for` in a conversation. */
  live: [{ readonly conversation: string; readonly from: string; readonly for: string; readonly state: 'thinking' | 'idle'; readonly agent?: AgentRef }];
  /** A chat file frame (f_get / f_data / f_err) from someone you're linked to (core/chat-files checks it). */
  file: [string, FileFrame];
}

/** The frames chat files travel in. */
export type FileFrame = Extract<LinkMessage, { t: 'f_get' | 'f_data' | 'f_err' }>;

const MAX_FRAME = 2 * 1024 * 1024;
/** How long leaving waits for the mailbox before it goes anyway. */
const LEAVING_MS = 4_000;
const HISTORY_PAGE = 50;

export class Mesh extends EventEmitter<MeshEvents> {
  private readonly friends: FriendBook;
  private readonly invitations: InvitationBook;
  private readonly dms: DmBook;
  private readonly dmReacts: DmReactions;
  private readonly groups: GroupHub;
  private readonly links: LinkManager;
  private readonly pairing: PairingHost;
  private readonly timing: Timing;
  private presence: Presence;
  /** When this Mac's status last changed (only ever forward): sent with it, so friends keep the newest. */
  private presenceAt = Date.now();
  private readonly theirPresence = new Map<string, Presence>();
  /** When each friend's status we have was set, by their clock (none: a Mac that doesn't say). */
  private readonly theirPresenceAt = new Map<string, number>();
  private readonly helloNames = new Map<string, string>();
  private readonly avatars: AvatarBook;
  /** The picture asked of each person on this link (asked again on their next link if it didn't come). */
  private readonly avatarAsked = new Map<string, string>();
  /** What each person's Beluga said about itself on its last link (kept while they're away). */
  private readonly theirBeluga = new Map<string, BelugaInfo>();
  /** People whose Mac speaks another network version, and who needs to update. */
  private readonly mismatched = new Map<string, 'them' | 'you'>();
  /** What else this Mac does now (the gateway adds its tasks while it listens). */
  private readonly offered = new Set<Feature>();
  private reads: Record<string, number>;
  /** The newest message of each friend's that this Mac said Seen for (BLG-798): said once per message. */
  private readonly seenSaid = new Map<string, string>();
  private allowed = new Map<string, Profile>();
  private wanted = new Map<string, Profile>();
  private byAddress = new Map<string, string>();
  private ticker: NodeJS.Timeout | undefined;
  private lastTick = Date.now();
  private readonly mailbox: Mailbox | undefined;
  private mailCheckedAt = 0;
  /** What to mail before this Mac leaves the network (each outbox: everything still waiting). */
  private readonly leavingHooks = new Set<() => Promise<unknown>>();
  private untilTimer: NodeJS.Timeout | undefined;
  private closed = false;
  /** Who you're pulling chat files from now (set by core/chat/files.ts). */
  private filesFrom: (peerId: string) => boolean = () => false;

  private constructor(
    private readonly opts: MeshOptions,
    private readonly keys: MeshKeys,
    private readonly node: DHT,
    NoiseStream: LinkManagerOptions['NoiseStream'],
  ) {
    super();
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.friends = new FriendBook(path.join(opts.dir, 'friends.json'));
    this.invitations = new InvitationBook(path.join(opts.dir, 'invitations.json'));
    this.dms = new DmBook(opts.dir);
    this.dmReacts = new DmReactions(opts.dir);
    this.avatars = new AvatarBook(path.join(opts.dir, 'avatars'));
    this.presence = loadPresence(this.file('presence.json'));
    const reads = readJson(this.file('reads.json'));
    this.reads = reads && typeof reads === 'object' ? Object.fromEntries(Object.entries(reads).filter(([, v]) => typeof v === 'number' && Number.isInteger(v) && v >= 0)) : {};
    this.groups = new GroupHub({
      keys,
      dir: path.join(opts.dir, 'groups'),
      myName: () => this.opts.name,
      linkOf: (peerId) => this.links.get(peerId),
      linked: () => this.links.linked(),
      onChange: () => this.contactsChanged(),
      trusted: (peerId) => this.friends.has(peerId),
      onMessages: (groupId, entries) => this.groupEntries(groupId, entries),
    });
    const contacts: Contacts = {
      byAddress: (address) => this.byAddress.get(address),
      addressOf: (peerId) => this.allowed.get(peerId)?.card.address,
      wanted: () => [...this.wanted.keys()],
      allows: (peerId) => this.allowed.has(peerId),
    };
    this.links = new LinkManager({
      node,
      NoiseStream,
      keyPair: keys.keyPair,
      contacts,
      timing: this.timing,
      maxBytes: MAX_FRAME,
      relay: opts.relay ?? true,
      ...(opts.blocked ? { blocked: opts.blocked } : {}),
      relaysFor: (peerId) => this.relaysFor(peerId),
      onLink: (link) => this.linkUp(link),
      onUnlink: (peerId) => {
        this.theirPresence.delete(peerId);
        this.theirPresenceAt.delete(peerId);
        this.avatarAsked.delete(peerId);
        this.emit('change');
      },
      onMessage: (link, msg) => this.onMessage(link, msg),
      wantsFiles: (peerId) => this.filesFrom(peerId),
    });
    this.pairing = new PairingHost({
      node,
      book: this.invitations,
      me: () => this.profile,
      timeoutMs: this.timing.pairTimeoutMs,
      decide: (record, profile) => {
        if (profile.card.peerId === this.peerId) return { ok: false, reason: "That's your own invitation" };
        if (record.kind === 'group') return this.groups.decideJoin(record, profile);
        if (record.for && record.for !== profile.card.peerId) return { ok: false, reason: 'That invitation was for someone else' };
        this.friends.add(profile.card, profile.name);
        this.contactsChanged();
        return { ok: true, kind: 'friend' };
      },
      onChange: () => this.emit('change'),
    });
    this.mailbox = opts.mailbox?.url
      ? new Mailbox(keys, opts.mailbox, {
          cardOf: (peerId) => this.friends.get(peerId)?.card,
          deliver: (from, t, p) => {
            if (!this.friends.has(from)) return;
            if (t === 'gw') this.emit('gateway', from, p);
            else this.emit(t, from, p);
          },
        })
      : undefined;
    this.rebuildContacts();
  }

  /** Join the network: listen at your address, reopen your invitations, link up with everyone. */
  static async start(opts: MeshOptions): Promise<Mesh> {
    NameSchema.parse(opts.name);
    const keys = await meshKeys(opts.identity);
    // Native networking code loads only when the network is turned on (as in p2p.ts).
    const [DHTClass, NoiseStream] = await Promise.all([import('hyperdht').then((m) => m.default), import('@hyperswarm/secret-stream').then((m) => m.default)]);
    const node = new DHTClass({ keyPair: keys.keyPair, ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}), ...(opts.host ? { host: opts.host } : {}) });
    const mesh = new Mesh(opts, keys, node, NoiseStream);
    try {
      await mesh.links.listen();
      await Promise.all(mesh.invitations.all().map((r) => mesh.pairing.listen(r)));
    } catch (err) {
      await mesh.close();
      throw err;
    }
    mesh.ticker = setInterval(() => mesh.tick(), mesh.timing.syncMs);
    mesh.ticker.unref();
    mesh.scheduleUntil();
    mesh.links.refresh();
    // What friends left while this Mac was off.
    if (mesh.mailbox) setTimeout(() => void mesh.checkMail(), 1_000).unref();
    return mesh;
  }

  get peerId(): string {
    return this.keys.identity.peerId;
  }

  /** Your network address (hex public key): where friends' Macs find yours. */
  get address(): string {
    return this.keys.card.address;
  }

  get profile(): Profile {
    return { card: this.keys.card, name: this.opts.name };
  }

  /** Everything screens show, without messages and without secrets. */
  summary(): NetworkSummary {
    return {
      enabled: true,
      self: { peerId: this.peerId, name: this.opts.name, presence: current(this.presence), appearOffline: current(this.presence).state === 'offline', ...(this.avatars.mine ? { avatar: this.avatars.mine } : {}) },
      friends: this.friendViews(),
      groups: this.groupViews(),
      invitations: this.invitations.all().map(invitationView),
      pendingJoins: this.groups.joins.allAsked().map((a) => ({ groupId: a.groupId, name: a.name, since: a.since })),
    };
  }

  // ---- friends

  /**
   * A one-time invitation to be friends: a link (a day, or `ttlMs`) and a code (an hour, or less).
   * `for`: only that person may use it; anyone else who got hold of it is refused.
   */
  async createInvite(opts: { ttlMs?: number; codeTtlMs?: number; for?: string } = {}): Promise<InvitationView> {
    const record = newInvitation('friend', { ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}), ...(opts.codeTtlMs ? { codeTtlMs: opts.codeTtlMs } : {}), ...(opts.for ? { for: opts.for } : {}) });
    await this.openInvitation(record);
    this.emit('change');
    return invitationView(record);
  }

  async cancelInvite(id: string): Promise<void> {
    await this.pairing.stop(id);
  }

  /**
   * Use a friend or group invitation (a beluga:// or klaud:// link, or a code). `from`: whose it must
   * be (a friend request sent in a room); anyone else on the other end isn't added.
   */
  async accept(text: string, opts: { from?: string } = {}): Promise<Accepted> {
    const ticket = parseTicket(text);
    if (!ticket) throw new Error('That isn’t a Beluga invitation: paste the beluga:// link or type the code (like K7QM-4XPA-R2TD)');
    const result = await pairWith(this.node, this.keys.keyPair, this.profile, ticket, this.timing.pairTimeoutMs);
    if (result.profile.card.peerId === this.peerId) throw new Error("That's your own invitation");
    if (opts.from && (result.kind !== 'friend' || result.profile.card.peerId !== opts.from)) throw new Error('That invitation came from someone else');
    if (result.kind === 'friend') {
      this.friends.add(result.profile.card, result.profile.name);
      this.contactsChanged();
      return { kind: 'friend', peerId: result.profile.card.peerId, name: result.profile.name };
    }
    if (!result.group) throw new Error('The invitation did not say which group');
    this.groups.asked(result);
    this.contactsChanged();
    return { kind: 'group', groupId: result.group.id, name: result.group.name, status: result.group.status };
  }

  removeFriend(peerId: string): void {
    if (!this.friends.remove(peerId)) throw new Error('Not a friend');
    this.dms.forget(peerId);
    this.dmReacts.forget(peerId);
    this.contactsChanged();
  }

  // ---- direct messages

  sendDm(peerId: string, text: string, extras?: ChatExtras): MessageView {
    if (!this.friends.has(peerId)) throw new Error('You can only message friends');
    checkMessage(text, extras, MAX_TEXT);
    const dm = this.dms.compose(this.peerId, peerId, text, extras);
    this.links.get(peerId)?.send(dmFrame(dm));
    const view = this.dmViewOf(peerId, dm);
    this.emit('message', view);
    this.emit('change');
    return view;
  }

  /** Delete a message (`dm:` only): here, or (`everyone`, your own) on their Mac too. */
  deleteMessage(conversation: string, id: string, everyone = false): void {
    const peerId = this.dmPeer(conversation);
    const mine = this.dms.find(peerId, id)?.from === this.peerId;
    const before = this.dmMessages(peerId);
    const change = this.dms.delete(peerId, id, everyone);
    if (change) this.links.get(peerId)?.send(changeFrame(change));
    if (!mine) this.unread(conversation, before, id);
    this.emit('unsent', conversation, id);
    this.emit('change');
  }

  /** Change the text of a message you sent (`dm:` only), here and on their Mac. */
  editMessage(conversation: string, id: string, text: string): MessageView {
    const peerId = this.dmPeer(conversation);
    const was = this.dms.find(peerId, id);
    checkMessage(text, was?.x, MAX_TEXT);
    const { dm, change } = this.dms.edit(peerId, id, text);
    this.links.get(peerId)?.send(changeFrame(change));
    const view = this.dmViewOf(peerId, dm);
    this.emit('message', view);
    this.emit('change');
    return view;
  }

  /**
   * Put an emoji on a message or take yours off (BLG-702): `on` says which, none flips it. In a
   * direct conversation it goes to your friend's Mac (and waits for it); in a group, into the log.
   * → the message's chips now.
   */
  react(conversation: string, id: string, emoji: string, on?: boolean): readonly Reaction[] {
    const target = this.conversation(conversation).find((m) => m.id === id);
    if (!target) throw new Error('No such message');
    if (target.status === 'locked') throw new Error('That message can’t be read here');
    if (conversation.startsWith('group:')) return this.reactInGroup(conversation.slice(6), target, emoji, on);
    const peerId = conversation.slice(3);
    const change = reactionChange(target.reactions, { id, emoji, me: this.peerId, ...(on !== undefined ? { on } : {}), at: this.dmReacts.nextAt(peerId, id, emoji, this.peerId) });
    const chips = this.dmReacts.mine(peerId, change);
    this.links.get(peerId)?.send({ t: 'dm_react', id, e: change.emoji, on: change.on, at: change.at });
    this.emit('reacted', conversation, id, chips);
    return chips;
  }

  private reactInGroup(groupId: string, target: MessageView, emoji: string, on?: boolean): readonly Reaction[] {
    const change = reactionChange(target.reactions, { id: target.id, emoji, me: this.peerId, ...(on !== undefined ? { on } : {}), at: 0 });
    const engine = this.groups.need(groupId);
    const words = target.text.trim() || (target.files?.length ? target.files.map((f) => f.name).join(', ') : '');
    this.groups.apply(groupId, (e) => e.react({ to: target.id, e: change.emoji, on: change.on }, reactNote(change.emoji, change.on, words)));
    return reactionsOf(splitReactions(engine.messages()).reactions.get(target.id) ?? []);
  }

  /** Empty a conversation on this Mac (`dm:` only; your friend keeps theirs). */
  clearConversation(conversation: string): void {
    const peerId = this.dmPeer(conversation);
    this.dms.clear(peerId);
    if (this.reads[conversation]) {
      this.reads = { ...this.reads, [conversation]: 0 };
      writeJson(this.file('reads.json'), this.reads);
    }
    this.emit('cleared', conversation);
    this.emit('change');
  }

  dmHistory(peerId: string, opts: { before?: number; limit?: number } = {}): MessageView[] {
    return page(this.dmMessages(peerId), opts);
  }

  // ---- groups

  createGroup(name: string, friendIds: readonly string[] = []): GroupView {
    const profiles = friendIds.map((id) => this.friendProfile(id));
    const engine = this.groups.create(NameSchema.parse(name), profiles);
    return this.groupViewOf(engine.id)!;
  }

  sendGroup(groupId: string, text: string, extras?: ChatExtras): MessageView {
    const entries = this.groups.apply(groupId, (e) => e.send(text, extras));
    return groupMessageView(this.ctx, groupId, { entry: entries.at(-1)!, text, ...(extras ? { extras } : {}) });
  }

  /** Write in a conversation (`dm:<peerId>` or `group:<id>`). */
  post(conversation: string, text: string, extras?: ChatExtras): MessageView {
    if (conversation.startsWith('dm:')) return this.sendDm(conversation.slice(3), text, extras);
    if (conversation.startsWith('group:')) return this.sendGroup(conversation.slice(6), text, extras);
    throw new Error('No such conversation');
  }

  /** A conversation's messages, oldest first (all of them: what Claudes read, what files were shared in). */
  conversation(conversation: string): MessageView[] {
    if (conversation.startsWith('dm:')) return this.friends.has(conversation.slice(3)) ? this.dmMessages(conversation.slice(3)) : [];
    if (conversation.startsWith('group:')) return this.groupMessages(conversation.slice(6));
    return [];
  }

  /** Conversations you can write in now: friends' and the groups you're in. */
  conversations(): string[] {
    return [...this.friends.all().map((f) => dmConversation(f.peerId)), ...this.groups.list().filter((g) => g.isMember()).map((g) => groupConversation(g.id))];
  }

  /** Is `peerId` in this conversation with you now (your friend for a DM; both of you members of a group)? */
  shares(conversation: string, peerId: string): boolean {
    if (peerId === this.peerId) return false;
    if (conversation.startsWith('dm:')) return conversation.slice(3) === peerId && this.friends.has(peerId);
    const engine = conversation.startsWith('group:') ? this.groups.get(conversation.slice(6)) : undefined;
    return Boolean(engine?.isMember() && engine.isMember(peerId));
  }

  /** The others in a conversation with you now. */
  peopleIn(conversation: string): string[] {
    if (conversation.startsWith('dm:')) return this.shares(conversation, conversation.slice(3)) ? [conversation.slice(3)] : [];
    const engine = conversation.startsWith('group:') ? this.groups.get(conversation.slice(6)) : undefined;
    if (!engine?.isMember()) return [];
    return [...(engine.model?.members.keys() ?? [])].filter((p) => p !== this.peerId);
  }

  /** Every file shared in your conversations, with where and by whom (oldest first). */
  sharedFiles(): Array<{ readonly conversation: string; readonly from: string; readonly file: ChatFile }> {
    return this.conversations().flatMap((c) => this.conversation(c).flatMap((m) => (m.files ?? []).map((file) => ({ conversation: c, from: m.from, file }))));
  }

  /** Tell the others in a conversation that your Claude is answering message `id` (or stopped). */
  sendLive(conversation: string, id: string, state: 'thinking' | 'idle', agent?: AgentRef): void {
    const g = conversation.startsWith('group:') ? conversation.slice(6) : undefined;
    for (const peerId of this.peopleIn(conversation)) this.links.get(peerId)?.send({ t: 'live', ...(g ? { g } : {}), for: id, state, ...(agent ? { agent } : {}) });
  }

  /** Say who you're pulling chat files from (their pieces get the file allowance on the link). */
  pullingFrom(fn: (peerId: string) => boolean): void {
    this.filesFrom = fn;
  }

  /** Send a chat file frame to someone linked now; false when they're not. */
  sendFile(peerId: string, frame: FileFrame): boolean {
    const link = this.links.get(peerId);
    if (!link?.isOpen) return false;
    link.send(frame);
    return true;
  }

  groupHistory(groupId: string, opts: { before?: number; limit?: number } = {}): MessageView[] {
    return page(this.groupMessages(groupId), opts);
  }

  addMember(groupId: string, friendId: string): void {
    const profile = this.friendProfile(friendId);
    this.groups.apply(groupId, (e) => e.addMember(profile));
  }

  removeMember(groupId: string, peerId: string): void {
    this.groups.apply(groupId, (e) => e.removeMember(peerId));
  }

  setAdmin(groupId: string, peerId: string, admin: boolean): void {
    this.groups.apply(groupId, (e) => e.setAdmin(peerId, admin));
  }

  leaveGroup(groupId: string): void {
    this.groups.leave(groupId);
  }

  /** Delete a group you left (or were removed from) from this Mac; the others keep theirs. */
  deleteGroup(groupId: string): void {
    this.groups.forget(groupId);
    const conversation = groupConversation(groupId);
    if (conversation in this.reads) {
      const { [conversation]: _gone, ...rest } = this.reads;
      this.reads = rest;
      writeJson(this.file('reads.json'), this.reads);
    }
    this.contactsChanged();
  }

  renameGroup(groupId: string, name: string): void {
    const valid = NameSchema.parse(name);
    this.groups.apply(groupId, (e) => e.rename(valid));
  }

  /** A link (and code) to join a group; `auto`: people get in without an admin approving. */
  async groupInvite(groupId: string, opts: { auto?: boolean } = {}): Promise<InvitationView> {
    if (!this.groups.need(groupId).isAdmin()) throw new Error('Only admins can invite people');
    const record = newInvitation('group', { groupId, ...(opts.auto ? { auto: true } : {}) });
    await this.openInvitation(record);
    this.emit('change');
    return invitationView(record);
  }

  approve(groupId: string, peerId: string): void {
    if (!this.groups.need(groupId).isAdmin()) throw new Error('Only admins can let people in');
    this.groups.approve(groupId, peerId);
  }

  decline(groupId: string, peerId: string): void {
    this.groups.decline(groupId, peerId);
  }

  // ---- the gateway (tasks between Claudes ride on friends' links)

  isFriend(peerId: string): boolean {
    return this.friends.has(peerId);
  }

  isLinked(peerId: string): boolean {
    return Boolean(this.links.get(peerId)?.isOpen);
  }

  nameFor(peerId: string): string {
    return this.nameOf(peerId);
  }

  /** Hand a gateway frame to a friend's link; false when they're not linked now. */
  sendGateway(peerId: string, payload: unknown): boolean {
    const link = this.links.get(peerId);
    if (!link?.isOpen || !this.friends.has(peerId)) return false;
    link.send({ t: 'gw', p: payload });
    return true;
  }

  /** Hand a sharing frame to a friend's link; false when they're not linked now. */
  sendShare(peerId: string, payload: unknown): boolean {
    const link = this.links.get(peerId);
    if (!link?.isOpen || !this.friends.has(peerId)) return false;
    link.send({ t: 'share', p: payload });
    return true;
  }

  /** A frame nobody took goes to the friend's mailbox after this long (undefined: there's no mailbox). */
  get mailAfterMs(): number | undefined {
    return this.mailbox?.afterMs;
  }

  /** Leave a frame in a friend's mailbox (mailbox.ts); false when there's none or it didn't take it. */
  mail(peerId: string, t: MailChannel, payload: unknown): Promise<boolean> {
    if (!this.mailbox || !this.friends.has(peerId) || this.closed) return Promise.resolve(false);
    return this.mailbox.post(peerId, t, payload);
  }

  /** Run `fn` (an outbox mailing what still waits) before this Mac leaves the network; returns how to stop. */
  onLeaving(fn: () => Promise<unknown>): () => void {
    this.leavingHooks.add(fn);
    return () => void this.leavingHooks.delete(fn);
  }

  /**
   * About to go (quitting, the network turned off): whatever no friend has acknowledged yet goes
   * to their mailboxes now, rather than waiting here until both of you happen to be online.
   * Their acknowledgements are in your mailbox when you're back, and clear your outbox then.
   */
  async leaving(timeoutMs = LEAVING_MS): Promise<void> {
    if (!this.mailbox || this.closed || !this.leavingHooks.size) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.leavingHooks].map((fn) => fn())), new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
  }

  /** Take what friends left in your mailbox now; how many frames it handed on. */
  checkMail(): Promise<number> {
    if (!this.mailbox || this.closed) return Promise.resolve(0);
    this.mailCheckedAt = Date.now();
    return this.mailbox.check();
  }

  /** Hand a team boards frame to a friend's link; false when they're not linked now. */
  sendTeam(peerId: string, payload: unknown): boolean {
    const link = this.links.get(peerId);
    if (!link?.isOpen || !this.friends.has(peerId)) return false;
    link.send({ t: 'team', p: payload });
    return true;
  }

  /** Hand a leaderboard frame to a friend's link; false when they're not linked now. */
  sendStats(peerId: string, payload: unknown): boolean {
    const link = this.links.get(peerId);
    if (!link?.isOpen || !this.friends.has(peerId)) return false;
    link.send({ t: 'stats', p: payload });
    return true;
  }

  /** Friends linked right now. */
  linkedFriends(): string[] {
    return this.friends
      .all()
      .map((f) => f.peerId)
      .filter((id) => this.isLinked(id));
  }

  /** Hand a call frame to someone linked now (a friend, or someone in a group with you); false when they're not. */
  sendCall(peerId: string, payload: unknown): boolean {
    const link = this.links.get(peerId);
    if (!link?.isOpen) return false;
    link.send({ t: 'call', p: payload });
    return true;
  }

  // ---- status and reading

  setPresence(next: Presence): Presence {
    this.presence = savePresence(this.file('presence.json'), next);
    this.presenceChanged();
    this.broadcastPresence();
    this.scheduleUntil();
    this.emit('change');
    return this.presence;
  }

  getPresence(): Presence {
    return current(this.presence);
  }

  /** Mark a conversation read (`dm:<peerId>` or `group:<id>`). */
  markRead(conversation: string): void {
    const messages = conversation.startsWith('dm:') ? this.dmMessages(conversation.slice(3)) : conversation.startsWith('group:') ? this.groupMessages(conversation.slice(6)) : [];
    const count = messages.filter((m) => !m.mine).length;
    if (this.reads[conversation] === count) return;
    this.reads = { ...this.reads, [conversation]: count };
    writeJson(this.file('reads.json'), this.reads);
    this.emit('change');
  }

  /**
   * A direct conversation was on a screen of yours (BLG-798): tell that friend you saw their messages
   * up to the newest, once per newest, only while you're linked (an older Beluga ignores it).
   */
  markSeen(conversation: string): void {
    if (!conversation.startsWith('dm:')) return;
    const peerId = conversation.slice(3);
    const newest = [...this.dms.history(peerId)].reverse().find((m) => m.from === peerId);
    const link = this.links.get(peerId);
    if (!newest || !link || this.seenSaid.get(peerId) === newest.id) return;
    this.seenSaid.set(peerId, newest.id);
    link.send({ t: 'dm_seen', id: newest.id });
  }

  /** The latest messages of every conversation (for a screen's first draw). */
  recent(limit = HISTORY_PAGE): Record<string, MessageView[]> {
    const out: Record<string, MessageView[]> = {};
    for (const f of this.friends.all()) out[dmConversation(f.peerId)] = this.dmMessages(f.peerId).slice(-limit);
    for (const g of this.groups.list()) out[groupConversation(g.id)] = this.groupMessages(g.id).slice(-limit);
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.leaving();
    this.closed = true;
    clearInterval(this.ticker);
    clearTimeout(this.untilTimer);
    await this.pairing.close();
    await this.links.close();
    // Give close frames a moment to leave, then drop the node.
    await new Promise((r) => setTimeout(r, 30));
    await this.node.destroy({ force: true }).catch(() => undefined);
  }

  // ---- inside

  private async openInvitation(record: InvitationRecord): Promise<void> {
    this.invitations.add(record);
    try {
      await this.pairing.listen(record);
    } catch (err) {
      this.invitations.remove(record.id);
      throw err;
    }
  }

  private get ctx(): ViewContext {
    return {
      me: this.peerId,
      link: (peerId) => this.links.get(peerId),
      presenceOf: (peerId) => this.theirPresence.get(peerId),
      belugaOf: (peerId) => this.theirBeluga.get(peerId),
      updateOf: (peerId) => this.mismatched.get(peerId),
      nameOf: (peerId) => this.nameOf(peerId),
      avatarOf: (peerId) => this.avatarOf(peerId),
      readCount: (conversation) => this.reads[conversation] ?? 0,
    };
  }

  private file(name: string): string {
    return path.join(this.opts.dir, name);
  }

  private nameOf(peerId: string): string {
    return this.friends.get(peerId)?.name ?? this.allowed.get(peerId)?.name ?? this.helloNames.get(peerId) ?? 'someone';
  }

  /** Someone's picture (yours too), once its bytes are here. */
  private avatarOf(peerId: string): string | undefined {
    const sha = peerId === this.peerId ? this.avatars.mine : this.avatars.theirs(peerId);
    return sha && this.avatars.has(sha) ? sha : undefined;
  }

  /** Set your profile picture (undefined takes it away): everyone linked hears at once, and fetches it once. → its checksum. */
  setAvatar(bytes: Uint8Array | undefined): string | undefined {
    const sha = this.avatars.setMine(bytes);
    if (!this.closed) for (const link of this.links.linked()) this.sendHello(link);
    this.emit('change');
    return sha;
  }

  /** A profile picture's bytes to show (yours, or one someone sent): → { mime, b64 }. */
  avatar(sha: string): { mime: string; b64: string } | undefined {
    const pic = this.avatars.read(sha);
    return pic ? { mime: pic.mime, b64: pic.bytes.toString('base64') } : undefined;
  }

  private friendProfile(peerId: string): Profile {
    const f = this.friends.get(peerId);
    if (!f) throw new Error('Add them as a friend first (or send them the group’s invite link)');
    return { card: f.card, name: f.name };
  }

  private dmPeer(conversation: string): string {
    if (conversation.startsWith('group:')) throw new Error('Messages in channels can’t be deleted or edited yet');
    const peerId = conversation.startsWith('dm:') ? conversation.slice(3) : '';
    if (!this.friends.has(peerId)) throw new Error('No such conversation');
    return peerId;
  }

  /** A message from them went: it no longer counts as read (`before`: the conversation as it was). */
  private unread(conversation: string, before: readonly MessageView[], id: string): void {
    const theirs = before.filter((m) => !m.mine);
    const at = theirs.findIndex((m) => m.id === id);
    const read = this.reads[conversation] ?? 0;
    if (at < 0 || at >= read) return;
    this.reads = { ...this.reads, [conversation]: read - 1 };
    writeJson(this.file('reads.json'), this.reads);
  }

  private dmMessages(peerId: string): MessageView[] {
    const status = this.dms.status(peerId);
    return this.dms.history(peerId).map((dm) => dmView(this.ctx, peerId, dm, status, this.dmReacts.of(peerId, dm.id)));
  }

  private dmViewOf(peerId: string, dm: Dm): MessageView {
    return dmView(this.ctx, peerId, dm, this.dms.status(peerId), this.dmReacts.of(peerId, dm.id));
  }

  private groupMessages(groupId: string): MessageView[] {
    const engine = this.groups.get(groupId);
    if (!engine) return [];
    const { messages, reactions } = splitReactions(engine.messages());
    return messages.map((m) => groupMessageView(this.ctx, groupId, m, reactionsOf(reactions.get(m.entry.id) ?? [])));
  }

  /** Group entries that came in (or that you wrote): messages as messages, reactions as their message's new chips. */
  private groupEntries(groupId: string, entries: readonly Entry[]): void {
    const engine = this.groups.get(groupId);
    const read: ReadMessage[] = engine ? entries.map((e) => engine.readMessage(e)) : entries.map((entry) => ({ entry }));
    const split = engine && read.some((m) => m.text !== undefined) ? splitReactions(engine.messages()).reactions : new Map<string, readonly ReactionEvent[]>();
    const chips = (id: string): Reaction[] => reactionsOf(split.get(id) ?? []);
    for (const m of read) {
      if (m.react) this.emit('reacted', groupConversation(groupId), m.react.to, chips(m.react.to));
      else this.emit('message', groupMessageView(this.ctx, groupId, m, chips(m.entry.id)));
    }
    this.emit('change');
  }

  private friendViews(): FriendView[] {
    return this.friends.all().map((f) => friendView(this.ctx, f, this.dmMessages(f.peerId)));
  }

  private groupViewOf(groupId: string): GroupView | undefined {
    const engine = this.groups.get(groupId);
    return engine ? groupView(this.ctx, engine, this.groupMessages(groupId), this.groups.joins.requestsFor(groupId)) : undefined;
  }

  private groupViews(): GroupView[] {
    return this.groups.list().flatMap((g) => this.groupViewOf(g.id) ?? []);
  }

  private rebuildContacts(): void {
    const fromGroups = this.groups.people();
    const wanted = new Map<string, Profile>();
    const allowed = new Map<string, Profile>();
    const byAddress = new Map<string, string>();
    // One address, one person: friends first, so a card naming someone else's address can't take it over.
    const admit = (profile: Profile, want: boolean): void => {
      const { peerId, address } = profile.card;
      if (peerId === this.peerId || address === this.address || allowed.has(peerId)) return;
      if (byAddress.has(address)) return;
      byAddress.set(address, peerId);
      allowed.set(peerId, profile);
      if (want) wanted.set(peerId, profile);
    };
    for (const f of this.friends.all()) admit({ card: f.card, name: f.name }, true);
    for (const p of fromGroups.wanted.values()) admit(p, true);
    for (const p of fromGroups.allowed.values()) admit(p, false);
    this.wanted = wanted;
    this.allowed = allowed;
    this.byAddress = byAddress;
  }

  private contactsChanged(): void {
    this.rebuildContacts();
    if (!this.closed) this.links.refresh();
    this.emit('change');
  }

  /** Tunnel candidates for someone: people who share a group with them first. */
  private relaysFor(peerId: string): string[] {
    return this.groups
      .list()
      .filter((g) => g.isMember(peerId))
      .flatMap((g) => [...(g.model?.members.keys() ?? [])])
      .filter((p) => p !== peerId && p !== this.peerId);
  }

  /** Say (again) that this Mac does these too, or no longer does: every linked friend hears it at once. */
  offer(features: readonly Feature[], on: boolean): void {
    for (const f of features) on ? this.offered.add(f) : this.offered.delete(f);
    if (this.closed) return;
    for (const link of this.links.linked()) this.sendHello(link);
  }

  /** What a person's Beluga said about itself (undefined for Macs from before that, or never linked). */
  belugaOf(peerId: string): BelugaInfo | undefined {
    return this.theirBeluga.get(peerId);
  }

  private sendHello(link: MeshLink): void {
    link.send({ t: 'hello', proto: PROTO, name: this.opts.name, presence: shown(this.presence), pat: this.presenceAt, app: this.opts.app ?? 'unknown', can: [...new Set([...MESH_FEATURES, ...this.offered])], ...(this.avatars.mine ? { avatar: this.avatars.mine } : {}) });
  }

  private linkUp(link: MeshLink): void {
    this.sendHello(link);
    this.groups.linkUp(link);
    for (const dm of this.dms.waiting(link.peerId)) link.send(dmFrame(dm));
    for (const change of this.dms.pendingChanges(link.peerId)) link.send(changeFrame(change));
    for (const r of this.dmReacts.waiting(link.peerId)) link.send({ t: 'dm_react', id: r.id, e: r.e, on: r.on, at: r.at });
    this.emit('link', link.peerId);
    this.emit('change');
  }

  private onMessage(link: MeshLink, msg: LinkMessage): void {
    if (this.groups.handle(link, msg)) return;
    const from = link.peerId;
    switch (msg.t) {
      case 'hello':
        if (Math.floor(msg.proto) !== PROTO) {
          // Said on their card rather than looking offline (they redial, and are told the same).
          this.mismatched.set(from, Math.floor(msg.proto) > PROTO ? 'you' : 'them');
          if (msg.app) this.theirBeluga.set(from, { version: msg.app, can: msg.can ?? [] });
          this.emit('change');
          link.close(CLOSE.version, 'different protocol version');
          return;
        }
        this.mismatched.delete(from);
        if (msg.app) this.theirBeluga.set(from, { version: msg.app, can: msg.can ?? [] });
        else this.theirBeluga.delete(from);
        // The name they go by now (shown for people in your groups; friends keep the name you know them by).
        this.helloNames.set(from, msg.name);
        this.takePresence(from, msg.presence, msg.pat);
        this.avatars.announce(from, msg.avatar);
        if (msg.avatar && !this.avatars.has(msg.avatar) && this.avatarAsked.get(from) !== msg.avatar) {
          this.avatarAsked.set(from, msg.avatar);
          link.send({ t: 'av_get', sha: msg.avatar });
        }
        this.emit('change');
        return;
      case 'av_get': {
        // Only your own picture, and only to people you're linked with (friends, people in your groups).
        const pic = msg.sha === this.avatars.mine ? this.avatars.read(msg.sha) : undefined;
        if (pic) link.send({ t: 'av_data', sha: msg.sha, d: pic.bytes.toString('base64') });
        return;
      }
      case 'av_data':
        if (this.avatars.receive(from, msg.sha, Buffer.from(msg.d, 'base64'))) this.emit('change');
        return;
      case 'presence':
        if (this.takePresence(from, msg.presence, msg.pat)) this.emit('change');
        return;
      case 'dm': {
        if (!this.friends.has(from)) return;
        const x = parseExtras(msg.x);
        if (!msg.text.trim() && !x?.files?.length && !x?.ask) return;
        const text = x && msg.text === wireNote(x) ? '' : msg.text;
        const dm = { id: msg.id, from, to: this.peerId, text, ts: msg.ts, ...(x ? { x } : {}) };
        if (this.dms.receive(dm)) {
          this.emit('message', this.dmViewOf(from, dm));
          this.emit('change');
        }
        link.send({ t: 'dm_ack', id: msg.id });
        return;
      }
      case 'dm_change': {
        if (!this.friends.has(from)) return;
        const conversation = dmConversation(from);
        const before = msg.text === undefined ? this.dmMessages(from) : [];
        const now = this.dms.changed(from, { id: msg.id, at: msg.at, ...(msg.text !== undefined ? { text: msg.text } : {}) });
        if (now) this.emit('message', this.dmViewOf(from, now));
        else if (now === undefined) {
          this.unread(conversation, before, msg.id);
          this.emit('unsent', conversation, msg.id);
        }
        if (now !== null) this.emit('change');
        link.send({ t: 'dm_change_ack', id: msg.id, at: msg.at });
        return;
      }
      case 'dm_change_ack':
        this.dms.changeDelivered(from, msg.id, msg.at);
        return;
      case 'dm_react': {
        if (!this.friends.has(from)) return;
        // Kept even before its message is here (it may come later, from the mailbox); the frame's emoji was checked (wire.ts).
        const changed = this.dmReacts.theirs(from, { id: msg.id, emoji: msg.e, by: from, on: msg.on, at: msg.at });
        if (changed && this.dms.find(from, msg.id)) this.emit('reacted', dmConversation(from), msg.id, this.dmReacts.of(from, msg.id));
        link.send({ t: 'dm_react_ack', id: msg.id, e: msg.e, at: msg.at });
        return;
      }
      case 'dm_react_ack':
        this.dmReacts.delivered(from, msg.id, msg.e, msg.at);
        return;
      case 'gw':
        if (this.friends.has(from)) this.emit('gateway', from, msg.p);
        return;
      case 'share':
        if (this.friends.has(from)) this.emit('share', from, msg.p);
        return;
      case 'team':
        if (this.friends.has(from)) this.emit('team', from, msg.p);
        return;
      case 'call':
        this.emit('call', from, msg.p);
        return;
      case 'stats':
        if (this.friends.has(from)) this.emit('stats', from, msg.p);
        return;
      case 'live': {
        const conversation = msg.g ? groupConversation(msg.g) : dmConversation(from);
        if (this.shares(conversation, from)) this.emit('live', { conversation, from, for: msg.for, state: msg.state, ...(msg.agent ? { agent: msg.agent } : {}) });
        return;
      }
      case 'f_get':
      case 'f_data':
      case 'f_err':
        this.emit('file', from, msg);
        return;
      case 'dm_seen': {
        if (!this.friends.has(from)) return;
        const seen = this.dms.seenBy(from, msg.id);
        for (const dm of seen) this.emit('message', this.dmViewOf(from, dm));
        if (seen.length) this.emit('change');
        return;
      }
      case 'dm_ack': {
        const dm = this.dms.delivered(from, msg.id);
        if (dm) {
          this.emit('message', this.dmViewOf(from, dm));
          this.emit('change');
        }
        return;
      }
      default:
    }
  }

  private broadcastPresence(): void {
    const presence = shown(this.presence);
    for (const link of this.links.linked()) link.send({ t: 'presence', presence, pat: this.presenceAt });
  }

  /** This Mac's status changed: later than anything said before (two changes in one millisecond too). */
  private presenceChanged(): void {
    this.presenceAt = Math.max(Date.now(), this.presenceAt + 1);
  }

  /**
   * A friend's status, unless it's older than the one we have: two links to them carry no order
   * between them, so a hello sent on one before they changed it can arrive after the change did
   * on the other, and would leave the old status showing (BLG-728). → whether it was taken.
   */
  private takePresence(from: string, presence: Presence, at: number | undefined): boolean {
    const had = this.theirPresenceAt.get(from);
    if (at !== undefined && had !== undefined && at < had) return false;
    this.theirPresence.set(from, presence);
    if (at === undefined) this.theirPresenceAt.delete(from);
    else this.theirPresenceAt.set(from, at);
    return true;
  }

  /** A status with an end time goes back to online by itself. */
  private scheduleUntil(): void {
    clearTimeout(this.untilTimer);
    const until = this.presence.until;
    if (until === undefined || this.closed) return;
    this.untilTimer = setTimeout(() => {
      if (this.presence.until !== until) return;
      this.presence = savePresence(this.file('presence.json'), ONLINE);
      this.presenceChanged();
      this.broadcastPresence();
      this.emit('change');
    }, Math.max(0, until - Date.now()));
    this.untilTimer.unref();
  }

  private tick(): void {
    if (this.closed) return;
    const now = Date.now();
    // A tick much later than planned: the Mac slept. Friends may have left mail meanwhile.
    const woke = isLate(now - this.lastTick, this.timing.syncMs);
    this.lastTick = now;
    if (this.mailbox && (woke || (now - this.mailCheckedAt >= this.mailbox.checkMs && this.friends.all().some((f) => !this.isLinked(f.peerId))))) void this.checkMail();
    this.groups.tick();
    for (const dm of this.dms.expire()) this.emit('message', this.dmViewOf(dm.to, dm));
    this.links.refresh();
  }
}

/** A direct message as it goes over the link. */
const dmFrame = (dm: { id: string; text: string; ts: number; x?: ChatExtras }): LinkMessage => ({ t: 'dm', id: dm.id, text: dm.text.trim() ? dm.text : wireNote(dm.x) || dm.text, ts: dm.ts, ...(dm.x ? { x: dm.x } : {}) });

const changeFrame = (c: DmChange): LinkMessage => ({ t: 'dm_change', id: c.id, at: c.at, ...(c.text !== undefined ? { text: c.text } : {}) });

/** A page of a conversation: the `limit` messages before `before` (default: the latest). */
function page(messages: readonly MessageView[], opts: { before?: number; limit?: number }): MessageView[] {
  const before = opts.before;
  const upTo = before === undefined ? messages.length : messages.findIndex((m) => m.ts >= before);
  const end = upTo < 0 ? messages.length : upTo;
  const limit = Math.min(Math.max(opts.limit ?? HISTORY_PAGE, 1), 500);
  return messages.slice(Math.max(0, end - limit), end);
}
