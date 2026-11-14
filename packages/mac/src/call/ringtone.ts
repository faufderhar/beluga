import { repeat } from './repeat.js';
import { midi, render, type Note, type SoundSpec } from '../lib/sounds/synth.js';

/**
 * Beluga's call sounds (BLG-706), made by the notification synthesizer so they sound like the rest
 * of Beluga. The ringtone is continuous and still unmistakably a call: a soft electric piano holds
 * each jazz chord (Dmaj9, Bm9, Em9, A13) so there's never a gap, and over it bright rolled "rings",
 * struck like a bell, land on a steady pulse twice a chord. The caller hears it ring at the others':
 * a bright double ring, then a moment of quiet, the way a phone rings at the other end, moving
 * through the same chords. Joining and leaving are short, crisp bells: three notes up, two notes down.
 */

/** A bright electric piano: a strong bell on the attack, gone quickly. */
const bell = (at: number, note: number, dur: number, gain: number): Note => ({ at, dur, freq: midi(note), wave: 'fm', gain, attack: 0.003, release: 0.18, decay: 3.2, fm: { ratio: 1, index: 2.4, fade: 4 } });
/** A vibraphone on top: clear, with a metal ring. */
const vibes = (at: number, note: number, dur: number, gain: number): Note => ({ at, dur, freq: midi(note), wave: 'fm', gain, attack: 0.002, release: 0.25, decay: 2.4, fm: { ratio: 4, index: 1, fade: 6 } });
/** The bed: a soft electric piano held under everything, each chord running into the next. */
const pad = (at: number, note: number, dur: number, gain: number): Note => ({ at, dur, freq: midi(note), wave: 'fm', gain, attack: 0.08, release: 0.6, decay: 0.25, fm: { ratio: 1, index: 0.9, fade: 1.5 } });

/** The four chords, voiced high and bright (MIDI notes, bottom to top). */
const CHORDS: ReadonlyArray<readonly number[]> = [
  [66, 69, 73, 76, 81], // Dmaj9
  [69, 73, 74, 78, 81], // Bm9
  [67, 71, 74, 78, 83], // Em9
  [67, 71, 73, 78, 81], // A13
];

/** One chord's length (seconds), and a ring every half of it: a steady, unhurried pulse. */
const CHORD_S = 1.8;
const PULSE_S = CHORD_S / 2;

/** One ring: the chord rolled up fast, its top three notes struck again twice, a vibraphone on the top note. */
function ring(at: number, chord: readonly number[], accent: boolean): Note[] {
  const top = chord.slice(-3);
  return [
    ...chord.map((n, i) => bell(at + i * 0.018, n, 0.7, accent ? 0.2 : 0.19)),
    ...[0.14, 0.28].flatMap((d) => top.map((n) => bell(at + d, n, 0.4, accent ? 0.15 : 0.14))),
    ...(accent ? [vibes(at + 0.09, chord.at(-1)! + 12, 0.9, 0.22)] : []),
  ];
}

/** The held chord under a bar: an octave down, overlapping the next so the sound never drops. */
const bed = (at: number, chord: readonly number[], gain: number): Note[] => chord.slice(0, 4).map((n, i) => pad(at + i * 0.02, n - 12, CHORD_S + 0.7, gain));

/** The ringtone: all four chords, a held bed and two rings each, then it starts again (no pause). */
export const RING: SoundSpec = {
  notes: CHORDS.flatMap((chord, i) => [...bed(i * CHORD_S, chord, 0.12), ...ring(i * CHORD_S, chord, true), ...ring(i * CHORD_S + PULSE_S, chord, false)]),
  lowpass: 7600,
  reverb: { mix: 0.2, time: 1 },
  maxLength: CHORDS.length * CHORD_S + 0.9,
};
export const RING_EVERY_S = CHORDS.length * CHORD_S;

/** A short plucked note, quick to speak: the ringback's rings. */
const pluck = (at: number, note: number, dur: number, gain: number): Note => ({ at, dur, freq: midi(note), wave: 'fm', gain, attack: 0.002, release: 0.08, decay: 4, fm: { ratio: 2, index: 1.8, fade: 5 } });

/** One ringback ring: the chord rattled up fast twice, like a bell's hammer, a sparkle on top. */
function burst(at: number, chord: readonly number[]): Note[] {
  return [0, 0.11].flatMap((d, k) => [
    ...chord.map((n, i) => pluck(at + d + i * 0.012, n, 0.32, k === 0 ? 0.2 : 0.17)),
    vibes(at + d + 0.05, chord.at(-1)! + 12, 0.35, k === 0 ? 0.16 : 0.12),
  ]);
}

/** Ring-ring, then a wait: one turn per chord. */
const RINGBACK_S = 2.2;
const RING_GAP_S = 0.42;

/**
 * What the caller hears while it rings at the others: a quick, bright ring-ring, then a moment of
 * quiet, again and again, moving through the ringtone's chords. Rings and pauses say "it's ringing
 * at their end, any second now", the way a phone does, not music on hold.
 */
export const RINGBACK: SoundSpec = {
  notes: CHORDS.flatMap((chord, i) => [...burst(i * RINGBACK_S, chord), ...burst(i * RINGBACK_S + RING_GAP_S, chord)]),
  lowpass: 8200,
  reverb: { mix: 0.14, time: 0.7 },
  maxLength: CHORDS.length * RINGBACK_S + 0.6,
};
export const RINGBACK_EVERY_S = CHORDS.length * RINGBACK_S;

/** A short, crisp bell for coming and going. */
const chime = (at: number, note: number, dur: number, gain: number): Note => ({ at, dur, freq: midi(note), wave: 'fm', gain, attack: 0.002, release: 0.08, decay: 5, fm: { ratio: 2, index: 1.4, fade: 8 } });

/** Someone joined (or you did): three quick notes up, D F♯ A. */
export const JOINED: SoundSpec = { notes: [chime(0, 74, 0.16, 0.5), chime(0.07, 78, 0.16, 0.55), chime(0.14, 81, 0.42, 0.65)], lowpass: 9000, reverb: { mix: 0.1, time: 0.5 }, maxLength: 0.75 };
/** Someone left: two notes down, A to D, a little darker. */
export const LEFT: SoundSpec = { notes: [chime(0, 81, 0.16, 0.55), chime(0.1, 74, 0.45, 0.5)], lowpass: 6000, reverb: { mix: 0.1, time: 0.5 }, maxLength: 0.75 };

let ctx: AudioContext | undefined;
const buffers = new Map<SoundSpec, AudioBuffer>();

/**
 * Where a sound heard in a call goes: as a stream into a hidden <audio>, the way the call's voices
 * play. Once your microphone is open (from the Call click on), macOS's voice processing turns down
 * everything else this window plays, and WebKit plays streams through that processing itself: the
 * ringback played straight out of Web Audio went unheard by the one calling.
 */
interface CallOut {
  readonly node: MediaStreamAudioDestinationNode;
  readonly el: HTMLAudioElement;
  playing: number;
}
let callOut: CallOut | undefined;
let callSpeaker: string | undefined;

/** The speaker picked for calls (undefined: macOS's own): call sounds go where the voices do. */
export function setCallSpeaker(id: string | undefined): void {
  callSpeaker = id;
  if (callOut) sinkTo(callOut.el, id ?? '');
}

function sinkTo(el: HTMLMediaElement, id: string): void {
  const media = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof media.setSinkId === 'function') void media.setSinkId(id).catch(() => undefined);
}

function callOutput(c: AudioContext): CallOut | undefined {
  if (callOut) return callOut;
  if (typeof document === 'undefined' || typeof c.createMediaStreamDestination !== 'function') return undefined;
  const node = c.createMediaStreamDestination();
  const el = document.createElement('audio');
  el.dataset['callSounds'] = '';
  el.style.display = 'none';
  el.srcObject = node.stream;
  document.body.append(el);
  if (callSpeaker) sinkTo(el, callSpeaker);
  callOut = { node, el, playing: 0 };
  return callOut;
}

/**
 * Connect a sound to the speakers: in a call through the call's stream (falling back to the plain
 * output if it can't play), else straight out. Returns what to call when it's done.
 */
function connectOut(c: AudioContext, node: AudioNode, inCall: boolean): () => void {
  const out = inCall ? callOutput(c) : undefined;
  if (!out) {
    node.connect(c.destination);
    return () => node.disconnect();
  }
  node.connect(out.node);
  out.playing++;
  let done = false;
  void out.el.play().catch(() => {
    if (done) return;
    // Refused: heard the plain way rather than not at all (never both).
    node.disconnect();
    node.connect(c.destination);
  });
  return () => {
    if (done) return;
    done = true;
    node.disconnect();
    out.playing--;
    // Nothing of the call's sounds left: the element rests instead of playing silence.
    if (!out.playing) out.el.pause();
  };
}

function context(): AudioContext | undefined {
  if (typeof AudioContext === 'undefined') return undefined;
  ctx ??= new AudioContext();
  return ctx;
}

function bufferOf(spec: SoundSpec, volume: number): AudioBuffer | undefined {
  const c = context();
  if (!c) return undefined;
  const cached = buffers.get(spec);
  if (cached) return cached;
  const samples = render(spec, volume, c.sampleRate);
  const buffer = c.createBuffer(1, samples.length, c.sampleRate);
  buffer.copyToChannel(samples, 0);
  buffers.set(spec, buffer);
  return buffer;
}

/**
 * Wake the window's sound from a click (Call, Join, or any first click in the window): WebKit keeps
 * a sound started without one silent, so the ringback and the ringtone would never be heard.
 */
export function wakeSound(): void {
  const c = context();
  if (c && c.state !== 'running') void c.resume().catch(() => undefined);
}

/** How a call sound plays: `inCall` while your microphone is open (heard through the call's stream). */
export interface PlayOptions {
  readonly volume?: number;
  readonly inCall?: boolean;
}

/** Play a call sound once. */
export function playOnce(spec: SoundSpec, { volume = 0.8, inCall = false }: PlayOptions = {}): void {
  const c = context();
  const buffer = bufferOf(spec, volume);
  if (!c || !buffer) return;
  void c.resume().catch(() => undefined);
  const source = c.createBufferSource();
  source.buffer = buffer;
  const release = connectOut(c, source, inCall);
  source.onended = release;
  source.start();
}

/** Play it again every `every` seconds until stopped (scheduled ahead, so it never stutters). */
export function loop(spec: SoundSpec, every: number, { volume = 0.8, inCall = false }: PlayOptions = {}): () => void {
  const c = context();
  const buffer = bufferOf(spec, volume);
  if (!c || !buffer) return () => undefined;
  void c.resume().catch(() => undefined);
  const gain = c.createGain();
  // A short swell in, so the first ring doesn't startle.
  gain.gain.setValueAtTime(0, c.currentTime);
  gain.gain.linearRampToValueAtTime(1, c.currentTime + 0.15);
  const release = connectOut(c, gain, inCall);
  const sources: AudioBufferSourceNode[] = [];
  let next = c.currentTime + 0.05;
  const schedule = (): void => {
    while (next < c.currentTime + every * 2) {
      const s = c.createBufferSource();
      s.buffer = buffer;
      s.connect(gain);
      s.start(next);
      sources.push(s);
      next += every;
    }
    while (sources.length > 4) sources.shift();
  };
  schedule();
  const stopSchedule = repeat(schedule, (every * 1000) / 2);
  return () => {
    stopSchedule();
    // A quick fade, so answering mid-ring doesn't click.
    gain.gain.cancelScheduledValues(c.currentTime);
    gain.gain.setTargetAtTime(0, c.currentTime, 0.12);
    setTimeout(() => {
      for (const s of sources) s.stop();
      release();
    }, 700);
  };
}
