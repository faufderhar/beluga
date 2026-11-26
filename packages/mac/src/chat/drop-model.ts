/**
 * Files dragged from Finder onto a conversation, as plain data: whether the drag is over it (the
 * app reports where in physical pixels), and which of the dropped paths can go with a message.
 * No DOM here, so it's tested on its own (use-attachments.tsx does the rest).
 */

import { keyPlatform } from '../lib/shortcuts-model.js';

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The drag at `x`, `y` (as the app gives them, `scale` of them to a CSS pixel: see dropScale) is over `box` (CSS pixels). A box with no size (hidden) is never hit. */
export function dropHits(box: Box | undefined, x: number, y: number, scale = 1): boolean {
  if (!box || box.right <= box.left || box.bottom <= box.top) return false;
  const px = x / (scale || 1);
  const py = y / (scale || 1);
  return px >= box.left && px <= box.right && py >= box.top && py <= box.bottom;
}

/**
 * How many of the app's drop units make one CSS pixel. The app calls them physical pixels, but on
 * a Mac and on Linux they're points, the page's own pixels (BLG-1000); only Windows gives the
 * screen's. Dividing by a Retina Mac's 2 found the drop up and to the left of the pointer.
 */
export const dropScale = (os: string, dpr: number): number => (os === 'windows' ? dpr || 1 : 1);

/** dropScale for this window. */
export const appDropScale = (): number => dropScale(keyPlatform(), globalThis.devicePixelRatio || 1);

/** The same place on screen (so a drag moving over it doesn't draw it again). */
export const sameBox = (a: Box | undefined, b: Box | undefined): boolean => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom);

/** How many dropped paths are looked at (Beluga checks up to this many at once). */
export const MAX_DROPPED = 20;

/**
 * Of the dropped paths' details: what can go with a message, in order (files, and folders by
 * their location when `folders`), the folders left out (a chat on another computer can't read a
 * path on this Mac), and how many were gone.
 */
export function droppedFiles<T extends { readonly kind: string }>(infos: readonly T[], { folders = true }: { readonly folders?: boolean } = {}): { readonly files: T[]; readonly folders: T[]; readonly missing: number } {
  const goes = (f: T): boolean => f.kind === 'file' || (folders && f.kind === 'folder');
  return {
    files: infos.filter(goes),
    folders: infos.filter((f) => f.kind === 'folder' && !folders),
    missing: infos.filter((f) => f.kind !== 'file' && f.kind !== 'folder').length,
  };
}

/** What a drop left out, said once (undefined: nothing was). */
export function leftOutWords(left: { readonly folders: readonly unknown[]; readonly missing: number }, computer: string): string | undefined {
  const parts = [
    left.folders.length === 1 ? `a folder stays on ${computer} (drop the files in it instead)` : '',
    left.folders.length > 1 ? `${left.folders.length} folders stay on ${computer} (drop the files in them instead)` : '',
    left.missing ? `${left.missing === 1 ? '1 item was' : `${left.missing} items were`} gone` : '',
  ].filter(Boolean);
  if (!parts.length) return undefined;
  const words = parts.join(', and ');
  return words[0]!.toUpperCase() + words.slice(1);
}
