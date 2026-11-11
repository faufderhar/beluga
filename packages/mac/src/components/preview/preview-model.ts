// Relative, not @beluga/shared: the root's tests and typecheck read this file too.
import type { PreviewProblem } from '../../../../../src/shared/preview/opened.js';
import { type Field, type Shape, choicesOf, isFlatRows, isNumberGrid, required } from '../../../../../src/shared/preview/shape.js';
import { MARK, isMark, pictureOf, sampleValue } from '../../../../../src/shared/preview/samples.js';

/**
 * A live preview's own rules, apart from drawing it (PreviewBlock.tsx): which control each prop
 * gets, how tall the frame is, what's kept when the component is rebuilt, and what your agent is
 * told when you ask it to fix one. Pure.
 */

export type ControlKind = 'choice' | 'switch' | 'number' | 'text' | 'longText' | 'color' | 'picture' | 'date' | 'event' | 'grid' | 'rows' | 'json';

const LONG = /\b(description|desc|body|content|message|text|summary|bio|details?|excerpt|caption|subtitle)\b/i;
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The control a prop gets, from its type and the value it has now. */
export function controlOf(field: Field, value: unknown): ControlKind {
  const s = required(field.shape);
  if (choicesOf(s)) return 'choice';
  switch (s.kind) {
    case 'function':
      return 'event';
    case 'boolean':
      return 'switch';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'string':
    case 'node':
    case 'literal':
      return textControl(field.name, value);
    case 'array':
    case 'tuple':
      if (isNumberGrid(s)) return 'grid';
      if (isFlatRows(s)) return 'rows';
      return 'json';
    case 'unknown':
      if (isMark(value, 'fn') || /^on[A-Z]/.test(field.name)) return 'event';
      if (typeof value === 'boolean') return 'switch';
      if (typeof value === 'number') return 'number';
      if (typeof value === 'string') return textControl(field.name, value);
      return 'json';
    default:
      return 'json';
  }
}

function textControl(name: string, value: unknown): ControlKind {
  if (pictureOf(value)) return 'picture';
  if (typeof value === 'string' && COLOR.test(value)) return 'color';
  if (LONG.test(name.replace(/([a-z])([A-Z])/g, '$1 $2')) || (typeof value === 'string' && value.length > 48)) return 'longText';
  return 'text';
}

/** A union's choices as the strings a picker shows (and back to the value). */
export function choiceLabels(shape: Shape): Array<{ readonly label: string; readonly value: string | number | boolean }> {
  return (choicesOf(required(shape)) ?? []).map((value) => ({ label: String(value), value }));
}

/** The prop whose choices "Every variant" draws side by side: the first with a few short ones. */
export function variantField(fields: readonly Field[]): Field | undefined {
  return fields.find((f) => {
    const choices = choicesOf(required(f.shape));
    return choices && choices.length >= 2 && choices.length <= 8 && choices.every((c) => String(c).length <= 24);
  });
}

/** How wide a component is drawn: the chat's width, or a device's (shown smaller to fit). */
export type ComponentWidth = 'fit' | 'phone' | 'tablet' | 'desktop';
export const COMPONENT_WIDTHS: ReadonlyArray<{ readonly value: ComponentWidth; readonly label: string }> = [
  { value: 'fit', label: 'Fit' },
  { value: 'phone', label: 'Phone' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'desktop', label: 'Desktop' },
];

/** Use These Props: what your agent is asked, with the props as you have them now. */
export function propsForAgent(name: string, file: string | undefined, values: Readonly<Record<string, unknown>>): string {
  return [`Use these props for ${name}${file ? ` (${file})` : ''}: make them its sample or default props, and use them in its preview from now on.`, '', '```json', JSON.stringify(values, null, 2).slice(0, 6000), '```'].join('\n');
}

/** How tall a component's frame is, from what it says it needs. */
export const FRAME = { min: 96, initial: 180, max: 560, maxExpanded: 920 } as const;

/** A problem shown over the last drawing (it still drew once); the others take the frame's place. */
export function floatsOverFrame(problem: PreviewProblem): boolean {
  return problem.kind === 'render' || problem.kind === 'provider';
}

export function frameHeight(reported: number | undefined, expanded: boolean): number {
  if (reported === undefined) return FRAME.initial;
  return Math.max(FRAME.min, Math.min(Math.ceil(reported), expanded ? FRAME.maxExpanded : FRAME.max));
}

/** A page drawn at `width` inside a box `box` wide: how much smaller it's shown (never bigger). */
export function pageScale(box: number, width: number): number {
  if (box <= 0 || width <= 0) return 1;
  return Math.min(1, box / width);
}

/**
 * Props after a rebuild: what you set stays while the prop still exists; new props get the
 * values the build came with; props that went away go.
 */
export function mergeProps(fields: readonly Field[], fresh: Readonly<Record<string, unknown>>, yours: Readonly<Record<string, unknown>>, touched: ReadonlySet<string>): Record<string, unknown> {
  const names = new Set(fields.map((f) => f.name));
  const out: Record<string, unknown> = { ...fresh };
  for (const name of touched) {
    if (!names.has(name)) continue;
    if (name in yours) out[name] = yours[name];
    else delete out[name];
  }
  return out;
}

/** A value for a prop you cleared and then set again: the sample the types give. */
export function startValue(field: Field): unknown {
  if (field.fallback !== undefined) return field.fallback;
  return sampleValue(field.shape, field.name);
}

/** A value as editable JSON (functions and dates as what they are). */
export function toJson(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

/** Editable JSON back to a value; undefined when it doesn't read. */
export function fromJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (!text.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** A date mark's day (yyyy-mm-dd) for a date field, and back. */
export const dayOf = (value: unknown): string => (isMark(value, 'date') ? String((value as Record<string, unknown>).iso).slice(0, 10) : typeof value === 'string' ? value.slice(0, 10) : '');
export const dateAt = (day: string): unknown => ({ [MARK]: 'date', iso: new Date(`${day}T09:00:00`).toISOString() });

/** A row of numbers or a grid, resized: new cells count on from the last. */
export function resizeGrid(grid: readonly (readonly number[])[], rows: number, cols: number): number[][] {
  const r = Math.max(1, Math.min(rows, 24));
  const c = Math.max(1, Math.min(cols, 24));
  return Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => grid[i]?.[j] ?? i * c + j + 1));
}

/** What your agent gets when you ask it to fix a preview: what happened in plain words, then the details. */
export function askToFix(title: string, problem: PreviewProblem, props?: Readonly<Record<string, unknown>>): string {
  const lines = [`The live preview of ${title} isn’t drawing: ${problem.title}. Can you fix it so it does?`];
  if (problem.forClaude) lines.push('', '```text', problem.forClaude.slice(0, 4000), '```');
  if (props && problem.kind === 'render') lines.push('', 'It was drawn with these props:', '```json', JSON.stringify(props, null, 2).slice(0, 2000), '```');
  return lines.join('\n');
}

/** Problems that may clear up by themselves (a save, a dev server starting): looked at again now and then. */
export const RETRYING: ReadonlySet<PreviewProblem['kind']> = new Set(['syntax', 'missing-import', 'missing-package', 'not-installed', 'not-running', 'missing', 'no-component', 'build']);

/** How often those are looked at again while the preview is on screen. */
export const RETRY_MS = 2500;

/** An event a callback prop fired, as a line ("onSelect("team")"). */
export interface FiredEvent {
  readonly id: number;
  readonly name: string;
  readonly detail: string;
}

/** The newest few events, newest first. */
export function addEvent(events: readonly FiredEvent[], name: string, detail: string, id: number, keep = 4): FiredEvent[] {
  return [{ id, name, detail }, ...events].slice(0, keep);
}
