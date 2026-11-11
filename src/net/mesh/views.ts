import type { MessageVia } from '../../protocol.js';
/**
 * What the Beluga network looks like to a screen: people, groups, messages and invitations.
 * Plain data only (no keys, no secrets): this is what goes into the shared state.
 * Browser-safe: types only.
 */

import type { AgentRef } from '../../protocol.js';
import type { Reaction } from '../../shared/reactions.js';
import type { CallNotesView, CallsView, MissedCallView } from '../../shared/calls.js';

export type PresenceState = 'online' | 'away' | 'dnd' | 'offline';

/** A status you set: shown to your friends and the people in your groups. */
export interface Presence {
  readonly state: PresenceState;
  /** A short note ("at lunch"). */
  readonly note?: string;
  /** An emoji that goes with it, shown next to your name ("🌮"). */
  readonly emoji?: string;
  /** When it goes back to online by itself (ms since epoch). */
  readonly until?: number;
}

/** Someone you know on the network (a friend or someone in one of your groups). */
export interface PersonView {
  readonly peerId: string;
  readonly name: string;
  /** Connected right now (and not appearing offline). */
  readonly online: boolean;
  readonly presence: Presence;
  /** How you're connected: straight to their Mac, or through another member's Mac (still end-to-end encrypted). */
  readonly via?: 'direct' | 'relay';
  /** Their Beluga's version and what it does, as it said on its last link (unknown for Macs from before that). */
  readonly beluga?: { readonly version: string; readonly can: readonly string[] };
  /** Your two Macs speak different network versions, so they can't link: who needs to update. */
  readonly update?: 'them' | 'you';
  /** Their profile picture's checksum, once it's here (`network.avatar.get` gives its bytes). */
  readonly avatar?: string;
}

/** A file shared in a chat: who has it is found by its checksum; the bytes come Mac to Mac. */
export interface ChatFile {
  /** SHA-256 of the bytes (hex): the file's id everywhere. */
  readonly sha: string;
  readonly name: string;
  readonly size: number;
  readonly mime?: string;
  /** A picture the chat can show. */
  readonly image?: boolean;
}

/** What the Mac a Claude in a chat can't touch would need to do (chat Claudes have no tools). */
export interface ChatRequest {
  /** The task, as a request to that Claude on its owner's Mac ("Send me your desktop wallpaper"). */
  readonly ask: string;
  readonly needs?: ReadonlyArray<'project' | 'shell' | 'files' | 'screen' | 'device'>;
}

/** A Claude's answer in a chat: to message `for`, and what it would take as a real request (the asker's Mac offers to send it). */
export interface ClaudeReply {
  readonly for: string;
  readonly request?: ChatRequest;
  /** Which of its owner's agents answered (an older Mac leaves it out: Claude). */
  readonly agent?: AgentRef;
}

/** Who a message asks to answer: everyone's Claude in the chat, or these people's. */
export interface ChatAsk {
  readonly to: 'all' | readonly string[];
}

/**
 * A task between Claudes this message stands for (BLG-208): each side draws its card from its own
 * task book by `id` (the requester's and the receiver's both know it), so it updates as the task goes.
 */
export interface ChatTaskRef {
  readonly id: string;
  readonly role: 'request';
}

/** What a message carries besides its text (all inside the encryption). */
export interface ChatExtras {
  readonly files?: readonly ChatFile[];
  /** The author called for Claudes to answer this message. */
  readonly ask?: ChatAsk;
  /** The message is the card of a task between two people's Claudes (its text is for Macs that don't know it). */
  readonly task?: ChatTaskRef;
  /** This message is the author's Claude answering message `for`. */
  readonly claude?: ClaudeReply;
  /** An external agent wrote it for its author: "Sent by <name>". */
  readonly via?: MessageVia;
}

/** One message in a conversation with a friend (`dm:<peerId>`) or in a group (`group:<id>`). */
export interface MessageView extends ChatExtras {
  readonly id: string;
  readonly conversation: string;
  readonly from: string;
  readonly name: string;
  readonly text: string;
  readonly ts: number;
  readonly mine: boolean;
  /**
   * Your direct messages: waiting (in your outbox until they're online), delivered, seen (it was on
   * their screen, BLG-798; a friend on an older Beluga never says), or expired.
   * Group messages that can't be read (no key for them yet) are 'locked'.
   */
  readonly status?: 'waiting' | 'delivered' | 'seen' | 'expired' | 'locked';
  /** When its author last changed its text (direct messages). */
  readonly edited?: number;
  /** Emoji reactions under it (BLG-702), in the order they were first put there; none: left out. */
  readonly reactions?: readonly Reaction[];
}

export interface FriendView extends PersonView {
  readonly addedAt: number;
  readonly unread: number;
  readonly last?: MessageView;
}

export interface MemberView extends PersonView {
  readonly admin: boolean;
  /** You (so a screen can say "you"). */
  readonly self: boolean;
}

/** Someone who used a group invite link and waits for an admin. */
export interface JoinRequestView {
  readonly peerId: string;
  readonly name: string;
  readonly ts: number;
}

export interface GroupView {
  readonly id: string;
  readonly name: string;
  readonly members: readonly MemberView[];
  /** You're an admin (you can add and remove people). */
  readonly admin: boolean;
  /** You're in it (false once you left or were removed: the history stays, read-only). */
  readonly active: boolean;
  readonly unread: number;
  readonly last?: MessageView;
  readonly requests: readonly JoinRequestView[];
  readonly createdAt: number;
}

/** An invitation you made: a link and a short code, either one works. */
export interface InvitationView {
  readonly id: string;
  readonly kind: 'friend' | 'group';
  readonly groupId?: string;
  /** e.g. K7QM-4XPA-R2TD (works until `codeExpiresAt`, an hour at most). */
  readonly code: string;
  /** beluga://add#… or beluga://join#… (works until `expiresAt`). */
  readonly link: string;
  readonly expiresAt: number;
  readonly uses: number;
  /** When the code stops working (the link keeps working until `expiresAt`). */
  readonly codeExpiresAt: number;
  /** The code as a link: beluga://add?code=K7QM-4XPA-R2TD (same lifetime as the code). */
  readonly codeLink: string;
  /** Made for one person (a friend request sent in a room): only they can use it. */
  readonly for?: string;
}

/**
 * A friend request between two people in the same room (BLG-202): one they sent you (`in`,
 * Accept makes you friends), or one you sent them (`out`, waiting for them). The invitation
 * link itself stays in the daemon.
 */
export interface FriendOfferView {
  readonly peerId: string;
  readonly name: string;
  readonly dir: 'in' | 'out';
  readonly at: number;
  readonly expiresAt: number;
  /** Asked through a team you're both on, not a room (BLG-510): its repository ("acme/api"). */
  readonly via?: string;
}

/** A group you asked to join and that hasn't let you in yet. */
export interface PendingJoinView {
  readonly groupId: string;
  readonly name: string;
  readonly since: number;
}

export interface NetworkSelf {
  readonly peerId: string;
  readonly name: string;
  /** What you chose (others see "offline" while you appear offline). */
  readonly presence: Presence;
  readonly appearOffline: boolean;
  /** Your profile picture's checksum, if you set one. */
  readonly avatar?: string;
}

/** Everything about the network except the messages (they're kept per conversation). */
export interface NetworkSummary {
  /** The network is turned on (settings `network: true` or BELUGA_NETWORK=1). */
  readonly enabled: boolean;
  readonly self?: NetworkSelf;
  readonly friends: readonly FriendView[];
  readonly groups: readonly GroupView[];
  readonly invitations: readonly InvitationView[];
  readonly pendingJoins: readonly PendingJoinView[];
}

/** A file of a chat on this Mac: here, coming, or not had (yet). */
export interface ChatFileState {
  readonly state: 'here' | 'coming' | 'failed';
  /** Where it is on this Mac (here). */
  readonly path?: string;
  /** Bytes so far (coming). */
  readonly received?: number;
  readonly size: number;
  readonly error?: string;
}

/** Someone's Claude working on an answer in a conversation right now. */
export interface LiveClaude {
  readonly peerId: string;
  readonly name: string;
  /** The message it answers. */
  readonly for: string;
  readonly since: number;
  /** Which agent (BLG-498: its mark); an older Mac's leaves it out: Claude. */
  readonly agent?: AgentRef;
}

export interface NetworkState extends NetworkSummary {
  /** The latest messages per conversation (older ones: `network.dm.history` / `network.groups.history`). */
  readonly messages: Readonly<Record<string, readonly MessageView[]>>;
  /** Chat files by checksum: the ones on this Mac and the ones coming. */
  readonly files?: Readonly<Record<string, ChatFileState>>;
  /** Claudes answering, per conversation. */
  readonly live?: Readonly<Record<string, readonly LiveClaude[]>>;
  /** Your main channel (a group with all your friends), once it exists. */
  readonly main?: string;
  /** Friend requests with people in your room, both ways (BLG-202). */
  readonly offers?: readonly FriendOfferView[];
  /** Calls going on (or ringing) in your conversations, by conversation (BLG-706). */
  readonly calls?: CallsView;
  /** Notes of the calls in your conversations (BLG-715), by conversation, oldest first. */
  readonly callNotes?: Readonly<Record<string, readonly CallNotesView[]>>;
  /** Calls that rang for you and stopped before you answered, by conversation, oldest first. */
  readonly missedCalls?: Readonly<Record<string, readonly MissedCallView[]>>;
}

export const dmConversation = (peerId: string): string => `dm:${peerId}`;
export const groupConversation = (groupId: string): string => `group:${groupId}`;
