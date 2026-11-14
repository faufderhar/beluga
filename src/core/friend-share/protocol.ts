import { z } from 'zod';
import { AgentRef } from '../../protocol.js';

/**
 * What two friends' Macs say about the things they share, inside the mesh's `share` frame (a
 * Noise link between the two of them; see docs/network.md, "Sharing with friends"). Each message
 * rides in a frame `{f, m}` the other side acknowledges (`{ack}`), like the gateway's.
 *
 * - `project`: the owner's project as the friend sees it now (name, icon, worktrees, who else is
 *   in it, their role). Sent whenever any of that changes; the newest replaces what waits.
 * - `unshare`: the owner took it back. `leave`: the friend left it.
 * - `history`: a worktree's recent conversation, once, when it's first shared with them; `more`:
 *   there's earlier. `history_request` asks for the page before `before` (a time), answered with a
 *   `history` carrying that `before`: the whole conversation comes a page at a time, as they scroll.
 * - `body`: one of today's room messages about a shared worktree or folder (its chat, requests to
 *   its Claude and what that Claude does, its files), checked on arrival as if it came from the
 *   room. `as`: a chat the owner passes on from someone else in the worktree.
 * - `folder`: a folder the owner shares with them (`active: false`: no longer).
 * - A whole project's `project` carries `copy` (with the repository's https address when it has
 *   one): the friend makes their own copy (copy.ts). When they can't clone it, `copy_request` asks
 *   the owner's Mac for a bundle of it, and `copy_ready` says where to fetch it (or `copy_failed`).
 *   `repo`: that address for a project shared a worktree at a time too (a fork looks for it in yours).
 * - `chats`: the owner's plain chats (no project folder), each shared on its own: a friend gets
 *   their conversation and Scratch, never a copy or a fork.
 * - `fork_request`: a friend who works in one of your worktrees wants their own fork of it on their
 *   Mac (fork.ts), with the commits they `have` (left out of the pack). `fork_ready` says where to
 *   fetch the pack and how many `files` are in it, for its progress (or `fork_failed`, why not).
 */

const id = z.string().regex(/^[\w:.-]{1,80}$/);
const peerId = z.string().regex(/^[\w-]{32}$/);
const role = z.enum(['contribute', 'view']);
const text = (max: number) => z.string().max(max);
const repoUrl = z.string().regex(/^https:\/\/[\w.~/-]{4,500}$/);

export const HISTORY_ITEMS = 60;
/** How long each message of a history page may be, for a Mac from before `share.history.long`. */
export const HISTORY_TEXT = 4000;
/** How long it may be for one that takes long messages: a graph or a long answer comes whole (BLG-622). */
export const HISTORY_TEXT_LONG = 60_000;
/** A history page stays under this many bytes, so it fits a link frame and a friend's mailbox. */
export const HISTORY_PAGE_BYTES = 400_000;

/**
 * The newest of `items` that fit one page: at most HISTORY_ITEMS, and under HISTORY_PAGE_BYTES
 * (always at least the newest one). `more`: there are older ones it left out.
 */
export function historyPageOf<T extends { readonly text: string }>(items: readonly T[], maxBytes = HISTORY_PAGE_BYTES): { items: T[]; more: boolean } {
  let bytes = 0;
  let start = items.length;
  while (start > 0 && items.length - start < HISTORY_ITEMS) {
    const size = Buffer.byteLength(JSON.stringify(items[start - 1]));
    if (start < items.length && bytes + size > maxBytes) break;
    bytes += size;
    start -= 1;
  }
  return { items: items.slice(start), more: start > 0 };
}

export const ShareMsg = z.discriminatedUnion('k', [
  z.object({
    k: z.literal('project'),
    id,
    name: text(200),
    icon: z.object({ mime: text(60), data: text(160_000) }).optional(),
    role,
    worktrees: z.array(z.object({ id, name: text(200), branch: text(200).optional(), agent: AgentRef.optional() })).max(200),
    members: z.array(z.object({ peerId, name: text(80), role })).max(100),
    copy: z.object({ url: repoUrl.optional() }).optional(),
    repo: repoUrl.optional(),
    chats: z.literal(true).optional(),
  }),
  z.object({ k: z.literal('copy_request'), id }),
  z.object({ k: z.literal('copy_ready'), id, share: id, size: z.number().int().min(0) }),
  z.object({ k: z.literal('copy_failed'), id, error: text(300) }),
  z.object({ k: z.literal('fork_request'), ws: id, have: z.array(z.string().regex(/^[0-9a-f]{40}$/)).max(40) }),
  z.object({ k: z.literal('fork_ready'), ws: id, share: id, size: z.number().int().min(0), files: z.number().int().min(0).max(1_000_000).optional() }),
  z.object({ k: z.literal('fork_failed'), ws: id, error: text(300) }),
  z.object({ k: z.literal('unshare'), id }),
  z.object({ k: z.literal('leave'), id }),
  z.object({
    k: z.literal('history'),
    ws: id,
    items: z.array(z.object({ from: text(120), text: text(HISTORY_TEXT_LONG), ts: z.number().int().min(0), byAgent: z.boolean() })).max(HISTORY_ITEMS),
    more: z.boolean().optional(),
    before: z.number().int().min(0).optional(),
  }),
  z.object({ k: z.literal('history_request'), ws: id, before: z.number().int().min(0) }),
  z.object({ k: z.literal('body'), b: z.unknown(), as: peerId.optional() }),
  z.object({ k: z.literal('folder'), name: z.string().regex(/^[\w.-]{1,64}$/), label: text(200), writable: z.boolean(), active: z.boolean() }),
]);
export type ShareMsg = z.infer<typeof ShareMsg>;

const frameId = z.string().regex(/^[\w-]{8,40}$/);
export const ShareFrame = z.union([z.object({ f: frameId, m: ShareMsg }), z.object({ ack: frameId })]);
export type ShareFrame = z.infer<typeof ShareFrame>;

export function parseShareFrame(raw: unknown): ShareFrame | undefined {
  const parsed = ShareFrame.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
