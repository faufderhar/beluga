import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMotionValue } from 'motion/react';
import { Lifted, useLean } from '../components/Lifted.js';
import { fileMention } from '../chat/mentions.js';
import { putChips } from '../chat/draft-chips.js';
import { SLOP, edgeSpeed, scrollerOf } from './arrange-drag.js';
import s from './file-drag.module.css';

/**
 * Dragging one file or folder from your Files tree onto a message box: "@src/auth.ts" (a folder
 * "@src/") goes into that draft and nothing is sent. Pointer events, as chat-drag.tsx: nothing
 * native starts, so the window's Finder file drop never sees these drags. Same slop and Esc.
 *
 * The tree marks a row with `data-file-row` (its worktree-relative path) and `data-file-dir` when
 * it's a folder. A shared folder's list has neither, so it doesn't drag. The box is the
 * `[data-chat-box]` under the pointer.
 */

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The message box a drop would land in. */
interface Lit {
  readonly box: Box;
}

/** The row being carried: a copy of it, at its width. */
interface Carried {
  readonly face: HTMLElement;
  readonly width: number;
}

/** One drag at a time, even when two Files tabs are mounted. */
let drag: symbol | undefined;

/** Mounted from the Files tree. Draws what's carried and the box that would take it. */
export function useFileDrag(): ReactNode {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const lean = useLean(x);
  const [carried, setCarried] = useState<Carried>();
  const [lit, setLit] = useState<Lit>();
  useEffect(() => {
    let stop: (() => void) | undefined;
    const press = (e: PointerEvent): void => {
      if (drag || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || stop || !(e.target instanceof Element)) return;
      const row = e.target.closest<HTMLElement>('[data-file-row]');
      if (!row || e.target.closest('button, input, a, [data-no-drag]')) return;
      const path = row.dataset.fileRow;
      if (path === undefined) return;
      const words = fileMention(path, row.dataset.fileDir !== undefined);
      const token = Symbol();
      drag = token;
      const start = { x: e.clientX, y: e.clientY };
      let point = start;
      let started = false;
      let grab = { x: 0, y: 0 };
      let target: HTMLElement | undefined;
      let frame = 0;
      const scroller = scrollerOf(row);

      const update = (): void => {
        const next = boxAt(point.x, point.y);
        if (next === target) return;
        target = next;
        setLit(next ? { box: rectOf(next) } : undefined);
      };
      const speed = (): number => {
        if (!scroller) return 0;
        const r = scroller.getBoundingClientRect();
        return point.x >= r.left && point.x <= r.right ? edgeSpeed(r, point.y) : 0;
      };
      const tick = (): void => {
        frame = 0;
        const v = speed();
        if (!v || !scroller) return;
        const before = scroller.scrollTop;
        scroller.scrollTop += v;
        if (scroller.scrollTop !== before) update();
        frame = requestAnimationFrame(tick);
      };
      const begin = (): void => {
        started = true;
        const r = row.getBoundingClientRect();
        grab = { x: Math.min(Math.max(start.x - r.left, 0), r.width), y: start.y - r.top };
        x.set(point.x - grab.x);
        y.set(point.y - grab.y);
        lean.jump(0);
        setCarried({ face: faceOf(row), width: r.width });
        document.documentElement.dataset.arranging = '';
        window.getSelection()?.removeAllRanges();
      };
      const move = (ev: PointerEvent): void => {
        point = { x: ev.clientX, y: ev.clientY };
        if (!started) {
          if (Math.hypot(point.x - start.x, point.y - start.y) < SLOP) return;
          begin();
        }
        ev.preventDefault();
        window.getSelection()?.removeAllRanges();
        x.set(point.x - grab.x);
        y.set(point.y - grab.y);
        update();
        if (!frame && speed()) frame = requestAnimationFrame(tick);
      };
      const end = (drop: boolean): void => {
        const box = drop ? target : undefined;
        cleanup();
        if (!started) return;
        // The click that ends a drag isn't a click on the row, so it doesn't also open.
        const swallow = (ev: MouseEvent): void => (ev.stopPropagation(), ev.preventDefault());
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
        if (!box?.dataset.chatBox) return;
        putChips(box.dataset.chatBox, words);
      };
      const up = (): void => end(true);
      const cancel = (): void => end(false);
      const key = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Escape' || !started) return;
        ev.preventDefault();
        ev.stopPropagation();
        end(false);
      };
      const noSelect = (ev: Event): void => ev.preventDefault();
      const cleanup = (): void => {
        document.removeEventListener('selectstart', noSelect, { capture: true });
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('blur', cancel);
        window.removeEventListener('keydown', key, { capture: true });
        if (frame) cancelAnimationFrame(frame);
        setCarried(undefined);
        setLit(undefined);
        delete document.documentElement.dataset.arranging;
        if (drag === token) drag = undefined;
        stop = undefined;
      };
      document.addEventListener('selectstart', noSelect, { capture: true });
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('blur', cancel);
      window.addEventListener('keydown', key, { capture: true });
      stop = cleanup;
    };
    window.addEventListener('pointerdown', press);
    return () => {
      window.removeEventListener('pointerdown', press);
      stop?.();
    };
  }, [x, y, lean]);
  return (
    <>
      {lit ? <DropGlow lit={lit} /> : null}
      {carried ? (
        <Lifted className={s.ghost} x={x} y={y} lean={lean} width={carried.width} data-file-ghost="">
          <Face face={carried.face} />
        </Lifted>
      ) : null}
    </>
  );
}

/** The message box under the pointer, when the pointer is on that box. The rest of the page inserts nothing. */
function boxAt(x: number, y: number): HTMLElement | undefined {
  const under = document.elementFromPoint(x, y);
  return under?.closest<HTMLElement>('[data-chat-box]') ?? undefined;
}

const rectOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

/** A copy of the row to carry. It looks the same and is nothing anyone can find or press. */
function faceOf(row: HTMLElement): HTMLElement {
  const face = row.cloneNode(true) as HTMLElement;
  for (const el of [face, ...face.querySelectorAll<HTMLElement>('*')]) {
    for (const name of ['id', 'role', 'tabindex', 'title', 'aria-label', 'aria-expanded', 'aria-selected', 'aria-level', 'data-file-row', 'data-file-dir', 'data-cursor']) el.removeAttribute(name);
  }
  face.inert = true;
  return face;
}

/** The row's copy, put in its holder as it is. */
function Face({ face }: { face: HTMLElement }) {
  const holder = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    holder.current?.replaceChildren(face);
  }, [face]);
  return <div ref={holder} />;
}

/** The message box that would take the file, glowing. */
function DropGlow({ lit }: { lit: Lit }) {
  return createPortal(<div className={s.boxGlow} style={lit.box} data-file-drop="box" aria-hidden />, document.body);
}
