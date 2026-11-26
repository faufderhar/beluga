/**
 * The Scratch tab, as plain data: how long ago a file was written, what kind of file it is, where
 * it sits, and which one the preview shows. No DOM here, so it's tested on its own.
 */

import { isImageFile, isVideoFile } from '../../components/markdown/md-paths.js';

export interface ScratchEntry {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
}

export type ScratchKind = 'image' | 'pdf' | 'video' | 'html' | 'json' | 'markdown' | 'text';

/** A file written this recently is marked as new. */
export const FRESH_MS = 15_000;

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 2) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export function fileKind(path: string): ScratchKind {
  if (isImageFile(path)) return 'image';
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (isVideoFile(path)) return 'video';
  if (/\.html?$/i.test(path)) return 'html';
  if (/\.json$/i.test(path)) return 'json';
  if (/\.(md|markdown)$/i.test(path)) return 'markdown';
  return 'text';
}

export const isFresh = (mtime: number, now = Date.now()): boolean => now - mtime < FRESH_MS;

/** The file the preview shows: the newest while following, else the one you picked (the newest once it's gone). */
export function followed(files: readonly ScratchEntry[], follow: boolean, picked: string | undefined): string | undefined {
  if (!follow && picked && files.some((f) => f.path === picked)) return picked;
  return files[0]?.path;
}

/** How near the end (in px) still counts as at the end. */
export const AT_END_PX = 8;

/**
 * Scrolled to the end of a file's view, so it follows what's written to it. Only a view that
 * scrolls has an end to scroll to: one that fits (at its top) waits for the to-the-end button.
 */
export const atEnd = (v: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean => v.scrollTop > 0 && v.scrollHeight - v.scrollTop - v.clientHeight <= AT_END_PX;

/** Where a listed file sits: which shown folder (`root`), the folders under it, and its name. */
export interface ScratchPlace {
  readonly root: string;
  readonly dir: string;
  readonly name: string;
}

export function scratchPlace(path: string, roots: readonly string[]): ScratchPlace {
  const name = path.split('/').pop() ?? path;
  const root = roots.find((r) => path.startsWith(`${r}/`)) ?? '';
  const dir = path.slice(root ? root.length + 1 : 0, path.length - name.length).replace(/\/$/, '');
  return { root, dir, name };
}

/** The shown folders that have something in them, in the order they're shown. */
export const foldersWithFiles = (files: readonly ScratchEntry[], roots: readonly string[]): string[] =>
  roots.filter((r) => files.some((f) => f.path.startsWith(`${r}/`)));

/**
 * What the tab shows: `loading` until the first look answers (the outline skeleton), `missing`
 * when there's no folder to look in, `empty` once looked and nothing's there (a calm empty
 * state, never the skeleton), else the `files`.
 */
export type ScratchState = 'loading' | 'missing' | 'empty' | 'files';

export function scratchState(list: { readonly files: readonly unknown[] } | null | undefined): ScratchState {
  if (list === undefined) return 'loading';
  if (list === null) return 'missing';
  return list.files.length ? 'files' : 'empty';
}

/** The placeholder rows' name widths (%), so the skeleton reads as a list of different files. */
export const GHOST_WIDTHS = [62, 44, 71, 38] as const;

// ---- sorting, and stepping through what can be looked at (BLG-111)

/** How the list is ordered: newest first, or what can be looked at first (then newest first in each). */
export type ScratchSort = 'newest' | 'viewable';

/** Shown as what it is rather than as text: pictures, videos, PDFs and web pages. */
export const isViewable = (path: string): boolean => {
  const kind = fileKind(path);
  return kind === 'image' || kind === 'video' || kind === 'pdf' || kind === 'html';
};

/**
 * The files in the order picked: newest first, or (`viewable`) what can be looked at first, each
 * group still newest first. Ties keep the listing's own order.
 */
export function sortScratch<T extends Pick<ScratchEntry, 'path' | 'mtime'>>(files: readonly T[], sort: ScratchSort): T[] {
  const newest = [...files].sort((a, b) => b.mtime - a.mtime);
  return sort === 'viewable' ? [...newest.filter((f) => isViewable(f.path)), ...newest.filter((f) => !isViewable(f.path))] : newest;
}

/**
 * The next (`1`) or previous (`-1`) file that can be looked at, from `current`, in the order given:
 * files that can't be are stepped over, and it stops at either end (undefined: nowhere to go).
 * From a file that isn't in the list, it starts at that end.
 */
export function stepViewable(paths: readonly string[], current: string | undefined, dir: 1 | -1): string | undefined {
  const at = current === undefined ? -1 : paths.indexOf(current);
  let i = at < 0 ? (dir > 0 ? -1 : paths.length) : at;
  for (i += dir; i >= 0 && i < paths.length; i += dir) if (isViewable(paths[i]!)) return paths[i];
  return undefined;
}

/** How much a scratch folder holds, all of it (the list shows only the newest few hundred). */
export interface ScratchTotal {
  readonly files: number;
  readonly bytes: number;
}

/**
 * How much it holds: the listed files' sizes while the list has them all (they're current), else the
 * count of everything (kept a moment, so a file just written may be missing from it).
 */
export function scratchBytes(files: readonly ScratchEntry[], total?: ScratchTotal): number | undefined {
  if (!total) return undefined;
  return total.files > files.length ? total.bytes : files.reduce((n, f) => n + f.size, 0);
}

/** The summary's title: "68 files", "300 of 5,578 files" when the list shows only the newest. */
export function scratchCount(listed: number, total?: ScratchTotal): string {
  const all = Math.max(listed, total?.files ?? 0);
  const word = all === 1 ? 'file' : 'files';
  return all > listed ? `${listed.toLocaleString('en-US')} of ${all.toLocaleString('en-US')} ${word}` : `${all.toLocaleString('en-US')} ${word}`;
}

// ---- what you sent, kept apart from what Claude saves (BLG-771)

/** Which of the folder's files the tab lists: what Claude saved, or the copies of what you sent it. */
export type ScratchView = 'claude' | 'sent';

/** The folder split in two: Claude's files and yours (`.beluga/scratch/sent/`), and which the tab lists. */
export interface ScratchSplit<T> {
  readonly view: ScratchView;
  readonly mine: readonly T[];
  readonly sent: readonly T[];
  /** The ones listed. */
  readonly shown: readonly T[];
}

/**
 * What the tab lists: the view you picked (what you sent only while there is some). Not picked yet:
 * Claude's files, or what you sent while Claude saved nothing. A pick sticks, even to Claude's empty
 * view: it was the "From Your Agent" you clicked that did nothing.
 */
export function splitSent<T extends Pick<ScratchEntry, 'path'>>(files: readonly T[], wanted: ScratchView | undefined, isSent: (path: string) => boolean): ScratchSplit<T> {
  const sent = files.filter((f) => isSent(f.path));
  const mine = files.filter((f) => !isSent(f.path));
  const view: ScratchView = !sent.length ? 'claude' : (wanted ?? (mine.length ? 'claude' : 'sent'));
  return { view, mine, sent, shown: view === 'sent' ? sent : mine };
}

/** How much the listed view holds: what you sent is all in the listing; Claude's is the rest of the count. */
export function viewTotal(split: ScratchSplit<ScratchEntry>, total?: ScratchTotal): ScratchTotal | undefined {
  const sentBytes = split.sent.reduce((n, f) => n + f.size, 0);
  if (split.view === 'sent') return { files: split.sent.length, bytes: sentBytes };
  return total ? { files: Math.max(split.mine.length, total.files - split.sent.length), bytes: Math.max(0, total.bytes - sentBytes) } : undefined;
}
