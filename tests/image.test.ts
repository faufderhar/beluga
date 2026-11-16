import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { createBitmap, fitPixels, resize } from '../src/image/bitmap.js';
import { decodeImage, detectFormat, isImagePath, sanitizeSvg, svgNeedsFonts } from '../src/image/decode.js';

function png(w: number, h: number, rgba: [number, number, number, number]): Buffer {
  const img = new PNG({ width: w, height: h });
  for (let i = 0; i < img.data.length; i += 4) img.data.set(rgba, i);
  return PNG.sync.write(img);
}

describe('image engine', () => {
  it('recognizes image files by name and by bytes', () => {
    expect(isImagePath('a/b/Photo.JPG')).toBe(true);
    expect(isImagePath('notes.md')).toBe(false);
    expect(detectFormat(png(1, 1, [0, 0, 0, 255]))).toBe('png');
    expect(detectFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    expect(detectFormat(Buffer.from('hello'))).toBeUndefined();
  });

  it('decodes PNG, JPEG and SVG to RGBA', () => {
    const p = decodeImage(png(3, 2, [255, 0, 0, 255]));
    expect([p.width, p.height, p.data[0], p.data[3]]).toEqual([3, 2, 255, 255]);

    const raw = { width: 4, height: 4, data: Buffer.alloc(64, 200) };
    const j = decodeImage(jpeg.encode(raw, 90).data);
    expect([j.width, j.height]).toEqual([4, 4]);

    const s = decodeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="5"><rect width="10" height="5" fill="#00ff00"/></svg>'));
    expect(s.width / s.height).toBeCloseTo(2);
    expect(s.data[1]).toBe(255);
  });

  it('loads the system fonts only for an SVG that draws text (slow on Windows)', () => {
    expect(svgNeedsFonts('<svg><text x="1">Hi</text></svg>')).toBe(true);
    expect(svgNeedsFonts('<svg><svg:text>Hi</svg:text></svg>')).toBe(true);
    expect(svgNeedsFonts('<svg><text\n x="1">Hi</text></svg>')).toBe(true);
    expect(svgNeedsFonts('<svg><rect width="1" height="1"/><textPath/></svg>')).toBe(false);
    expect(svgNeedsFonts('<svg><title>text</title><rect/></svg>')).toBe(false);
  });

  it('rejects non-images with a friendly message', () => {
    expect(() => decodeImage(Buffer.from('just text'))).toThrow(/PNG, JPEG, GIF or SVG/);
  });

  it('area-averages when shrinking, so detail blends instead of vanishing', () => {
    const b = createBitmap(2, 1);
    b.data.set([255, 255, 255, 255, 0, 0, 0, 255]);
    const one = resize(b, 1, 1);
    expect(one.data[0]).toBe(128);
  });

  it('ignores transparent pixels when averaging color', () => {
    const b = createBitmap(2, 1);
    b.data.set([255, 0, 0, 255, 0, 0, 0, 0]);
    const one = resize(b, 1, 1);
    expect([one.data[0], one.data[3]]).toEqual([255, 128]);
  });

  it('fits within the cell box keeping aspect (a cell is 1×2 pixels)', () => {
    expect(fitPixels({ width: 1000, height: 500 }, 80, 100)).toEqual({ width: 80, height: 40 });
    expect(fitPixels({ width: 500, height: 1000 }, 80, 20)).toEqual({ width: 20, height: 40 });
    expect(fitPixels({ width: 8, height: 8 }, 80, 20)).toEqual({ width: 8, height: 8 });
    expect(fitPixels({ width: 8, height: 8 }, 80, 20, true)).toEqual({ width: 40, height: 40 });
  });
});

describe('untrusted images', () => {
  it('rejects a PNG that claims huge dimensions before inflating anything', () => {
    const tiny = png(1, 1, [0, 0, 0, 255]);
    tiny.writeUInt32BE(20000, 16);
    tiny.writeUInt32BE(20000, 20);
    const started = Date.now();
    expect(() => decodeImage(tiny)).toThrow(/too large/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('rasterizes even extreme SVG aspect ratios at a bounded size', () => {
    const started = Date.now();
    expect(() => decodeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="20000"><rect width="1" height="20000" fill="red"/></svg>'))).toThrow(/too thin/);
    const tall = decodeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20000"><rect width="100" height="20000" fill="red"/></svg>'));
    expect(Math.max(tall.width, tall.height)).toBeLessThanOrEqual(800);
    // A backstop, the size above being the real check: unshrunk (800 × 160,000 px) takes far longer.
    // Loaded CI runners took 5.8 s for this (macOS, PR #273), so the budget is generous.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('strips references to local files from SVGs across any XML namespace prefix and CSS url(), keeping #ids and data: URLs', () => {
    expect(sanitizeSvg('<image href="/etc/secret.png"/>')).toBe('<image href=""/>');
    expect(sanitizeSvg("<image xlink:href='file:///Users/me/a.png'/>")).toBe("<image xlink:href=''/>");
    expect(sanitizeSvg('<svg xmlns:a="http://www.w3.org/1999/xlink"><image a:href="/etc/secret.png"/></svg>')).toBe('<svg xmlns:a="http://www.w3.org/1999/xlink"><image a:href=""/></svg>');
    expect(sanitizeSvg('<feImage ns-1.2:href="/etc/secret.png"/>')).toBe('<feImage ns-1.2:href=""/>');
    expect(sanitizeSvg('<rect fill="url(/etc/secret.svg#p)" style="filter: url(\x27file:///a.svg#f\x27)"/>')).toBe('<rect fill="url()" style="filter: url()"/>');
    expect(sanitizeSvg('<use href="#dot" xlink:href="#dot"/>')).toBe('<use href="#dot" xlink:href="#dot"/>');
    expect(sanitizeSvg('<rect fill="url(#grad)" stroke="url(\x27#grad\x27)"/>')).toBe('<rect fill="url(#grad)" stroke="url(\x27#grad\x27)"/>');
    expect(sanitizeSvg('<image href="data:image/png;base64,AAAA"/>')).toBe('<image href="data:image/png;base64,AAAA"/>');

    const dir = mkdtempSync(path.join(tmpdir(), 'beluga-svg-ns-'));
    try {
      const secret = path.join(dir, 'secret.png');
      writeFileSync(secret, png(4, 4, [255, 0, 0, 255]));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:a="http://www.w3.org/1999/xlink" width="4" height="4"><image a:href="${secret}" width="4" height="4"/></svg>`;
      const bmp = decodeImage(Buffer.from(svg));
      expect(Array.from(bmp.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps at most 800px on the longest side after decoding', () => {
    const big = decodeImage(png(1600, 400, [1, 2, 3, 255]));
    expect([big.width, big.height]).toEqual([800, 200]);
  });
});
