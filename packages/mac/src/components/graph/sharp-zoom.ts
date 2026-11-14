import { useEffect, useRef } from 'react';
import { useOnViewportChange, useStore, useStoreApi } from '@xyflow/react';

/** How long the view must sit still before it's redrawn sharp. */
export const SETTLE_MS = 120;
/** The nudge as written, and as the browser reads it back (`translateZ(0px)`): React Flow's own transform never has one. */
const NUDGE = ' translateZ(0)';
const NUDGED = /\s*translateZ\([^)]*\)/g;

/**
 * Text stays sharp at every zoom (KLD-25). React Flow zooms with `transform: scale()` on `.react-flow__viewport`.
 * In WKWebView, once that layer is composited (anything inside it animating transform or opacity), it keeps the
 * bitmap it was rasterized at and zooming past it just stretches the pixels. So once a zoom or pan settles,
 * nudge the layer: for two frames it gets `translateZ(0)` and then loses it, which makes WebKit rebuild its
 * backing at the current scale. Chromium re-rasterizes on its own; there the nudge is harmless.
 *
 * Call inside a ReactFlowProvider. Keep blur (filter, backdrop-filter) off anything inside the viewport.
 */
export function useSharpZoom(): void {
  const store = useStoreApi();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settle = (): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const { domNode, panZoom, transform } = store.getState();
      // The view is gliding somewhere (Fit to View, a step): setting it now would stop it where it is. It settles when it lands.
      if (gliding(domNode?.querySelector('.react-flow__renderer'))) return settle();
      // A view left between device pixels draws every glyph soft: snap it to whole ones (KLD-70). Moving it
      // fires another change, so this settles once more with nothing left to snap, and is redrawn then.
      const [x, y, zoom] = transform;
      const sx = snap(x);
      const sy = snap(y);
      if (panZoom && (sx !== x || sy !== y)) return void panZoom.setViewport({ x: sx, y: sy, zoom });
      const el = domNode?.querySelector<HTMLElement>('.react-flow__viewport');
      if (el) sharpen(el);
    }, SETTLE_MS);
  };
  useOnViewportChange({ onChange: settle, onEnd: settle });
  // Nodes that glided to a new place (a re-cut plan) were composited while they moved: redraw once they stop.
  const dom = useStore((s) => s.domNode);
  useEffect(() => {
    const moved = (e: TransitionEvent): void => {
      if (e.propertyName === 'transform') settle();
    };
    dom?.addEventListener('transitionend', moved);
    return () => dom?.removeEventListener('transitionend', moved);
  }, [dom]);
  useEffect(() => () => clearTimeout(timer.current), []);
}

/** React Flow is animating the view: d3 keeps the element's running transitions on it (`__transition`) until they end. */
export const gliding = (pane: Element | null | undefined): boolean => {
  const running = (pane as { __transition?: object } | null | undefined)?.__transition;
  return !!running && Object.keys(running).length > 0;
};

/** The nearest whole device pixel. */
export const snap = (v: number, dpr = globalThis.devicePixelRatio || 1): number => Math.round(v * dpr) / dpr;

/** Re-rasterize a scaled layer at its current scale. */
export function sharpen(el: HTMLElement): void {
  const plain = el.style.transform.replace(NUDGED, '');
  if (!plain) return;
  el.style.transform = plain + NUDGE;
  el.dataset.sharpened = String(Date.now());
  // Two frames: the first commits the 3D layer, the second drops it. React Flow may have moved the view
  // meanwhile (its own transform then has no nudge), so only strip what we added. Read back, the nudge is
  // `translateZ(0px)`, so match it by pattern: an exact match never strips it and the layer stays 3D.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      el.style.transform = el.style.transform.replace(NUDGED, '');
    }),
  );
}
