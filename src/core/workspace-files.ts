import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { MAX_FILE_BYTES } from '../protocol.js';

/**
 * Your own workspace's files, from the Mac app's Files tab: searching their contents (ripgrep
 * when it's on this Mac, else a careful walk in Node that skips what .gitignore does), saving a
 * file you edited (only inside the workspace, never over a change made since you started), and
 * formatting one with the project's own Prettier.
 */

// ---- searching contents

export interface ContentSearchOptions {
  /** The query is a regular expression (else plain text). */
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
}

export interface LineMatch {
  /** 1-based. */
  readonly line: number;
  /** The line, trimmed and clipped around the first match. */
  readonly text: string;
  /** Where the matches are in `text` (UTF-16 offsets, [start, end)). */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
}

export interface FileMatches {
  readonly path: string;
  readonly matches: readonly LineMatch[];
}

export interface ContentResults {
  readonly files: readonly FileMatches[];
  /** Matching lines found (up to the cap). */
  readonly count: number;
  /** Stopped at the cap: there are more. */
  readonly truncated: boolean;
  readonly engine: 'ripgrep' | 'node';
  /** A newer search replaced this one. */
  readonly cancelled?: boolean;
  /** The query couldn't run (a broken regular expression…). */
  readonly error?: string;
}

/** At most this many matching lines in all, and per file. */
export const MAX_LINES = 1000;
export const MAX_PER_FILE = 50;
/** Files bigger than this aren't searched (minified bundles, data dumps). */
export const MAX_SEARCH_BYTES = 1024 * 1024;
/** A preview line is clipped to about this many characters. */
export const PREVIEW_CHARS = 200;
/** How much comes before the first match when a long line is clipped. */
const LEAD = 48;

/** Not worth searching even outside a git repository (where .gitignore isn't read). */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.turbo', '.cache', 'coverage', 'target', '.venv', 'venv', '__pycache__', '.beluga', '.claude', 'Pods', 'DerivedData']);

/** A line as shown in results: leading space trimmed, long ones clipped around the first match. */
export function previewLine(raw: string, ranges: ReadonlyArray<readonly [number, number]>): { text: string; ranges: Array<[number, number]> } {
  const line = raw.replace(/\r?\n$/, '');
  const indent = line.length - line.trimStart().length;
  let start = indent;
  const first = ranges[0]?.[0] ?? 0;
  if (line.length - start > PREVIEW_CHARS && first - start > LEAD) start = first - LEAD;
  const end = Math.min(line.length, start + PREVIEW_CHARS);
  const head = start > indent ? '…' : '';
  const tail = end < line.length ? '…' : '';
  const shift = head.length - start;
  const text = head + line.slice(start, end).trimEnd() + tail;
  const limit = text.length - tail.length;
  const shown: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const a = Math.max(head.length, s + shift);
    const b = Math.min(limit, e + shift);
    if (b > a) shown.push([a, b]);
  }
  return { text, ranges: shown };
}

/** UTF-8 byte offsets in `text` (what ripgrep reports) as string offsets. */
export function byteToChar(text: string, byteOffset: number): number {
  if (Buffer.byteLength(text) === text.length) return byteOffset;
  return Buffer.from(text).subarray(0, byteOffset).toString('utf8').length;
}

type RgText = { readonly text?: string; readonly bytes?: string };
const rgText = (t: RgText | undefined): string => (t?.text !== undefined ? t.text : t?.bytes ? Buffer.from(t.bytes, 'base64').toString('utf8') : '');

/** One line of `rg --json` as a match (path, line number, preview), or undefined for the other kinds (begin, end, summary…). */
export function parseRgLine(json: string): { path: string; match: LineMatch } | undefined {
  let ev: { type?: string; data?: { path?: RgText; lines?: RgText; line_number?: number; submatches?: Array<{ start: number; end: number }> } };
  try {
    ev = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (ev.type !== 'match' || !ev.data) return undefined;
  const file = rgText(ev.data.path).replace(/^\.\//, '');
  const raw = rgText(ev.data.lines);
  if (!file || typeof ev.data.line_number !== 'number') return undefined;
  const ranges = (ev.data.submatches ?? []).map((m) => [byteToChar(raw, m.start), byteToChar(raw, m.end)] as const);
  const { text, ranges: shown } = previewLine(raw, ranges);
  return { path: file, match: { line: ev.data.line_number, text, ranges: shown } };
}

/** Matches as files with their lines, in path order (then line order). */
class Collector {
  private readonly byFile = new Map<string, LineMatch[]>();
  count = 0;
  truncated = false;
  add(file: string, match: LineMatch): boolean {
    if (this.count >= MAX_LINES) {
      this.truncated = true;
      return false;
    }
    let list = this.byFile.get(file);
    if (!list) this.byFile.set(file, (list = []));
    if (list.length >= MAX_PER_FILE) {
      this.truncated = true;
      return true;
    }
    list.push(match);
    this.count++;
    return true;
  }
  get full(): boolean {
    return this.count >= MAX_LINES;
  }
  files(): FileMatches[] {
    return [...this.byFile].sort(([a], [b]) => a.localeCompare(b)).map(([p, matches]) => ({ path: p, matches: [...matches].sort((x, y) => x.line - y.line) }));
  }
}

let rgFound: string | null | undefined;

/** Where ripgrep is on this Mac (the app's PATH is short, so the usual places are looked in too), or undefined. */
export function findRipgrep(): string | undefined {
  if (rgFound !== undefined) return rgFound ?? undefined;
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])];
  rgFound = null;
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, process.platform === 'win32' ? 'rg.exe' : 'rg');
    try {
      accessSync(p, constants.X_OK);
      rgFound = p;
      break;
    } catch {
      // Not here.
    }
  }
  return rgFound ?? undefined;
}

export function ripgrepArgs(query: string, opts: ContentSearchOptions): string[] {
  return [
    '--json',
    '--hidden',
    '--no-require-git',
    '--glob',
    '!.git',
    '--max-count',
    String(MAX_PER_FILE),
    '--max-filesize',
    `${MAX_SEARCH_BYTES / 1024}K`,
    '--no-messages',
    opts.caseSensitive ? '--case-sensitive' : '--ignore-case',
    ...(opts.regex ? [] : ['--fixed-strings']),
    ...(opts.wholeWord ? ['--word-regexp'] : []),
    '--regexp',
    query,
    '--',
    '.',
  ];
}

function searchWithRipgrep(rg: string, root: string, query: string, opts: ContentSearchOptions, signal: AbortSignal | undefined): Promise<ContentResults> {
  return new Promise((resolve) => {
    const found = new Collector();
    const child = spawn(rg, ripgrepArgs(query, opts), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let rest = '';
    let stderr = '';
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      child.kill();
    };
    const onAbort = (): void => stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) {
        const hit = parseRgLine(l);
        if (hit && !found.add(hit.path, hit.match)) return stop();
      }
      if (found.full) stop();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      if (stderr.length < 4000) stderr += c;
    });
    const finish = (code: number | null, error?: string): void => {
      signal?.removeEventListener('abort', onAbort);
      if (!stopped && rest) {
        const hit = parseRgLine(rest);
        if (hit) found.add(hit.path, hit.match);
      }
      const base = { files: found.files(), count: found.count, truncated: found.truncated, engine: 'ripgrep' as const };
      if (signal?.aborted) return resolve({ ...base, cancelled: true });
      // 0: found some, 1: none, 2: an error (a bad pattern…), unless we stopped it.
      if (!stopped && code === 2 && !found.count) return resolve({ ...base, error: rgError(stderr) });
      resolve(error ? { ...base, error } : base);
    };
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });
}

/** ripgrep's complaint about a pattern, in one line ("regex parse error: unclosed group"). */
function rgError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const why = (lines.find((l) => /^error:/i.test(l)) ?? lines.at(-1) ?? 'The search couldn’t run').replace(/^error:\s*/i, '').replace(/^regex parse error:?\s*/i, '');
  return /regex parse error/i.test(stderr) ? `Not a valid pattern: ${why}` : why;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The query as the regular expression the Node search uses (throws when it isn't a valid one). */
export function queryRegex(query: string, opts: ContentSearchOptions): RegExp {
  const body = opts.regex ? query : escapeRegex(query);
  return new RegExp(opts.wholeWord ? `\\b(?:${body})\\b` : body, opts.caseSensitive ? 'gu' : 'giu');
}

/** Every line of `text` that matches, with where. */
export function matchLines(text: string, re: RegExp, max = MAX_PER_FILE): LineMatch[] {
  const out: LineMatch[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i]!;
    re.lastIndex = 0;
    const ranges: Array<[number, number]> = [];
    for (let m = re.exec(line); m; m = re.exec(line)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      ranges.push([m.index, m.index + m[0].length]);
      if (ranges.length >= 50) break;
    }
    if (ranges.length) out.push({ line: i + 1, ...previewLine(line, ranges) });
  }
  return out;
}

/** The workspace's files the way git sees them (tracked and new, not ignored), or undefined outside a repository. */
function gitFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean) : undefined));
  });
}

async function walk(root: string, signal: AbortSignal | undefined, limit = 50_000): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length < limit && !signal?.aborted) {
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(rel);
      } else if (e.isFile()) out.push(rel);
    }
  }
  return out;
}

async function searchWithNode(root: string, query: string, opts: ContentSearchOptions, signal: AbortSignal | undefined): Promise<ContentResults> {
  const found = new Collector();
  const done = (extra: Partial<ContentResults> = {}): ContentResults => ({ files: found.files(), count: found.count, truncated: found.truncated, engine: 'node', ...(signal?.aborted ? { cancelled: true } : {}), ...extra });
  let re: RegExp;
  try {
    re = queryRegex(query, opts);
  } catch (err) {
    return done({ error: `Not a valid pattern: ${(err as Error).message.replace(/^Invalid regular expression:\s*/i, '')}` });
  }
  const files = (await gitFiles(root)) ?? (await walk(root, signal));
  let next = 0;
  const worker = async (): Promise<void> => {
    const mine = new RegExp(re.source, re.flags);
    while (next < files.length && !found.full && !signal?.aborted) {
      const rel = files[next++]!;
      if (rel.split('/').some((p) => p === '.git')) continue;
      const abs = path.join(root, rel);
      try {
        const st = await fs.stat(abs);
        if (!st.isFile() || st.size > MAX_SEARCH_BYTES || st.size === 0) continue;
        const buf = await fs.readFile(abs);
        if (buf.subarray(0, 8000).includes(0)) continue;
        for (const m of matchLines(buf.toString('utf8'), mine)) if (!found.add(rel, m)) break;
      } catch {
        // Gone or unreadable: skip it.
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return done();
}

/**
 * Lines in the workspace's files that have the query, grouped by file. ripgrep does it when it's
 * here (fast, and it reads .gitignore); otherwise Node does, over the files git knows about.
 * Aborting stops it (a newer query came); the cap keeps a one-letter query from flooding the window.
 */
export async function searchContents(root: string, query: string, opts: ContentSearchOptions = {}, signal?: AbortSignal, engine: 'auto' | 'node' = 'auto'): Promise<ContentResults> {
  if (!query) return { files: [], count: 0, truncated: false, engine: 'node' };
  const rg = engine === 'auto' ? findRipgrep() : undefined;
  return rg ? searchWithRipgrep(rg, root, query, opts, signal) : searchWithNode(root, query, opts, signal);
}

// ---- searching names

export interface NameMatch {
  /** Relative to the workspace, with `/`. */
  readonly path: string;
  /** Where the query matched in `path` (UTF-16 offsets, [start, end)). */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
}

export interface NameResults {
  readonly files: readonly NameMatch[];
  /** Stopped at MAX_NAMES: there are more. */
  readonly truncated: boolean;
  readonly cancelled?: boolean;
  readonly error?: string;
}

/** At most this many files found by name. */
export const MAX_NAMES = 500;

/** Every file under `root` as ripgrep lists it (hidden ones too, not .git or what .gitignore leaves out), or undefined without ripgrep. */
function rgFiles(rg: string, root: string, signal: AbortSignal | undefined): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const child = spawn(rg, ['--files', '--hidden', '--no-require-git', '--glob', '!.git', '--no-messages'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], signal });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => resolve(undefined));
    // 1: no files at all; 2 with some listed: a folder it couldn't read.
    child.on('close', () => resolve(signal?.aborted ? undefined : Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean)));
  });
}

/**
 * Files whose path matches the query (plain text, or a regular expression with `regex`), anywhere
 * in the workspace: what ripgrep lists, else what git knows about, else a walk. The query runs
 * against the whole relative path, so `^src/.*\.test\.ts$` works as well as `readme`.
 */
export async function searchNames(root: string, query: string, opts: ContentSearchOptions = {}, signal?: AbortSignal, engine: 'auto' | 'node' = 'auto'): Promise<NameResults> {
  if (!query) return { files: [], truncated: false };
  let re: RegExp;
  try {
    re = queryRegex(query, opts);
  } catch (err) {
    return { files: [], truncated: false, error: `Not a valid pattern: ${(err as Error).message.replace(/^Invalid regular expression:\s*/i, '')}` };
  }
  const rg = engine === 'auto' ? findRipgrep() : undefined;
  const listed = rg ? await rgFiles(rg, root, signal) : undefined;
  if (signal?.aborted) return { files: [], truncated: false, cancelled: true };
  const all = listed ?? (await gitFiles(root)) ?? (await walk(root, signal));
  if (signal?.aborted) return { files: [], truncated: false, cancelled: true };
  const files: NameMatch[] = [];
  let truncated = false;
  for (const rel of all.map((p) => p.replace(/^\.\//, '')).sort((a, b) => a.localeCompare(b))) {
    if (rel.split('/').includes('.git')) continue;
    re.lastIndex = 0;
    const ranges: Array<[number, number]> = [];
    for (let m = re.exec(rel); m; m = re.exec(rel)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      ranges.push([m.index, m.index + m[0].length]);
    }
    if (!ranges.length) continue;
    if (files.length >= MAX_NAMES) {
      truncated = true;
      break;
    }
    files.push({ path: rel, ranges });
  }
  return { files, truncated };
}

// ---- where a path may go

export class FileEditError extends Error {}

/**
 * A workspace-relative path as the real file inside the workspace: no absolute paths, no `..`,
 * nothing in .git, and no symlink (of the file or a folder on the way) that leads out of it.
 */
export function resolveInWorkspace(root: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('\0')) throw new FileEditError('No file given');
  if (cleaned.startsWith('/') || path.isAbsolute(cleaned)) throw new FileEditError('Only files inside the workspace can be changed');
  const parts = cleaned.split('/').filter((p) => p && p !== '.');
  if (!parts.length) throw new FileEditError('No file given');
  if (parts.includes('..')) throw new FileEditError('Only files inside the workspace can be changed');
  if (parts[0]?.toLowerCase() === '.git') throw new FileEditError('Git’s own files can’t be changed here');
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new FileEditError('The workspace’s folder isn’t there');
  }
  const inside = (p: string): boolean => p === realRoot || p.startsWith(realRoot + path.sep);
  const target = path.join(realRoot, ...parts);
  // The file itself if it's there, else the nearest folder on the way that is.
  let probe = target;
  for (;;) {
    try {
      const real = realpathSync(probe);
      if (!inside(real)) throw new FileEditError('That path leads outside the workspace');
      return probe === target ? real : path.join(real, path.relative(probe, target));
    } catch (err) {
      if (err instanceof FileEditError) throw err;
      const up = path.dirname(probe);
      if (up === probe || !inside(up)) throw new FileEditError('That path leads outside the workspace');
      probe = up;
    }
  }
}

export const hashText = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export type WriteResult = { readonly ok: true; readonly hash: string } | { readonly ok: false; readonly conflict: true };

/**
 * Save a file you edited. `expect`: the hash of the text you started from; when the file has
 * changed since (someone else, Claude, a formatter…) nothing is written and you're asked first
 * (`force` writes anyway). Only existing text files, never past the size Beluga reads.
 */
export async function writeWorkspaceFile(root: string, rel: string, content: string, opts: { expect?: string; force?: boolean } = {}): Promise<WriteResult> {
  const file = resolveInWorkspace(root, rel);
  let st: import('node:fs').Stats;
  try {
    st = await fs.stat(file);
  } catch {
    throw new FileEditError('That file isn’t there anymore');
  }
  if (!st.isFile()) throw new FileEditError('Only files can be edited');
  if (st.size > MAX_FILE_BYTES) throw new FileEditError('This file is too big to edit here');
  if (Buffer.byteLength(content) > MAX_FILE_BYTES * 4) throw new FileEditError('That’s too much text to save here');
  const now = await fs.readFile(file);
  if (now.includes(0) || !isUtf8(now)) throw new FileEditError('Only UTF-8 text files can be edited here');
  if (opts.expect && !opts.force && hashText(now.toString('utf8')) !== opts.expect) return { ok: false, conflict: true };
  // Next to it, then over it in one step: a crash never leaves half a file.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, content, { mode: st.mode & 0o7777 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return { ok: true, hash: hashText(content) };
}

// ---- Prettier

export interface FormatterInfo {
  readonly available: boolean;
  /** Why not (shown on the disabled Format button). */
  readonly reason?: string;
  readonly version?: string;
  /** Beluga's own Prettier, because the project doesn't install one. */
  readonly bundled?: boolean;
}

/** Prettier's command-line script in the nearest node_modules from the file's folder up to `top` (then each extra root), or undefined. */
export function findPrettier(fileAbs: string, top: string, more: readonly string[] = []): { bin: string; version?: string } | undefined {
  const dirs: string[] = [];
  const stopAt = path.resolve(top);
  for (let d = path.dirname(fileAbs); ; d = path.dirname(d)) {
    dirs.push(d);
    if (d === stopAt || path.dirname(d) === d || !d.startsWith(stopAt)) break;
  }
  for (const m of more) if (m && !dirs.includes(m)) dirs.push(m);
  for (const d of dirs) {
    const found = prettierAt(path.join(d, 'node_modules', 'prettier', 'package.json'));
    if (found) return found;
  }
  return undefined;
}

/** Prettier's script and version from its package.json, or undefined when it isn't a usable install. */
function prettierAt(pkgFile: string): { bin: string; version?: string } | undefined {
  if (!existsSync(pkgFile)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { version?: string; bin?: string | Record<string, string> };
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.prettier;
    if (!binRel) return undefined;
    const bin = path.join(path.dirname(pkgFile), binRel);
    return existsSync(bin) ? { bin, ...(pkg.version ? { version: pkg.version } : {}) } : undefined;
  } catch {
    return undefined; // A broken install.
  }
}

/** The Prettier Beluga ships with (a dependency of the engine), for projects that don't install their own. */
export function ownPrettier(): { bin: string; version?: string } | undefined {
  try {
    return prettierAt(createRequire(import.meta.url).resolve('prettier/package.json'));
  } catch {
    return undefined; // A build without it: Format says Prettier isn't there.
  }
}

/** The project's own Prettier first (the version its CI and teammates use), else Beluga's. */
function resolvePrettier(file: string, root: string, more: readonly string[]): { bin: string; version?: string; bundled?: true } | undefined {
  const project = findPrettier(file, root, more);
  if (project) return project;
  const own = ownPrettier();
  return own ? { ...own, bundled: true } : undefined;
}

/** Text in a language Prettier formats out of the box. */
export const PRETTIER_FILES = /\.(m?[jt]sx?|c[jt]s|json5?|jsonc|css|scss|less|html?|vue|md|mdx|ya?ml|graphql|gql|hbs|handlebars)$/i;

export function formatterFor(root: string, rel: string, more: readonly string[] = []): FormatterInfo {
  let file: string;
  try {
    file = resolveInWorkspace(root, rel);
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
  const found = resolvePrettier(file, root, more);
  if (!found) return { available: false, reason: 'Prettier isn’t available' };
  const about = { ...(found.version ? { version: found.version } : {}), ...(found.bundled ? { bundled: true as const } : {}) };
  if (!PRETTIER_FILES.test(rel)) return { available: false, reason: 'Prettier doesn’t format this kind of file', ...about };
  return { available: true, ...about };
}

/** The text as the project's Prettier lays it out (its own config and .prettierignore apply). */
export function formatWithPrettier(root: string, rel: string, content: string, more: readonly string[] = [], timeoutMs = 20_000): Promise<string> {
  const file = resolveInWorkspace(root, rel);
  const found = resolvePrettier(file, root, more);
  if (!found) return Promise.reject(new FileEditError('Prettier isn’t available'));
  return new Promise((resolve, reject) => {
    // The daemon runs on Node, so Prettier's script runs on the same one (no PATH needed).
    const child = spawn(process.execPath, [found.bin, '--stdin-filepath', file], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      if (err.length < 4000) err += c;
    });
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (sig) return reject(new FileEditError('Prettier took too long'));
      if (code !== 0) return reject(new FileEditError(prettierError(err)));
      resolve(Buffer.concat(out).toString('utf8'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(content);
  });
}

function prettierError(stderr: string): string {
  const line = stderr
    .split('\n')
    .map((l) => l.replace(/^\[error\]\s*/, '').trim())
    .find(Boolean);
  if (!line) return 'Prettier couldn’t format this file';
  if (/No parser could be inferred/i.test(line)) return 'Prettier doesn’t format this kind of file';
  return `Prettier: ${line.replace(/^.*?:\s*SyntaxError:\s*/, 'Syntax error: ')}`.slice(0, 300);
}
