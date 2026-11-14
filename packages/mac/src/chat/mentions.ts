import type { FsEntry } from '../../../../src/protocol.js';
import { chatMentionsIn } from '../../../../src/shared/chat-ref.js';
import { friendMention } from '../../../../src/ui/suggest.js';
import { type TaskMention, taskByKey } from '../../../../src/shared/task-refs.js';

/**
 * "@mia", "@bob-api", "@add-auth", "@src/", "@src/auth.ts", "@BLG-24": who or what a mention in a message
 * names. A mention that names something real is drawn as a pill (in the message box and in the
 * conversation) and does something when clicked; anything else stays text. Plain data.
 */

/** 'image' only marks "[image N]" in the message box (an image waiting to be sent), 'worktree' a pasted "worktree:wt-…" (BLG-878). */
export type MentionKind = 'friend' | 'claude' | 'project' | 'workspace' | 'folder' | 'file' | 'task' | 'chat' | 'image' | 'worktree';

export interface MentionRef {
  readonly kind: MentionKind;
  /** What the pill says (without the @). */
  readonly label: string;
  /** The friend's peer id, the project's or the workspace's id, the task's key, the chat's ref. */
  readonly id?: string;
  /** A folder or file, relative to the worktree it was written in. */
  readonly path?: string;
}

/** What mentions can name here. */
export interface MentionWorld {
  readonly friends: ReadonlyArray<{ readonly name: string; readonly peerId: string }>;
  /** People in this room, for "@claude:bob" (friends count too). */
  readonly peers: ReadonlyArray<{ readonly name: string; readonly peerId: string }>;
  readonly projects: ReadonlyArray<{ readonly name: string; readonly id: string }>;
  /** Worktrees and chats ("@add-auth"), as the main chat offers them. */
  readonly workspaces: ReadonlyArray<{ readonly label: string; readonly id: string }>;
  /** A folder's entries in the worktree this message is about (undefined: not known yet). */
  readonly entries?: (dir: string) => readonly FsEntry[] | undefined;
  /** Tasks on your board ("@BLG-24"); left out where a key might be someone else's. */
  readonly tasks?: readonly TaskMention[];
}

/** "@" then a name or a path; it ends at a space (trailing punctuation isn't part of it). */
export const MENTION = /(^|[\s({"'“])@([\p{L}\p{N}_][\p{L}\p{N}_.:/+-]*)/gu;
const TRAILING = /[.,;:!?)\]}"'”]+$/u;

const lower = (s: string): string => s.toLowerCase();

/** The folder or file a path names in the worktree, if it's there. */
function pathRef(token: string, world: MentionWorld): MentionRef | undefined {
  if (!world.entries || token.startsWith('/') || token.includes('..')) return undefined;
  const folder = token.endsWith('/');
  const clean = token.replace(/\/+$/, '');
  if (!clean) return undefined;
  const at = clean.lastIndexOf('/');
  const dir = at < 0 ? '' : clean.slice(0, at);
  const name = clean.slice(at + 1);
  const hit = world.entries(dir)?.find((e) => e.name === name);
  if (!hit || (folder && !hit.dir)) return undefined;
  return hit.dir ? { kind: 'folder', label: `${clean}/`, path: `${clean}/` } : { kind: 'file', label: clean, path: clean };
}

/** Who or what "@token" names (the token without the @), or undefined when it's nothing known. */
export function resolveMention(token: string, world: MentionWorld): MentionRef | undefined {
  const t = lower(token);
  if (t === 'claude' || t === 'claudes') return { kind: 'claude', label: token };
  // "@claude:ata": Ata's Claude, someone in the room or a friend (plain "@ata" is Ata, the person).
  const theirs = /^claude:(.+)$/i.exec(token);
  if (theirs) {
    const who = lower(theirs[1]!);
    const peer = world.peers.find((p) => lower(p.name) === who) ?? world.friends.find((f) => lower(friendMention(f.name).slice(1)) === who);
    return peer ? { kind: 'claude', label: `${peer.name}’s agent`, id: peer.peerId } : undefined;
  }
  const friend = world.friends.find((f) => lower(friendMention(f.name).slice(1)) === t);
  if (friend) return { kind: 'friend', label: friend.name, id: friend.peerId };
  const ws = world.workspaces.find((w) => lower(w.label) === `@${t}`);
  if (ws) return { kind: 'workspace', label: token, id: ws.id };
  const project = world.projects.find((p) => lower(p.name) === t);
  if (project) return { kind: 'project', label: project.name, id: project.id };
  const task = world.tasks ? taskByKey(token, world.tasks) : undefined;
  if (task) return { kind: 'task', label: task.key, id: task.key };
  return pathRef(token, world);
}

export type MentionPiece = { readonly text: string } | { readonly raw: string; readonly ref: MentionRef };

/** A line of text cut into plain text and the mentions it makes (only those that name something). */
export function splitMentions(text: string, world: MentionWorld): MentionPiece[] {
  if (!text.includes('(chat: ')) return splitWords(text, world);
  const out: MentionPiece[] = [];
  let last = 0;
  for (const c of chatMentionsIn(text)) {
    out.push(...splitWords(text.slice(last, c.start), world));
    out.push({ raw: c.raw, ref: { kind: 'chat', label: c.title, id: c.ref } });
    last = c.end;
  }
  out.push(...splitWords(text.slice(last), world));
  return out;
}

function splitWords(text: string, world: MentionWorld): MentionPiece[] {
  const out: MentionPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const lead = m[1] ?? '';
    const token = (m[2] ?? '').replace(TRAILING, '');
    const ref = token ? resolveMention(token, world) : undefined;
    if (!ref) continue;
    const start = (m.index ?? 0) + lead.length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ raw: `@${token}`, ref });
    last = start + token.length + 1;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The chats the words name, as refs, each once, in order. */
export function chatsIn(text: string, world: MentionWorld): string[] {
  return [...new Set(chatMentionsIn(text).map((c) => c.ref))];
}

/** The tasks the words name ("@BLG-24"), each once, in order. */
export function tasksIn(text: string, world: MentionWorld): string[] {
  if (!world.tasks?.length || !text.includes('@')) return [];
  const keys = splitMentions(text, world).flatMap((p) => ('ref' in p && p.ref.kind === 'task' ? [p.ref.label] : []));
  return [...new Set(keys)];
}

/** The link a mention becomes in a message's Markdown (the renderer draws it as a pill). */
export const MENTION_SCHEME = 'beluga-mention:';

export const mentionHref = (ref: MentionRef): string => `${MENTION_SCHEME}${encodeURIComponent(JSON.stringify(ref))}`;

export function parseMentionHref(href: string): MentionRef | undefined {
  if (!href.startsWith(MENTION_SCHEME)) return undefined;
  try {
    const ref = JSON.parse(decodeURIComponent(href.slice(MENTION_SCHEME.length))) as MentionRef;
    return typeof ref?.kind === 'string' && typeof ref.label === 'string' ? ref : undefined;
  } catch {
    return undefined;
  }
}

/** Markdown with each mention that names something turned into a mention link (code is left alone). */
export function linkMentions(markdown: string, world: MentionWorld): string {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      // Leave code and lines with links alone.
      if (fenced || line.includes('`') || line.includes('](')) return line;
      return splitMentions(line, world)
        .map((p) => ('ref' in p ? `[${p.raw.replace(/([[\]\\])/g, '\\$1')}](${mentionHref(p.ref)})` : p.text))
        .join('');
    })
    .join('\n');
}
