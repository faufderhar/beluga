import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { isSecretPath } from '../core/shares.js';
import { outputKind } from '../core/claude-code/outputs.js';
import { redactSecrets } from '../shared/steps.js';
import { FILE_PAGE, type FilePageView, type FileEntryView, type FolderView, type FoundView, MAX_COMPANION_FRAME } from './protocol.js';
import type { RefTable } from './files.js';

/**
 * A worktree's files on the phone (BLG-42), read-only: the companion's file gate. Everything the
 * phone names is a path inside one worktree (its conversation's topic says which), and before a
 * folder is listed or a byte is read:
 *
 * - the path stays inside that worktree: no absolute paths, no `..`, nothing in `.git`;
 * - links are followed and the real place is checked again: one that leads out of the worktree is
 *   refused (and not listed);
 * - secrets are refused by the name given and by where it really leads (`isSecretPath`: .env,
 *   keys, credentials, Beluga's own files), and aren't listed;
 * - text is read in pages of FILE_PAGE bytes, with secrets a file holds redacted (as logs are).
 *
 * Nothing is ever written: the phone has no way to change a file.
 */

export class FileGateError extends Error {}

/** Folders never shown (the Mac's Files tab hides them from the room too). */
const HIDDEN = new Set(['.git']);
/** Folders a name search doesn't walk into (they're big and never what you look for). */
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.turbo', '.cache', 'coverage', 'target', '.venv', 'venv', '__pycache__', 'Pods', 'DerivedData']);
const MAX_ENTRIES = 2000;
const MAX_HITS = 200;
const MAX_WALK = 30_000;

const realOf = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

/** The worktree's folder as it really is. */
function rootOf(root: string): string {
  const real = realOf(root);
  if (!real) throw new FileGateError('The worktree’s folder isn’t there');
  return real;
}

const insideOf = (realRoot: string) => (p: string): boolean => p === realRoot || p.startsWith(realRoot + path.sep);

/** A path inside the worktree as its parts; '' is the top. Refuses what leaves it, `.git`, and secrets by name. */
export function cleanRel(rel: string): string[] {
  const cleaned = rel.replace(/\\/g, '/');
  if (cleaned.includes('\0')) throw new FileGateError('That isn’t a path');
  if (cleaned.startsWith('/') || path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) throw new FileGateError('Only files inside the worktree can be opened');
  const parts = cleaned.split('/').filter((p) => p && p !== '.');
  if (parts.includes('..')) throw new FileGateError('Only files inside the worktree can be opened');
  if (parts.some((p) => HIDDEN.has(p.toLowerCase()))) throw new FileGateError('Git’s own files aren’t shown');
  if (parts.length && isSecretPath(parts.join('/'))) throw new FileGateError('That file is secret: it never leaves your Mac');
  return parts;
}

/**
 * The real path of `rel` inside the worktree at `root`, checked: inside it (links followed), and
 * not a secret by its name or where it leads.
 */
export function gate(root: string, rel: string): { abs: string; real: string; rel: string } {
  const parts = cleanRel(rel);
  const realRoot = rootOf(root);
  const abs = path.join(realRoot, ...parts);
  const real = realOf(abs);
  if (!real) throw new FileGateError('That isn’t there any more');
  if (!insideOf(realRoot)(real)) throw new FileGateError('That leads outside the worktree');
  if (isSecretPath(abs) || isSecretPath(real) || (real !== realRoot && isSecretPath(path.relative(realRoot, real)))) throw new FileGateError('That file is secret: it never leaves your Mac');
  return { abs, real, rel: parts.join('/') };
}

/** May this entry of a folder be shown: not hidden, not secret, and (a link) not leading out or to a secret. */
function shown(realRoot: string, dirReal: string, name: string, relDir: string): { abs: string; real: string } | undefined {
  if (HIDDEN.has(name)) return undefined;
  const rel = relDir ? `${relDir}/${name}` : name;
  if (isSecretPath(rel)) return undefined;
  const abs = path.join(dirReal, name);
  const real = realOf(abs);
  if (!real || !insideOf(realRoot)(real) || isSecretPath(abs) || isSecretPath(real)) return undefined;
  return { abs, real };
}

/** A folder of the worktree: folders first, then files, by name. Pictures and videos carry a ref for the viewer. */
export async function listFolder(root: string, rel: string, refs?: RefTable): Promise<FolderView> {
  const g = gate(root, rel);
  const realRoot = rootOf(root);
  const st = await fs.stat(g.real);
  if (!st.isDirectory()) throw new FileGateError('That isn’t a folder');
  const names = (await fs.readdir(g.real)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const entries: FileEntryView[] = [];
  for (const name of names) {
    const ok = shown(realRoot, g.real, name, g.rel);
    if (!ok) continue;
    let s: import('node:fs').Stats;
    try {
      s = await fs.stat(ok.real);
    } catch {
      continue;
    }
    if (!s.isDirectory() && !s.isFile()) continue;
    const dir = s.isDirectory();
    // Pictures and videos open in the viewer (videos streamed: src/companion/media-stream.ts).
    const kind = dir ? undefined : outputKind(name);
    const ref = kind === 'image' || kind === 'video' ? refs?.refFor(ok.abs, root) : undefined;
    entries.push({ name: name.slice(0, 256), dir, ...(dir ? {} : { size: s.size }), ...(ref ? { ref: ref as FileEntryView['ref'] } : {}) });
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir));
  return { path: g.rel, entries: entries.slice(0, MAX_ENTRIES), ...(entries.length > MAX_ENTRIES ? { more: true } : {}) };
}

/** Files and folders whose names hold `query` (any case), anywhere in the worktree (big build folders skipped). */
export async function findByName(root: string, query: string): Promise<FoundView> {
  const realRoot = rootOf(root);
  const q = query.trim().toLowerCase();
  if (!q) return { hits: [] };
  const hits: FoundView['hits'] = [];
  let walked = 0;
  let more = false;
  const queue: string[] = [''];
  while (queue.length && !more) {
    const relDir = queue.shift()!;
    const dirReal = relDir ? realOf(path.join(realRoot, relDir)) : realRoot;
    if (!dirReal || !insideOf(realRoot)(dirReal)) continue;
    let names: import('node:fs').Dirent[];
    try {
      names = await fs.readdir(dirReal, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of names) {
      if (++walked > MAX_WALK) {
        more = true;
        break;
      }
      const ok = shown(realRoot, dirReal, d.name, relDir);
      if (!ok) continue;
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      // Links to folders aren't walked into (they could loop); real folders are.
      const dir = d.isDirectory() || (d.isSymbolicLink() && (await fs.stat(ok.real).then((s) => s.isDirectory(), () => false)));
      if (d.name.toLowerCase().includes(q)) {
        hits.push({ path: rel, dir });
        if (hits.length >= MAX_HITS) {
          more = true;
          break;
        }
      }
      if (d.isDirectory() && !SKIP.has(d.name)) queue.push(rel);
    }
  }
  // Closer matches first: the name starting with it, then shallower paths.
  const name = (p: string): string => p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  hits.sort((a, b) => Number(name(b.path).startsWith(q)) - Number(name(a.path).startsWith(q)) || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  return { hits, ...(more ? { more: true } : {}) };
}

/** A file's language for the phone's colours, from its name. */
export function langOf(name: string): string | undefined {
  const base = name.toLowerCase();
  if (base === 'dockerfile') return 'docker';
  if (base === 'makefile') return 'make';
  const ext = path.extname(base).slice(1);
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    json: 'json', jsonc: 'json', json5: 'json', py: 'py', rb: 'rb', go: 'go', rs: 'rs', swift: 'swift', kt: 'kt', java: 'java',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', m: 'c', mm: 'cpp', cs: 'cs',
    sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
    md: 'md', markdown: 'md', mdx: 'md', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'toml', sql: 'sql', lua: 'lua', php: 'php',
  };
  return map[ext];
}

/** How much of a page's JSON fits in one frame (the text is escaped, and some characters grow). */
const FRAME_ROOM = MAX_COMPANION_FRAME - 16 * 1024;

/**
 * One page of a file, read-only: up to FILE_PAGE bytes from `off`, ending at a line's end unless
 * it's the last page, with secrets it holds redacted. A file that isn't UTF-8 text says `binary`.
 */
export async function readPage(root: string, rel: string, off = 0): Promise<FilePageView> {
  const g = gate(root, rel);
  const handle = await fs.open(g.real, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new FileGateError('That isn’t a file');
    const lang = langOf(path.basename(g.rel));
    const base = { path: g.rel, size: st.size, ...(lang ? { lang } : {}) };
    const start = Math.min(Math.max(0, off), st.size);
    let want = Math.min(FILE_PAGE, st.size - start);
    for (;;) {
      const bytes = Buffer.alloc(want);
      const { bytesRead } = want ? await handle.read(bytes, 0, want, start) : { bytesRead: 0 };
      let buf = bytes.subarray(0, bytesRead);
      const atEnd = start + buf.length >= st.size;
      // Text only: a NUL in the first bytes of the file is a binary file.
      if (start === 0 && buf.subarray(0, 8000).includes(0)) return { ...base, text: '', off: start, next: st.size, eof: true, binary: true };
      if (!atEnd) {
        // Whole lines, so a page never splits a line (or a character).
        const nl = buf.lastIndexOf(10);
        if (nl > 0) buf = buf.subarray(0, nl + 1);
        else {
          let cut = buf.length;
          while (cut > 0 && (buf[cut - 1]! & 0xc0) === 0x80) cut--;
          if (cut > 0 && buf[cut - 1]! >= 0xc0) cut--;
          buf = buf.subarray(0, cut || buf.length);
        }
      }
      if (start === 0 && !isUtf8(buf) && !isUtf8(buf.subarray(0, Math.max(0, buf.length - 4)))) return { ...base, text: '', off: start, next: st.size, eof: true, binary: true };
      const text = redactSecrets(buf.toString('utf8'));
      const page: FilePageView = { ...base, text, off: start, next: start + buf.length, eof: start + buf.length >= st.size };
      if (JSON.stringify(page).length <= FRAME_ROOM || want <= 4096) return page;
      want = Math.floor(want / 2);
    }
  } finally {
    await handle.close();
  }
}
