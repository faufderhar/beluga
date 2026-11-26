import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dataUrlBytes } from '../packages/mac/src/lib/data-url.js';

/** Copy Image reads a picture's bytes itself: the app's CSP refuses fetch on data: and blob: URLs. */
describe('dataUrlBytes', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255]);
  const url = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;

  it('decodes a PNG data URL to its exact bytes', () => {
    expect(dataUrlBytes(url, 'image/png')).toEqual(png);
  });

  it('leaves other URLs and types to the caller', () => {
    expect(dataUrlBytes('blob:http://localhost/abc', 'image/png')).toBeUndefined();
    expect(dataUrlBytes(url.replace('image/png', 'image/jpeg'), 'image/png')).toBeUndefined();
    expect(dataUrlBytes('data:image/png;base64,***', 'image/png')).toBeUndefined();
  });

  it('is what the share sheet and chat copy with, never fetch', () => {
    const share = readFileSync(new URL('../packages/mac/src/views/usage/ShareSheet.tsx', import.meta.url), 'utf8');
    const images = readFileSync(new URL('../packages/mac/src/chat/images.ts', import.meta.url), 'utf8');
    expect(share).toContain('copyPng(pngOf(png))');
    expect(share).not.toMatch(/fetch\(png\)/);
    expect(images).not.toMatch(/await fetch\(url\)/);
  });
});
