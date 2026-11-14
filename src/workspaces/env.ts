import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Files and folders that hold local secrets/config and aren't in git, copied into new worktrees:
 * `.env*`, direnv's `.envrc` and Wrangler's `.dev.vars` (all KEY=VALUE), and `.ssh`/`.aws` folders.
 * A `.worktreeinclude` at the root (gitignore patterns, as Claude Code reads it) adds any others.
 */
const ENV_FILE = /^(\.env(\..+)?|\.envrc|\.dev\.vars(\..+)?)$/;
const ENV_DIRS = new Set(['.ssh', '.aws']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.beluga', '.klaud', '.klaude', '.next', 'vendor']);
const MAX_DEPTH = 3;
const INCLUDE_FILE = '.worktreeinclude';

/** A file name env.ts calls an env file (`.env.example` and other templates aren't). */
export const isEnvFileName = (name: string): boolean => ENV_FILE.test(name) && !/\.(example|sample|template)$/.test(name);

const LS_OPTS = { encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024 } as const;
const lsArgs = (args: readonly string[]): string[] => ['ls-files', '--others', '-z', ...args];
const listedFiles = (out: string): string[] => out.split('\0').filter((f) => f && !f.endsWith('/'));

/** Untracked files git lists in a checkout (none when it isn't one, or git can't say). */
function untracked(root: string, args: readonly string[]): string[] {
  try {
    return listedFiles(execFileSync('git', lsArgs(args), { ...LS_OPTS, cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return [];
  }
}

/** The same, without holding up the daemon while git looks. */
function untrackedAsync(root: string, args: readonly string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const child = execFile('git', lsArgs(args), { ...LS_OPTS, cwd: root }, (err, out) => resolve(err ? [] : listedFiles(out)));
    child.stdin?.end();
  });
}

/** Relative paths of env files (files inside .ssh/.aws folders, and what .worktreeinclude names) in a checkout. */
export function findEnvFiles(root: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string, rel: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && isEnvFileName(e.name)) found.add(relPath);
      else if (e.isDirectory() && ENV_DIRS.has(e.name)) {
        for (const f of readdirSync(path.join(dir, e.name), { withFileTypes: true })) if (f.isFile()) found.add(`${relPath}/${f.name}`);
      } else if (e.isDirectory() && depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), relPath, depth + 1);
    }
  };
  walk(root, '', 0);
  // Deeper than the walk goes (a monorepo's apps/web/config/local/.env): git lists the ignored files (ignored folders
  // like node_modules folded into one line) and the untracked ones it doesn't ignore.
  const listed = [...untracked(root, ['--ignored', '--exclude-standard', '--directory']), ...untracked(root, ['--exclude-standard'])];
  const included = existsSync(path.join(root, INCLUDE_FILE)) ? untracked(root, ['--ignored', `--exclude-from=${INCLUDE_FILE}`]) : [];
  return withListed(found, listed, included);
}

/** What git listed, added to what the walk found → the sorted list. */
function withListed(found: Set<string>, listed: readonly string[], included: readonly string[]): string[] {
  const skipped = (rel: string) => rel.split('/').slice(0, -1).some((d) => SKIP_DIRS.has(d));
  for (const rel of listed) if (isEnvFileName(path.posix.basename(rel)) && !skipped(rel)) found.add(rel);
  for (const rel of included) if (!skipped(rel)) found.add(rel);
  return [...found].sort();
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

/** findEnvFiles without holding up the daemon (BLG-406): git's lists are made while the folders are walked. */
async function readEnvFiles(root: string): Promise<string[]> {
  const found = new Set<string>();
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // One folder at a time, as findEnvFiles goes (a big checkout never fills the disk queue the rest of Beluga waits on).
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && isEnvFileName(e.name)) found.add(relPath);
      else if (e.isDirectory() && ENV_DIRS.has(e.name)) {
        for (const f of await readdir(path.join(dir, e.name), { withFileTypes: true })) if (f.isFile()) found.add(`${relPath}/${f.name}`);
      } else if (e.isDirectory() && depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), relPath, depth + 1);
    }
  };
  const [, ignored, others, included] = await Promise.all([
    walk(root, '', 0),
    untrackedAsync(root, ['--ignored', '--exclude-standard', '--directory']),
    untrackedAsync(root, ['--exclude-standard']),
    exists(path.join(root, INCLUDE_FILE)).then((has) => (has ? untrackedAsync(root, ['--ignored', `--exclude-from=${INCLUDE_FILE}`]) : [])),
  ]);
  return withListed(found, [...ignored, ...others], included);
}

interface EnvScan {
  readonly running: Promise<string[]>;
  next?: Promise<string[]>;
}

/** Per folder: the scan running now, and the one queued behind it. */
const envScans = new Map<string, EnvScan>();

/**
 * The same list as findEnvFiles, without blocking the daemon, and never two scans of one folder
 * at once (BLG-406): a call while one runs gets one more after it (what's running may have looked
 * before the call's change), and every call meanwhile shares that one.
 */
export function scanEnvFiles(root: string): Promise<string[]> {
  const now = envScans.get(root);
  if (!now) return startScan(root);
  now.next ??= now.running.catch(() => undefined).then(() => startScan(root));
  return now.next;
}

function startScan(root: string): Promise<string[]> {
  const scan: EnvScan = { running: readEnvFiles(root) };
  envScans.set(root, scan);
  const done = (): void => {
    // The one queued behind it takes its place itself.
    if (envScans.get(root) === scan && !scan.next) envScans.delete(root);
  };
  scan.running.then(done, done);
  return scan.running;
}

/** Copy env files from the main folder into a new worktree (only ones the worktree doesn't have). */
export async function copyEnvFiles(from: string, to: string): Promise<string[]> {
  const copied: string[] = [];
  for (const rel of await scanEnvFiles(from)) {
    const target = path.join(to, rel);
    if (existsSync(target)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(from, rel), target, { recursive: true, preserveTimestamps: true });
    copied.push(rel);
  }
  return copied;
}

const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const hashAsync = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');

/** Fingerprint of every env file in a folder, taken when the worktree is created. */
export async function envSnapshot(dir: string): Promise<Record<string, string>> {
  const files = await scanEnvFiles(dir);
  const out: Record<string, string> = {};
  for (const rel of files) out[rel] = await hashAsync(path.join(dir, rel));
  return out;
}

export interface EnvChange {
  readonly file: string;
  /** For KEY=VALUE files: key names that were added, changed or removed (values are never shown). */
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  /** Not a KEY=VALUE file (e.g. a key in .ssh): the whole file differs. */
  readonly binary: boolean;
}

export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line);
    if (m?.[1]) out.set(m[1], m[2] ?? '');
  }
  return out;
}

/**
 * What changed in a worktree's env files compared with the main folder. `kept`: files you said
 * stay in the worktree, by their hash then (left out until they change again).
 */
export function envChanges(worktree: string, main: string, snapshot: Readonly<Record<string, string>> = {}, kept: Readonly<Record<string, string>> = {}): EnvChange[] {
  const changes: EnvChange[] = [];
  for (const rel of findEnvFiles(worktree)) {
    const file = path.join(worktree, rel);
    const now = hash(file);
    if (snapshot[rel] === now || kept[rel] === now) continue; // untouched since creation, or kept here as it is
    const mainFile = path.join(main, rel);
    const isDotenv = ENV_FILE.test(path.basename(rel));
    if (!isDotenv) {
      if (!existsSync(mainFile) || hash(mainFile) !== hash(file)) changes.push({ file: rel, added: [], changed: [], removed: [], binary: true });
      continue;
    }
    const mine = parseDotenv(readFileSync(file, 'utf8'));
    const theirs = existsSync(mainFile) ? parseDotenv(readFileSync(mainFile, 'utf8')) : new Map<string, string>();
    const change = keyChange(rel, mine, theirs);
    if (change) changes.push(change);
  }
  return changes;
}

/** A KEY=VALUE file's keys added, changed and removed against the main folder's (none: in step). */
function keyChange(file: string, mine: Map<string, string>, theirs: Map<string, string>): EnvChange | undefined {
  const added = [...mine.keys()].filter((k) => !theirs.has(k));
  const changed = [...mine.keys()].filter((k) => theirs.has(k) && theirs.get(k) !== mine.get(k));
  const removed = [...theirs.keys()].filter((k) => !mine.has(k));
  return added.length || changed.length || removed.length ? { file, added, changed, removed, binary: false } : undefined;
}

/**
 * envChanges without blocking the daemon (BLG-406), for the checks that run on their own. `files`:
 * the worktree's env files when they were just listed (else they're listed now). Same answer.
 */
export async function envChangesAsync(
  worktree: string,
  main: string,
  snapshot: Readonly<Record<string, string>> = {},
  kept: Readonly<Record<string, string>> = {},
  files?: readonly string[],
): Promise<EnvChange[]> {
  const changes: EnvChange[] = [];
  for (const rel of files ?? (await scanEnvFiles(worktree))) {
    const file = path.join(worktree, rel);
    const now = await hashAsync(file);
    if (snapshot[rel] === now || kept[rel] === now) continue;
    const mainFile = path.join(main, rel);
    const there = await exists(mainFile);
    if (!ENV_FILE.test(path.basename(rel))) {
      if (!there || (await hashAsync(mainFile)) !== now) changes.push({ file: rel, added: [], changed: [], removed: [], binary: true });
      continue;
    }
    const mine = parseDotenv(await readFile(file, 'utf8'));
    const theirs = there ? parseDotenv(await readFile(mainFile, 'utf8')) : new Map<string, string>();
    const change = keyChange(rel, mine, theirs);
    if (change) changes.push(change);
  }
  return changes;
}

/**
 * Bring the main folder's env changes into a worktree: a file the worktree never touched (it still
 * has the copy it was made with) follows the main folder's, and one new there is copied in. One
 * changed in the worktree, or deleted there, is left alone. → the files updated and the new snapshot.
 */
export function followMainEnv(worktree: string, main: string, snapshot: Readonly<Record<string, string>> = {}, mainFiles: readonly string[] = findEnvFiles(main)): { updated: string[]; snapshot: Record<string, string> } {
  const next = { ...snapshot };
  const updated: string[] = [];
  for (const rel of mainFiles) {
    const src = path.join(main, rel);
    const dst = path.join(worktree, rel);
    let theirs: string;
    try {
      if (!statSync(src).isFile()) continue;
      theirs = hash(src);
    } catch {
      continue;
    }
    const here = existsSync(dst) ? hash(dst) : undefined;
    if (here === theirs) {
      next[rel] = theirs;
      continue;
    }
    const untouched = here === undefined ? !(rel in snapshot) : snapshot[rel] === here;
    if (!untouched) continue;
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(src, dst, { preserveTimestamps: true });
    next[rel] = theirs;
    updated.push(rel);
  }
  return { updated, snapshot: next };
}

/** followMainEnv without blocking the daemon (BLG-406): `mainFiles` as the main folder's scan listed them. Same result. */
export async function followMainEnvAsync(worktree: string, main: string, snapshot: Readonly<Record<string, string>>, mainFiles: readonly string[]): Promise<{ updated: string[]; snapshot: Record<string, string> }> {
  const next = { ...snapshot };
  const updated: string[] = [];
  for (const rel of mainFiles) {
    const src = path.join(main, rel);
    const dst = path.join(worktree, rel);
    let theirs: string;
    try {
      if (!(await stat(src)).isFile()) continue;
      theirs = await hashAsync(src);
    } catch {
      continue;
    }
    const here = (await exists(dst)) ? await hashAsync(dst) : undefined;
    if (here === theirs) {
      next[rel] = theirs;
      continue;
    }
    const untouched = here === undefined ? !(rel in snapshot) : snapshot[rel] === here;
    if (!untouched) continue;
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(src, dst, { preserveTimestamps: true });
    next[rel] = theirs;
    updated.push(rel);
  }
  return { updated, snapshot: next };
}

/** The hashes of these files in a folder now (missing ones left out). */
export function envHashes(dir: string, files: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of files) {
    try {
      out[rel] = hash(path.join(dir, rel));
    } catch {
      // gone
    }
  }
  return out;
}

/**
 * Bring a worktree's env changes back into the main folder: changed and added keys are
 * written into the main file (keeping its other keys and comments); other files are copied.
 * Removed keys are left alone, so nothing in the main folder is deleted by surprise, unless
 * `removed` says to take them out too (you ticked it, archiving or deleting the worktree).
 */
export function applyEnvChanges(worktree: string, main: string, changes: readonly EnvChange[], opts: { readonly removed?: boolean } = {}): void {
  for (const c of changes) {
    const src = path.join(worktree, c.file);
    const dst = path.join(main, c.file);
    if (c.binary || !existsSync(dst)) {
      cpSync(src, dst, { recursive: true });
      continue;
    }
    const mine = parseDotenv(readFileSync(src, 'utf8'));
    const lines = readFileSync(dst, 'utf8').split('\n');
    const keys = new Set([...c.added, ...c.changed]);
    const gone = new Set(opts.removed ? c.removed : []);
    const updated = lines.filter((line) => !gone.has(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/.exec(line)?.[1] ?? '')).map((line) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/.exec(line);
      const key = m?.[1];
      if (key && keys.has(key)) {
        keys.delete(key);
        return `${key}=${mine.get(key) ?? ''}`;
      }
      return line;
    });
    const appended = [...keys].map((k) => `${k}=${mine.get(k) ?? ''}`);
    const body = [...updated.filter((l, i) => !(i === updated.length - 1 && l === '' && appended.length)), ...appended].join('\n');
    writeFileSync(dst, body.endsWith('\n') ? body : `${body}\n`, { mode: statSync(dst).mode });
  }
}
