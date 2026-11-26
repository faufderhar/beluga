import { appendFile, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Uploads } from '../companion/uploads.js';
import { safeFileName, uniquePath } from '../core/downloads.js';
import { belugaHome } from '../core/home.js';
import { isSecretPath } from '../core/shares.js';
import { isEnvFileName } from '../workspaces/env.js';
import { refusedOnThisMac } from './env-send.js';
import { uploadsDir } from '../daemon/web-files.js';
import { MAX_UPLOAD_BYTES, UPLOAD_PIECE } from '../shared/uploads.js';
import { THIS_COMPUTER } from '../shared/assistant.js';

/**
 * Files you add to a chat that runs on one of your computers (BLG-793): a file dropped from Finder
 * is on this Mac, so its bytes go there, a piece at a time over the link your screen has open (the
 * door), and the chat names it by its path there. This Mac's daemon reads each piece the app asks
 * for (machines.upload.send) and hands it to the computer's own machines.upload.put, which writes it the way
 * the phone's uploads are written (companion/uploads.ts) into ~/.beluga/uploads there. The app
 * shows each piece's progress. A pasted or dropped picture already goes as bytes (attachments.add
 * runs on the computer).
 */

export { UPLOAD_PIECE } from '../shared/uploads.js';

/** One piece of a file, as machines.upload.put takes it. */
export interface UploadPiece {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly off: number;
  readonly b64: string;
  readonly eof: boolean;
}

/** What machines.upload.put answers: how much is in so far, or, for the last piece, where the file is now. */
export type PutAnswer = { readonly received: number } | { readonly path: string; readonly name: string; readonly size: number; readonly image: boolean };

/** A screen of yours sending this computer files: all of them under one name (it's you). */
const YOU = 'your-app';
const all = new WeakMap<object, Uploads>();

/** On the computer: one piece of a file your app sends. */
export async function receivePiece(session: object, id: number, piece: UploadPiece): Promise<PutAnswer> {
  let uploads = all.get(session);
  if (!uploads) {
    uploads = new Uploads(path.join(uploadsDir(), new Date().toISOString().slice(0, 10)), { maxBytes: MAX_UPLOAD_BYTES });
    all.set(session, uploads);
  }
  // Your app sends one file at a time: a new one lets go of any it gave up on halfway.
  if (piece.off === 0) await uploads.drop(YOU);
  const r = await uploads.piece(YOU, { t: 'put', id, ...piece });
  if ('received' in r) return r;
  const [up] = await uploads.resolve(YOU, [r.ref]);
  return { path: up!.path, name: up!.name, size: up!.size, image: up!.image };
}

const MIME: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** What machines.upload.send answers the app: how far it got, and the file's path there once it's all in. */
export interface SentPiece {
  readonly sent: number;
  readonly total: number;
  readonly name: string;
  /** Once it's all there. */
  readonly path?: string;
  readonly image?: boolean;
}

/**
 * What becomes of a file dropped on a chat on a computer (BLG-854), the env send's rules: `refuse`
 * (keys, certificates, anything in a credential folder or Beluga's own, followed through links)
 * with why, `ask` for an env file (its name only, then Send Once or Don't Send), else `send`.
 */
export type DropVerdict = { readonly path: string; readonly name: string } & ({ readonly verdict: 'send' | 'ask' } | { readonly verdict: 'refuse'; readonly reason: string });

export async function checkDrop(file: string, home: string = belugaHome()): Promise<DropVerdict> {
  const name = path.basename(file);
  if (!path.isAbsolute(file)) return { path: file, name, verdict: 'refuse', reason: `not a file on ${THIS_COMPUTER}` };
  const real = await realpath(file).catch(() => file);
  const insideHome = (p: string): boolean => p === home || p.startsWith(home + path.sep);
  const reason = refusedOnThisMac(file) ?? refusedOnThisMac(real) ?? (insideHome(file) || insideHome(real) ? `Beluga’s own files stay on ${THIS_COMPUTER}` : undefined);
  if (reason) return { path: file, name, verdict: 'refuse', reason };
  return { path: file, name, verdict: isEnvFileName(name) || isEnvFileName(path.basename(real)) ? 'ask' : 'send' };
}

/**
 * In the app: read the piece of local `file` at `off` and put it on computer `machine` through
 * `call` (the door's own call over a screen's link). Upload `id` names the file there until its last piece.
 * A refused file never goes; an env file only with `env` (you said Send Once).
 */
export async function sendPiece(call: (method: string, args: readonly unknown[]) => Promise<unknown>, id: number, file: string, off: number, opts: { readonly env?: boolean } = {}): Promise<SentPiece> {
  if (!path.isAbsolute(file)) throw new Error(`Pick a file on ${THIS_COMPUTER}`);
  const check = await checkDrop(file);
  if (check.verdict === 'refuse') throw new Error(`${check.name} stays on ${THIS_COMPUTER}: ${check.reason}`);
  if (check.verdict === 'ask' && !opts.env) throw new Error(`${check.name} holds secrets: say Send Once first`);
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Only files go with a message (not folders)');
  if (info.size > MAX_UPLOAD_BYTES) throw new Error(`That file is too big to send (up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
  if (off < 0 || off > info.size) throw new Error('That upload went wrong; send it again');
  const length = Math.min(UPLOAD_PIECE, info.size - off);
  const bytes = Buffer.alloc(length);
  const handle = await open(file, 'r');
  try {
    if (length) await handle.read(bytes, 0, length, off);
  } finally {
    await handle.close();
  }
  const name = path.basename(file);
  const piece: UploadPiece = { name, mime: MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream', size: info.size, off, b64: bytes.toString('base64'), eof: off + length >= info.size };
  const answer = (await call('machines.upload.put', [id, piece])) as PutAnswer;
  if ('received' in answer) return { sent: answer.received, total: info.size, name };
  return { sent: info.size, total: info.size, name: answer.name, path: answer.path, image: answer.image };
}

/** A piece of a file on this computer, for your app to download (BLG-794). */
export interface DownPiece {
  readonly b64: string;
  readonly total: number;
  readonly eof: boolean;
}

/** On the computer: the piece of `file` at `off` (a file, never a secret, up to MAX_UPLOAD_BYTES). */
export async function readPieceHere(file: string, off: number): Promise<DownPiece> {
  if (!path.isAbsolute(file)) throw new Error('Name the file by its whole path');
  if (isSecretPath(file)) throw new Error('That file is private');
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Only a file downloads (copy a folder’s path instead)');
  if (info.size > MAX_UPLOAD_BYTES) throw new Error(`That file is too big to download (up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
  if (off < 0 || off > info.size) throw new Error('That download went wrong; try again');
  const length = Math.min(UPLOAD_PIECE, info.size - off);
  const bytes = Buffer.alloc(length);
  const handle = await open(file, 'r');
  try {
    if (length) await handle.read(bytes, 0, length, off);
  } finally {
    await handle.close();
  }
  return { b64: bytes.toString('base64'), total: info.size, eof: off + length >= info.size };
}

/**
 * In the app: a file on one of your computers, down to `dir` on this Mac (~/Downloads/Beluga) a
 * piece at a time through `call` (the door) → where it's saved. A half-done one is removed.
 */
export async function downloadThere(call: (method: string, args: readonly unknown[]) => Promise<unknown>, file: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const to = await uniquePath(dir, safeFileName(path.posix.basename(file.replace(/\\/g, '/'))));
  const tmp = `${to}.part`;
  try {
    for (let off = 0; ; ) {
      const piece = (await call('machines.download.piece', [file, off])) as DownPiece;
      const bytes = Buffer.from(piece.b64, 'base64');
      await appendFile(tmp, bytes, { mode: 0o600 });
      off += bytes.length;
      if (piece.eof || off >= piece.total) break;
      if (!bytes.length) throw new Error('The download stopped moving; try again');
    }
    await rename(tmp, to);
    return to;
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
