import { z } from 'zod';
import { AgentRef } from '../../protocol.js';
import { EmojiSchema } from '../../shared/reactions.js';
import { AVATAR_MAX } from './avatars.js';
import { NameSchema, PeerIdSchema, PresenceSchema, ProfileSchema } from './schemas.js';

/**
 * The messages two Beluga Macs send each other over a link (JSON, one per frame). `hello` says
 * which protocol version each side speaks; a different major version closes the link. Kinds a
 * side doesn't know are ignored, so new ones can be added without breaking older Macs.
 */
export const PROTO = 1;

/** The biggest piece of a chat file one frame carries. */
export const FILE_PIECE = 256 * 1024;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const groupId = z.string().regex(/^[0-9a-f]{32}$/);
const msgId = z.string().regex(/^[\w-]{8,64}$/);
const tid = z.number().int().min(0).max(2 ** 31);

export const LinkMessage = z.discriminatedUnion('t', [
  /**
   * `app`, `can`: their Beluga's version and what it does (net/mesh/features.ts); Macs from before them send neither.
   * `avatar`: the checksum of their profile picture (net/mesh/avatars.ts); said again when it changes, left out when there's none.
   */
  z.object({
    t: z.literal('hello'),
    proto: z.number().int(),
    name: NameSchema,
    presence: PresenceSchema,
    app: z.string().max(64).optional(),
    can: z.array(z.string().max(40)).max(64).optional(),
    avatar: hex64.optional(),
    /** When that status was set (the sender's clock, see `pat` on presence). */
    pat: z.number().int().min(0).optional(),
  }),
  /**
   * `pat`: when it was set, so an older status that comes in later on another link (two links to one
   * friend while they settle which to keep, BLG-728) never replaces it. A Mac from before it leaves it out.
   */
  z.object({ t: z.literal('presence'), presence: PresenceSchema, pat: z.number().int().min(0).optional() }),
  /** A direct message (end-to-end: the link is a Noise channel between the two of you). */
  z.object({ t: z.literal('dm'), id: msgId, text: z.string().max(8_000), ts: z.number().int().min(0), x: z.unknown().optional() }),
  /** Someone's Claude started (or stopped) answering in a conversation: `g` a group's id, or none for your direct messages; `agent`: which of theirs (BLG-498; an older Mac leaves it out). */
  z.object({ t: z.literal('live'), g: groupId.optional(), for: z.string().min(1).max(80), state: z.enum(['thinking', 'idle']), agent: AgentRef.optional().catch(undefined) }),
  /** Chat files (core/chat-files): ask for a piece of a file by checksum, in a conversation you share. */
  z.object({ t: z.literal('f_get'), rid: msgId, sha: hex64, g: groupId.optional(), off: z.number().int().min(0), len: z.number().int().min(1).max(FILE_PIECE) }),
  z.object({ t: z.literal('f_data'), rid: msgId, off: z.number().int().min(0), d: z.string().max(Math.ceil(FILE_PIECE / 3) * 4) }),
  z.object({ t: z.literal('f_err'), rid: msgId, off: z.number().int().min(0), e: z.string().max(200) }),
  /** Profile pictures: ask for the one someone said is theirs; they answer with its bytes (base64), or nothing. */
  z.object({ t: z.literal('av_get'), sha: hex64 }),
  z.object({ t: z.literal('av_data'), sha: hex64, d: z.string().max(Math.ceil(AVATAR_MAX / 3) * 4) }),
  z.object({ t: z.literal('dm_ack'), id: msgId }),
  /** BLG-798: their direct messages up to this one were on your screen (on a device of yours, never sent by an Always On on its own). Older Macs ignore it. */
  z.object({ t: z.literal('dm_seen'), id: msgId }),
  /** The author deleted (no `text`) or edited one of their direct messages; `at` orders edits (BLG-425). */
  z.object({ t: z.literal('dm_change'), id: msgId, text: z.string().max(8_000).optional(), at: z.number().int().min(0) }),
  z.object({ t: z.literal('dm_change_ack'), id: msgId, at: z.number().int().min(0) }),
  /** BLG-702: you put an emoji on a direct message (`on`) or took it off; `at` orders your changes to it. Older Macs ignore it. */
  z.object({ t: z.literal('dm_react'), id: msgId, e: EmojiSchema, on: z.boolean(), at: z.number().int().min(0) }),
  z.object({ t: z.literal('dm_react_ack'), id: msgId, e: EmojiSchema, at: z.number().int().min(0) }),
  /** The newest entries I have of a group we're both in. */
  z.object({ t: z.literal('g_heads'), group: groupId, heads: z.array(hex64).max(64) }),
  /** Send me what I'm missing (these are my newest entries). */
  z.object({ t: z.literal('g_sync'), group: groupId, heads: z.array(hex64).max(64) }),
  z.object({ t: z.literal('g_entries'), group: groupId, entries: z.array(z.unknown()).max(500), more: z.boolean().optional() }),
  /** Relaying: open a tunnel to someone through you; bytes inside are Noise-encrypted end to end. */
  z.object({ t: z.literal('tun_open'), tid, to: PeerIdSchema }),
  z.object({ t: z.literal('tun_in'), tid, from: PeerIdSchema }),
  /** `o`: the sender picked this tunnel id (each side of a hop numbers its own tunnels). */
  z.object({ t: z.literal('tun_data'), tid, o: z.boolean(), d: z.string().max(90_000) }),
  z.object({ t: z.literal('tun_close'), tid, o: z.boolean(), reason: z.string().max(200).optional() }),
  /** The gateway (tasks between Claudes, core/gateway): a frame it checks itself, between friends only. */
  z.object({ t: z.literal('gw'), p: z.unknown() }),
  /** Sharing projects, worktrees and folders with friends (core/friend-share): a frame it checks itself, between friends only. */
  z.object({ t: z.literal('share'), p: z.unknown() }),
  /** Team boards (core/team): friends on the same GitHub repo; a frame it checks itself, between friends only. */
  z.object({ t: z.literal('team'), p: z.unknown() }),
  /** Calls in a conversation (core/calls, BLG-706): ringing, who's in, and WebRTC setup; a frame it checks itself, between people in that conversation. */
  z.object({ t: z.literal('call'), p: z.unknown() }),
  /** The leaderboard (core/leaderboard, BLG-904): a friend's day sums; a frame it checks itself, between friends only. Older Macs ignore it. */
  z.object({ t: z.literal('stats'), p: z.unknown() }),
]);
export type LinkMessage = z.infer<typeof LinkMessage>;

/** Parse one frame; undefined for anything malformed or of a kind this version doesn't know. */
export function parseLink(text: string): LinkMessage | undefined {
  try {
    const parsed = LinkMessage.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pairing: what's said over the short-lived connection an invitation opens. Both sides prove
 * they know the invitation's secret with an HMAC over the Noise handshake hash, so nobody
 * without it can pose as either side, and a proof can't be replayed on another connection.
 */
export const PairMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('pair_hello'), proto: z.number().int(), mac: z.string().max(100), profile: ProfileSchema }),
  z.object({
    t: z.literal('pair_ok'),
    mac: z.string().max(100),
    profile: ProfileSchema,
    kind: z.enum(['friend', 'group']),
    group: z.object({ id: groupId, name: NameSchema, status: z.enum(['joined', 'waiting']) }).optional(),
  }),
  z.object({ t: z.literal('pair_refused'), reason: z.string().max(200) }),
]);
export type PairMessage = z.infer<typeof PairMessage>;

export function parsePair(text: string): PairMessage | undefined {
  try {
    const parsed = PairMessage.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
