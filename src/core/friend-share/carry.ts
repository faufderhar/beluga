import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from '../../net/mesh/files.js';
import { git } from '../../workspaces/git.js';
import { isSecretPath } from '../shares.js';
import { CANDIDATES, CARRY_FILE_MAX, CARRY_FILES, CARRY_MAX, CARRY_WARN, type CarryCandidate, type CarryFile, type CarryNote, type CarryPicks, CarryPicks as CarryPicksSchema, type CarryPreview, FORK_NOTE, ForkNote, LISTED, type LeftWhy, NEVER_INTO, NOTED, REGENERATED, relPath } from '../../shared/fork-carry.js';

export { type CarryNote, type CarryPicks, type CarryPreview, FORK_NOTE, type ForkNote, NO_PICKS } from '../../shared/fork-carry.js';

/**
 * What a fork brings besides its commits, Scratch and conversation (BLG-1017): files git ignores
 * that the worktree's work relies on (`.context/`, benchmark docs, a key a script reads), picked
 * by its owner ahead of time in Share › What Forks Bring. Nothing git ignores goes unless picked,
 * and a secret-looking file inside a pick only goes once its owner ticks that very file.
 *
 * The pack carries them under `carry/` and its meta says what came and what stayed behind (and
 * why); the friend's Mac places them in the new worktree, never over a file already there, and
 * writes `.beluga/fork.json` so its agent knows what to ask for instead of failing mid-run.
 */

/**
 * A secret-looking name beyond isSecretPath's (`typesafe.env`, `service-account.json`, `.envrc`,
 * `api-token.txt`, Terraform's variables and state), and databases, which tend to hold customer data.
 */
const SECRETISH = [/\.env$/i, /^\.envrc$/i, /\.(p8|ppk|kdbx|gpg|asc|tfvars|tfstate|sqlite3?|db)$/i, /^(\.htpasswd|\.my\.cnf|\.dockercfg|auth\.json|kubeconfig)$/i,/(^|[._-])(secrets?|tokens?|credentials?|passwords?|service[-_]?account|private[-_]?key|api[-_]?keys?)([._-]|$)/i];

/** Whether a file in a pick looks like a secret (it only goes when ticked). */
export function looksSecret(rel: string): boolean {
  const base = rel.split(/[\\/]/).at(-1) ?? '';
  return isSecretPath(rel) || SECRETISH.some((re) => re.test(base));
}

interface Walked {
  readonly path: string;
  readonly bytes: number;
}

/** In a folder nothing is carried from or into (whatever its case: the Mac's disk ignores it). */
const forbidden = (rel: string): boolean => rel.split('/').some((s) => NEVER_INTO.has(s.toLowerCase()));

/** Whether `rel` in `root` is reached without going through a link (its real path is the path itself). */
async function direct(root: string, rel: string): Promise<boolean> {
  const realRoot = await fs.realpath(root).catch(() => '');
  const real = await fs.realpath(path.join(root, rel)).catch(() => '');
  return Boolean(realRoot && real) && real.toLowerCase() === path.join(realRoot, rel).toLowerCase();
}

/** Files under `rel` in `root` (no links, on the way to it either; `guard`: nothing in git's or Beluga's folders), at most `max`. */
async function walk(root: string, rel: string, max = CARRY_FILES * 2, guard = true): Promise<Walked[]> {
  const out: Walked[] = [];
  const start = rel.replace(/\/+$/, '');
  if (start !== '.' && !(await direct(root, start))) return out;
  const visit = async (r: string): Promise<void> => {
    if (out.length >= max || (guard && forbidden(r))) return;
    const st = await fs.lstat(path.join(root, r)).catch(() => undefined);
    if (!st) return;
    if (st.isFile()) {
      out.push({ path: r, bytes: st.size });
      return;
    }
    if (!st.isDirectory()) return;
    const entries = await fs.readdir(path.join(root, r)).catch(() => [] as string[]);
    for (const name of entries.sort()) await visit(`${r}/${name}`);
  };
  await visit(start);
  return out;
}

/** What git ignores in `dir` that someone might want to bring (top-most ignored paths, nothing the setup makes again). */
async function ignoredPaths(dir: string): Promise<string[]> {
  const out = await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']).catch(() => '');
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => !p.replace(/\/$/, '').split('/').some((s) => REGENERATED.has(s)) && !p.endsWith('.log'))
    .slice(0, CANDIDATES);
}

const bare = (p: string): string => p.replace(/\/+$/, '');
const within = (file: string, pick: string): boolean => file === bare(pick) || file.startsWith(`${bare(pick)}/`);

/** The picks still worth keeping: paths still ignored here (none inside another), secrets inside one of them. */
function livePicks(picks: CarryPicks, candidates: readonly string[]): CarryPicks {
  const there = [...new Set(picks.paths)].filter((p) => !forbidden(bare(p)) && candidates.some((c) => bare(c) === bare(p) || within(bare(p), c)));
  const paths = there.filter((p, i) => !there.some((q, j) => j !== i && (bare(q) === bare(p) ? j < i : within(bare(p), q))));
  return { paths, secrets: picks.secrets.filter((s) => paths.some((p) => within(s, p))) };
}

interface Plan {
  readonly files: CarryFile[];
  readonly bytes: number;
  readonly count: number;
}

/** How long a file's path may be to be said in a pack's note (a friend's Mac refuses longer ones). */
const NOTE_PATH = 400;

/** Which of the picks' files go: secrets only when ticked, each under CARRY_FILE_MAX, all under `budget`. */
function plan(all: readonly Walked[], picks: CarryPicks, budget = CARRY_MAX): Plan {
  const ticked = new Set(picks.secrets);
  let bytes = 0;
  let count = 0;
  const files = all.map((f): CarryFile => {
    const secret = looksSecret(f.path);
    const base = { path: f.path, bytes: f.bytes, ...(secret ? { secret: true as const } : {}) };
    if (secret && !ticked.has(f.path)) return { ...base, goes: false, why: 'secret' };
    if (f.bytes > CARRY_FILE_MAX) return { ...base, goes: false, why: 'big' };
    if (bytes + f.bytes > budget || count >= CARRY_FILES || f.path.length > NOTE_PATH) return { ...base, goes: false, why: 'limit' };
    bytes += f.bytes;
    count++;
    return { ...base, goes: true };
  });
  return { files, bytes, count };
}

async function pickedFiles(dir: string, picks: CarryPicks): Promise<Walked[]> {
  const seen = new Set<string>();
  const all: Walked[] = [];
  for (const p of picks.paths) for (const f of await walk(dir, p)) if (!seen.has(f.path)) (seen.add(f.path), all.push(f));
  return all;
}

const mb = (n: number): string => `${Math.max(1, Math.round(n / (1024 * 1024)))} MB`;

/** What forks of `dir` bring with `picks`: for the owner to look over (and change) before any goes. */
export async function carryPreview(dir: string, scratchDir: string, picks: CarryPicks): Promise<CarryPreview> {
  const ignored = await ignoredPaths(dir);
  const live = livePicks(picks, ignored);
  const candidates: CarryCandidate[] = [];
  for (const c of ignored) {
    const files = await walk(dir, c);
    const bytes = files.reduce((n, f) => n + f.bytes, 0);
    candidates.push({ path: c, files: files.length, bytes, secrets: files.filter((f) => looksSecret(f.path)).length, picked: live.paths.some((p) => bare(p) === bare(c)), ...(bytes > CARRY_WARN ? { large: true as const } : {}) });
  }
  const scratch = await walk(dir, scratchDir, CARRY_FILES, false);
  const { files, bytes, count } = plan(await pickedFiles(dir, live), live);
  // Secrets first (they need a look), then what doesn't go, then the rest.
  const order = (f: CarryFile): number => (f.secret ? 0 : f.goes ? 2 : 1);
  const sorted = [...files].sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path));
  const warnings = [
    ...candidates.filter((c) => c.picked && c.large).map((c) => `${bare(c.path)} is ${mb(c.bytes)}: the fork takes longer to come over`),
    ...(files.some((f) => f.why === 'limit') ? [`Over ${mb(CARRY_MAX)} in all: some files stay behind`] : []),
    ...(files.some((f) => f.why === 'big') ? [`Files over ${mb(CARRY_FILE_MAX)} stay behind`] : []),
  ];
  return { scratch: { files: scratch.length, bytes: scratch.reduce((n, f) => n + f.bytes, 0) }, candidates, files: sorted.slice(0, LISTED), more: Math.max(0, sorted.length - LISTED), bytes, count, limit: CARRY_MAX, warn: CARRY_WARN, warnings };
}

/**
 * Copy what goes into `stage/carry`, within `budget` bytes (what's left of the pack's limit after its
 * commits, Scratch and session). → what came and what stayed behind, for the pack's meta.
 */
export async function packCarry(dir: string, picks: CarryPicks, stage: string, budget = CARRY_MAX): Promise<CarryNote> {
  const ignored = await ignoredPaths(dir);
  const live = livePicks(picks, ignored);
  const { files } = plan(await pickedFiles(dir, live), live, Math.min(budget, CARRY_MAX));
  const to = path.join(stage, 'carry');
  for (const f of files.filter((x) => x.goes)) {
    await fs.mkdir(path.dirname(path.join(to, f.path)), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(dir, f.path), path.join(to, f.path));
    if (f.secret) await fs.chmod(path.join(to, f.path), 0o600);
  }
  const sent = live.paths.map((p) => {
    const mine = files.filter((f) => f.goes && within(f.path, p));
    return { path: p, files: mine.length, bytes: mine.reduce((n, f) => n + f.bytes, 0) };
  });
  const leftInPicks = files.filter((f) => !f.goes).map((f) => ({ path: f.path.slice(0, NOTE_PATH), why: f.why ?? ('limit' as const) }));
  const unpicked = ignored.filter((c) => !live.paths.some((p) => bare(p) === bare(c) || within(bare(c), p))).map((c) => ({ path: c.slice(0, NOTE_PATH), why: (looksSecret(bare(c)) ? 'secret' : 'ignored') as LeftWhy }));
  return { sent: sent.filter((s) => s.files).slice(0, NOTED), secrets: files.filter((f) => f.goes && f.secret).map((f) => f.path).slice(0, NOTED), left: [...leftInPicks, ...unpicked].slice(0, NOTED) };
}

/** Whether every folder on the way to `rel` in `dir` is a real folder or not there yet (never a link, never a file). */
async function clearWay(dir: string, rel: string): Promise<boolean> {
  const parts = rel.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const st = await fs.lstat(path.join(dir, ...parts.slice(0, i))).catch(() => undefined);
    if (!st) return true;
    if (!st.isDirectory()) return false;
  }
  return true;
}

/**
 * Place what came in `from/carry` into the new worktree at `dir`: never over a file already there
 * (your own .env stays yours), never into git's, Beluga's, an editor's or an agent's own folders
 * (their hooks run on their own), never through a link. A file that can't go in stays out; the rest
 * still go. → the paths that were already there (kept as they were), and those that couldn't be placed.
 */
export async function placeCarry(from: string, dir: string): Promise<{ kept: string[]; unplaced: string[] }> {
  const src = path.join(from, 'carry');
  const kept: string[] = [];
  const unplaced: string[] = [];
  for (const f of await walk(src, '.', Number.POSITIVE_INFINITY, false)) {
    const rel = f.path.replace(/^\.\//, '');
    if (!relPath.safeParse(rel).success || forbidden(rel)) {
      unplaced.push(rel);
      continue;
    }
    const target = path.join(dir, rel);
    try {
      if (!(await clearWay(dir, rel))) {
        unplaced.push(rel);
        continue;
      }
      if (await fs.lstat(target).then(() => true, () => false)) {
        kept.push(rel);
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(src, rel), target, fs.constants.COPYFILE_EXCL);
      if (looksSecret(rel)) await fs.chmod(target, 0o600);
    } catch {
      unplaced.push(rel);
    }
  }
  return { kept, unplaced };
}

/** A forked worktree's note (what came and what stayed with its owner), or undefined when it isn't a fork. */
export function forkNoteOf(dir: string): ForkNote | undefined {
  const parsed = ForkNote.safeParse(readJson(path.join(dir, FORK_NOTE)));
  return parsed.success ? parsed.data : undefined;
}

/** Where an owner's picks are kept (worktree id → picks). */
export class CarryPicksStore {
  private picks: Record<string, CarryPicks> = {};

  constructor(private readonly file: string) {
    const raw = readJson(file);
    const parsed = z.record(z.string(), CarryPicksSchema).safeParse(raw);
    if (parsed.success) this.picks = parsed.data;
  }

  get(wsId: string): CarryPicks {
    return this.picks[wsId] ?? { paths: [], secrets: [] };
  }

  set(wsId: string, picks: CarryPicks): void {
    const { [wsId]: _old, ...rest } = this.picks;
    this.picks = picks.paths.length ? { ...rest, [wsId]: picks } : rest;
    writeJson(this.file, this.picks);
  }
}
