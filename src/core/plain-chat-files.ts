import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Body, BodyInput } from '../protocol.js';
import { SHOWN_SCRATCH_DIRS } from '../shared/scratch-dir.js';
import { shareNameOf } from '../shared/share-names.js';
import type { Project } from '../workspaces/types.js';

/**
 * A plain chat (one in no project) shared with someone, a friend or a person in your room, has no
 * project folder to give: it runs in its own folder, or in one you started it in, whose other files
 * stay yours. They get only its Scratch, as the Scratch tab shows it, and nothing outside it (links
 * followed and checked): no other file, no search, no diff.
 */

export const NO_CHAT_FILES = 'A chat has no project files: only its Scratch is shared';

type FileRequest = Extract<Body, { kind: 'fs_list' | 'fs_read' | 'fs_fetch' | 'fs_search' | 'ws_diff' }>;

/** The refusal to send back when `body` (from someone else) asks for a plain chat's files outside its Scratch. */
export function chatFilesRefusal(projects: readonly Project[], body: Body): BodyInput | undefined {
  if (!isFileRequest(body)) return undefined;
  const chats = projects.filter((p) => !p.root).flatMap((p) => p.workspaces);
  if (body.kind === 'ws_diff') return chats.some((w) => w.id === body.id) ? refusal(body) : undefined;
  const chat = chats.find((w) => shareNameOf(w.id) === body.share);
  if (!chat || (body.kind !== 'fs_search' && inChatScratch(chat.path, body.path))) return undefined;
  return refusal(body);
}

/** Is `rel` (a peer's path in the chat's folder at `root`) inside one of its Scratch folders? */
export function inChatScratch(root: string, rel: string): boolean {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (cleaned.split('/').includes('..')) return false;
  const dir = SHOWN_SCRATCH_DIRS.find((d) => cleaned === d || cleaned.startsWith(`${d}/`));
  if (!dir) return false;
  // A link in it may point out of it: where it really is counts. One that isn't there is read as missing.
  const target = realOf(path.join(root, cleaned));
  const scratch = realOf(path.join(root, dir));
  if (!target || !scratch) return true;
  return target === scratch || target.startsWith(scratch + path.sep);
}

function isFileRequest(body: Body): body is FileRequest {
  return body.kind === 'fs_list' || body.kind === 'fs_read' || body.kind === 'fs_fetch' || body.kind === 'fs_search' || body.kind === 'ws_diff';
}

/** The refusal in the kind of answer the request waits for. */
function refusal(body: FileRequest): BodyInput {
  const kind = body.kind === 'fs_list' ? 'fs_list_result' : body.kind === 'fs_read' ? 'fs_read_result' : body.kind === 'fs_fetch' ? 'fs_chunk' : body.kind === 'fs_search' ? 'fs_search_result' : 'ws_diff_result';
  return { kind, reqId: body.reqId, ok: false, error: NO_CHAT_FILES };
}

function realOf(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}
