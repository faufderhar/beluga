import { afterEach, describe, expect, it, vi } from 'vitest';

// Root CI installs only the root packages: the hooks' React Flow import is never called here.
vi.mock('@xyflow/react', () => ({}));
const { gliding, sharpen, snap } = await import('../packages/mac/src/components/graph/sharp-zoom.js');

/** Plan canvas text stays crisp when zoomed in (KLD-70, checked for the real app in KLD-81). */

describe('snap: the view lands on whole device pixels', () => {
  it('rounds to the nearest device pixel on a Retina screen', () => {
    expect(snap(10.3, 2)).toBe(10.5);
    expect(snap(10.2, 2)).toBe(10);
    expect(snap(-33.74, 2)).toBe(-33.5);
  });

  it('rounds to whole pixels at 1x and leaves whole device pixels alone', () => {
    expect(snap(7.6, 1)).toBe(8);
    expect(snap(12.5, 2)).toBe(12.5);
    expect(snap(0, 2)).toBe(0);
  });
});

describe('sharpen: the zoomed layer is rebuilt at its current scale', () => {
  const frames: (() => void)[] = [];
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => frames.push(f));
  const flush = (): void => {
    while (frames.length) frames.shift()!();
  };
  const layer = (transform: string) => ({ style: { transform }, dataset: {} as Record<string, string> }) as unknown as HTMLElement;
  afterEach(() => void (frames.length = 0));

  it('nudges into 3D for two frames, then puts back exactly what React Flow wrote', () => {
    const el = layer('translate(10.5px, 20px) scale(2.5)');
    sharpen(el);
    expect(el.style.transform).toBe('translate(10.5px, 20px) scale(2.5) translateZ(0)');
    expect(el.dataset.sharpened).toBeDefined();
    frames.shift()!();
    expect(el.style.transform).toContain('translateZ');
    flush();
    expect(el.style.transform).toBe('translate(10.5px, 20px) scale(2.5)');
  });

  it('strips the nudge as WebKit reads it back, and keeps a move React Flow made meanwhile', () => {
    const el = layer('translate(0px, 0px) scale(3)');
    sharpen(el);
    el.style.transform = 'translate(4px, 8px) scale(3) translateZ(0px)';
    flush();
    expect(el.style.transform).toBe('translate(4px, 8px) scale(3)');
  });

  it('never stacks nudges when sharpened twice, and leaves an untransformed layer alone', () => {
    const el = layer('translate(1px, 1px) scale(2)');
    sharpen(el);
    sharpen(el);
    expect(el.style.transform.match(/translateZ/g)).toHaveLength(1);
    flush();
    expect(el.style.transform).toBe('translate(1px, 1px) scale(2)');

    const bare = layer('');
    sharpen(bare);
    expect(bare.style.transform).toBe('');
    expect(frames).toHaveLength(0);
  });
});

describe('gliding: the view is on its way somewhere (BLG-931)', () => {
  it('sees a running d3 transition on the zoom pane, so settling never stops Fit to View halfway', () => {
    expect(gliding({ __transition: { 3: {} } } as unknown as Element)).toBe(true);
  });

  it('is still once the transitions are gone, or there is no pane', () => {
    expect(gliding({ __transition: {} } as unknown as Element)).toBe(false);
    expect(gliding({} as Element)).toBe(false);
    expect(gliding(null)).toBe(false);
    expect(gliding(undefined)).toBe(false);
  });
});
