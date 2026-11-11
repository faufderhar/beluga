import path from 'node:path';
import { z } from 'zod';
import { AgentRef, MessageVia } from '../../protocol.js';
import { PeerIdSchema } from './schemas.js';
import type { ChatExtras, ChatFile } from './views.js';

/**
 * What a chat message can carry besides its text, inside the encryption (a group message's
 * sealed JSON, a direct message's Noise link): files (by checksum; the bytes travel separately,
 * see core/chat-files), a call for Claudes to answer (`ask`), that it is a Claude's answer
 * (`claude`), or a task between two people's Claudes (`task`). Older Macs read only `text` and
 * ignore the rest.
 */

/** No size limit on chat files (they're pulled in pieces, straight from Mac to Mac): only what a number can say. */
export const MAX_CHAT_FILE = Number.MAX_SAFE_INTEGER;
/** Files on one message. */
export const MAX_FILES = 20;
/** The longest request a chat Claude's answer can offer (see ChatRequest). */
export const MAX_REQUEST_ASK = 500;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** A file name that can't climb out of a folder or hide its kind: no paths, no control characters. */
export function cleanFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').replace(/^\.+/, '').trim().slice(0, 200);
  return clean || 'file';
}

export const ChatFileSchema = z.object({
  sha: hex64,
  name: z.string().min(1).max(200).transform(cleanFileName),
  size: z.number().int().min(0).max(MAX_CHAT_FILE),
  mime: z.string().max(100).regex(/^[\w.+-]+\/[\w.+-]+$/).optional(),
  image: z.boolean().optional(),
});

export const ExtrasSchema = z.object({
  files: z.array(ChatFileSchema).max(MAX_FILES).optional(),
  ask: z.object({ to: z.union([z.literal('all'), z.array(PeerIdSchema).min(1).max(100)]) }).optional(),
  claude: z
    .object({
      for: z.string().min(1).max(80),
      // Older Macs drop `request` (zod strips what it doesn't know) and show the answer alone.
      request: z.object({ ask: z.string().min(1).max(MAX_REQUEST_ASK), needs: z.array(z.enum(['project', 'shell', 'files', 'screen', 'device'])).max(5).optional() }).optional(),
      // Older Macs drop it and say "Claude"; a malformed one is dropped alone, never the answer.
      agent: AgentRef.optional().catch(undefined),
    })
    .optional(),
  // Which external agent wrote this for its owner. Older Macs drop it and show the words; a malformed one is dropped alone.
  via: MessageVia.optional().catch(undefined),
  // Older Macs drop it and show the text ("kay asked bob's Claude: …").
  task: z.object({ id: z.string().regex(/^t_[\w-]{10,40}$/), role: z.literal('request') }).optional(),
});

/** The extras of a message as they came (anything malformed is dropped; nothing at all: undefined). */
export function parseExtras(raw: unknown): ChatExtras | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const parsed = ExtrasSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { files, ask, claude, task, via } = parsed.data;
  const out: { files?: ChatFile[]; ask?: ChatExtras['ask']; claude?: ChatExtras['claude']; task?: ChatExtras['task']; via?: ChatExtras['via'] } = {};
  if (via) out.via = via;
  if (task) out.task = { id: task.id, role: task.role };
  if (files?.length) out.files = files.map((f) => ({ sha: f.sha, name: f.name, size: f.size, ...(f.mime ? { mime: f.mime } : {}), ...(f.image ? { image: true } : {}) }));
  if (ask) out.ask = ask;
  if (claude) out.claude = { for: claude.for, ...(claude.agent ? { agent: claude.agent } : {}), ...(claude.request ? { request: { ask: claude.request.ask, ...(claude.request.needs?.length ? { needs: [...new Set(claude.request.needs)] } : {}) } } : {}) };
  return Object.keys(out).length ? out : undefined;
}

/** The fields to spread into a message or a view: nothing when there are no extras. */
export const extrasFields = (x: ChatExtras | undefined): ChatExtras => (x ? { ...(x.via ? { via: x.via } : {}), ...(x.files ? { files: x.files } : {}), ...(x.ask ? { ask: x.ask } : {}), ...(x.claude ? { claude: x.claude } : {}), ...(x.task ? { task: x.task } : {}) } : {});

/** A message needs words, files, or a call for Claudes (who then read the conversation and answer it). */
export function checkMessage(text: string, extras: ChatExtras | undefined, maxText: number): void {
  if (text.length > maxText) throw new Error(`Messages are at most ${maxText} characters`);
  if (!text.trim() && !extras?.files?.length && !extras?.ask) throw new Error('Write something or add a file');
}

/** What a direct message with no words says to Macs that need some text (they drop it otherwise). */
export const ASK_NOTE = '✳ Asked Claude to read the conversation';

/**
 * What a direct message with only files says to Macs that don't know about files (they need some
 * text): "📎 deck.pdf". Newer Macs see the files and drop the note.
 */
export const filesNote = (files: ReadonlyArray<{ readonly name: string }>): string => `📎 ${files.map((f) => f.name).join(', ')}`.slice(0, 500);

/** The text a wordless direct message carries on the wire (see filesNote, ASK_NOTE). */
export const wireNote = (x: ChatExtras | undefined): string => (x?.files?.length ? filesNote(x.files) : x?.ask ? ASK_NOTE : '');

/** Does this call for Claudes include `peerId`'s? */
export const asks = (x: ChatExtras | undefined, peerId: string): boolean => Boolean(x?.ask && (x.ask.to === 'all' || x.ask.to.includes(peerId)));
