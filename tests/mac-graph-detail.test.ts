import { describe, expect, it } from 'vitest';
import { BUSY_FROM, LIGHT_BELOW, detailAt } from '../packages/mac/src/components/graph/detail.js';

/** A busy board's What Waits on What draws lighter only when zoomed out (BLG-931). */

describe('detailAt: how much a graph draws at a zoom', () => {
  it('leaves a small graph alone at any zoom', () => {
    expect(detailAt(BUSY_FROM - 1, 0.1)).toBeUndefined();
    expect(detailAt(12, 1)).toBeUndefined();
  });

  it('draws a busy graph in full where its words read, lighter below that', () => {
    expect(detailAt(BUSY_FROM, 1)).toBe('full');
    expect(detailAt(440, 0.65)).toBe('full');
    expect(detailAt(440, LIGHT_BELOW)).toBe('full');
    expect(detailAt(440, LIGHT_BELOW - 0.01)).toBe('light');
    expect(detailAt(440, 0.08)).toBe('light');
  });

  it('opens a busy board in full: it opens at a zoom whose words read (graph-pack START_ZOOM)', async () => {
    const { START_ZOOM } = await import('../src/shared/render/graph-pack.js');
    expect(detailAt(440, START_ZOOM)).toBe('full');
  });
});
