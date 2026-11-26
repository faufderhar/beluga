import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fontDirs, listMonoFonts, monoFamilies, readFaces, type ReadAt } from '../src/terminal/fonts.js';
import { fontChoices } from '../packages/mac/src/lib/terminal-look.js';
import { initialWork, reduceWork } from '../src/core/work-store.js';

/** What a made-up font face says about itself. */
interface Spec {
  readonly family: string;
  /** The typographic family (name ID 16), as every weight of a family shares it. */
  readonly typo?: string;
  readonly fixedPitch?: boolean;
  /** PANOSE proportion: 9 is monospaced, 3 modern (proportional). */
  readonly proportion?: number;
  /** Glyph widths in font units. */
  readonly widths?: readonly number[];
  readonly unitsPerEm?: number;
  /** Covers Basic Latin (OS/2 Unicode range bit 0). */
  readonly latin?: boolean;
}

function nameTable(names: ReadonlyArray<readonly [number, string]>): Buffer {
  const strings = names.map(([, text]) => Buffer.from(text, 'utf16le').swap16());
  const head = Buffer.alloc(6 + names.length * 12);
  head.writeUInt16BE(names.length, 2);
  head.writeUInt16BE(head.length, 4);
  let offset = 0;
  names.forEach(([id], i) => {
    const at = 6 + i * 12;
    head.writeUInt16BE(3, at); // Windows
    head.writeUInt16BE(1, at + 2); // Unicode BMP
    head.writeUInt16BE(0x409, at + 4); // English (US)
    head.writeUInt16BE(id, at + 6);
    head.writeUInt16BE(strings[i]!.length, at + 8);
    head.writeUInt16BE(offset, at + 10);
    offset += strings[i]!.length;
  });
  return Buffer.concat([head, ...strings]);
}

/** The tables of a face, by tag. */
function faceTables(s: Spec): Array<[string, Buffer]> {
  const post = Buffer.alloc(32);
  post.writeUInt32BE(s.fixedPitch ? 1 : 0, 12);
  const os2 = Buffer.alloc(96);
  os2[32] = 2; // Latin text
  os2[35] = s.proportion ?? 3;
  os2.writeUInt32BE(s.latin === false ? 1 << 10 : 0b111, 42);
  const head = Buffer.alloc(54);
  head.writeUInt16BE(s.unitsPerEm ?? 1000, 18);
  const widths = s.widths ?? [600, 250, 600, 720, 500, 0];
  const hhea = Buffer.alloc(36);
  hhea.writeUInt16BE(widths.length, 34);
  const hmtx = Buffer.alloc(widths.length * 4);
  widths.forEach((w, i) => hmtx.writeUInt16BE(w, i * 4));
  const names: Array<[number, string]> = [[1, s.family], ...(s.typo ? [[16, s.typo] as [number, string]] : [])];
  return [
    ['OS/2', os2],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['name', nameTable(names)],
    ['post', post],
  ];
}

/** A font file: one face, or a collection (.ttc) of several. */
function fontFile(...specs: Spec[]): Buffer {
  const collection = specs.length > 1;
  const top = collection ? 12 + specs.length * 4 : 0;
  const parts: Buffer[] = [];
  let size = top;
  const dirs: Buffer[] = [];
  const starts: number[] = [];
  // Every face's table directory first, then all the tables.
  const tables = specs.map(faceTables);
  for (const t of tables) {
    starts.push(size);
    const dir = Buffer.alloc(12 + t.length * 16);
    dirs.push(dir);
    size += dir.length;
  }
  tables.forEach((t, f) => {
    const dir = dirs[f]!;
    dir.writeUInt32BE(0x00010000, 0);
    dir.writeUInt16BE(t.length, 4);
    t.forEach(([tag, data], i) => {
      dir.write(tag, 12 + i * 16, 'latin1');
      dir.writeUInt32BE(size, 12 + i * 16 + 8);
      dir.writeUInt32BE(data.length, 12 + i * 16 + 12);
      parts.push(data);
      size += data.length;
    });
  });
  const header = Buffer.alloc(top);
  if (collection) {
    header.write('ttcf', 0, 'latin1');
    header.writeUInt32BE(0x00010000, 4);
    header.writeUInt32BE(specs.length, 8);
    starts.forEach((s, i) => header.writeUInt32BE(s, 12 + i * 4));
  }
  return Buffer.concat([header, ...dirs, ...parts]);
}

const reader =
  (b: Buffer): ReadAt =>
  async (offset, length) =>
    b.subarray(offset, offset + length);

const faces = (...specs: Spec[]) => readFaces(reader(fontFile(...specs)));

describe('reading a font file', () => {
  it('finds a Nerd Font: monospaced by its PANOSE, named by its typographic family (#547)', async () => {
    expect(await faces({ family: 'JetBrainsMono NF ExtraBold', typo: 'JetBrainsMono Nerd Font', proportion: 9, widths: [600, 600, 1200, 0] })).toEqual([{ family: 'JetBrainsMono Nerd Font', mono: true }]);
  });

  it('takes the post table’s fixed pitch', async () => {
    expect(await faces({ family: 'Menlo', fixedPitch: true })).toEqual([{ family: 'Menlo', mono: true }]);
  });

  it('counts a font with no flag whose glyphs are one narrow width (Monaco, Courier)', async () => {
    expect(await faces({ family: 'Monaco', unitsPerEm: 2048, widths: [1229, 1229, 1229, 1229, 1229, 1229, 1229, 1229, 1229, 1229, 0, 0] })).toEqual([{ family: 'Monaco', mono: true }]);
  });

  it('leaves out proportional, full-width (CJK, emoji) and non-Latin fixed-pitch faces', async () => {
    expect(await faces({ family: 'Arial' })).toEqual([{ family: 'Arial', mono: false }]);
    expect(await faces({ family: 'Hiragino Sans GB', widths: [1000, 1000, 1000, 1000] })).toEqual([{ family: 'Hiragino Sans GB', mono: false }]);
    expect(await faces({ family: 'Apple Braille', fixedPitch: true, latin: false })).toEqual([{ family: 'Apple Braille', mono: false }]);
  });

  it('reads every face of a collection (.ttc)', async () => {
    expect(await faces({ family: 'Courier', fixedPitch: true }, { family: 'Courier Bold', typo: 'Courier', fixedPitch: true })).toEqual([
      { family: 'Courier', mono: true },
      { family: 'Courier', mono: true },
    ]);
  });

  it('gives nothing for a file that isn’t a font', async () => {
    expect(await readFaces(reader(Buffer.from('not a font at all')))).toEqual([]);
    expect(await readFaces(reader(Buffer.alloc(0)))).toEqual([]);
  });
});

describe('the monospace families', () => {
  it('lists each once, by name, without hidden faces or (on a Mac) SF Mono, which web views can’t pick by name', () => {
    const list = monoFamilies(
      [
        { family: 'Menlo', mono: true },
        { family: 'menlo', mono: true },
        { family: 'Arial', mono: false },
        { family: '.SF NS Mono', mono: true },
        { family: 'SF Mono', mono: true },
        { family: 'Fira Code', mono: true },
      ],
      'darwin',
    );
    expect(list).toEqual(['Fira Code', 'Menlo']);
  });

  it('looks where each system keeps fonts, yours first', () => {
    expect(fontDirs('darwin', {}, '/Users/me')).toEqual(['/Users/me/Library/Fonts', '/Library/Fonts', '/Network/Library/Fonts', '/System/Library/Fonts']);
    expect(fontDirs('linux', {}, '/home/me')).toContain('/home/me/.local/share/fonts');
    expect(fontDirs('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', SystemRoot: 'C:\\Windows' }, 'C:\\Users\\me')).toEqual(['C:\\Users\\me\\AppData\\Local\\Microsoft\\Windows\\Fonts', 'C:\\Windows\\Fonts']);
  });
});

describe('the font folders', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds a Nerd Font installed on its own, in folders and collections, and skips the rest', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'beluga-fonts-'));
    mkdirSync(path.join(dir, 'nerd'));
    writeFileSync(path.join(dir, 'nerd', 'JetBrainsMonoNerdFont-Regular.ttf'), fontFile({ family: 'JetBrainsMono Nerd Font', proportion: 9 }));
    writeFileSync(path.join(dir, 'Courier.ttc'), fontFile({ family: 'Courier', fixedPitch: true }, { family: 'Courier', fixedPitch: true }));
    writeFileSync(path.join(dir, 'Arial.ttf'), fontFile({ family: 'Arial' }));
    writeFileSync(path.join(dir, 'broken.otf'), 'nope');
    writeFileSync(path.join(dir, 'readme.txt'), fontFile({ family: 'Not A Font File', fixedPitch: true }));
    expect(await listMonoFonts([dir, path.join(dir, 'missing')], 'darwin')).toEqual(['Courier', 'JetBrainsMono Nerd Font']);
  });
});

describe('Settings › Terminal › Font', () => {
  const installed = new Set(['Menlo', 'JetBrains Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMono Nerd Font Mono']);
  const has = (f: string): boolean => installed.has(f);
  const values = (o: ReadonlyArray<{ value: string }>): string[] => o.map((c) => c.value);

  it('offers a Nerd Font the daemon found installed (#547)', () => {
    const offered = values(fontChoices('', ['JetBrains Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMono Nerd Font Mono', 'Menlo'], has));
    expect(offered).toEqual(['', 'JetBrains Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMono Nerd Font Mono', 'Menlo']);
  });

  it('drops a font this window can’t draw, and keeps the one you picked', () => {
    expect(values(fontChoices('Gone Mono', ['Menlo', 'Gone Mono', 'Hidden Mono'], has))).toEqual(['', 'Menlo', 'Gone Mono']);
    expect(fontChoices('Gone Mono', ['Menlo'], has).at(-1)?.label).toBe('Gone Mono (not installed)');
  });

  it('falls back to the fonts it knows when the daemon hasn’t said', () => {
    expect(values(fontChoices('', [], has))).toEqual(['', 'Menlo', 'JetBrains Mono']);
  });
});

describe('the daemon’s font list in the state', () => {
  it('replaces the list, and keeps the same state when nothing changed', () => {
    const s1 = reduceWork(initialWork, { type: 'font_choices', fonts: ['Menlo', 'JetBrainsMono Nerd Font'] });
    expect(s1.fontChoices).toEqual(['Menlo', 'JetBrainsMono Nerd Font']);
    expect(reduceWork(s1, { type: 'font_choices', fonts: ['Menlo', 'JetBrainsMono Nerd Font'] })).toBe(s1);
  });
});
