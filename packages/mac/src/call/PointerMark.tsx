import type { CSSProperties } from 'react';
import { Avatar, personColor } from '../components/ui.js';
import { POINTER_PATH } from './ink.js';
import { type PointerTag, TAG_IDLE_MS, newTag, tagClicked, tagMoved, tagOpen } from './pointer-tag.js';
import p from './pointer.module.css';

/** The face's size beside the arrow (px). */
const FACE_PX = 18;
/** A click: the face pops this long. */
const POP_MS = 360;

export interface PointerMarkProps {
  readonly by: string;
  readonly name: string;
  /** Their picture, when this window can't look it up itself (the sharer's overlay). */
  readonly picture?: string | undefined;
  readonly style?: CSSProperties;
  readonly nodeRef?: (el: HTMLDivElement | null) => void;
}

/**
 * One person's pointer: an arrow in their colour, their face beside it, and their name while
 * they're busy (call/pointer-tag.ts). The same mark on every screen: the others see yours gliding,
 * you see it right under your own mouse, and the sharer sees it over their own screen. Whether the
 * name shows is set on the element (`paintTag`), not through React: it changes with every rest.
 */
export function PointerMark({ by, name, picture, style, nodeRef }: PointerMarkProps) {
  const color = personColor(by);
  return (
    <div className={p.pointer} style={style} ref={nodeRef} data-open="true">
      <svg className={p.pointerArrow} viewBox="0 0 16 21" width={16} height={21}>
        <path d={POINTER_PATH} fill={color} stroke="#ffffff" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
      <span className={p.pointerTag} style={{ background: color }}>
        <span className={p.pointerFace}>
          <Avatar name={name} id={by} size={FACE_PX} picture={picture} />
        </span>
        <span className={p.pointerName}>
          <span>
            <span>{name}</span>
          </span>
        </span>
      </span>
    </div>
  );
}

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Show a mark's tag as it is at `now`: the name open or folded, and a pop for a click it hasn't shown yet. */
export function paintTag(el: HTMLElement, tag: PointerTag, now: number): void {
  const open = tagOpen(tag, now) ? 'true' : 'false';
  if (el.dataset['open'] !== open) el.dataset['open'] = open;
  const click = tag.clickAt === undefined ? '' : String(tag.clickAt);
  if (el.dataset['click'] === click) return;
  el.dataset['click'] = click;
  const pill = el.lastElementChild;
  if (!click || !pill || reducedMotion() || typeof pill.animate !== 'function') return;
  pill.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: POP_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
}

/**
 * Your own mark under your mouse (call/Stage.tsx): nothing draws it each frame, so the fold after
 * a rest comes from a timer. Returns what to call as you move and click, and a stop.
 */
export function ownTag(mark: () => HTMLElement | null): { moved(x: number, y: number): void; clicked(x: number, y: number): void; stop(): void } {
  let tag: PointerTag | undefined;
  let fold: ReturnType<typeof setTimeout> | undefined;
  const paint = (): void => {
    const el = mark();
    if (el && tag) paintTag(el, tag, performance.now());
  };
  const later = (): void => {
    clearTimeout(fold);
    fold = setTimeout(paint, TAG_IDLE_MS + 20);
  };
  return {
    moved(x, y) {
      const now = performance.now();
      const next = tag ? tagMoved(tag, x, y, now) : newTag(x, y, now);
      if (next === tag) return;
      tag = next;
      paint();
      later();
    },
    clicked(x, y) {
      const now = performance.now();
      tag = tagClicked(tag ?? newTag(x, y, now), now);
      paint();
      later();
    },
    stop() {
      clearTimeout(fold);
    },
  };
}
