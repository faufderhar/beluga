import { execFile } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { claudeConfigDir, encodeProjectDir, pathVariants } from '../../agent/runtime/claude/claude-sessions.js';
import { MAX_DOWNLOAD_BYTES } from '../../protocol.js';
import { SCRATCH_DIR } from '../../shared/scratch-dir.js';
import { findEnvFiles, parseDotenv } from '../../workspaces/env.js';
import { git } from '../../workspaces/git.js';
import { isDenied } from '../shares.js';
import { CarryNote, type CarryPicks, FORK_NOTE, type ForkNote, NO_PICKS, plainLine } from '../../shared/fork-carry.js';
import { packCarry, placeCarry } from './carry.js';

/**
 * Forking a friend's worktree to your own Mac (BLG-312): a worktree of yours that starts where
 * theirs is now, with their uncommitted work, its Scratch and its conversation (Claude's own
 * session too, so your Claude remembers it). Their worktree stays as it is.
 *
 * The owner's Mac packs it into one file, `fork.tgz`, fetched over the friends' link as a copy's
 * bundle is (service.ts):
 *
 * - `fork.bundle`: a git bundle of the branch's last commit and, on top of it, a commit of the
 *   uncommitted work (made with an index of its own, so nothing in their worktree changes),
 *   without what the friend says they have already. None when they have all of it.
 * - `meta.json` (ForkMeta), `history.json` (the conversation), `session.jsonl` (Claude's session,
 *   the values of the worktree's .env files taken out), `scratch/` (its Scratch folder).
 * - `carry/`: what git ignores that its owner picked for forks to bring (carry.ts, BLG-1017), and
 *   in the meta's `carried`, what came and what stayed behind.
 *
 * Nothing else git ignores goes (node_modules, build output: the setup makes them again). Nor do
 * secrets (.env files, keys: `isDenied`), unless the owner ticked that very file in a pick.
 */

/** A file in Scratch bigger than this stays behind; so does the rest once they add up to `SCRATCH_MAX`. */
const SCRATCH_FILE_MAX = 50 * 1024 * 1024;
const SCRATCH_MAX = 120 * 1024 * 1024;
const SCRATCH_FILES = 2000;
/** What the friend may say they have (commits of theirs the bundle needn't carry). */
export const HAVE_MAX = 40;
const PACK_MS = 10 * 60_000;
const REF = 'refs/beluga-fork';
/** Who the commit of uncommitted work is by (it's never pushed: only its tree matters). */
const WORK_ENV = { GIT_AUTHOR_NAME: 'Beluga', GIT_AUTHOR_EMAIL: 'fork@beluga.local', GIT_COMMITTER_NAME: 'Beluga', GIT_COMMITTER_EMAIL: 'fork@beluga.local' };

const sha = z.string().regex(/^[0-9a-f]{40}$/);

export const ForkMeta = z.object({
  v: z.literal(1),
  id: z.string().regex(/^[\w-]{1,40}$/),
  name: z.string().max(200),
  branch: z.string().max(200),
  /** The branch's last commit, and the uncommitted work on top of it (when there's any). */
  tip: sha,
  work: sha.optional(),
  /** Uncommitted files in `work`, files in Scratch. */
  changed: z.number().int().min(0),
  scratch: z.number().int().min(0),
  sessionId: z.string().regex(/^[\w-]{1,100}$/).optional(),
  /** What git ignores that came along (under `carry/`), and what stayed behind. A Mac from before BLG-1017 sends none. */
  carried: CarryNote.optional(),
});
export type ForkMeta = z.infer<typeof ForkMeta>;

export const ForkHistory = z.array(z.object({ from: z.string().max(120), text: z.string().max(100_000), ts: z.number().int().min(0), byAgent: z.boolean() })).max(5000);
export type ForkHistory = z.infer<typeof ForkHistory>;

const run = (cmd: string, args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => execFile(cmd, [...args], { cwd, timeout: PACK_MS, maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve())));

/** How many bytes the files under `dir` take (no links followed). */
async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  const walk = async (at: string): Promise<void> => {
    for (const e of await fs.readdir(at, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(path.join(at, e.name));
      else if (e.isFile()) total += (await fs.stat(path.join(at, e.name)).catch(() => undefined))?.size ?? 0;
    }
  };
  await walk(dir);
  return total;
}

/** Files under `from` (no links, nothing hidden by isDenied), copied to `to`, within the limits. → how many. */
async function copyTree(from: string, to: string, budget = { bytes: SCRATCH_MAX, files: SCRATCH_FILES }): Promise<number> {
  let copied = 0;
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(path.join(from, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (isDenied(r)) continue;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) {
        const st = await fs.stat(path.join(from, r)).catch(() => undefined);
        if (!st || st.size > SCRATCH_FILE_MAX || st.size > budget.bytes || budget.files <= 0) continue;
        await fs.mkdir(path.dirname(path.join(to, r)), { recursive: true });
        await fs.copyFile(path.join(from, r), path.join(to, r));
        budget.bytes -= st.size;
        budget.files--;
        copied++;
      }
    }
  };
  await walk('');
  return copied;
}

/**
 * A commit of the worktree's uncommitted work (changed, deleted and new files git doesn't ignore,
 * never a secret nor Beluga's own folder) on top of `tip`, made with an index of its own.
 */
async function snapshotWork(dir: string, tip: string): Promise<{ sha?: string; changed: number }> {
  const list = async (args: string[]): Promise<string[]> => (await git(dir, args).catch(() => '')).split('\0').filter(Boolean);
  const listed = [...(await list(['diff', '--name-only', '-z', 'HEAD'])), ...(await list(['ls-files', '--others', '--exclude-standard', '-z']))];
  const files = [...new Set(listed)].filter((rel) => !isDenied(rel) && !/^\.(beluga|klaud)\//.test(rel));
  if (!files.length) return { changed: 0 };
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'beluga-fork-index-'));
  const env = { ...WORK_ENV, GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    await git(dir, ['read-tree', tip], 60_000, env);
    for (let i = 0; i < files.length; i += 200) await git(dir, ['--literal-pathspecs', 'add', '-A', '--', ...files.slice(i, i + 200)], PACK_MS, env);
    const tree = (await git(dir, ['write-tree'], 60_000, env)).trim();
    const commit = (await git(dir, ['commit-tree', '--no-gpg-sign', tree, '-p', tip, '-m', 'Uncommitted work, forked with Beluga'], 60_000, env)).trim();
    return { sha: commit, changed: files.length };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Claude Code's session for `dir`, with the values in the worktree's .env files taken out. */
function sessionText(dir: string, sessionId: string): string | undefined {
  if (!/^[\w-]{1,100}$/.test(sessionId)) return undefined;
  const projects = path.join(claudeConfigDir(), 'projects');
  const file = pathVariants(dir)
    .map((d) => path.join(projects, encodeProjectDir(d), `${sessionId}.jsonl`))
    .find((f) => existsSync(f));
  if (!file) return undefined;
  let text = readFileSync(file, 'utf8');
  const values = new Set<string>();
  for (const rel of findEnvFiles(dir)) {
    try {
      for (const v of parseDotenv(readFileSync(path.join(dir, rel), 'utf8')).values()) {
        const bare = v.trim().replace(/^(['"])(.*)\1$/, '$2');
        if (bare.length >= 6) values.add(bare);
      }
    } catch {
      // Not readable: nothing of it to take out.
    }
  }
  // Longest first, so a value inside another goes with it; as written and as JSON writes it.
  for (const v of [...values].sort((a, b) => b.length - a.length)) {
    for (const form of new Set([v, JSON.stringify(v).slice(1, -1)])) text = text.split(form).join('[secret]');
  }
  return text;
}

export interface PackInput {
  readonly id: string;
  /** The worktree's folder, name and branch. */
  readonly dir: string;
  readonly name: string;
  readonly branch: string;
  readonly sessionId?: string;
  readonly history: ForkHistory;
  /** Commits the friend has (the bundle leaves out what they reach). */
  readonly have: readonly string[];
  /** Where the pack goes (a fresh folder of its own). */
  readonly out: string;
  /** What git ignores that the owner picked for forks to bring (carry.ts). */
  readonly carry?: CarryPicks;
  /** The friend may have the secrets the owner ticked ("Can fork with secrets", BLG-1019); else they stay behind. */
  readonly secrets?: boolean;
}

/** Pack a worktree for a friend's fork. → `fork.tgz` in `out`, its size and what's in it. */
export async function packFork(input: PackInput): Promise<{ file: string; size: number; meta: ForkMeta }> {
  const { dir, out } = input;
  const stage = path.join(out, 'stage');
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  const tip = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const work = await snapshotWork(dir, tip);
  const refs = [`${REF}/${input.id}/tip`, ...(work.sha ? [`${REF}/${input.id}/work`] : [])];
  await git(dir, ['update-ref', refs[0]!, tip]);
  if (work.sha) await git(dir, ['update-ref', refs[1]!, work.sha]);
  try {
    // Only commits this Mac knows can be left out (a bundle can't stand on one it doesn't have).
    const known: string[] = [];
    for (const h of input.have.slice(0, HAVE_MAX)) if (/^[0-9a-f]{40}$/.test(h) && (await git(dir, ['cat-file', '-e', `${h}^{commit}`]).then(() => true, () => false))) known.push(h);
    const fresh = Number((await git(dir, ['rev-list', '--count', ...refs, ...known.map((h) => `^${h}`)])).trim());
    if (fresh > 0) await git(dir, ['bundle', 'create', path.join(stage, 'fork.bundle'), ...refs, ...known.map((h) => `^${h}`)], PACK_MS);
  } finally {
    for (const r of refs) await git(dir, ['update-ref', '-d', r]).catch(() => undefined);
  }
  const session = input.sessionId ? sessionText(dir, input.sessionId) : undefined;
  if (session) await fs.writeFile(path.join(stage, 'session.jsonl'), session, { mode: 0o600 });
  const scratch = existsSync(path.join(dir, SCRATCH_DIR)) ? await copyTree(path.join(dir, SCRATCH_DIR), path.join(stage, 'scratch')) : 0;
  // What's carried fits in what the pack has left (its commits, Scratch and session come first), with room to spare.
  const used = await sizeOf(stage);
  const picks = input.carry ?? NO_PICKS;
  const carried = await packCarry(dir, input.secrets ? picks : { ...picks, secrets: [] }, stage, Math.max(0, MAX_DOWNLOAD_BYTES * 0.9 - used));
  const meta: ForkMeta = { v: 1, id: input.id, name: input.name.slice(0, 200), branch: input.branch.slice(0, 200), tip, ...(work.sha ? { work: work.sha } : {}), changed: work.changed, scratch, ...(session && input.sessionId ? { sessionId: input.sessionId } : {}), carried };
  await fs.writeFile(path.join(stage, 'history.json'), JSON.stringify(input.history));
  await fs.writeFile(path.join(stage, 'meta.json'), JSON.stringify(meta));
  const file = path.join(out, 'fork.tgz');
  await run('tar', ['-czf', file, '-C', stage, '.'], out);
  await fs.rm(stage, { recursive: true, force: true });
  const size = (await fs.stat(file)).size;
  if (size > MAX_DOWNLOAD_BYTES) throw new Error('the worktree is too large to send this way');
  return { file: 'fork.tgz', size, meta };
}

/** Up to HAVE_MAX of a repository's newest branch tips (yours and origin's), for the owner to leave out of the bundle. */
export async function haveOf(root: string): Promise<string[]> {
  const out = await git(root, ['for-each-ref', '--sort=-committerdate', `--count=${HAVE_MAX}`, '--format=%(objectname)', 'refs/heads', 'refs/remotes']).catch(() => '');
  return [...new Set(out.split('\n').map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}$/.test(s)))];
}

export interface Unpacked {
  readonly dir: string;
  readonly meta: ForkMeta;
  readonly history: ForkHistory;
}

/** A fork's pack, opened in a folder of its own under `tmp` (removed by the caller). */
export async function unpackFork(bytes: Buffer, tmp: string): Promise<Unpacked> {
  const dir = path.join(tmp, 'fork');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(tmp, 'fork.tgz');
  await fs.writeFile(file, bytes, { mode: 0o600 });
  // tar keeps every name inside `dir` (no absolute paths, no ".."); links in it are never followed below.
  await run('tar', ['-xzf', file, '-C', dir], tmp);
  const meta = ForkMeta.parse(JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')));
  const history = ForkHistory.parse(JSON.parse(await fs.readFile(path.join(dir, 'history.json'), 'utf8').catch(() => '[]')));
  return { dir, meta, history };
}

/** Bring a fork's commits into the repository at `root` and make `branch` at its tip. */
export async function fetchFork(root: string, from: Unpacked, branch: string): Promise<void> {
  const { meta } = from;
  const bundle = path.join(from.dir, 'fork.bundle');
  const has = (c: string): Promise<boolean> => git(root, ['cat-file', '-e', `${c}^{commit}`]).then(() => true, () => false);
  if (existsSync(bundle)) await git(root, ['fetch', '--quiet', '--no-tags', '--', bundle, `+${REF}/${meta.id}/*:${REF}/${meta.id}/*`], PACK_MS);
  try {
    if (!(await has(meta.tip)) || (meta.work && !(await has(meta.work)))) throw new Error('its commits didn’t all come');
    await git(root, ['branch', '--no-track', '--', branch, meta.tip]);
  } finally {
    for (const r of ['tip', 'work']) await git(root, ['update-ref', '-d', `${REF}/${meta.id}/${r}`]).catch(() => undefined);
  }
}

/**
 * Into the new worktree at `dir`: the uncommitted work (left uncommitted, as it was), Scratch, what
 * git ignores that its owner sent (never over a file already here), Claude's session where Claude
 * Code looks for it, and `.beluga/fork.json`: what came and what stayed with `owner`, for its agent.
 */
export async function placeFork(dir: string, from: Unpacked, owner = 'its owner'): Promise<ForkNote> {
  const { meta } = from;
  if (meta.work) {
    await git(dir, ['read-tree', '-m', '-u', 'HEAD', meta.work]);
    await git(dir, ['reset', '-q']);
  }
  const scratch = path.join(from.dir, 'scratch');
  if (existsSync(scratch)) await copyTree(scratch, path.join(dir, SCRATCH_DIR));
  const session = path.join(from.dir, 'session.jsonl');
  if (meta.sessionId && existsSync(session)) {
    const target = path.join(claudeConfigDir(), 'projects', encodeProjectDir(path.resolve(dir)), `${meta.sessionId}.jsonl`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(session, target);
  }
  const carried = meta.carried ?? { sent: [], secrets: [], left: [] };
  const { kept, unplaced } = existsSync(path.join(from.dir, 'carry')) ? await placeCarry(from.dir, dir) : { kept: [], unplaced: [] };
  const note: ForkNote = {
    owner: plainLine(owner, 120),
    from: plainLine(meta.name, 200),
    at: Date.now(),
    scratch: meta.scratch,
    sent: carried.sent,
    secrets: carried.secrets.filter((s) => !kept.includes(s) && !unplaced.includes(s)),
    left: [...kept.map((p) => ({ path: p, why: 'there' as const })), ...unplaced.map((p) => ({ path: plainLine(p, 400), why: 'unplaced' as const })), ...carried.left].slice(0, 100),
  };
  await fs.mkdir(path.dirname(path.join(dir, FORK_NOTE)), { recursive: true });
  await fs.writeFile(path.join(dir, FORK_NOTE), JSON.stringify(note, null, 2));
  return note;
}
