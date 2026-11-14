import { useLayoutEffect, useSyncExternalStore } from 'react';
import f from './flight.module.css';
import { reducedMotion } from '../lib/reduced-motion.js';
import { type Starting, startingShows } from './starting-model.js';

/**
 * Your message flying from the box you typed it in to where it lands, so sending doesn't feel
 * like the screen just jumped (a FLIP animation): when you press Return the box's spot and the
 * words are noted; when the message's row (in the chat, or in the queue tray when Claude is
 * busy) appears, a copy of it starts where the box was and settles into place, then the row
 * itself shows. With reduced motion, or landing above other rows (said while Claude works), the
 * row just fades in where it goes. For a message to Claude, once it has landed,
 * "Claude is starting…" shows under it until Claude's card appears (starting-model.ts).
 */

export interface Flight {
  readonly id: number;
  readonly channel: string;
  /** Where it lands: the chat, or the queue above the box (Claude is busy). */
  readonly target: 'chat' | 'queue';
  /** What you typed, to know its row. */
  readonly text: string;
  readonly from: DOMRect;
  readonly at: number;
  /** A turn was going in that conversation when you sent it: then it may land above the turn's live part. */
  readonly live: boolean;
}

/** Unclaimed flights are forgotten after this (the row never came: an error, another screen). */
const FLIGHT_TTL_MS = 4000;
/** "Claude is starting…" gives up after this. */
const STARTING_TTL_MS = 20_000;
export const FLIGHT_MS = 420;
/** A soft spring: settles quickly with the slightest overshoot. */
const SPRING = 'cubic-bezier(0.2, 1.08, 0.32, 1)';

const WAITING = f.waiting ?? 'flightWaiting';
const FLYING = f.flight ?? 'flight';
const DRAWN = f.drawn ?? 'flightDrawn';

/**
 * The copy is only a picture of the row: its words are drawn by CSS (::before), so the page has
 * the message's text once (find, copy, screen readers and tests see the real row only).
 */
function pictureOf(row: HTMLElement): HTMLElement {
  const clone = row.cloneNode(true) as HTMLElement;
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const t of texts) {
    if (!t.data) continue;
    const span = document.createElement('span');
    span.className = DRAWN;
    span.dataset.text = t.data;
    t.replaceWith(span);
  }
  for (const el of [clone, ...clone.querySelectorAll<HTMLElement>('[data-mine],[data-flown],[id]')]) {
    el.removeAttribute('data-mine');
    el.removeAttribute('data-flown');
    el.removeAttribute('id');
  }
  clone.setAttribute('aria-hidden', 'true');
  return clone;
}

let flights: Flight[] = [];
let nextId = 0;


/** Mentions in front ("@claude ", "@bob ") and spacing don't change which message it is. */
const norm = (text: string): string =>
  text
    .replace(/^(\s*@[\w:.-]+\s+)+/, '')
    .replace(/\s+/g, ' ')
    .trim();

/** You pressed Return: note where the words leave from. */
export function launchFlight(input: { channel: string; target: 'chat' | 'queue'; text: string; from: HTMLElement | null; live: boolean }): void {
  const text = norm(input.text);
  if (!text || !input.from) return;
  const now = Date.now();
  flights = [...flights.filter((x) => now - x.at < FLIGHT_TTL_MS), { id: ++nextId, channel: input.channel, target: input.target, text, from: input.from.getBoundingClientRect(), at: now, live: input.live }];
  // The box empties with a soft fade instead of blinking clear.
  if (!reducedMotion()) input.from.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  // Make sure the chat is at its newest message, where this one lands.
  if (input.target === 'chat') document.dispatchEvent(new CustomEvent('beluga:chat-bottom'));
}

/** The flight for a row that just appeared, if it's the message you just sent (taken: it lands once). */
function claim(channel: string, target: Flight['target'], text: string): Flight | undefined {
  const now = Date.now();
  const words = norm(text);
  const hit = flights.find((x) => x.channel === channel && x.target === target && now - x.at < FLIGHT_TTL_MS && words.startsWith(x.text.slice(0, 80)));
  if (hit) flights = flights.filter((x) => x !== hit);
  return hit;
}

/**
 * Whether the row lands with others below it: a message said while Claude works goes in above
 * the turn's live part (BLG-22). A copy flying up from the box would cross over that.
 */
function landsAboveOthers(row: HTMLElement): boolean {
  const holder = row.closest<HTMLElement>('[data-index]');
  const at = Number(holder?.dataset.index);
  if (!holder?.parentElement || Number.isNaN(at)) return false;
  return [...holder.parentElement.children].some((el) => Number((el as HTMLElement).dataset.index) > at);
}

/** Fly a copy of `row` from where the box was into the row's place, then show the row. */
function land(flight: Flight, row: HTMLElement): void {
  // Landing among other rows (said while a turn was going): it just fades in where it goes, over
  // nothing else. With none going, a row below is its own answer, already started: it still flies.
  if (flight.live && landsAboveOthers(row)) {
    row.dataset.flown = 'in-place';
    if (!reducedMotion()) row.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    return;
  }
  if (reducedMotion()) {
    row.dataset.flown = 'instant';
    row.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
    return;
  }
  row.classList.add(WAITING);
  // "Claude is starting…" waits until it's down (see startingShows).
  const into = flight.target === 'chat' ? flight.channel : undefined;
  let down = !into;
  const touchDown = (): void => {
    if (down || !into) return;
    down = true;
    setLanding(into, -1);
  };
  if (into) {
    setLanding(into, 1);
    // A hidden window draws no frames: the line still comes, a little after the flight would have.
    setTimeout(touchDown, FLIGHT_MS + 600);
  }
  // Two frames later: the virtualized list has measured the rows that changed with it (a turn
  // split around it, BLG-22) and placed it; a frame earlier its place can still be the old one.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const to = row.getBoundingClientRect();
    const show = (): void => {
      row.classList.remove(WAITING);
      row.dataset.flown = 'true';
      touchDown();
    };
    if (!to.width || !to.height) return show();
    const clone = pictureOf(row);
    clone.classList.remove(WAITING);
    clone.classList.add(FLYING);
    clone.dataset.sendFlight = flight.target;
    // Out of the page's flow whatever classes the row carries: one that places the row
    // (`position: relative` from reactions) once won over `.flight`, and the copy then took its
    // room in the chat's flex row, squeezing the list to nothing until it landed (a blank flash).
    Object.assign(clone.style, { position: 'fixed', margin: '0', left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
    (row.closest<HTMLElement>('[data-flight-layer]') ?? document.body).appendChild(clone);
    // Start where the words were in the box: its left edge, its bottom line.
    const dx = flight.from.left - to.left;
    const dy = flight.from.top + Math.max(0, flight.from.height - to.height) - to.top;
    const anim = clone.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(0.96)`, opacity: 0.35 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      ],
      { duration: FLIGHT_MS, easing: SPRING },
    );
    const done = (): void => {
      clone.remove();
      show();
    };
    anim.finished.then(done, done);
  }));
}

/** For a row that may be the message you just sent: it lands with the flight. */
export function useFlightLanding(ref: React.RefObject<HTMLElement | null>, channel: string, target: Flight['target'], text: string, enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled || !flights.length || !ref.current) return;
    const flight = claim(channel, target, text);
    if (flight) land(flight, ref.current);
    // Only when the row first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ---- "Claude is starting…" until Claude's card shows

let starting: Starting | undefined;
/** Flights flying into a chat now, by conversation (the row shows when they land). */
let landing: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();
const notify = (): void => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function setLanding(channel: string, by: number): void {
  const next = new Map(landing);
  const n = (next.get(channel) ?? 0) + by;
  if (n > 0) next.set(channel, n);
  else next.delete(channel);
  landing = next;
  notify();
}

export function expectClaude(channel: string, cardsBefore: number, lastMineBefore: string | undefined): void {
  const mine: Starting = { channel, cardsBefore, lastMineBefore, at: Date.now() };
  starting = mine;
  notify();
  setTimeout(() => {
    if (starting !== mine) return;
    starting = undefined;
    notify();
  }, STARTING_TTL_MS);
}

/** Whether to show "Claude is starting…" at the end of this conversation. */
export function useClaudeStarting(channel: string, cards: number, lastMine: string | undefined): boolean {
  const s = useSyncExternalStore(subscribe, () => starting);
  const inAir = useSyncExternalStore(subscribe, () => landing.get(channel) ?? 0);
  return startingShows(s, { channel, cards, lastMine, landing: inAir });
}
