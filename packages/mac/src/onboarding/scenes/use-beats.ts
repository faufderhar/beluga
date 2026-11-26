import { useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { usePrefs } from '../../lib/prefs.js';

/**
 * A scene's beats: each lasts its own time (ms), then the next one plays, round and round
 * (`onLoop` when it starts over).
 * With Reduce Motion (the Mac's, or Beluga's own) the scene holds on `rest`, the beat that
 * explains it best on its own.
 */
export function useBeats(durations: readonly number[], rest = durations.length - 1, onLoop?: () => void): number {
  return useBeatControl(durations, { rest, onLoop }).beat;
}

export interface BeatOptions {
  /** The beat a still scene (Reduce Motion) holds on. */
  readonly rest?: number;
  /** Called as the last beat ends, before it starts over. */
  readonly onLoop?: () => void;
  /** Hold on the current beat (someone is looking at something they opened). */
  readonly paused?: boolean;
}

/**
 * Beats a click can move (BLG-989): the scene plays on its own, and `go` jumps to a beat when
 * someone presses what the scene is waiting on (Allow, Invite, a request), timing on from there.
 * With Reduce Motion it holds on `rest` until a click moves it, and then stays where it was sent.
 */
export function useBeatControl(durations: readonly number[], { rest = durations.length - 1, onLoop, paused = false }: BeatOptions = {}): { readonly beat: number; readonly go: (to: number) => void; readonly still: boolean } {
  const still = (useReducedMotion() ?? false) || usePrefs().reduceMotion;
  const [beat, setBeat] = useState(still ? rest : 0);
  useEffect(() => {
    if (still || paused) return;
    const t = setTimeout(() => {
      if (beat === durations.length - 1) onLoop?.();
      setBeat((beat + 1) % durations.length);
    }, durations[beat]);
    return () => clearTimeout(t);
  }, [beat, still, paused]);
  return { beat, go: setBeat, still };
}
