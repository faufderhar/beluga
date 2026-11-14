import { describe, expect, it } from 'vitest';
import { GLIDE_S, POINTER_IDLE_MS, aim, glideAlpha, settled, step } from '../packages/mac/src/call/glide.js';
import { NO_INK, SKETCH_FADE_MS, SKETCH_HOLD_MS, applyInk, boxPoints, hasInk, holdSketch, releaseSketch, sketchBox, tidyInk } from '../packages/mac/src/call/ink.js';
import { BLANKS_TO_TRUST, MISSES_TO_CLEAN, NEW_PROBE, PROBE_COLORS, type ProbeState, isProbe, judge, probeColor } from '../packages/mac/src/call/leak-probe.js';
import { TAG_IDLE_MS, TAG_STILL_MOVE, TAG_WAKE_MOVE, newTag, tagClicked, tagMoved, tagOpen } from '../packages/mac/src/call/pointer-tag.js';
import { parseStage } from '../src/shared/calls.js';

const stroke = (by: string, id: string) => ({ k: 'ink' as const, by, id, color: '#a3c9f7', pts: [0.2, 0.2, 0.4, 0.4], done: true });

describe('a pointer’s face and name (BLG-912)', () => {
  it('opens as it appears, stays open while it moves, folds into the face once it rests', () => {
    let t = newTag(0.5, 0.5, 0);
    expect(tagOpen(t, 0)).toBe(true);
    t = tagMoved(t, 0.6, 0.5, 1_000);
    expect(tagOpen(t, 1_000 + TAG_IDLE_MS - 1)).toBe(true);
    expect(tagOpen(t, 1_000 + TAG_IDLE_MS)).toBe(false);
  });

  it('the same spot sent again isn’t a move: a pointer resting still folds', () => {
    const t = newTag(0.5, 0.5, 0);
    expect(tagMoved(t, 0.5, 0.5, 500)).toBe(t);
    expect(tagMoved(t, 0.5 + TAG_STILL_MOVE / 2, 0.5, 900)).toBe(t);
    expect(tagOpen(tagMoved(t, 0.5, 0.5, TAG_IDLE_MS - 10), TAG_IDLE_MS)).toBe(false);
  });

  it('folded, a hand resting on the mouse doesn’t open it; a real move does', () => {
    const folded = newTag(0.5, 0.5, 0);
    const later = TAG_IDLE_MS + 100;
    const jitter = tagMoved(folded, 0.5 + TAG_WAKE_MOVE / 2, 0.5, later);
    expect(jitter).toBe(folded);
    expect(tagOpen(jitter, later)).toBe(false);
    const moved = tagMoved(folded, 0.5 + TAG_WAKE_MOVE * 2, 0.5, later);
    expect(tagOpen(moved, later)).toBe(true);
  });

  it('a click opens it and pops, and an older click never shortens a newer move', () => {
    const folded = newTag(0.2, 0.2, 0);
    const later = TAG_IDLE_MS * 2;
    const clicked = tagClicked(folded, later);
    expect(tagOpen(clicked, later + 10)).toBe(true);
    expect(clicked.clickAt).toBe(later);
    const moved = tagMoved(clicked, 0.4, 0.4, later + 500);
    expect(tagClicked(moved, later + 100).at).toBe(later + 500);
  });
});

describe('pointers glide on the others’ screens (BLG-733)', () => {
  it('appears where it is first seen, then follows smoothly without overshooting', () => {
    let g = aim(undefined, 0.2, 0.3, 0);
    expect([g.x, g.y]).toEqual([0.2, 0.3]);
    g = aim(g, 0.8, 0.3, 16);
    const xs: number[] = [];
    for (let i = 0; i < 30; i++) {
      g = step(g, 1 / 60);
      xs.push(g.x);
    }
    // Every frame closer, never past it.
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
    expect(Math.max(...xs)).toBeLessThanOrEqual(0.8 + 1e-9);
    // Within a few frames of the spring's time it's (almost) there.
    expect(xs[Math.ceil((GLIDE_S * 4) * 60)]!).toBeGreaterThan(0.79);
    expect(settled(step(g, 1))).toBe(true);
  });

  it('a window that slept doesn’t fling it; a still pointer fades, then goes', () => {
    const g = step(aim(aim(undefined, 0, 0, 0), 1, 1, 0), 30);
    expect(g.x).toBeLessThanOrEqual(1);
    expect(glideAlpha(g, POINTER_IDLE_MS - 1)).toBe(1);
    expect(glideAlpha(g, POINTER_IDLE_MS + 300)).toBeGreaterThan(0);
    expect(glideAlpha(g, POINTER_IDLE_MS + 5_000)).toBe(0);
  });

  it('Beluga says it has the fast pointer channel; older ones don’t, and get pointers the old way', () => {
    expect(parseStage('{"k":"streams","by":"a","cam":"c1","pointers":true}')).toMatchObject({ pointers: true });
    expect(parseStage('{"k":"streams","by":"a","cam":"c1"}')).not.toHaveProperty('pointers');
  });
});

describe('sketches dissolve, and Ask keeps the one it’s about (BLG-734)', () => {
  it('a held sketch stays however old; let go, it lasts a moment more, then dissolves', () => {
    const ink = holdSketch(applyInk(NO_INK, stroke('a', 's1'), 0), 'a');
    expect(hasInk(tidyInk(ink, 60_000))).toBe(true);
    const freed = releaseSketch(tidyInk(ink, 60_000), 60_000);
    expect(freed.hold).toBeUndefined();
    expect(tidyInk(freed, 60_000 + SKETCH_HOLD_MS).strokes).toHaveLength(1);
    expect(tidyInk(freed, 60_000 + SKETCH_HOLD_MS + SKETCH_FADE_MS + 1).strokes).toHaveLength(0);
  });

  it('holding yours never keeps someone else’s', () => {
    const ink = holdSketch(applyInk(applyInk(NO_INK, stroke('a', 's1'), 0), stroke('b', 't1'), 0), 'a');
    expect(tidyInk(ink, 30_000).strokes.map((s) => s.by)).toEqual(['a']);
  });
});

describe('a box is a stroke along its sides (BLG-735)', () => {
  it('goes round all four corners and back, whichever way it was dragged', () => {
    const pts = boxPoints(0.6, 0.7, 0.2, 0.3);
    const xs = pts.filter((_, i) => i % 2 === 0);
    const ys = pts.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeCloseTo(0.2);
    expect(Math.max(...xs)).toBeCloseTo(0.6);
    expect(Math.min(...ys)).toBeCloseTo(0.3);
    expect(Math.max(...ys)).toBeCloseTo(0.7);
    // Sent as ink: within what every Beluga accepts, and Ask covers exactly the box (with its room).
    expect(parseStage(JSON.stringify({ ...stroke('a', 'b1'), pts }))).toBeDefined();
    const ink = applyInk(NO_INK, { ...stroke('a', 'b1'), pts }, 0);
    const [x, y, w, h] = sketchBox(ink.strokes, 'a')!;
    expect([x, y, w, h].map((v) => Math.round(v * 100) / 100)).toEqual([0.16, 0.26, 0.48, 0.48]);
  });
});

describe('the sharer’s overlay stays out of what they share (BLG-736)', () => {
  const pixel = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const run = (readings: Array<[number, number, number] | undefined>): ProbeState => readings.reduce<ProbeState>((p, r) => judge(p, r), NEW_PROBE);

  it('both probe colours found in the capture, in turn: it’s in the picture', () => {
    let p = NEW_PROBE;
    p = judge(p, pixel(probeColor(p)));
    expect(p.verdict).toBe('unknown');
    p = judge(p, pixel(probeColor(p)));
    expect(p.verdict).toBe('leaks');
    // A capture shifts colours a little: still found.
    expect(isProbe([240, 20, 230], PROBE_COLORS[0])).toBe(true);
  });

  it('a corner that is the probe colour by chance once isn’t enough; not found, it’s out', () => {
    expect(run([pixel(PROBE_COLORS[0]), pixel(PROBE_COLORS[0])]).verdict).toBe('unknown');
    expect(run(Array.from({ length: MISSES_TO_CLEAN }, () => [30, 30, 30] as [number, number, number])).verdict).toBe('clean');
    // No frames to read: after a while macOS is trusted, as before.
    expect(run(Array.from({ length: BLANKS_TO_TRUST }, () => undefined)).verdict).toBe('clean');
  });
});
