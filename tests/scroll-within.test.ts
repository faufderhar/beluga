import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scrollTopFor } from '../packages/mac/src/lib/scroll-within.js';

describe('scrollTopFor', () => {
  it('leaves a row that already shows where it is', () => {
    expect(scrollTopFor(100, 300, 40, 60, 'nearest')).toBe(100);
  });

  it('scrolls up just enough for a row above the view', () => {
    expect(scrollTopFor(100, 300, -30, -10, 'nearest')).toBe(70);
  });

  it('scrolls down just enough for a row below the view', () => {
    expect(scrollTopFor(100, 300, 310, 330, 'nearest')).toBe(130);
  });

  it('puts the top of a row taller than the view at the top', () => {
    expect(scrollTopFor(0, 100, 50, 250, 'nearest')).toBe(50);
  });

  it('centers a line, never above the start', () => {
    expect(scrollTopFor(0, 300, 500, 520, 'center')).toBe(360);
    expect(scrollTopFor(0, 300, 20, 40, 'center')).toBe(0);
  });
});

describe('the Files panel scrolls only its own list', () => {
  // scrollIntoView also scrolls the window's clipped boxes, leaving the app shifted up for good.
  it.each(['packages/mac/src/layout/panel/ContentSearch.tsx', 'packages/mac/src/layout/panel/FilesTab.tsx', 'packages/mac/src/views/reader/reveal.ts'])('%s', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(/\.scrollIntoView\(/);
  });
});
