import { describe, expect, it } from 'vitest';
import { imageReadOf } from '../packages/mac/src/chat/steps/image-read.js';
import { dropHits, dropScale, droppedFiles, leftOutWords, sameBox } from '../packages/mac/src/chat/drop-model.js';
import { boxTakesFiles, carriesFiles, dropPosition } from '../packages/mac/src/lib/file-drop.js';

/** A step reading a picture shows its name as a badge (BLG-19). */
describe('image reads in steps', () => {
  const read = { kind: 'tool', tool: 'Read' };
  it('finds the picture a Read step reads, by its name only', () => {
    expect(imageReadOf(read, 'Read shots/home.png')).toEqual({ verb: 'Read', name: 'home.png', path: 'shots/home.png' });
    expect(imageReadOf(read, 'Reading /Users/k/Desktop/Screen Shot 1.HEIC')).toMatchObject({ verb: 'Reading', name: 'Screen Shot 1.HEIC' });
    for (const ext of ['jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'tiff', 'avif']) expect(imageReadOf(read, `Read a/b.${ext}`)?.name).toBe(`b.${ext}`);
    // A long path kept by its end.
    expect(imageReadOf(read, 'Reading …deep/deeper/shot.png')?.name).toBe('shot.png');
  });

  it('leaves other reads, other tools and thinking alone', () => {
    expect(imageReadOf(read, 'Read src/auth.ts')).toBeUndefined();
    expect(imageReadOf(read, 'Read a.png.txt')).toBeUndefined();
    expect(imageReadOf(read, 'Reading')).toBeUndefined();
    expect(imageReadOf({ kind: 'tool', tool: 'Edit' }, 'Read a.png')).toBeUndefined();
    expect(imageReadOf({ kind: 'thinking' }, 'Read a.png')).toBeUndefined();
  });

  it('reads a one-line step (no tool given) by its words', () => {
    expect(imageReadOf({ kind: 'tool' }, 'Read /tmp/x.png')?.name).toBe('x.png');
    expect(imageReadOf({ kind: 'tool' }, 'Ran npm test')).toBeUndefined();
  });
});

/** Files dragged from Finder onto a conversation (BLG-2). */
describe('Finder drops', () => {
  const box = { left: 100, top: 50, right: 500, bottom: 450 };
  it('hits the conversation in physical pixels, never a hidden one', () => {
    expect(dropHits(box, 200, 100)).toBe(true);
    expect(dropHits(box, 400, 200, 2)).toBe(true);
    expect(dropHits(box, 1200, 200, 2)).toBe(false);
    expect(dropHits(box, 50, 100)).toBe(false);
    expect(dropHits({ left: 0, top: 0, right: 0, bottom: 0 }, 0, 0)).toBe(false);
    expect(dropHits(undefined, 10, 10)).toBe(false);
  });

  // BLG-1000: the app says "physical", but on a Mac (and Linux) it gives the page's own pixels;
  // dividing by a Retina screen's 2 put a drop on the home composer up in the header.
  it('reads the drop where the pointer is, on a Retina Mac too', () => {
    expect(dropScale('mac', 2)).toBe(1);
    expect(dropScale('linux', 2)).toBe(1);
    expect(dropScale('windows', 1.5)).toBe(1.5);
    expect(dropScale('windows', 0)).toBe(1);
    const composer = { left: 300, top: 260, right: 1100, bottom: 520 };
    expect(dropHits(composer, 700, 400, dropScale('mac', 2))).toBe(true);
    expect(dropHits(composer, 1050, 600, dropScale('windows', 1.5))).toBe(true);
  });

  it('knows the same place', () => {
    expect(sameBox(box, { ...box })).toBe(true);
    expect(sameBox(box, { ...box, right: 501 })).toBe(false);
    expect(sameBox(undefined, undefined)).toBe(true);
    expect(sameBox(box, undefined)).toBe(false);
  });

  const dropped = [
    { path: '/a.png', kind: 'file' },
    { path: '/dir', kind: 'folder' },
    { path: '/b.txt', kind: 'file' },
    { path: '/gone', kind: 'missing' },
  ];

  it('keeps files and folders, in order, and counts what was gone', () => {
    const got = droppedFiles(dropped);
    expect(got.files.map((f) => f.path)).toEqual(['/a.png', '/dir', '/b.txt']);
    expect(got.folders).toEqual([]);
    expect(got.missing).toBe(1);
    expect(leftOutWords(got, 'this Mac')).toBe('1 item was gone');
  });

  it('leaves folders out for a chat on another computer, and says so', () => {
    const got = droppedFiles(dropped, { folders: false });
    expect(got.files.map((f) => f.path)).toEqual(['/a.png', '/b.txt']);
    expect(got.folders.map((f) => f.path)).toEqual(['/dir']);
    expect(leftOutWords(got, 'this Mac')).toBe('A folder stays on this Mac (drop the files in it instead), and 1 item was gone');
    expect(leftOutWords({ folders: [{}, {}], missing: 0 }, 'this Mac')).toBe('2 folders stay on this Mac (drop the files in them instead)');
    expect(leftOutWords({ folders: [], missing: 0 }, 'this Mac')).toBeUndefined();
  });
});

/** On Windows the page takes the drag itself (so a panel tab can be dragged too) and reports it as the app would. */
describe('files dropped on the page (Windows)', () => {
  it('takes a drag of files, never one of the page itself', () => {
    expect(carriesFiles(['Files'])).toBe(true);
    expect(carriesFiles(['text/plain', 'Files'])).toBe(true);
    expect(carriesFiles(['text/plain'])).toBe(false);
    expect(carriesFiles([])).toBe(false);
    expect(carriesFiles(undefined)).toBe(false);
  });

  it('attaches a dropped file once: by its path when the app hands it over, else by the box', () => {
    // Windows, in the app, a box that hears the app's drops: the app's path is the one.
    expect(boxTakesFiles({ platform: 'windows', inApp: true, hearsAppDrops: true })).toBe(false);
    // A box that doesn't hear them (the plan ask) takes the drop itself.
    expect(boxTakesFiles({ platform: 'windows', inApp: true, hearsAppDrops: false })).toBe(true);
    // The web version has no paths: the box takes it.
    expect(boxTakesFiles({ platform: 'windows', inApp: false, hearsAppDrops: true })).toBe(true);
    // A Mac and Linux: the page only sees its own drags (Finder's go to the app), as before.
    expect(boxTakesFiles({ platform: 'mac', inApp: true, hearsAppDrops: true })).toBe(true);
    expect(boxTakesFiles({ platform: 'linux', inApp: true, hearsAppDrops: true })).toBe(true);
  });

  it('says where in the units the app uses, so the same place is hit at any scaling', () => {
    const box = { left: 100, top: 50, right: 500, bottom: 450 };
    for (const dpr of [1, 1.5, 2]) {
      const scale = dropScale('windows', dpr);
      const at = dropPosition(200, 100, scale);
      expect(at).toEqual({ x: 200 * dpr, y: 100 * dpr });
      expect(dropHits(box, at.x, at.y, scale)).toBe(true);
      const out = dropPosition(600, 100, scale);
      expect(dropHits(box, out.x, out.y, scale)).toBe(false);
    }
  });
});
