import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import { GifReader } from 'omggif';
import { PNG } from 'pngjs';
import { type Bitmap, resize } from './bitmap.js';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg']);
/** Refuse absurd images before decoding (a 1 KB file can claim to be 100k×100k). */
export const MAX_PIXELS = 16_000_000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Longest side kept after decoding. A terminal never shows more than a few hundred pixels across. */
export const KEEP_SIDE = 800;

export function isImagePath(p: string): boolean {
  return IMAGE_EXTS.has(path.extname(p).toLowerCase());
}

type Format = 'png' | 'jpeg' | 'gif' | 'svg';

/** Sniff the format from the bytes, falling back to the file name. */
export function detectFormat(bytes: Uint8Array, name = ''): Format | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  if (path.extname(name).toLowerCase() === '.svg') return 'svg';
  return undefined;
}

function checkSize(width: number, height: number): void {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error('The image is empty');
  if (width * height > MAX_PIXELS) throw new Error(`The image is too large to show (${Math.round(width)}×${Math.round(height)})`);
}

/** PNG width/height from the IHDR chunk, read before anything is inflated. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || Buffer.from(bytes.subarray(12, 16)).toString('latin1') !== 'IHDR') throw new Error('The PNG is damaged');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function decodeGif(bytes: Uint8Array): Bitmap {
  const reader = new GifReader(Buffer.from(bytes));
  checkSize(reader.width, reader.height);
  const data = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, data);
  return { width: reader.width, height: reader.height, data };
}

/**
 * The SVG comes from someone else's computer. resvg never uses the network, but it
 * would load files from *this* disk named in an href (under any XML namespace prefix)
 * or a CSS url(), so only in-document (#id) and inline data: references are kept.
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/(\s(?:[\w.-]+:)?href\s*=\s*)(["'])(?!\s*(?:#|data:))[^"']*\2/gi, '$1$2$2')
    .replace(/\burl\(\s*(?:(["'])(?!\s*(?:#|data:))[^"']*\1|(?![#"'\s]|data:)[^)]*)\)/gi, 'url()');
}

/**
 * Whether an SVG draws text, so needs the system's fonts. Loading them takes resvg a while (whole
 * seconds on Windows), so an SVG without text skips it and looks the same.
 */
export function svgNeedsFonts(svg: string): boolean {
  return /<(?:[\w-]+:)?text[\s>/]/i.test(svg);
}

function decodeSvg(bytes: Uint8Array): Bitmap {
  const source = sanitizeSvg(Buffer.from(bytes).toString('utf8'));
  // Its size comes from the root element, never its text: no fonts needed to learn it.
  const probe = new Resvg(source, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } });
  if (!probe.width || !probe.height) throw new Error('The image is empty');
  // Rasterize so the longest side is KEEP_SIDE, whatever size the file claims to be.
  const zoom = KEEP_SIDE / Math.max(probe.width, probe.height);
  checkSize(probe.width * zoom, probe.height * zoom);
  if (Math.min(probe.width, probe.height) * zoom < 1) throw new Error('The image is too thin to show');
  const img = new Resvg(source, { fitTo: { mode: 'zoom', value: zoom }, font: { loadSystemFonts: svgNeedsFonts(source) } }).render();
  return { width: img.width, height: img.height, data: new Uint8Array(img.pixels) };
}

function decodeFull(bytes: Uint8Array, name: string): Bitmap {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('The image file is too large to show');
  switch (detectFormat(bytes, name)) {
    case 'png': {
      const size = pngSize(bytes);
      checkSize(size.width, size.height);
      const png = PNG.sync.read(Buffer.from(bytes));
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    }
    case 'jpeg': {
      const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 256 });
      return { width: img.width, height: img.height, data: img.data };
    }
    case 'gif':
      return decodeGif(bytes);
    case 'svg':
      return decodeSvg(bytes);
    default:
      throw new Error('Not an image Beluga can show (PNG, JPEG, GIF or SVG)');
  }
}

/**
 * Decode PNG, JPEG, GIF (first frame) or SVG into RGBA pixels, shrunk so the
 * longest side is at most `keepSide` (keeps memory small and later renders fast).
 */
export function decodeImage(bytes: Uint8Array, name = '', keepSide = KEEP_SIDE): Bitmap {
  const full = decodeFull(bytes, name);
  checkSize(full.width, full.height);
  const scale = keepSide / Math.max(full.width, full.height);
  return scale < 1 ? resize(full, full.width * scale, full.height * scale) : full;
}
