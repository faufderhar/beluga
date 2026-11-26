import type { Dirent } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { attachmentsDir, isAttachmentName, pastedThisSession } from './attachments.js';
import { belugaHome } from './home.js';

/**
 * Images nobody links any more, cleaned up. What you paste is saved in ~/.beluga/attachments
 * (friends' in `received/`, the copies they fetch in `room/`, the phone's in `phone/`), and a
 * message only links it by name ("klaud-attachment:<owner>/<file>"). When the conversation goes
 * (a worktree or chat deleted: its ~/.beluga/history/<id>.json with it), the image stayed forever.
 *
 * So: an image no file Beluga keeps in its home names any more (chat histories, archived worktrees'
 * histories, DMs, groups, the board, sentinels, queued messages) and older than a day goes. Any
 * mention of its name keeps it: keeping one too many costs a few KB, deleting one too many breaks a
 * chat. The day covers an image still waiting in the box, or a history not written yet.
 */

/** How old an image nobody links must be before it goes. */
export const SWEEP_GRACE_MS = 24 * 60 * 60_000;
/** The first sweep, this long after the daemon starts (out of the way of everything starting). */
const FIRST_SWEEP_MS = 3 * 60_000;
/** Then this often. */
const SWEEP_EVERY_MS = 6 * 60 * 60_000;
/** After a worktree or chat is deleted (several deleted in a row: one sweep). */
const AFTER_DELETE_MS = 30_000;

/** Folders below the attachments folder whose images are swept (top level: your own pastes). */
const IMAGE_FOLDERS = ['', 'room', 'received'] as const;
/** The phone's uploads: any file (a PDF a message names by path too), and pieces of uploads cut short. */
const PHONE_FOLDER = 'phone';

/**
 * Folders of the home never read for links: the images themselves, worktree folders and archives
 * (code, and copies of images rather than links), and big folders of other things. The step records
 * are left out on purpose: they outlive the chat they came from and would keep its images.
 */
const SKIP_IN_HOME = new Set(['attachments', 'workspaces', 'archives', 'claude-code', 'voice', 'bin', 'logs', 'steps', 'proof', 'e2e', 'tests']);
const SKIP_ANYWHERE = new Set(['node_modules', '.git']);
/** Files that can hold a message's text. */
const TEXT_FILE = /\.(json|jsonl|md|txt)$/i;
/** Bigger files are not read (nothing Beluga keeps a message in is near this). */
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 6;

export interface SweepOptions {
  /** Beluga's home, read for links (default ~/.beluga). */
  readonly home?: string;
  /** The attachments folder (default ~/.beluga/attachments). */
  readonly dir?: string;
  readonly now?: number;
  readonly graceMs?: number;
  /** Images never taken (default: those pasted into a box this session). */
  readonly keep?: ReadonlySet<string>;
}

export interface SweepResult {
  readonly removed: readonly string[];
  readonly bytes: number;
}

interface Candidate {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  /** A piece of a phone upload cut short: goes once it's old, whatever names it. */
  readonly partial: boolean;
}

const entries = (dir: string): Promise<Dirent[]> => fs.readdir(dir, { withFileTypes: true }).catch(() => []);

/** Images (and phone uploads) old enough to go, if nothing names them. Never a link, never a folder. */
async function candidates(dir: string, cutoff: number, keep: ReadonlySet<string>): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const consider = async (folder: string, accepts: (name: string) => boolean): Promise<void> => {
    for (const e of await entries(folder)) {
      if (!e.isFile() || !accepts(e.name)) continue;
      const file = path.join(folder, e.name);
      if (keep.has(path.resolve(file))) continue;
      const st = await fs.lstat(file).catch(() => undefined);
      if (!st?.isFile() || st.mtimeMs > cutoff) continue;
      out.push({ path: file, name: e.name, size: st.size, partial: e.name.startsWith('.') && e.name.endsWith('.part') });
    }
  };
  for (const sub of IMAGE_FOLDERS) await consider(path.join(dir, sub), isAttachmentName);
  await consider(path.join(dir, PHONE_FOLDER), (name) => !name.startsWith('.') || name.endsWith('.part'));
  return out;
}

/** Every text file of the home that may hold a message, as it's found. */
async function* textFiles(home: string, at = home, depth = 0): AsyncGenerator<string> {
  for (const e of await entries(at)) {
    const file = path.join(at, e.name);
    if (e.isDirectory()) {
      if (depth >= MAX_DEPTH || SKIP_ANYWHERE.has(e.name) || (depth === 0 && SKIP_IN_HOME.has(e.name))) continue;
      yield* textFiles(home, file, depth + 1);
    } else if (e.isFile() && TEXT_FILE.test(e.name)) yield file;
  }
}

/** The names of `wanted` that some text file in the home mentions. */
async function namedInHome(home: string, wanted: ReadonlySet<string>): Promise<Set<string>> {
  const found = new Set<string>();
  for await (const file of textFiles(home)) {
    const st = await fs.stat(file).catch(() => undefined);
    if (!st || st.size > MAX_TEXT_BYTES) continue;
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    for (const name of wanted) if (!found.has(name) && text.includes(name)) found.add(name);
    if (found.size === wanted.size) break;
  }
  return found;
}

/** Delete the images nothing links any more. Never throws: a file that can't go stays for next time. */
export async function sweepAttachments(o: SweepOptions = {}): Promise<SweepResult> {
  const dir = o.dir ?? attachmentsDir();
  const cutoff = (o.now ?? Date.now()) - (o.graceMs ?? SWEEP_GRACE_MS);
  const found = await candidates(dir, cutoff, o.keep ?? pastedThisSession());
  const linkable = found.filter((c) => !c.partial);
  const named = linkable.length ? await namedInHome(o.home ?? belugaHome(), new Set(linkable.map((c) => c.name))) : new Set<string>();
  const removed: string[] = [];
  let bytes = 0;
  for (const c of found) {
    if (!c.partial && named.has(c.name)) continue;
    const gone = await fs.rm(c.path).then(
      () => true,
      () => false,
    );
    if (!gone) continue;
    removed.push(c.path);
    bytes += c.size;
  }
  return { removed, bytes };
}

/** Where the daemon hears that a worktree or chat was deleted. */
export interface SweepHost {
  readonly onRemoved?: (listener: () => void) => () => void;
  readonly log?: (line: string) => void;
}

/** Sweep a while after start, then every few hours, and soon after a worktree or chat is deleted. */
export function launchAttachmentSweep(host: SweepHost = {}, o: SweepOptions = {}): () => void {
  let running = false;
  let soon: NodeJS.Timeout | undefined;
  const sweep = (): void => {
    if (running) return;
    running = true;
    void sweepAttachments(o)
      .then((r) => {
        if (r.removed.length) host.log?.(`attachments: removed ${r.removed.length} image${r.removed.length === 1 ? '' : 's'} no chat links any more (${Math.round(r.bytes / 1024)} KB)`);
      })
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(sweep, FIRST_SWEEP_MS);
  const every = setInterval(sweep, SWEEP_EVERY_MS);
  first.unref();
  every.unref();
  const stopListening = host.onRemoved?.(() => {
    if (soon) clearTimeout(soon);
    soon = setTimeout(sweep, AFTER_DELETE_MS);
    soon.unref();
  });
  return () => {
    clearTimeout(first);
    clearInterval(every);
    if (soon) clearTimeout(soon);
    stopListening?.();
  };
}
