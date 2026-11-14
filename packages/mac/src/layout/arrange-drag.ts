import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { type Entry, type Place, type Target, keyOfEntry, placeOf, staysPut, targetOfEntry } from './project-layout.js';

/**
 * Dragging projects and groups around the sidebar, the way Finder's sidebar and Xcode's
 * navigator do it: pick a row up (it follows the pointer), an insertion line shows where it
 * will land (a folder lights up when it would go inside), the list scrolls near its edges, and
 * Esc puts it back. Pointer events, not HTML drag and drop: nothing native starts, so the
 * window's own file drop (folders from Finder) never sees these drags.
 *
 * The rows say what they are: `data-drag` on a row you can pick up, `data-slot` on each block
 * (a project with its worktrees, a group with its projects), `data-head` on a group's row.
 */

export type Hover = { readonly kind: 'line'; readonly place: Place; readonly y: number; readonly depth: 0 | 1 } | { readonly kind: 'into'; readonly place: Place };

export interface Dragging {
  readonly item: Target;
  readonly hover?: Hover;
}

/** How far the pointer moves before a press becomes a drag. */
export const SLOP = 4;
/** Near the scrolling list's top or bottom edge (px), it scrolls; faster the closer you are. */
const EDGE = 40;
const MAX_SPEED = 16;
/** Left of this (from the list's left edge), the end of a group means "after the group". */
const OUTDENT_X = 30;

const parse = (raw: string): Target => (raw.startsWith('group:') ? { group: raw.slice(6) } : { project: raw.slice(8) });
const slot = (tree: HTMLElement, key: string): HTMLElement | null => tree.querySelector<HTMLElement>(`[data-slot="${CSS.escape(key)}"]`);

/** Where a drop at (x, y) would put `item`; undefined: nowhere new. */
export function hoverAt(tree: HTMLElement, entries: readonly Entry[], item: Target, x: number, y: number): Hover | undefined {
  const box = tree.getBoundingClientRect();
  const rel = (v: number): number => v - box.top;
  const line = (place: Place, at: number, depth: 0 | 1): Hover | undefined => (staysPut(entries, item, place) ? undefined : { kind: 'line', place, y: rel(at), depth });
  const into = (group: string): Hover | undefined => (placeOf(entries, item)?.into === group ? undefined : { kind: 'into', place: { into: group, before: null } });
  const groupDrag = 'group' in item;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const el = slot(tree, keyOfEntry(e));
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const last = i === entries.length - 1;
    if (y > r.bottom && !last) continue;
    const next = entries[i + 1] ? targetOfEntry(entries[i + 1]!) : null;
    const before: Place = { into: null, before: targetOfEntry(e) };
    const after: Place = { into: null, before: next };
    if (y < r.top) return line(before, r.top, 0);
    if (y > r.bottom) return line(after, r.bottom, 0);
    if (e.kind === 'group' && !groupDrag) {
      const head = el.querySelector<HTMLElement>('[data-head]')?.getBoundingClientRect() ?? r;
      if (y <= head.bottom) return y < head.top + head.height * 0.3 ? line(before, r.top, 0) : into(e.name);
      for (let j = 0; j < e.projects.length; j++) {
        const kid = slot(tree, `project:${e.projects[j]!.id}`)?.getBoundingClientRect();
        if (!kid) continue;
        const lastKid = j === e.projects.length - 1;
        if (y > kid.bottom && !lastKid) continue;
        if (y < kid.top + kid.height / 2) return line({ into: e.name, before: { project: e.projects[j]!.id } }, kid.top, 1);
        // Below the last one: still in the group, unless you pull left (out, after the group).
        if (lastKid && x < box.left + OUTDENT_X) return line(after, r.bottom, 0);
        return line({ into: e.name, before: e.projects[j + 1] ? { project: e.projects[j + 1]!.id } : null }, kid.bottom, 1);
      }
      return into(e.name);
    }
    return y < r.top + r.height / 2 ? line(before, r.top, 0) : line(after, r.bottom, 0);
  }
  return undefined;
}

/** How fast a list scrolls with the pointer at `y`: near its edges, faster the closer. */
export function edgeSpeed(r: DOMRect, y: number): number {
  if (y < r.top + EDGE) return -MAX_SPEED * Math.min(1, (r.top + EDGE - y) / EDGE);
  if (y > r.bottom - EDGE) return MAX_SPEED * Math.min(1, (y - (r.bottom - EDGE)) / EDGE);
  return 0;
}

/** The nearest scrolling ancestor (the sidebar's list). */
export function scrollerOf(el: HTMLElement): HTMLElement | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return undefined;
}

/** A copy of the row you picked up, following the pointer (like Finder's drag image). */
function makeGhost(row: HTMLElement, className: string): HTMLElement {
  const ghost = row.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('id');
  ghost.removeAttribute('data-drag');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.classList.add(className);
  document.body.appendChild(ghost);
  return ghost;
}

export function useArrangeDrag(tree: RefObject<HTMLElement | null>, entries: readonly Entry[], onDrop: (item: Target, place: Place) => void, ghostClass: string): { dragging?: Dragging; onPointerDown: (e: ReactPointerEvent) => void } {
  const [dragging, setDragging] = useState<Dragging | undefined>();
  const latest = useRef({ entries, onDrop });
  latest.current = { entries, onDrop };
  const stop = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || stop.current) return;
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>('[data-drag]');
    if (!row || !tree.current?.contains(row) || target.closest('button, input, a, [data-no-drag], [data-chat-row]')) return;
    const item = parse(row.dataset.drag!);
    const start = { x: e.clientX, y: e.clientY };
    const grab = row.getBoundingClientRect();
    let point = start;
    let started = false;
    let ghost: HTMLElement | undefined;
    let hover: Hover | undefined;
    let frame = 0;
    const scroller = scrollerOf(row);

    const update = (): void => {
      if (!tree.current) return;
      const next = hoverAt(tree.current, latest.current.entries, item, point.x, point.y);
      if (JSON.stringify(next) !== JSON.stringify(hover)) {
        hover = next;
        setDragging({ item, ...(next ? { hover: next } : {}) });
      }
    };
    const speed = (): number => (scroller ? edgeSpeed(scroller.getBoundingClientRect(), point.y) : 0);
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
      ghost = makeGhost(row, ghostClass);
      document.documentElement.dataset.arranging = '';
      window.getSelection()?.removeAllRanges();
      setDragging({ item });
    };
    const move = (ev: PointerEvent): void => {
      point = { x: ev.clientX, y: ev.clientY };
      if (!started) {
        if (Math.hypot(point.x - start.x, point.y - start.y) < SLOP) return;
        begin();
      }
      ev.preventDefault();
      if (ghost) ghost.style.transform = `translate(${grab.left + point.x - start.x}px, ${grab.top + point.y - start.y}px)`;
      update();
      if (!frame && speed()) frame = requestAnimationFrame(tick);
    };
    const end = (drop: boolean): void => {
      cleanup();
      if (!started) return;
      // The click that ends a drag isn't a click on the row.
      const swallow = (ev: MouseEvent): void => (ev.stopPropagation(), ev.preventDefault());
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      if (drop && hover) latest.current.onDrop(item, hover.place);
    };
    const up = (): void => end(true);
    const cancel = (): void => end(false);
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !started) return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, { capture: true });
      if (frame) cancelAnimationFrame(frame);
      ghost?.remove();
      delete document.documentElement.dataset.arranging;
      stop.current = undefined;
      setDragging(undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, { capture: true });
    stop.current = cleanup;
  };

  return { ...(dragging ? { dragging } : {}), onPointerDown };
}
