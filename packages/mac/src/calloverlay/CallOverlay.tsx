import { useEffect, useRef, useState } from 'react';
import { personColor } from '../components/ui.js';
import { draw, hasInk, tidyInk } from '../call/ink.js';
import { type Glide, POINTER_FADE_MS, POINTER_IDLE_MS, aim, step } from '../call/glide.js';
import { PROBE_PX } from '../call/leak-probe.js';
import { PointerMark, paintTag } from '../call/PointerMark.js';
import { type PointerTag, newTag, tagClicked, tagMoved } from '../call/pointer-tag.js';
import { PopList } from '../call/PopList.js';
import type { OverlayFace, OverlayState } from '../call/overlay.js';
import s from './overlay.module.css';

/** Hear what to show (now, and as it changes), from Beluga's window through the shell. */
function useOverlayState(): { state: OverlayState | null; offset: number } {
  const [got, setGot] = useState<{ state: OverlayState | null; offset: number }>({ state: null, offset: 0 });
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    // The two windows' clocks differ: line this one up with the sender's on each update.
    const take = (state: OverlayState | null): void => setGot({ state, offset: state ? performance.now() - state.now : 0 });
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<OverlayState | null>('call-overlay', (e) => take(e.payload)))
      .then(async (un) => {
        if (!alive) return un();
        off = un;
        const { invoke } = await import('@tauri-apps/api/core');
        take(await invoke<OverlayState | null>('call_overlay_state'));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return got;
}

/**
 * Over the screen you share (BLG-717): a soft frame that says it's on show, the others' sketches,
 * pointers and clicks where they made them, and what they write in the chat, bottom right,
 * dissolving. Nothing here takes the mouse. Pointers glide between updates (call/glide.ts), each
 * with its owner's face beside it and their name while they click or move (BLG-912).
 */
export function CallOverlay() {
  const { state, offset } = useOverlayState();
  const canvas = useRef<HTMLCanvasElement>(null);
  const glides = useRef(new Map<string, Glide>());
  const tags = useRef(new Map<string, PointerTag>());
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const lastFrame = useRef(0);
  // Faces come only when they change (call/overlay.ts): kept here between updates.
  const [faces, setFaces] = useState<Readonly<Record<string, OverlayFace>>>({});
  useEffect(() => {
    if (state?.faces) setFaces(state.faces);
  }, [state?.faces]);
  const who = Object.keys(state?.ink?.lasers ?? {});

  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext('2d');
    if (!el || !g) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(window.innerWidth * dpr);
    el.height = Math.round(window.innerHeight * dpr);
    const ink = state?.ink;
    if (!ink) {
      glides.current.clear();
      tags.current.clear();
      g.clearRect(0, 0, el.width, el.height);
      return;
    }
    // Each pointer heads for where it is now; ones that went, go.
    const here = performance.now();
    for (const by of [...glides.current.keys()]) {
      if (ink.lasers[by]) continue;
      glides.current.delete(by);
      tags.current.delete(by);
    }
    for (const [by, l] of Object.entries(ink.lasers)) {
      glides.current.set(by, aim(glides.current.get(by), l.x, l.y, here));
      const tag = tags.current.get(by);
      tags.current.set(by, tag ? tagMoved(tag, l.x, l.y, l.at) : newTag(l.x, l.y, l.at));
    }
    // A click by someone pointing opens their name (times here are the sharer's, like the ink's).
    for (const p of ink.pings) {
      const tag = tags.current.get(p.by);
      if (tag && p.at > (tag.clickAt ?? -Infinity)) tags.current.set(p.by, tagClicked(tag, p.at));
    }
    // Times in the ink are the sharer's: this window's clock, moved back by the offset.
    let raf = 0;
    const tick = (): void => {
      const t = performance.now();
      const dt = lastFrame.current ? (t - lastFrame.current) / 1000 : 0;
      lastFrame.current = t;
      const now = t - offset;
      const tidy = tidyInk(ink, now);
      const W = window.innerWidth;
      const H = window.innerHeight;
      draw(g, { ...tidy, lasers: {} }, { x: 0, y: 0, w: W, h: H }, now, personColor, dpr);
      for (const [by, glide] of glides.current) {
        const next = step(glide, dt);
        glides.current.set(by, next);
        const node = nodes.current.get(by);
        if (!node) continue;
        // Still for a while: it fades, the way the others' screens let it go.
        const still = now - (ink.lasers[by]?.at ?? now) - POINTER_IDLE_MS;
        node.style.transform = `translate3d(${next.x * W}px, ${next.y * H}px, 0)`;
        node.style.opacity = String(still <= 0 ? 1 : Math.max(0, 1 - still / POINTER_FADE_MS));
        const tag = tags.current.get(by);
        if (tag) paintTag(node, tag, now);
      }
      if (hasInk(tidy) || glides.current.size) raf = requestAnimationFrame(tick);
      else lastFrame.current = 0;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [state, offset]);

  return (
    <div className={s.overlay}>
      <canvas ref={canvas} className={s.ink} aria-hidden="true" />
      <div className={s.pointers} aria-hidden="true">
        {who.map((by) => (
          <PointerMark
            key={by}
            by={by}
            name={faces[by]?.name ?? 'Someone'}
            picture={faces[by]?.picture}
            style={{ opacity: 0 }}
            nodeRef={(node) => {
              if (node) nodes.current.set(by, node);
              else nodes.current.delete(by);
            }}
          />
        ))}
      </div>
      {state?.frame ? <div className={s.frame} aria-hidden="true" /> : null}
      {/* While Beluga checks the overlay stays out of what's shared (call/leak-probe.ts): under the screen's corner. */}
      {state?.probe ? <div className={s.probe} style={{ background: state.probe, width: PROBE_PX, height: PROBE_PX }} aria-hidden="true" /> : null}
      {state ? <PopList pops={state.pops} now={Date.now()} className={s.pops} /> : null}
    </div>
  );
}
