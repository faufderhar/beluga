/**
 * Experimental features (Settings › Experimental): early work that's off until you turn it on,
 * except the ones in DEFAULT_ON, which are on until you turn them off. One list for the daemon (what Claude is told, what the API allows) and the screens (the pane
 * that explains each one). Browser-safe: data only.
 */

export const EXPERIMENTS = ['previews'] as const;
export type Experiment = (typeof EXPERIMENTS)[number];

/** Experiments that are on by default: the switch stays, as an off switch. */
export const DEFAULT_ON: readonly Experiment[] = [];

/** How the list says "off" for an experiment that is on by default ("-<id>"). */
const offMark = (id: Experiment): string => `-${id}`;

export interface ExperimentInfo {
  readonly id: Experiment;
  readonly title: string;
  /** One sentence: what it is. */
  readonly summary: string;
  /** What changes in Beluga while it's on, a line each. */
  readonly changes: readonly string[];
  /** What it costs this computer, in plain words. */
  readonly cost: string;
  /** Other words people would search Settings with. */
  readonly keywords: string;
}

export const EXPERIMENT_INFO: Readonly<Record<Experiment, ExperimentInfo>> = {
  previews: {
    id: 'previews',
    title: 'Live previews',
    summary: 'See the React components and web pages your agent builds, drawn live in the chat, and play with them there.',
    changes: [
      'Your agent can show a component it made or changed as a live preview in its answer: React, Vue or Svelte, a web page, or your own dev server.',
      'Props are filled in from the component’s own types, and you can change each one beside it. What you change is kept.',
      'Tailwind, Next.js and your app’s providers work as in the app; your agent can add a small preview wrapper file for the providers.',
      'Each preview can pin hover and focus, switch to a dark canvas or a phone’s width, check accessibility and save a picture.',
      'Component files in Files get a Preview view. The preview follows the file: save it and the drawing updates in place.',
    ],
    keywords: 'preview component react render storybook page html props live',
    cost: 'Each preview is built on this computer when it scrolls into view, which takes a moment of CPU and some memory. Beluga lets it go when you look away, and while this is off nothing of it runs at all.',
  },
};

/**
 * Whether an experiment is on in the saved list (unknown ids from a newer Beluga are kept, never on).
 * One that is on by default is on unless the list has its off mark.
 */
export function experimentOn(enabled: readonly string[] | undefined, id: Experiment): boolean {
  if (DEFAULT_ON.includes(id)) return !enabled?.includes(offMark(id));
  return Boolean(enabled?.includes(id));
}

/** A live check of one experiment, for the daemon to hand to the code it gates (reads the prefs at each call). */
export function experimentGate(enabled: () => readonly string[] | undefined, id: Experiment): () => boolean {
  return () => experimentOn(enabled(), id);
}

/** The list with `id` turned on or off (a new list; order kept). */
export function withExperiment(enabled: readonly string[], id: Experiment, on: boolean): string[] {
  const rest = enabled.filter((e) => e !== id && e !== offMark(id));
  if (DEFAULT_ON.includes(id)) return on ? rest : [...rest, offMark(id)];
  return on ? [...rest, id] : rest;
}
