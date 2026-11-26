import type { BoardState } from './model.js';
import { knownOr } from '../../shared/known-or.js';

/**
 * Labels come from a set, never typed in passing: a few built-in ones every board has (Bug,
 * Important…), each with its own icon and color, and the ones people add to a project on purpose.
 * Claude only ever picks from the set. Tasks keep labels by name (lowercase); one that isn't in
 * the set any more (from before, from Linear, a teammate's own) still shows, plainly, and can be removed.
 */

/** Named colors (soft, the same hue in light and dark). */
export const LABEL_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'grey'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export const LABEL_COLOR_INFO: Readonly<Record<LabelColor, { readonly label: string; readonly hue: number; readonly sat: number }>> = knownOr({
  red: { label: 'Red', hue: 4, sat: 62 },
  orange: { label: 'Orange', hue: 28, sat: 70 },
  yellow: { label: 'Yellow', hue: 44, sat: 72 },
  green: { label: 'Green', hue: 142, sat: 42 },
  teal: { label: 'Teal', hue: 178, sat: 46 },
  blue: { label: 'Blue', hue: 212, sat: 60 },
  purple: { label: 'Purple', hue: 264, sat: 48 },
  pink: { label: 'Pink', hue: 330, sat: 54 },
  grey: { label: 'Grey', hue: 220, sat: 8 },
}, (v) => ({ label: v, hue: 0, sat: 0 }));

/** Icons a label can have (names in the Mac app's icon set). */
export const LABEL_ICONS = ['tag', 'bug', 'exclaim', 'sparkles', 'palette', 'book', 'wrench', 'flag', 'star', 'bulb', 'bolt', 'lock', 'gauge', 'globe', 'phone', 'heart'] as const;
export type LabelIcon = (typeof LABEL_ICONS)[number];

export interface LabelDef {
  /** Lowercase, what tasks keep ("bug", "dark-mode"). */
  readonly name: string;
  readonly icon: LabelIcon;
  readonly color: LabelColor;
  /** What it's for, in a few words (menus, and Claude). */
  readonly hint?: string;
}

/** Every board has these. */
export const DEFAULT_LABELS: readonly LabelDef[] = [
  { name: 'bug', icon: 'bug', color: 'red', hint: 'Something is broken' },
  { name: 'important', icon: 'exclaim', color: 'orange', hint: 'Matters more than most' },
  { name: 'feature', icon: 'sparkles', color: 'green', hint: 'Something new' },
  { name: 'design', icon: 'palette', color: 'purple', hint: 'How it looks and feels' },
  { name: 'docs', icon: 'book', color: 'blue', hint: 'Words for people' },
  { name: 'chore', icon: 'wrench', color: 'grey', hint: 'Upkeep: cleanup, tooling, dependencies' },
];

/** A label's name as tasks keep it: one short lowercase word or two joined by a dash. */
export const LABEL_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const cleanLabelName = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, '-');
/** Custom labels a project may have (the point is a few that mean something). */
export const MAX_CUSTOM_LABELS = 12;

/** A project's set: the built-in labels, then its own. */
export function labelsFor(board: Pick<BoardState, 'projects'>, projectId: string): readonly LabelDef[] {
  return [...DEFAULT_LABELS, ...(board.projects[projectId]?.labels ?? [])];
}

/** A label in a project's set, if it is one. */
export const labelDef = (board: Pick<BoardState, 'projects'>, projectId: string, name: string): LabelDef | undefined => labelsFor(board, projectId).find((l) => l.name === name.toLowerCase());

/** "dark-mode" → "Dark mode": how screens write a label. */
export const labelTitle = (name: string): string => {
  const words = name.replace(/-/g, ' ');
  return words ? words[0]!.toUpperCase() + words.slice(1) : words;
};

/** Split labels into those in the set (in its spelling) and those that aren't. */
export function inSet(defs: readonly LabelDef[], names: readonly string[]): { readonly known: string[]; readonly unknown: string[] } {
  const set = new Set(defs.map((d) => d.name));
  const clean = [...new Set(names.map(cleanLabelName).filter(Boolean))];
  return { known: clean.filter((n) => set.has(n)), unknown: clean.filter((n) => !set.has(n)) };
}
