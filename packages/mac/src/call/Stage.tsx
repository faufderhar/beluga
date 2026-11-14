import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CallView, ShareMode } from '@beluga/shared/calls.js';
import { Icon } from '../components/Icon.js';
import { IconButton, Tip, cx, personColor } from '../components/ui.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { useApp } from '../lib/beluga.js';
import { useMyAgentName } from '../lib/agent-words.js';
import { AskBox, AskCard, type Region } from './AskClaude.js';
import { type Ink, MAX_POINTS, NO_INK, applyInk, boxPoints, draw, hasInk, holdSketch, pictureBox, releaseSketch, sketchBox, tidyInk } from './ink.js';
import { PointerMark, ownTag } from './PointerMark.js';
import { Pointers } from './Pointers.js';
import { CallChatPops } from './ChatPops.js';
import { CameraStrip } from './Cameras.js';
import { useCallEngine, useCallLive, useCallPlace } from './use-call.js';
import c from './call.module.css';

/** How often a growing stroke is sent (the data channel takes far more; the eye doesn't). */
const SEND_MS = 33;
/** How often your pointer is sent: every frame of a 60 Hz display, so it glides on the others' screens. */
const POINTER_MS = 15;
/** Full screen: the bar steps aside after this long without the pointer moving. */
const BAR_IDLE_MS = 2_500;
/** Moving less than this (a fraction of the picture) between press and release is a click, not a drag. */
const CLICK = 0.012;

const clamp = (v: number): number => Math.min(1, Math.max(0, v));

interface Press {
  readonly x: number;
  readonly y: number;
  moved: boolean;
  /** Drawing a box (the Box tool, or Shift held as you pressed). */
  readonly box: boolean;
}

/** What dragging does: draw freely, or mark a box. */
type Tool = 'draw' | 'box';

/**
 * A shared screen in the call (BLG-706, BLG-717), beside the same chat. Nothing to pick: your
 * pointer shows for everyone as you move, a click sends a ripple there, and dragging draws. What
 * you draw in one go (strokes a moment apart: a word, a circle and an arrow) is one sketch, seen by
 * everyone, the person sharing too (on their own screen). Draw again after a pause and the old
 * sketch makes way; left alone, it dissolves. The Box tool (or Shift) marks a box instead (BLG-735).
 * Show My Pointer (off until you turn it on) shows your pointer to everyone as an arrow with your
 * picture and name, gliding on their screens; you see the same mark under your own mouse (BLG-733). Beside your sketch, Ask your agent about it: the part it
 * covers, with the ink on it, goes in the chat as a picture. Full Screen gives the picture the
 * whole display; the chat beside it is covered then, so what the others write pops up on the
 * right, with a line to answer in. Esc comes back.
 */
export function Stage({ call }: { call: CallView }) {
  const engine = useCallEngine();
  const live = useCallLive();
  const me = useApp((st) => st.network.self?.peerId ?? '');
  const stage = live.stage;
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [ink, setInk] = useState<Ink>(NO_INK);
  const inkRef = useRef(ink);
  inkRef.current = ink;
  const [size, setSize] = useState({ w: 0, h: 0, vw: 0, vh: 0 });
  const [asking, setAsking] = useState<Region | undefined>();
  const [tool, setTool] = useState<Tool>('draw');
  /** Your pointer goes to everyone only while this is on (it starts off, each share). */
  const [showMine, setShowMine] = useState(false);
  /** Your own mark, moved straight under your mouse (no React on each move). */
  const mineMark = useRef<HTMLDivElement | null>(null);
  /** Its name opens as you move or click and folds as you rest, as the others see it (BLG-912). */
  const [mineTag] = useState(() => ownTag(() => mineMark.current));
  useEffect(() => () => mineTag.stop(), [mineTag]);
  const press = useRef<Press | undefined>(undefined);
  const stroke = useRef<{ id: string; pts: number[]; sent: number } | undefined>(undefined);
  const lastSent = useRef(0);
  const sharer = call.people.find((p) => p.peerId === stage?.by);
  // macOS put the sharer's overlay in the picture: the pointers are in it already (BLG-743), so none drawn over it here.
  const pointersInPicture = Boolean(stage && live.overlayBy === stage.by);
  const color = personColor(me);
  const agent = useMyAgentName();
  const place = useCallPlace(call.conversation);

  // The picture.
  useEffect(() => {
    const v = video.current;
    if (!v || !stage) return;
    v.srcObject = stage.stream;
    void v.play().catch(() => undefined);
    const sized = (): void => setSize((s) => ({ ...s, vw: v.videoWidth, vh: v.videoHeight }));
    v.addEventListener('resize', sized);
    v.addEventListener('loadedmetadata', sized);
    return () => {
      v.removeEventListener('resize', sized);
      v.removeEventListener('loadedmetadata', sized);
    };
  }, [stage?.stream]);

  // The box it's drawn in.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize((s) => ({ ...s, w: e.contentRect.width, h: e.contentRect.height })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Everyone's marks and ink, as they come (pointers glide on their own layer, Pointers.tsx).
  useEffect(() => engine.onStage((m) => m.k !== 'laser' && setInk((i) => applyInk(i, m, performance.now()))), [engine]);

  // Asking about your sketch keeps it up (and the picture sent has it); done, it dissolves as usual.
  const ask = (r: Region): void => {
    setInk((i) => holdSketch(i, me));
    setAsking(r);
  };
  const unask = (): void => {
    setInk((i) => releaseSketch(i, performance.now()));
    setAsking(undefined);
  };

  const box = useMemo(() => pictureBox(size.w, size.h, size.vw, size.vh), [size]);

  // Drawn once for what stays (kept marks), and on every frame while something fades or moves.
  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext('2d');
    if (!el || !g) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(size.w * dpr);
    el.height = Math.round(size.h * dpr);
    draw(g, ink, box, performance.now(), personColor, dpr);
    if (!hasInk(ink)) return;
    let raf = 0;
    const tick = (): void => {
      const now = performance.now();
      const tidy = tidyInk(inkRef.current, now);
      if (tidy !== inkRef.current) setInk(tidy);
      draw(g, tidy, box, now, personColor, dpr);
      if (hasInk(tidy)) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ink, box, size.w, size.h]);

  // Full screen: the bar goes once you just look, and comes back as the pointer moves or rests on it.
  const [barAway, setBarAway] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onBar = useRef(false);
  const wake = (): void => {
    setBarAway(false);
    clearTimeout(idle.current);
    if (live.theater && !onBar.current) idle.current = setTimeout(() => setBarAway(true), BAR_IDLE_MS);
  };
  const wakeRef = useRef(wake);
  wakeRef.current = wake;
  useEffect(() => {
    wakeRef.current();
    return () => clearTimeout(idle.current);
  }, [live.theater]);

  // Esc drops a half-asked question first, then leaves full screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (asking) unask();
      else if (live.theater) void engine.setTheater(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [asking, live.theater, engine]);

  if (!stage) return null;

  const fraction = (e: ReactPointerEvent): [number, number] => {
    const r = frame.current!.getBoundingClientRect();
    return [clamp((e.clientX - r.left - box.x) / box.w), clamp((e.clientY - r.top - box.y) / box.h)];
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const [x, y] = fraction(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (asking || inkRef.current.hold) unask();
    press.current = { x, y, moved: false, box: tool === 'box' || e.shiftKey };
    stroke.current = { id: `${me.slice(0, 6)}-${Date.now().toString(36)}`, pts: [x, y], sent: 0 };
  };
  const placeMine = (e: ReactPointerEvent): void => {
    const el = mineMark.current;
    if (!el) return;
    const r = frame.current!.getBoundingClientRect();
    el.style.transform = `translate3d(${e.clientX - r.left}px, ${e.clientY - r.top}px, 0)`;
    el.style.opacity = '1';
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const [x, y] = fraction(e);
    const now = performance.now();
    if (showMine) {
      placeMine(e);
      mineTag.moved(x, y);
    }
    const p = press.current;
    if (!p) {
      // Just moving: your pointer, for everyone, if you chose to show it.
      if (showMine && now - lastSent.current > POINTER_MS) {
        lastSent.current = now;
        engine.pointerSend({ k: 'laser', by: me, x, y });
      }
      return;
    }
    if (!p.moved && Math.hypot(x - p.x, y - p.y) > CLICK) p.moved = true;
    const s = stroke.current;
    if (!p.moved || !s) return;
    if (p.box) s.pts = boxPoints(p.x, p.y, x, y);
    else if (s.pts.length < MAX_POINTS) s.pts.push(x, y);
    if (now - s.sent > SEND_MS) {
      s.sent = now;
      engine.stageSend({ k: 'ink', by: me, id: s.id, color, pts: [...s.pts] });
    }
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const p = press.current;
    const s = stroke.current;
    press.current = undefined;
    stroke.current = undefined;
    if (!p || !s) return;
    if (p.moved) {
      if (p.box) {
        const [x, y] = fraction(e);
        s.pts = boxPoints(p.x, p.y, x, y);
      }
      engine.stageSend({ k: 'ink', by: me, id: s.id, color, pts: s.pts, done: true });
      return;
    }
    // A click: a ripple there, for everyone.
    const [x, y] = fraction(e);
    engine.stageSend({ k: 'ping', by: me, x, y });
    if (showMine) mineTag.clicked(x, y);
  };
  const onLeave = (): void => {
    if (mineMark.current) mineMark.current.style.opacity = '0';
    if (!press.current && showMine) engine.pointerSend({ k: 'laser', by: me, x: -1, y: -1 });
  };

  const styleOf = (r: Region): CSSProperties => ({ left: box.x + r.x * box.w, top: box.y + r.y * box.h, width: r.w * box.w, height: r.h * box.h });
  // Your sketch, while it's up: Ask beside it, about the part it covers.
  const mine = ink.strokes.some((x) => x.by === me) ? sketchBox(ink.strokes, me) : undefined;
  const sketch: Region | undefined = mine ? { x: mine[0], y: mine[1], w: mine[2], h: mine[3] } : undefined;
  const anyInk = ink.strokes.length > 0;

  return (
    <section className={cx(c.stage, live.theater && c.theater, live.theater && barAway && c.theaterIdle)} onPointerMove={wake} aria-label={sharer?.me ? 'Your shared screen' : `${sharer?.name ?? 'Their'}’s screen`}>
      <div ref={frame} className={cx(c.stageFrame, showMine && c.stageOwnPointer)} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onLeave}>
        <video ref={video} className={c.stageVideo} autoPlay playsInline muted />
        <canvas ref={canvas} className={c.stageInk} style={{ width: size.w, height: size.h }} aria-hidden="true" />
        {pointersInPicture ? null : <Pointers people={call.people} me={me} box={box} />}
        {/* Yours, as the others see it, right under your mouse (it stands in for the arrow there). */}
        {showMine && !pointersInPicture ? (
          <div className={c.pointers} aria-hidden="true">
            <PointerMark by={me} name={call.people.find((p) => p.me)?.name ?? 'You'} style={{ opacity: 0 }} nodeRef={(el) => (mineMark.current = el)} />
          </div>
        ) : null}
        {sketch && !asking && !press.current ? (
          <AskPill
            at={styleOf(sketch)}
            frame={size}
            agent={agent}
            ask={() => ask(sketch)}
            // Pointing at Ask keeps the sketch up: it doesn't dissolve while you reach for it.
            hold={(on) => setInk((i) => (on ? holdSketch(i, me) : releaseSketch(i, performance.now())))}
          />
        ) : null}
        {asking ? (
          <>
            <div className={cx(c.region, c.regionChosen)} style={styleOf(asking)} aria-hidden="true" />
            <AskBox call={call} region={asking} anchor={styleOf(asking)} video={video.current} ink={ink} sharer={sharer?.me ? 'your' : `${sharer?.name ?? 'their'}’s`} done={unask} />
          </>
        ) : null}
        <CameraStrip call={call} floating />
      </div>
      <div
        className={cx(c.stageBar, live.theater && barAway && c.barAway)}
        role="toolbar"
        aria-label="The shared screen"
        onPointerEnter={() => {
          onBar.current = true;
          wake();
        }}
        onPointerLeave={() => {
          onBar.current = false;
          wake();
        }}
      >
        <span className={c.stageWho}>
          <Icon name="screenShare" size={13} />
          <span>{sharer?.me ? 'You’re sharing' : `${sharer?.name ?? 'Someone'}’s screen`}</span>
        </span>
        <span className={c.toolGroup} role="radiogroup" aria-label="Drag to">
          <Tip label="Draw">
            <button type="button" role="radio" aria-checked={tool === 'draw'} aria-label="Draw" className={cx(c.tool, tool === 'draw' && c.toolOn)} onClick={() => setTool('draw')}>
              <Icon name="pencil" size={14} />
            </button>
          </Tip>
          <Tip label="Box" keys="⇧">
            <button type="button" role="radio" aria-checked={tool === 'box'} aria-label="Box" className={cx(c.tool, tool === 'box' && c.toolOn)} onClick={() => setTool('box')}>
              <Icon name="square" size={14} />
            </button>
          </Tip>
        </span>
        <Tip label={showMine ? 'Stop Showing My Pointer' : 'Show My Pointer to Everyone'}>
          <button
            type="button"
            className={cx(c.tool, showMine && c.toolOn)}
            aria-pressed={showMine}
            aria-label="Show My Pointer"
            onClick={() => {
              if (showMine) engine.pointerSend({ k: 'laser', by: me, x: -1, y: -1 });
              setShowMine(!showMine);
            }}
          >
            <Icon name="pointer" size={14} />
          </button>
        </Tip>
        <span className={c.stageHint}>{tool === 'box' ? 'Drag a box around something · everyone sees it' : 'Draw to point something out · ⇧ for a box'}</span>
        {anyInk ? (
          <Tip label="Clear the Drawing">
            <button type="button" className={c.tool} aria-label="Clear the Drawing" onClick={() => engine.stageSend({ k: 'clear', by: me })}>
              <Icon name="eraser" size={14} />
            </button>
          </Tip>
        ) : null}
        <Tip label={live.theater ? 'Exit Full Screen' : 'Full Screen'} keys={live.theater ? 'esc' : undefined}>
          <button type="button" className={c.tool} aria-label={live.theater ? 'Exit Full Screen' : 'Full Screen'} onClick={() => void engine.setTheater(!live.theater)}>
            <Icon name="expand" size={14} />
          </button>
        </Tip>
        {sharer && !sharer.me ? (
          <ActionsDropdown items={wantItems(sharer.name, live.mode, live.want, (m) => engine.setWant(m))}>
            <IconButton icon="more" label="How You See Their Screen" />
          </ActionsDropdown>
        ) : null}
        {sharer?.me ? (
          <>
            <ActionsDropdown items={shareItems(live.mode, (m) => engine.setShareMode(m))}>
              <IconButton icon="more" label="How Your Screen Is Sent" />
            </ActionsDropdown>
            <button type="button" className={c.pillQuiet} onClick={() => void engine.stopSharing()}>
              Stop Sharing
            </button>
          </>
        ) : null}
      </div>
      <div className={c.stageRail}>
        <AskCard call={call} />
        {/* Full screen covers the chat: what the others write pops up here instead. */}
        {live.theater ? <CallChatPops conversation={call.conversation} place={place} /> : null}
      </div>
    </section>
  );
}

/** Beside your sketch while it's up: ask your agent about the part it covers. */
function AskPill({ at, frame, agent, ask, hold }: { at: CSSProperties; frame: { w: number; h: number }; agent: string; ask: () => void; hold: (on: boolean) => void }) {
  const right = Number(at.left ?? 0) + Number(at.width ?? 0);
  const top = Number(at.top ?? 0);
  const style: CSSProperties = { left: Math.min(Math.max(8, right + 8), frame.w - 150), top: Math.min(Math.max(8, top - 6), frame.h - 40) };
  return (
    <button type="button" className={c.askPill} style={style} onPointerDown={(e) => e.stopPropagation()} onPointerEnter={() => hold(true)} onPointerLeave={() => hold(false)} onClick={ask}>
      <Icon name="sparkles" size={12} />
      Ask {agent}
    </button>
  );
}

/**
 * Watching, behind •••: how it comes to you (BLG-743). As the sharer sends it, or your own choice;
 * yours goes to whoever feeds you the picture.
 */
function wantItems(name: string, mode: ShareMode, want: ShareMode | undefined, set: (m: ShareMode | undefined) => void): ActionItem[] {
  return [
    { label: `As ${name} Sends It`, hint: mode === 'sharp' ? 'Sharp now' : 'Smooth now', checked: want === undefined, onSelect: () => set(undefined) },
    { label: 'Sharp', separate: true, hint: 'Text stays crisp: full resolution, fewer frames', checked: want === 'sharp', onSelect: () => set('sharp') },
    { label: 'Smooth', hint: 'Motion stays fluid: every frame, softer when the network is tight', checked: want === 'smooth', onSelect: () => set('smooth') },
  ];
}

/** The sharer's choice, behind •••: every pixel of text, or every frame of motion, for everyone who didn't pick their own. */
function shareItems(mode: ShareMode, set: (m: ShareMode) => void): ActionItem[] {
  return [
    { label: 'Sharp', hint: 'Text stays crisp: full resolution, fewer frames', checked: mode === 'sharp', onSelect: () => set('sharp') },
    { label: 'Smooth', hint: 'Motion stays fluid: every frame, softer when the network is tight', checked: mode === 'smooth', onSelect: () => set('smooth') },
  ];
}
