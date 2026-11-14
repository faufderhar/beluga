import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { SCRATCH_DIR, SHOWN_SCRATCH_DIRS } from '../shared/scratch-dir.js';

/**
 * A workspace's scratch folder: where Claude keeps the screenshots, logs and intermediate output it
 * makes while it works (not the work itself). It lives in the workspace as `.beluga/scratch/`, kept
 * out of git through the repo's own exclude file (never a change to .gitignore), and the Mac app
 * shows it live (the panel's Scratch tab), together with the `.context/` folder Claude saves to
 * when another tool runs it in the same worktree (looked at, never written).
 */

export { SCRATCH_DIR, SHOWN_SCRATCH_DIRS };
const EXCLUDE_LINE = `/${SCRATCH_DIR}/`;
/** How many files the list shows, and how deep it looks. */
const MAX_FILES = 300;
const MAX_DEPTH = 4;

const run = promisify(execFile);

export interface ScratchFile {
  /** From the workspace's folder, e.g. `.beluga/scratch/shots/home.png`. */
  readonly path: string;
  readonly size: number;
  /** Last written (ms). */
  readonly mtime: number;
}

/** The repo's exclude file (a worktree shares its main checkout's), or undefined outside git. */
async function excludeFile(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--git-common-dir'], { cwd: dir, timeout: 5000 });
    return path.join(path.resolve(dir, stdout.trim()), 'info', 'exclude');
  } catch {
    return undefined;
  }
}

/** Each part of a folder's path inside the workspace is a real folder (or not there yet), never a link out. */
async function noLinks(dir: string, rel: string = SCRATCH_DIR): Promise<boolean> {
  let at = dir;
  for (const part of rel.split('/')) {
    at = path.join(at, part);
    const st = await fs.lstat(at).catch(() => undefined);
    if (st && !st.isDirectory()) return false; // a link (or a file) where the folder goes
  }
  return true;
}

/** Keeping each workspace's folder out of git, done once per process (two runs at once share it). */
const excluding = new Map<string, Promise<void>>();

async function excludeOnce(dir: string): Promise<void> {
  const exclude = await excludeFile(dir);
  if (!exclude) return;
  const current = await fs.readFile(exclude, 'utf8').catch(() => '');
  if (current.split('\n').some((l) => l.trim() === EXCLUDE_LINE)) return;
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  await fs.appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# beluga: Claude's scratch folder\n${EXCLUDE_LINE}\n`);
}

/** Make the folder and keep it out of git. Never throws: a run goes ahead without it. */
export async function ensureScratch(dir: string): Promise<string | undefined> {
  const scratch = path.join(dir, SCRATCH_DIR);
  try {
    if (!(await noLinks(dir))) return undefined;
    await fs.mkdir(scratch, { recursive: true });
    let job = excluding.get(dir);
    if (!job) {
      job = excludeOnce(dir);
      excluding.set(dir, job);
      job.catch(() => excluding.delete(dir));
    }
    await job;
    return scratch;
  } catch {
    return undefined;
  }
}

/** What's in the shown folders (Beluga's and `.context/`), newest first (no links followed). */
export async function listScratch(dir: string): Promise<ScratchFile[]> {
  const files: ScratchFile[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory() && depth < MAX_DEPTH) await walk(child, depth + 1);
      else if (e.isFile()) {
        const st = await fs.stat(path.join(dir, child)).catch(() => undefined);
        if (st) files.push({ path: child, size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    }
  };
  for (const rel of SHOWN_SCRATCH_DIRS) {
    if (await noLinks(dir, rel)) await walk(rel, 1);
  }
  return files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, MAX_FILES);
}

/** How much the shown folders hold, all of it (the list has only the newest MAX_FILES, a few deep). */
export interface ScratchTotal {
  readonly files: number;
  readonly bytes: number;
}

/** Each file under a folder, however deep (no links followed), with its size and when it was last written. */
async function eachFile(abs: string, seen: (size: number, mtime: number) => void): Promise<void> {
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const child = path.join(abs, e.name);
    if (e.isDirectory()) await eachFile(child, seen);
    else if (e.isFile()) {
      const st = await fs.lstat(child).catch(() => undefined);
      if (st) seen(st.size, st.mtimeMs);
    }
  }
}

/** A count is kept this long: the tab asks every moment, and a folder can hold thousands of files. */
const TOTAL_TTL_MS = 15_000;
const totals = new Map<string, { readonly at: number; readonly total: Promise<ScratchTotal> }>();

/** Everything in the shown folders, counted (at most every TOTAL_TTL_MS for each workspace). */
export function scratchTotal(dir: string, now = Date.now()): Promise<ScratchTotal> {
  const kept = totals.get(dir);
  if (kept && now - kept.at < TOTAL_TTL_MS) return kept.total;
  const total = (async (): Promise<ScratchTotal> => {
    let files = 0;
    let bytes = 0;
    for (const rel of SHOWN_SCRATCH_DIRS) {
      if (await noLinks(dir, rel))
        await eachFile(path.join(dir, rel), (size) => {
          files += 1;
          bytes += size;
        });
    }
    return { files, bytes };
  })();
  totals.set(dir, { at: now, total });
  total.catch(() => totals.delete(dir));
  return total;
}

/**
 * How long Your Mac's scratch keeps what its Claude saved: untouched this long, it goes to the Trash on
 * its own (a worktree's scratch goes with the worktree when it's archived; Your Mac's never would).
 */
export const SCRATCH_KEEP_MS = 30 * 86_400_000;

/** When a file, or a folder and everything in it, was last written: the newest time in it. */
async function lastWritten(abs: string): Promise<number> {
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return Number.POSITIVE_INFINITY; // gone already, or can't be read: left alone
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    await eachFile(abs, (_size, mtime) => {
      newest = Math.max(newest, mtime);
    });
  }
  return newest;
}

export interface TidyOptions {
  readonly keepMs?: number;
  readonly now?: number;
  /** Where an old one goes (the Trash: it can be put back). */
  readonly trash: (abs: string) => Promise<void>;
}

/**
 * Put what's in Beluga's own scratch folder (never `.context/`) and untouched for `keepMs` in the
 * Trash, each top-level file or folder whole, judged by the newest thing in it → the names that went.
 * One that won't go stays for the next time.
 */
export async function tidyScratch(dir: string, opts: TidyOptions): Promise<string[]> {
  if (!(await noLinks(dir))) return [];
  const scratch = path.join(dir, SCRATCH_DIR);
  const cutoff = (opts.now ?? Date.now()) - (opts.keepMs ?? SCRATCH_KEEP_MS);
  const entries = await fs.readdir(scratch).catch(() => [] as string[]);
  const gone: string[] = [];
  for (const name of entries.sort()) {
    const abs = path.join(scratch, name);
    if ((await lastWritten(abs)) >= cutoff) continue;
    try {
      await opts.trash(abs);
      gone.push(name);
    } catch {
      // Still there: tried again at the next tidy.
    }
  }
  totals.delete(dir);
  return gone;
}

/**
 * Copy one workspace's scratch folder into another's (a fork gets everything its source made), as
 * clones where the disk can (APFS: instant, no space used). Links are left behind, never followed;
 * nothing there yet copies nothing. Resolves whether there was a folder to copy.
 */
export async function copyScratch(fromDir: string, toDir: string): Promise<boolean> {
  const from = path.join(fromDir, SCRATCH_DIR);
  const st = await fs.lstat(from).catch(() => undefined);
  if (!st?.isDirectory() || !(await noLinks(fromDir)) || !(await noLinks(toDir))) return false;
  await fs.cp(from, path.join(toDir, SCRATCH_DIR), {
    recursive: true,
    mode: fsConstants.COPYFILE_FICLONE,
    errorOnExist: false,
    force: false,
    filter: async (src) => !(await fs.lstat(src).catch(() => undefined))?.isSymbolicLink(),
  });
  totals.delete(toDir);
  return true;
}

/**
 * Delete a conversation's copies of what was sent to it (`rel`, from the folder's root: see
 * core/sent-files.ts), when the conversation goes but its folder stays. Never through a link.
 */
export async function dropSent(dir: string, rel: string): Promise<void> {
  if (!rel.startsWith(`${SCRATCH_DIR}/`) || !(await noLinks(dir, rel))) return;
  await fs.rm(path.join(dir, rel), { recursive: true, force: true });
  totals.delete(dir);
}
