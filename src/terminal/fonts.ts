/**
 * The monospace fonts installed on this computer, for Settings › Terminal › Font (#547).
 *
 * A web view can't list local fonts (WebKit has no queryLocalFonts), so the app only knew a
 * fixed list and a Nerd Font ("JetBrainsMono Nerd Font") never showed. The daemon reads the
 * font folders instead: each font file's `name` table for its family, and its `post` and `OS/2`
 * tables for whether it's monospaced, the same flags terminals and font menus go by.
 */
import { type FSWatcher, watch } from 'node:fs';
import { type FileHandle, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i;
/** How deep to look under a font folder (/usr/share/fonts/truetype/<foundry>/… on Linux). */
const MAX_DEPTH = 4;
/** Files read at once. */
const BATCH = 32;
/** Font files read at most (a folder of thousands is someone's archive, not their fonts). */
const MAX_FILES = 5000;
/** Faces read from one collection (.ttc) at most. */
const MAX_FACES = 64;
/** Glyph widths looked at to tell a font with no monospace flag is one anyway. */
const MAX_METRICS = 4096;

/** Where this computer keeps fonts, yours first (in that system's own path style). */
export function fontDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  if (platform === 'darwin') return [path.posix.join(home, 'Library/Fonts'), '/Library/Fonts', '/Network/Library/Fonts', '/System/Library/Fonts'];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local');
    return [path.win32.join(local, 'Microsoft', 'Windows', 'Fonts'), path.win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'Fonts')];
  }
  const data = env.XDG_DATA_HOME ?? path.posix.join(home, '.local/share');
  return [path.posix.join(data, 'fonts'), path.posix.join(home, '.fonts'), '/usr/local/share/fonts', '/usr/share/fonts'];
}

/** What one face in a font file says about itself. */
export interface FontFace {
  readonly family: string;
  readonly mono: boolean;
}

/** Reads `length` bytes at `offset` (fewer at the end of the file). */
export type ReadAt = (offset: number, length: number) => Promise<Buffer>;

interface Table {
  readonly offset: number;
  readonly length: number;
}

/** The tables of the face whose table directory starts at `at`, by tag. */
async function tablesAt(read: ReadAt, at: number): Promise<Map<string, Table>> {
  const head = await read(at, 12);
  if (head.length < 12) return new Map();
  const count = Math.min(head.readUInt16BE(4), 512);
  const dir = await read(at + 12, count * 16);
  const tables = new Map<string, Table>();
  for (let i = 0; i + 16 <= dir.length; i += 16) tables.set(dir.toString('latin1', i, i + 4), { offset: dir.readUInt32BE(i + 8), length: dir.readUInt32BE(i + 12) });
  return tables;
}

const utf16be = (b: Buffer): string => {
  const le = Buffer.from(b.subarray(0, b.length - (b.length % 2)));
  le.swap16();
  return le.toString('utf16le');
};

/**
 * A face's family from its `name` table: the typographic family (ID 16) when it has one, as
 * "JetBrains Mono" for every weight, else the family (ID 1); English Windows names first.
 */
export function familyFromNameTable(name: Buffer): string | undefined {
  if (name.length < 6) return undefined;
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  let best: { rank: number; text: string } | undefined;
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > name.length) break;
    const platform = name.readUInt16BE(at);
    const encoding = name.readUInt16BE(at + 2);
    const language = name.readUInt16BE(at + 4);
    const id = name.readUInt16BE(at + 6);
    if (id !== 1 && id !== 16) continue;
    const start = strings + name.readUInt16BE(at + 10);
    const raw = name.subarray(start, start + name.readUInt16BE(at + 8));
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    const roman = platform === 1 && encoding === 0;
    if (!unicode && !roman) continue;
    const text = (unicode ? utf16be(raw) : raw.toString('latin1')).replace(/\0/g, '').trim();
    if (!text) continue;
    const rank = (id === 16 ? 0 : 10) + (platform === 3 ? (language === 0x409 ? 0 : 1) : platform === 0 ? 2 : 3);
    if (!best || rank < best.rank) best = { rank, text };
  }
  return best?.text;
}

/** A text cell is narrower than this share of the em; ideographs, emoji and dingbats are a whole one. */
const NARROW = 0.75;

/**
 * Whether glyph widths (an `hmtx` table's first `count` advances) are nearly all one narrow
 * width, as in Monaco and Courier, which set neither flag: the commonest is 9 in 10 of the drawn
 * ones, and narrower than an em (so a CJK or emoji font, all full-width squares, isn't counted).
 */
export function evenAdvances(hmtx: Buffer, count: number, unitsPerEm: number): boolean {
  const widths = new Map<number, number>();
  let drawn = 0;
  for (let i = 0; i < count && i * 4 + 2 <= hmtx.length; i++) {
    const w = hmtx.readUInt16BE(i * 4);
    if (w === 0) continue; // Accents and other marks take no room.
    widths.set(w, (widths.get(w) ?? 0) + 1);
    drawn++;
  }
  const [width, times] = [...widths].reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0]);
  return drawn > 0 && times >= drawn * 0.9 && width < unitsPerEm * NARROW;
}

/** What says a face is monospaced: its `post`, `OS/2`, `head`, `hhea` and `hmtx` tables (as far as read). */
export interface MonoSigns {
  readonly post?: Buffer;
  readonly os2?: Buffer;
  readonly head?: Buffer;
  readonly hhea?: Buffer;
  readonly hmtx?: Buffer;
}

/**
 * Whether a face is monospaced: its `post` table says fixed pitch, its PANOSE says a monospaced
 * Latin text face (what Nerd Fonts and most coding fonts set), or its glyphs are all one width.
 */
export function isMonospaced({ post, os2, head, hhea, hmtx }: MonoSigns): boolean {
  if (post && post.length >= 16 && post.readUInt32BE(12) !== 0) return true;
  // PANOSE starts 32 bytes into OS/2: family kind 2 is Latin text, proportion 9 is monospaced.
  if (os2 && os2.length >= 42 && os2[32] === 2 && os2[35] === 9) return true;
  if (!head || !hhea || !hmtx || head.length < 20 || hhea.length < 36) return false;
  return evenAdvances(hmtx, hhea.readUInt16BE(34), head.readUInt16BE(18) || 1000);
}

/**
 * Whether a face draws Latin text, by its `OS/2` Unicode ranges (bit 0 is Basic Latin), so a
 * fixed-pitch Braille or bitmap CJK face isn't offered. A face that gives no ranges counts.
 */
export function drawsLatin(os2: Buffer | undefined): boolean {
  if (!os2 || os2.length < 58 || os2.subarray(42, 58).every((b) => b === 0)) return true;
  return (os2.readUInt32BE(42) & 1) === 1;
}

/** The faces in one font file (a .ttc holds several); none when it isn't one Beluga can read. */
export async function readFaces(read: ReadAt): Promise<FontFace[]> {
  const head = await read(0, 12);
  if (head.length < 12) return [];
  const tag = head.toString('latin1', 0, 4);
  let starts: number[] = [0];
  if (tag === 'ttcf') {
    const count = Math.min(head.readUInt32BE(8), MAX_FACES);
    const offsets = await read(12, count * 4);
    starts = Array.from({ length: Math.floor(offsets.length / 4) }, (_, i) => offsets.readUInt32BE(i * 4));
  } else if (tag !== 'OTTO' && tag !== 'true' && head.readUInt32BE(0) !== 0x00010000) return [];
  const faces: FontFace[] = [];
  for (const start of starts) {
    const tables = await tablesAt(read, start);
    const name = tables.get('name');
    if (!name) continue;
    const family = familyFromNameTable(await read(name.offset, Math.min(name.length, 1 << 20)));
    if (!family) continue;
    const at = async (tag: string, length: number): Promise<Buffer | undefined> => {
      const t = tables.get(tag);
      return t ? read(t.offset, Math.min(t.length, length)) : undefined;
    };
    const signs: MonoSigns = { post: await at('post', 16), os2: await at('OS/2', 58) };
    // Only when neither flag says so: the widths take a bigger read.
    const mono = drawsLatin(signs.os2) && (isMonospaced(signs) || isMonospaced({ head: await at('head', 20), hhea: await at('hhea', 36), hmtx: await at('hmtx', MAX_METRICS * 4) }));
    faces.push({ family, mono });
  }
  return faces;
}

async function facesOfFile(file: string): Promise<FontFace[]> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(file, 'r');
    const handle = fh;
    return await readFaces(async (offset, length) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    });
  } catch {
    // Unreadable or not really a font: it just isn't offered.
    return [];
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

async function fontFiles(dir: string, depth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // No such folder here.
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < MAX_DEPTH) await fontFiles(full, depth + 1, out);
    else if ((e.isFile() || e.isSymbolicLink()) && FONT_FILE.test(e.name)) out.push(full);
  }
}

/**
 * Families that can't be picked by name: hidden system faces (".SF NS Mono") and, on a Mac,
 * SF Mono, which web views only reach as ui-monospace (it's the "SF Mono (system)" choice).
 */
const unpickable = (family: string, platform: NodeJS.Platform): boolean => family.startsWith('.') || (platform === 'darwin' && /^SF Mono$/i.test(family));

/** The monospace families among these faces, each once, by name. */
export function monoFamilies(faces: readonly FontFace[], platform: NodeJS.Platform = process.platform): string[] {
  const byKey = new Map<string, string>();
  for (const f of faces) if (f.mono && !unpickable(f.family, platform) && !byKey.has(f.family.toLowerCase())) byKey.set(f.family.toLowerCase(), f.family);
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/** Every monospace font family installed in `dirs`, by name. */
export async function listMonoFonts(dirs: readonly string[] = fontDirs(), platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) await fontFiles(dir, 0, files);
  const faces: FontFace[] = [];
  for (let i = 0; i < files.length; i += BATCH) faces.push(...(await Promise.all(files.slice(i, i + BATCH).map(facesOfFile))).flat());
  return monoFamilies(faces, platform);
}

let scanned: Promise<string[]> | undefined;

/** The monospace fonts installed here, read once per process unless `fresh` (fonts changed). */
export function installedMonoFonts(fresh = false): Promise<string[]> {
  if (fresh || !scanned) scanned = listMonoFonts();
  return scanned;
}

/**
 * Calls `onChange` (once things settle) when fonts are added to or removed from these folders,
 * as installing a Nerd Font with Font Book or Homebrew does. Returns how to stop watching.
 */
export function watchFontDirs(onChange: () => void, dirs: readonly string[] = fontDirs(), settleMs = 2000): () => void {
  let timer: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];
  for (const dir of dirs) {
    try {
      const w = watch(dir, () => {
        clearTimeout(timer);
        timer = setTimeout(onChange, settleMs);
        timer.unref();
      });
      w.on('error', () => w.close());
      w.unref();
      watchers.push(w);
    } catch {
      // A folder that isn't there (most of them, on any one computer).
    }
  }
  return () => {
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
