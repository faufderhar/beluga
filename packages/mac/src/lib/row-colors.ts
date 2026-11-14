import { LABEL_COLORS, LABEL_COLOR_INFO, type LabelColor } from '../../../../src/core/board/labels.js';

/**
 * Colours you give projects and conversations, so what each chat works on stands out in the
 * sidebar. Only ever picked by you (nothing is coloured until you do), and kept on this Mac, like a
 * group's icon. A chat or worktree without a colour of its own wears its project's; "None" on one
 * keeps it plain even then. The names are the board's label colours, so a colour means the same everywhere.
 */

export type RowColor = LabelColor;
/** What's kept for one row: a colour, or `none` (plain even in a coloured project). */
export type RowColorChoice = RowColor | 'none';
/** By `project:<id>` and `ws:<id>`. */
export type RowColors = Readonly<Record<string, RowColorChoice>>;

export const ROW_COLORS: readonly RowColor[] = LABEL_COLORS;

export const projectColorKey = (projectId: string): string => `project:${projectId}`;
export const workspaceColorKey = (wsId: string): string => `ws:${wsId}`;

const isRowColor = (v: unknown): v is RowColor => typeof v === 'string' && (ROW_COLORS as readonly string[]).includes(v);
const isChoice = (v: unknown): v is RowColorChoice => v === 'none' || isRowColor(v);

/** A project's colour (a project never says `none`: it's simply plain). */
export function projectColor(colors: RowColors, projectId: string): RowColor | undefined {
  const c = colors[projectColorKey(projectId)];
  return isRowColor(c) ? c : undefined;
}

/** A chat's or worktree's colour: its own, else its project's; `none` keeps it plain. */
export function workspaceColor(colors: RowColors, wsId: string, projectId: string | undefined): RowColor | undefined {
  const own = colors[workspaceColorKey(wsId)];
  if (own === 'none') return undefined;
  if (isRowColor(own)) return own;
  return projectId ? projectColor(colors, projectId) : undefined;
}

/** The colours with one row's changed (`undefined`: back to the default, its project's for a chat). Never changes `colors`. */
export function withColor(colors: RowColors, key: string, choice: RowColorChoice | undefined): RowColors {
  const { [key]: _old, ...rest } = colors;
  // A project's "none" is the same as no colour: nothing to keep.
  if (choice === undefined || (choice === 'none' && key.startsWith('project:'))) return rest;
  return { ...rest, [key]: choice };
}

/** Saved colours, as read back: anything that isn't one (an old name, a hand edit) is dropped. */
export function rowColorsOf(saved: unknown): RowColors {
  if (!saved || typeof saved !== 'object') return {};
  return Object.fromEntries(Object.entries(saved as Record<string, unknown>).filter(([k, v]) => /^(project|ws):./.test(k) && isChoice(v))) as RowColors;
}

export const colorLabel = (c: RowColor): string => LABEL_COLOR_INFO[c].label;

/** The CSS variables a coloured row (and its icon) draws from. */
export function colorVars(c: RowColor): Readonly<Record<string, string>> {
  const { hue, sat } = LABEL_COLOR_INFO[c];
  return { '--row-hue': String(hue), '--row-sat': `${sat}%` };
}

/** The colour as a menu's swatch shows it. */
export function swatchOf(c: RowColor): string {
  const { hue, sat } = LABEL_COLOR_INFO[c];
  return `hsl(${hue} ${sat}% 62%)`;
}

/** The hue a project's letter tile takes when you coloured the project. */
export const tileHue = (c: RowColor): number => LABEL_COLOR_INFO[c].hue;
