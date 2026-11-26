import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GIT_IN_ENGLISH } from './git.js';

/**
 * The git side of a smart archive (archive.ts): running git and tar, the checks that keep it
 * from losing anything (a merge in progress, a submodule's local work), and the snapshot commit
 * of a folder as it is.
 */

/** git add and read-tree on a big folder can take a while; packing much longer. */
export const LONG_MS = 10 * 60_000;
export const TAR_TIMEOUT_MS = 30 * 60_000;
/** Commits need a name; yours when git has one. */
const IDENTITY = { GIT_AUTHOR_NAME: 'Beluga', GIT_AUTHOR_EMAIL: 'beluga@localhost', GIT_COMMITTER_NAME: 'Beluga', GIT_COMMITTER_EMAIL: 'beluga@localhost' };

export class ArchiveError extends Error {}

/**
 * Files byte for byte: no .gitattributes (line endings, filters like LFS) and no autocrlf, both
 * when the snapshot is made and when it's written back (attributes from git's empty tree).
 */
export const RAW_ENV: Partial<NodeJS.ProcessEnv> = { GIT_ATTR_SOURCE: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' };
export const RAW_ARGS = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'] as const;

export function run(cmd: string, args: readonly string[], opts: { cwd: string; env?: Partial<NodeJS.ProcessEnv>; timeoutMs?: number; input?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...GIT_IN_ENGLISH, GIT_TERMINAL_PROMPT: '0', ...opts.env } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export const git = (cwd: string, args: readonly string[], env?: Partial<NodeJS.ProcessEnv>, timeoutMs?: number): Promise<string> => run('git', args, { cwd, ...(env ? { env } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
/** Paths given to git as they are (a "[" or "*" in a name is just a character). */
export const gitLiteral = (cwd: string, args: readonly string[]): Promise<string> => git(cwd, ['--literal-pathspecs', ...args]);
export const tryGit = (cwd: string, args: readonly string[]): Promise<string | undefined> => git(cwd, args).then((s) => s.trim(), () => undefined);

/** Ignored files and folders (a folder git ignores whole is one entry, ending in "/"). */
export async function ignoredIn(dir: string): Promise<string[]> {
  return (await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], undefined, LONG_MS)).split('\0').filter(Boolean);
}

/** `git check-ignore -v` over these paths (exit 1 is "none of them": not a failure). */
function checkIgnore(dir: string, rels: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['check-ignore', '-v', '-z', '--stdin'], { cwd: dir, timeout: LONG_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as { code?: unknown }).code !== 1) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
    child.stdin?.end(rels.join('\0'));
  });
}

/**
 * Of these ignored paths, the ones the project itself ignores (a .gitignore in the repo), not
 * only your own global ignore file or .git/info/exclude: only those can be throwaway.
 */
export async function ignoredByProject(dir: string, rels: readonly string[]): Promise<Set<string>> {
  if (!rels.length) return new Set();
  const out = await checkIgnore(dir, rels.map((r) => r.replace(/\/$/, '')));
  const fields = out.split('\0');
  const mine = new Set<string>();
  // source, line, pattern, path: four fields each.
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const source = fields[i]!;
    const pattern = fields[i + 2]!;
    const rel = fields[i + 3]!;
    // A negated pattern ("!keep") matched last: not ignored by it at all.
    if (pattern.startsWith('!') || path.isAbsolute(source) || source.includes('.git/') || !source.endsWith('.gitignore')) continue;
    mine.add(rel);
  }
  return new Set(rels.filter((r) => mine.has(r.replace(/\/$/, ''))));
}

/** Refuse when git is in the middle of something the folder's own git data holds (it goes with the folder). */
export async function assertSettled(dir: string): Promise<void> {
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
  const busy: Array<[string, string]> = [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['BISECT_LOG', 'a bisect'],
  ];
  const found = busy.find(([f]) => existsSync(path.join(gitDir, f)));
  if (found) throw new ArchiveError(`It’s in the middle of ${found[1]}. Finish or abort it first, then archive.`);
}

/** Folders that are git repos of their own, in a git index (mode 160000 entries). */
async function gitlinks(dir: string, env?: Partial<NodeJS.ProcessEnv>): Promise<string[]> {
  const out = await git(dir, ['ls-files', '--stage', '-z'], env, LONG_MS);
  return out
    .split('\0')
    .filter((l) => l.startsWith('160000 '))
    .map((l) => l.slice(l.indexOf('\t') + 1));
}

/** The submodules checked out in a folder. */
export async function submodulesIn(dir: string): Promise<string[]> {
  return (await gitlinks(dir)).filter((p) => existsSync(path.join(dir, p, '.git')));
}

/**
 * What in a submodule only lives here (its git data is in the worktree's git folder, which goes
 * with it): changes, a stash, a branch or commits no remote has. Fails closed: git can't tell → refuse.
 */
export async function submoduleOnlyHere(at: string): Promise<string | undefined> {
  if ((await git(at, ['status', '--porcelain'])).trim()) return 'uncommitted changes';
  if ((await git(at, ['stash', 'list'])).trim()) return 'a stash';
  const branches = (await git(at, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).split('\n').filter(Boolean);
  for (const ref of ['HEAD', ...branches]) if ((await git(at, ['rev-list', '-n', '1', ref, '--not', '--remotes'])).trim()) return ref === 'HEAD' ? 'commits that aren’t pushed' : `the branch ${ref.replace('refs/heads/', '')}, which no remote has`;
  return undefined;
}

/** Untracked folders git lists whole (folders ending in "/"), for empty ones and repos inside. */
export async function untrackedDirs(dir: string): Promise<string[]> {
  return (await git(dir, ['ls-files', '--others', '--exclude-standard', '--directory', '-z'], undefined, LONG_MS)).split('\0').filter((r) => r.endsWith('/'));
}

/** Files' sizes and times under these paths, as one hash (the same twice: nothing in them changed). */
export function fingerprint(dir: string, rels: readonly string[]): string {
  const h = createHash('sha1');
  const walk = (rel: string): void => {
    const st = lstatSync(path.join(dir, rel), { throwIfNoEntry: false });
    if (!st) return void h.update(`${rel}\0gone\n`);
    h.update(`${rel}\0${st.size}\0${st.mtimeMs}\0${st.mode}\n`);
    if (st.isDirectory()) for (const name of readdirSync(path.join(dir, rel)).sort()) walk(path.join(rel, name));
  };
  for (const rel of [...rels].sort()) walk(rel.replace(/\/$/, ''));
  return h.digest('hex');
}

/** Your name for the snapshot commit when git has one, else Beluga's. */
async function identity(dir: string): Promise<Partial<NodeJS.ProcessEnv>> {
  const name = await tryGit(dir, ['config', 'user.name']);
  const email = await tryGit(dir, ['config', 'user.email']);
  return name && email ? {} : IDENTITY;
}

export interface Snapshot {
  readonly commit: string;
  readonly tree: string;
  readonly head?: string;
  /** Git repos of yours inside the folder that aren't submodules (their files and history go in the packed file). */
  readonly nested: readonly string[];
}

/**
 * The folder as it is, as a commit: its tree has every file git doesn't ignore (changed, new
 * or deleted), its second parent's tree is the staging. Nothing in the folder changes.
 */
export async function snapshot(dir: string, message: string): Promise<Snapshot> {
  const env = await identity(dir);
  const head = await tryGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const parents = head ? ['-p', head] : [];
  const submodules = new Set(await gitlinks(dir));
  // Staging: unmerged files can't be written as a tree; then it's the same as the folder.
  const staged = await tryGit(dir, ['write-tree']);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'beluga-archive-'));
  try {
    const temp = { ...env, ...RAW_ENV, GIT_INDEX_FILE: path.join(tmp, 'index') };
    await git(dir, head ? ['read-tree', head] : ['read-tree', '--empty'], temp, LONG_MS);
    await git(dir, [...RAW_ARGS, '-c', 'advice.addEmbeddedRepo=false', 'add', '-A', '--', '.'], temp, LONG_MS);
    const tree = (await git(dir, ['write-tree'], temp, LONG_MS)).trim();
    // A repo inside that isn't a submodule: git only notes it's there, so it's packed whole.
    const nested = (await gitlinks(dir, temp)).filter((p) => !submodules.has(p));
    const stagedCommit = (await git(dir, ['commit-tree', staged ?? tree, ...parents, '-m', `${message} (staged)`], env)).trim();
    const commit = (await git(dir, ['commit-tree', tree, ...parents, '-p', stagedCommit, '-m', message], env)).trim();
    return { commit, tree, nested, ...(head ? { head } : {}) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Which tar this is: macOS's bsdtar (libarchive) or GNU tar (Linux). They differ in how xz's level
 * is set and in what `-k` does with a file that's there (bsdtar skips it, GNU tar fails).
 */
let flavor: Promise<'bsd' | 'gnu'> | undefined;
export function tarFlavor(): Promise<'bsd' | 'gnu'> {
  flavor ??= run('tar', ['--version'], { cwd: os.tmpdir() }).then(
    (v) => (/GNU tar/i.test(v) ? 'gnu' : 'bsd'),
    () => 'bsd',
  );
  return flavor;
}

/** Unpack `file` into `dir`, keeping every file that's already there (both tars, the same way). */
export async function unpackKeeping(file: string, dir: string): Promise<void> {
  const keep = (await tarFlavor()) === 'gnu' ? '--skip-old-files' : '-k';
  await run('tar', ['-x', keep, '-p', '-f', file, '-C', dir], { cwd: dir, timeoutMs: TAR_TIMEOUT_MS });
}

/**
 * xz's own default: within a few percent of its smallest (9), several times faster, and about
 * 94 MB of memory to compress instead of 674 MB.
 */
const XZ_LEVEL = 6;

/** Pack these (relative) paths of `dir` into an xz file, and check every one is in it. */
export async function pack(dir: string, rels: readonly string[], file: string): Promise<void> {
  const names = rels.map((r) => r.replace(/\/$/, ''));
  const list = `${file}.list`;
  writeFileSync(list, names.join('\0'));
  try {
    // bsdtar takes xz's level as an option; GNU tar runs xz, which reads it from XZ_OPT.
    const gnu = (await tarFlavor()) === 'gnu';
    const level = gnu ? [] : ['--options', `xz:compression-level=${XZ_LEVEL}`];
    await run('tar', ['-c', '-J', ...level, '-f', file, '-C', dir, '--null', '-T', list], { cwd: dir, timeoutMs: TAR_TIMEOUT_MS, ...(gnu ? { env: { XZ_OPT: `-${XZ_LEVEL}` } } : {}) });
    const listed = new Set((await run('tar', ['-t', '-f', file], { cwd: dir, timeoutMs: TAR_TIMEOUT_MS })).split(/\r?\n/).map((l) => l.replace(/\/$/, '')));
    const missing = names.find((n) => !listed.has(n));
    if (missing) throw new ArchiveError(`Couldn’t pack ${missing}`);
  } finally {
    rmSync(list, { force: true });
  }
}
