import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachmentLabel,
  chipText,
  droppedImagePaths as dropped,
  expandChips,
  formatBytes,
  importImage,
  isOwnImageFile,
  insertChip,
  linkedImages,
  mediaTypeOf,
  publishForRoom,
  registerAttachment,
  withImagePaths,
} from '../src/core/attachments.js';
import { imageContent } from '../src/agent/runtime/claude/runner.js';

describe('image chips', () => {
  it('inserts a chip at the cursor with spacing', () => {
    expect(insertChip('', 0, '[image 1]')).toEqual({ buffer: '[image 1] ', cursor: 10 });
    expect(insertChip('look', 4, '[image 2]')).toEqual({ buffer: 'look [image 2] ', cursor: 15 });
    expect(insertChip('a  b', 2, '[image 3]')).toEqual({ buffer: 'a [image 3] b', cursor: 12 });
  });

  it('turns chips into image links on send, leaving unknown ones', () => {
    const a = registerAttachment('/x/attachments/20260101-1.png', 120 * 1024);
    expect(attachmentLabel(a)).toBe(`📎 image ${a.n} (png, 120K)`);
    const out = expandChips(`what is this? ${chipText(a.n)} and [image 999]`, 'me');
    expect(out.text).toBe(`what is this? [📎 image ${a.n} (png, 120K)](klaud-attachment:me/20260101-1.png) and [image 999]`);
    expect(out.attachments).toEqual([a]);
    expect(formatBytes(500)).toBe('500B');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0M');
  });

  it('links the box’s own numbers: "[image 1]" is the image the box numbered 1, and says so', () => {
    registerAttachment('/x/attachments/20260101-2.png', 1024);
    const b = registerAttachment('/x/attachments/20260101-3.png', 2048);
    // The session counted past 1, the box numbered its only image 1.
    expect(b.n).toBeGreaterThan(1);
    const out = expandChips('see [image 1], not [image 2]', 'me', undefined, [b.n], [1]);
    expect(out.text).toBe('see [📎 image 1 (png, 2K)](klaud-attachment:me/20260101-3.png), not [image 2]');
    expect(out.attachments).toEqual([b]);
    // Its session number isn't one the box shows, so it stays words.
    expect(expandChips(`[image ${b.n}]`, 'me', undefined, [b.n], [1]).text).toBe(`[image ${b.n}]`);
  });

  it('recognizes dragged-in image paths (a Mac’s, where a backslash escapes)', () => {
    const exists = (p: string) => p.startsWith('/img/');
    const droppedImagePaths = (text: string, has: (p: string) => boolean) => dropped(text, has, 'darwin');
    expect(droppedImagePaths('/img/My\\ Shot.png ', exists)).toEqual(['/img/My Shot.png']);
    expect(droppedImagePaths("'/img/a b.jpg' /img/c.gif", exists)).toEqual(['/img/a b.jpg', '/img/c.gif']);
    expect(droppedImagePaths('file:///img/x%20y.png', exists)).toEqual(['/img/x y.png']);
    expect(droppedImagePaths('/img/notes.txt', exists)).toBeUndefined();
    expect(droppedImagePaths('/other/a.png', exists)).toBeUndefined();
    expect(droppedImagePaths('hello world', exists)).toBeUndefined();
    expect(droppedImagePaths('', exists)).toBeUndefined();
  });
});

describe('images for Claude', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-att-'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  writeFileSync(path.join(dir, 'a.png'), png);
  mkdirSync(path.join(dir, 'room'));
  writeFileSync(path.join(dir, 'room', 'b.jpg'), png);

  it('finds only linked images that are in the attachments folder', () => {
    const prompt = '[x](klaud-attachment:me/a.png) [y](klaud-attachment:me/b.jpg) [z](klaud-attachment:me/missing.png) [w](klaud-attachment:me/notes.txt)';
    expect(linkedImages(prompt, dir)).toEqual([path.join(dir, 'a.png'), path.join(dir, 'room', 'b.jpg')]);
    expect(linkedImages('klaud-attachment:me/../secret.png', dir)).toEqual([]);
    expect(mediaTypeOf('a.JPG')).toBe('image/jpeg');
  });

  it('points linked images at their files for an answer Claude reads as text', () => {
    const answer = 'like this [📎 image 1 (png, 1K)](klaud-attachment:me/a.png), not [x](klaud-attachment:me/missing.png)';
    expect(withImagePaths(answer, dir)).toBe(`like this [📎 image 1 (png, 1K)](${path.join(dir, 'a.png')}), not [x](klaud-attachment:me/missing.png)`);
    // Only an image right in the folder (the one your own run may Read): a room copy stays a link.
    expect(withImagePaths('[y](klaud-attachment:me/b.jpg)', dir)).toBe('[y](klaud-attachment:me/b.jpg)');
    expect(withImagePaths('klaud-attachment:me/../secret.png', dir)).toBe('klaud-attachment:me/../secret.png');
    expect(withImagePaths('klaud-attachment:me/a\\..\\x.png', dir)).toBe('klaud-attachment:me/a\\..\\x.png');
  });

  it('knows an image right in the folder, where it really is', () => {
    expect(isOwnImageFile(path.join(dir, 'a.png'), dir)).toBe(true);
    expect(isOwnImageFile(path.join(dir, 'room', 'b.jpg'), dir)).toBe(false);
    expect(isOwnImageFile(path.join(dir, 'missing.png'), dir)).toBe(false);
    expect(isOwnImageFile(dir, dir)).toBe(false);
  });

  it('sends images as content blocks next to the text', async () => {
    expect(imageContent('hi', [])).toBe('hi');
    const content = imageContent('hi', [path.join(dir, 'a.png')]) as Array<{ type: string; source?: { data: string; media_type: string } }>;
    expect(content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(content[1]?.source).toEqual({ type: 'base64', media_type: 'image/png', data: png.toString('base64') });
  });

  it('copies images in, and out for the room', async () => {
    const copy = await importImage(path.join(dir, 'a.png'), path.join(dir, 'in'));
    expect(readFileSync(copy)).toEqual(png);
    const a = registerAttachment(copy, png.length);
    const name = publishForRoom(a, path.join(dir, 'out'));
    expect(readFileSync(path.join(dir, 'out', name))).toEqual(png);
  });
});

describe('an image linked into an answer', () => {
  it("stays in Beluga's own folder: secret, and never sent (only your own run's Read of it is let through, policy.ts)", async () => {
    const { attachmentsDir } = await import('../src/core/attachments.js');
    const { isSecretPath } = await import('../src/core/shares.js');
    expect(isSecretPath(path.join(attachmentsDir(), 'shot.png'))).toBe(true);
    expect(isSecretPath(path.join(attachmentsDir(), 'received', 'f-shot.png'))).toBe(true);
  });
});
