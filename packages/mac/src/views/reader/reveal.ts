import { useSyncExternalStore } from 'react';
import type { Location } from '../../../../../src/core/store.js';
import { scrollWithin } from '../../lib/scroll-within.js';

/**
 * "Open this file at line 42" (a content search result): remembered until the file that shows
 * the line has drawn it, then scrolled to and flashed once.
 */

interface Reveal {
  readonly key: string;
  readonly line: number;
  readonly seq: number;
}

const keyOf = (at: Pick<Location, 'owner' | 'share' | 'path'>): string => `${at.owner}\0${at.share}\0${at.path}`;

let pending: Reveal | undefined;
let seq = 0;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Ask the file's view to show this line (call before or after opening it). */
export function revealLine(at: Pick<Location, 'owner' | 'share' | 'path'>, line: number): void {
  pending = { key: keyOf(at), line, seq: ++seq };
  emit();
}

/** A line waiting to be shown in this file (without taking it). */
export const pendingLine = (at: Pick<Location, 'owner' | 'share' | 'path'>): number | undefined => (pending?.key === keyOf(at) ? pending.line : undefined);

/** Shown: done with it. */
export function doneRevealing(at: Pick<Location, 'owner' | 'share' | 'path'>): void {
  if (pending?.key === keyOf(at)) pending = undefined;
}

/** The line waiting for this file, as { line, seq } (a new seq for the same line again), re-rendering when one comes. */
export function useReveal(at: Pick<Location, 'owner' | 'share' | 'path'>): { line: number; seq: number } | undefined {
  const p = useSyncExternalStore(subscribe, () => pending);
  return p && p.key === keyOf(at) ? { line: p.line, seq: p.seq } : undefined;
}

/** Scroll a drawn line (1-based) of the code in `root` into the middle of its page and flash it. */
export function scrollToLine(root: HTMLElement, line: number, flash: string): boolean {
  const code = root.querySelector('pre code');
  // Long code comes in blocks of lines (CodeLines): its lines are theirs.
  const lines = code?.querySelector(':scope > [data-chunk]') ? code.querySelectorAll(':scope > [data-chunk] > *') : code?.children;
  const el = lines?.[Math.max(0, Math.min(lines.length - 1, line - 1))] as HTMLElement | undefined;
  if (!el) return false;
  scrollWithin(el, 'center');
  el.classList.remove(flash);
  void el.offsetWidth;
  el.classList.add(flash);
  setTimeout(() => el.classList.remove(flash), 1600);
  return true;
}
