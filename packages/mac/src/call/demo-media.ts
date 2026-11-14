import { repeat } from './repeat.js';

/**
 * The demo's side of a call (BLG-706): bob and mia have no window, so their voices are made-up
 * levels (talking in turns, with pauses) and a shared screen is an editor drawn on a canvas. Only
 * used when the call says `demo`.
 */

/** A made-up voice: phrases of one to three seconds, with pauses, different per person. */
export function demoVoice(peerId: string): () => number {
  const seed = [...peerId].reduce((a, c) => a + c.charCodeAt(0), 0);
  const offset = (seed % 7) * 1300;
  return () => {
    const t = performance.now() + offset;
    const turn = Math.floor(t / 2600) % 3;
    if (turn !== seed % 3) return 0;
    const syllable = Math.abs(Math.sin(t / 95) * Math.sin(t / 330));
    return 0.05 + syllable * 0.22;
  };
}

/** The made-up file: each line a run of [kind, text] pieces (keyword, function, plain, comment, string). */
const LINES: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [['k', 'export async function '], ['f', 'checkout'], ['p', '(cart: Cart) {']],
  [['c', '  // Taxes first, then the discount: the order matters']],
  [['p', '  const taxed = '], ['f', 'applyTax'], ['p', '(cart.total, cart.region);']],
  [['p', '  const total = '], ['f', 'discount'], ['p', '(taxed, cart.code);']],
  [['k', '  if '], ['p', '(total < 0) '], ['k', 'throw new '], ['f', 'Error'], ['s', "('Total below zero');"]],
  [['k', '  return '], ['p', 'stripe.charge({ amount: total, currency: '], ['s', "'eur'"], ['p', ' });']],
  [['p', '}']],
];

const INK: Record<string, string> = { k: '#8b6fd6', f: '#3f8fd8', p: '#3a3f4b', c: '#9aa3ae', s: '#3f9e72' };

/** A shared screen for the demo: an editor with a file that scrolls a little and a blinking cursor. */
export function demoScreen(owner: string): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 1440;
  canvas.height = 900;
  const g = canvas.getContext('2d');
  const draw = (): void => {
    if (!g) return;
    const t = performance.now();
    g.fillStyle = '#fbfaf7';
    g.fillRect(0, 0, canvas.width, canvas.height);
    // The window's top bar and its file tab.
    g.fillStyle = '#f0eee8';
    g.fillRect(0, 0, canvas.width, 56);
    for (const [i, c] of ['#f3b6ae', '#f4dc9c', '#b9dfb3'].entries()) {
      g.fillStyle = c;
      g.beginPath();
      g.arc(28 + i * 26, 28, 8, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#ffffff';
    g.fillRect(120, 14, 220, 42);
    g.fillStyle = '#5b6170';
    g.font = '500 20px -apple-system, system-ui, sans-serif';
    g.fillText('checkout.ts', 146, 42);
    g.fillStyle = '#9aa3ae';
    g.fillText(`${owner}’s screen`, canvas.width - 220, 36);
    // The code, a line number gutter, the line being worked on.
    g.font = '26px "SF Mono", Menlo, monospace';
    const top = 120;
    const lineH = 54;
    const at = Math.floor(t / 2200) % LINES.length;
    g.fillStyle = '#eef3fb';
    g.fillRect(0, top + at * lineH - 36, canvas.width, lineH);
    LINES.forEach((line, i) => {
      const y = top + i * lineH;
      g.fillStyle = '#c3c8cf';
      g.fillText(String(i + 12).padStart(3, ' '), 30, y);
      let x = 120;
      for (const [kind, text] of line) {
        g.fillStyle = INK[kind] ?? '#3a3f4b';
        g.fillText(text, x, y);
        x += g.measureText(text).width;
      }
      if (i === at && Math.floor(t / 530) % 2 === 0) {
        g.fillStyle = '#3f8fd8';
        g.fillRect(x + 4, y - 26, 3, 34);
      }
    });
  };
  draw();
  const stopDrawing = repeat(draw, 1000 / 15);
  const stream = canvas.captureStream(15);
  const track = stream.getVideoTracks()[0];
  if (track) {
    const stop = track.stop.bind(track);
    track.stop = () => {
      stopDrawing();
      stop();
    };
  }
  return stream;
}

const FACES = [
  ['#cfe3f7', '#e7dcf6', '#5b8def'],
  ['#d8f0e3', '#f6ead2', '#3fa776'],
  ['#f6dcd6', '#e7dcf6', '#c06a5a'],
] as const;

/**
 * A camera for the demo: a soft pastel room with the person's initial in a circle that sways a
 * little, as someone sitting in front of their Mac would. Their color from their name.
 */
export function demoCamera(name: string): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const g = canvas.getContext('2d');
  const [from, to, ink] = FACES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % FACES.length]!;
  const draw = (): void => {
    if (!g) return;
    const t = performance.now() / 1000;
    const bg = g.createLinearGradient(0, 0, 640, 360);
    bg.addColorStop(0, from);
    bg.addColorStop(1, to);
    g.fillStyle = bg;
    g.fillRect(0, 0, 640, 360);
    // A window behind them, and a lamp's warm patch.
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(430, 40, 150, 110);
    const x = 320 + Math.sin(t * 0.7) * 10;
    const y = 200 + Math.sin(t * 1.1) * 4;
    g.fillStyle = 'rgba(255,255,255,0.65)';
    g.beginPath();
    g.ellipse(x, 360, 150, 90, 0, Math.PI, 0);
    g.fill();
    g.fillStyle = ink;
    g.beginPath();
    g.arc(x, y - 30, 62, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = '600 56px -apple-system, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name.slice(0, 1).toUpperCase(), x, y - 28);
  };
  draw();
  const stopDrawing = repeat(draw, 1000 / 20);
  const stream = canvas.captureStream(20);
  const track = stream.getVideoTracks()[0];
  if (track) {
    const stop = track.stop.bind(track);
    track.stop = () => {
      stopDrawing();
      stop();
    };
  }
  return stream;
}

/** The demo friend's rhythm (BLG-912): they read along a while, then rest on a spot and click it. */
const DEMO_MOVE_MS = 3_500;
const DEMO_CYCLE_MS = 9_500;
const DEMO_CLICK_MS = 6_200;

/** Where a demo friend points on a shared screen at `ms`: a slow, wandering loop, as a person reads along (BLG-733), with rests. */
export function demoPointer(ms: number): readonly [number, number] {
  // Time spent moving so far: it stands still through each rest, and goes on from there after.
  const t = (Math.floor(ms / DEMO_CYCLE_MS) * DEMO_MOVE_MS + Math.min(ms % DEMO_CYCLE_MS, DEMO_MOVE_MS)) / 1000;
  return [0.5 + 0.28 * Math.sin(t * 0.7) + 0.05 * Math.sin(t * 2.3), 0.45 + 0.2 * Math.sin(t * 0.9 + 1) + 0.04 * Math.cos(t * 3.1)];
}

/** Whether the demo friend clicked between `from` and `to` (ms): once each rest, on the spot they rest on. */
export const demoClicked = (from: number, to: number): boolean => Math.floor((to - DEMO_CLICK_MS) / DEMO_CYCLE_MS) > Math.floor((from - DEMO_CLICK_MS) / DEMO_CYCLE_MS);
