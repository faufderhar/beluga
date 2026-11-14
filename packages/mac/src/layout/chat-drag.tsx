import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMotionValue } from 'motion/react';
import { resolveChat } from '@beluga/core/chat-links/resolve.js';
import { type ChatRef, chatChipOf, chatMention } from '@beluga/shared/chat-ref.js';
import { Icon } from '../components/Icon.js';
import { Lifted, useLean } from '../components/Lifted.js';
import { useBeluga } from '../lib/beluga.js';
import { putChips } from '../chat/draft-chips.js';
import c from '../chat/composer.module.css';
import { SLOP, edgeSpeed, scrollerOf } from './arrange-drag.js';
import s from './chat-drag.module.css';

/**
 * Dragging a chat's row onto a chat, to give it as context: a chip goes in the target's draft and
 * nothing is sent. Pointer events, as arrange-drag.ts: nothing native starts, so the window's file
 * drop never sees these drags. Same slop and Esc.
 *
 * The rows and boxes say what they are: `data-chat-row` on a chat's row (its channel), and
 * `data-chat-box` on a message box that takes chips (the key of its draft). Anything without them
 * (the room, a DM, a group) refuses, and so does the chat you picked up.
 *
 * What's carried is the row itself, at its own width, lifted and swinging as a board's card does
 * (Lifted.tsx). Over a chat that takes it, the chat and its box light up as for files from Finder.
 */

/** What's picked up: a list, though one row gives one (several selected rows can give more). */
type Payload = readonly ChatRef[];

interface DropTarget {
  /** The draft that gets the chip. */
  readonly key: string;
  readonly el: HTMLElement;
  /** A row: going there is a click on it. */
  readonly row: boolean;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The row being carried: a copy of it, at its width. */
interface Carried {
  readonly face: HTMLElement;
  readonly width: number;
}

/** A chat that a drop would go in: the conversation, and its message box. */
interface Lit {
  readonly pane: Box;
  readonly box: Box;
}

/** Sidebar rows can be picked up. Mounted once, with the sidebar; draws what's carried. */
export function useChatDrag(): ReactNode {
  const { client } = useBeluga();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const lean = useLean(x);
  const [carried, setCarried] = useState<Carried>();
  const [lit, setLit] = useState<Lit>();
  useEffect(() => {
    let stop: (() => void) | undefined;
    const press = (e: PointerEvent): void => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || stop || !(e.target instanceof Element)) return;
      const state = client.store.getState();
      const row = e.target.closest<HTMLElement>('[data-chat-row]');
      if (!row || e.target.closest('button, input, a, [data-no-drag]')) return;
      const from = row.dataset.chatRow!;
      const refs: Payload = [{ owner: state.selfId, channel: from }];
      const words = refs.flatMap((r) => chatMention(titleOf(state, r), r) ?? []).join(' ');
      if (!words) return;
      const start = { x: e.clientX, y: e.clientY };
      let point = start;
      let started = false;
      let grab = { x: 0, y: 0 };
      let target: DropTarget | undefined;
      let frame = 0;
      const scroller = scrollerOf(row);

      const update = (): void => {
        const next = targetAt(point.x, point.y, from);
        if (next?.el === target?.el) return;
        target?.el.classList.remove(s.over!);
        if (next?.row) next.el.classList.add(s.over!);
        target = next;
        setLit(next && !next.row ? litOf(next.el) : undefined);
      };
      /** Only over the list: a drop near the window's bottom edge doesn't scroll the sidebar. */
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
        // Its nesting is the sidebar's, not the row's: the copy starts at its icon.
        const trim = Math.max(0, parseFloat(getComputedStyle(row).paddingLeft) - FACE_PADDING);
        const width = r.width - trim;
        grab = { x: Math.min(Math.max(start.x - r.left - trim, 0), width), y: start.y - r.top };
        x.set(point.x - grab.x);
        y.set(point.y - grab.y);
        lean.jump(0);
        setCarried({ face: faceOf(row), width });
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
        const dropped = drop ? target : undefined;
        cleanup();
        if (!started) return;
        // The click that ends a drag isn't a click on the row.
        const swallow = (ev: MouseEvent): void => (ev.stopPropagation(), ev.preventDefault());
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
        if (!dropped) return;
        putChips(dropped.key, words);
        // After the timer above: this click is the row's own, and opens its chat as any click does.
        if (dropped.row) setTimeout(() => dropped.el.click(), 0);
      };
      const up = (): void => end(true);
      const cancel = (): void => end(false);
      const key = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Escape' || !started) return;
        ev.preventDefault();
        ev.stopPropagation();
        end(false);
      };
      // Pressing a row and moving selects nothing: not the row's words, nor a chat's, a terminal's or a file's on the way.
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
        target?.el.classList.remove(s.over!);
        delete document.documentElement.dataset.arranging;
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
  }, [client, x, y, lean]);
  return (
    <>
      {lit ? <DropGlow lit={lit} /> : null}
      {carried ? (
        <Lifted className={s.ghost} x={x} y={y} lean={lean} width={carried.width} data-chat-ghost="">
          <Face face={carried.face} />
        </Lifted>
      ) : null}
    </>
  );
}

/** Where a drop at (x, y) goes: another chat's row, or the message box of the chat under the pointer. */
function targetAt(x: number, y: number, from: string): DropTarget | undefined {
  const under = document.elementFromPoint(x, y);
  const row = under?.closest<HTMLElement>('[data-chat-row]');
  if (row) return row.dataset.chatRow === from ? undefined : { key: row.dataset.chatRow!, el: row, row: true };
  const box = under?.closest('main, [role="complementary"]')?.querySelector<HTMLElement>('[data-chat-box]');
  return box && box.dataset.chatBox !== from ? { key: box.dataset.chatBox!, el: box, row: false } : undefined;
}

const titleOf = (state: Parameters<typeof resolveChat>[0], ref: ChatRef): string => chatChipOf(resolveChat(state, ref)).label;

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

/** The conversation a message box is in, and the box. */
const litOf = (box: HTMLElement): Lit => ({ pane: boxOf(box.closest('main, [role="complementary"]') ?? box), box: boxOf(box) });

/** The carried copy's own left padding (a top-level row's, Row in sidebar-parts.tsx), whatever the row's nesting. */
const FACE_PADDING = 8;

/** A copy of the row to carry: it looks the same, without its nesting, and is nothing anyone can find or press. */
function faceOf(row: HTMLElement): HTMLElement {
  const face = row.cloneNode(true) as HTMLElement;
  for (const el of [face, ...face.querySelectorAll<HTMLElement>('*')]) {
    for (const name of ['id', 'role', 'tabindex', 'title', 'aria-label', 'aria-expanded', 'aria-current', 'data-chat-row', 'data-drag']) el.removeAttribute(name);
  }
  face.style.paddingLeft = `${FACE_PADDING}px`;
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

/** The chat that would take a drop: the conversation veiled as for files from Finder, its box glowing. */
function DropGlow({ lit }: { lit: Lit }) {
  return createPortal(
    <>
      <div className={c.dropTarget} style={lit.pane} data-chat-drop="pane" aria-hidden>
        <div className={c.dropTargetLabel}>
          <Icon name="chat" size={16} />
          Drop to add it to your message
        </div>
      </div>
      <div className={s.boxGlow} style={lit.box} data-chat-drop="box" aria-hidden />
    </>,
    document.body,
  );
}
