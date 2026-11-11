import { useEffect, useState, useSyncExternalStore } from 'react';
import { ATTACHMENT_SCHEME } from '@beluga/core/attachment-share.js';
import type { LinkedImage } from '@beluga/shared/attachment-links.js';
import type { Location } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { copyPng } from '../lib/copy.js';
import { sourceTag } from '../machines/pane-model.js';

/**
 * Images linked in chat messages, fetched through the core (yours from disk, a friend's through
 * their share) and kept as object URLs for this window. Plus the one open lightbox.
 *
 * Kept small (BLG-367): a message shows a copy no bigger than THUMB_PX (a full-size Retina screenshot
 * decodes to ~24 MB, its thumbnail to ~2), the full picture is read only for the lightbox, and
 * both caches let the oldest go, but never one that's on screen.
 */

type Api = SocketClient['api'];
export type ImageSize = 'thumb' | 'full';

/** A thumbnail's longest side, in pixels: 360 CSS px on a Retina screen, with room to spare. */
export const THUMB_PX = 1024;
/** How many of each the window keeps (beyond those on screen). */
const KEEP = { thumb: 120, full: 4 } as const;

interface Entry {
  readonly url: Promise<string>;
  /** Shown now (by useImage): not let go. */
  users: number;
  /** Not ours to let go (a pasted image's preview, kept by `pending`). */
  readonly borrowed?: boolean;
}

const caches = { thumb: new Map<string, Entry>(), full: new Map<string, Entry>() };

/** Let the oldest go, past what the window keeps: least recently used first, never one shown or borrowed. */
function trim(size: ImageSize): void {
  const cache = caches[size];
  const kept = (e: Entry): boolean => e.users > 0 || Boolean(e.borrowed);
  let over = cache.size - KEEP[size] - [...cache.values()].filter(kept).length;
  for (const [key, e] of cache) {
    if (over <= 0) break;
    if (kept(e)) continue;
    cache.delete(key);
    void e.url.then(URL.revokeObjectURL, () => undefined);
    over--;
  }
}

function toBlob(data: string, mime: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** The picture no bigger than THUMB_PX on its longest side (as it is, when it's already that small or can't be read). */
export async function shrink(blob: Blob, px = THUMB_PX): Promise<Blob> {
  if (blob.type === 'image/svg+xml' || blob.type === 'image/gif') return blob;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }
  try {
    const scale = px / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return blob;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const g = canvas.getContext('2d');
    if (!g) return blob;
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // A photo stays a photo (small as JPEG); a screenshot or anything see-through stays PNG.
    const type = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9))) ?? blob;
  } finally {
    bitmap.close();
  }
}

function entry(size: ImageSize, key: string): Entry | undefined {
  const e = caches[size].get(key);
  if (!e) return undefined;
  // Used again: newest (Maps keep the order things went in).
  caches[size].delete(key);
  caches[size].set(key, e);
  return e;
}

/**
 * An image a message shows: one sent to the room (an attachment), or a file on this Mac that a
 * message points at by its path (`![](/Users/…/shot.png)`, as Claude shows screenshots).
 */
export type ChatImage = LinkedImage & {
  /** The file's path on this Mac, when the message names one. */
  readonly local?: string;
};

type Loadable = Pick<ChatImage, 'href' | 'owner' | 'file' | 'local'>;

/** Where a file on this Mac is, as Beluga reads it (asked once per path). */
const located = new Map<string, Promise<Location>>();

/** A path on the computer `api` is of (BLG-784): the same path on two computers is two files. */
const pathKey = (api: Api, local: string): string => `${sourceTag(api)}\0${local}`;

function locate(api: Api, local: string): Promise<Location> {
  const k = pathKey(api, local);
  const hit = located.get(k);
  if (hit) return hit;
  const at = api.session.localLocation(local, false);
  located.set(k, at);
  at.catch(() => located.get(k) === at && located.delete(k));
  return at;
}

/**
 * What a picture is kept under. A file on this Mac also says which version it is (its size and when
 * it last changed, a stat, not a read), so one rewritten under the same name is read again (BLG-749);
 * when that can't be told (it's gone), its path alone.
 */
async function keyOf(api: Api, image: Loadable): Promise<{ key: string; at?: Location }> {
  if (!image.local) return { key: image.href };
  const at = await locate(api, image.local);
  try {
    const { size, mtime } = await api.files.version(at);
    return { key: `${pathKey(api, image.href)}\0${mtime}:${size}`, at };
  } catch {
    // Where it is is asked again next time (its folder may have been shared since).
    located.delete(pathKey(api, image.local));
    return { key: pathKey(api, image.href), at };
  }
}

function load(api: Api, image: Loadable, size: ImageSize, key: string, at?: Location): Entry {
  const hit = entry(size, key);
  if (hit) return hit;
  const read: Promise<Blob> = image.local
    ? (at ? Promise.resolve(at) : locate(api, image.local)).then((loc) => api.files.readImageFile(loc)).then((r) => toBlob(r.data, r.mediaType))
    : api.attachments.read(image.owner, image.file).then((r) => toBlob(r.data, r.mime));
  const url = (size === 'thumb' ? read.then((b) => shrink(b)) : read).then((b) => URL.createObjectURL(b));
  const e: Entry = { url, users: 0 };
  caches[size].set(key, e);
  // A failure isn't kept: the next time it shows, it tries again (the friend may be back).
  url.catch(() => caches[size].get(key) === e && caches[size].delete(key));
  trim(size);
  return e;
}

/** The image as a URL this window can show (fetched on first use, then kept a while): `thumb` for a message, `full` for the lightbox. */
export function loadImage(api: Api, image: Loadable, size: ImageSize = 'full'): Promise<string> {
  return keyOf(api, image).then(({ key, at }) => load(api, image, size, key, at).url);
}

/** The image, kept until `release` (while it's on screen). */
export function holdImage(api: Api, image: Loadable, size: ImageSize): { url: Promise<string>; release: () => void } {
  let held: Entry | undefined;
  let released = false;
  const url = keyOf(api, image).then(({ key, at }) => {
    const e = load(api, image, size, key, at);
    if (!released) {
      e.users++;
      held = e;
    }
    return e.url;
  });
  return {
    url,
    release: () => {
      if (released) return;
      released = true;
      if (!held) return;
      held.users--;
      trim(size);
    },
  };
}

/** Whether a failed read means the file is gone (an agent deleted or moved it since it linked it). */
export const imageGone = (error: string): boolean => /ENOENT|no such file|is not there|is gone/i.test(error);

/** What a picture that can't show says in its place: never the raw error for one that was deleted. */
export const unavailableText = (error: string): { text: string; detail: string } =>
  imageGone(error) ? { text: 'Image no longer here', detail: 'The file was moved or deleted since this was written' } : { text: 'Image unavailable', detail: error };

export type ImageState ={ readonly status: 'loading' } | { readonly status: 'ready'; readonly url: string } | { readonly status: 'error'; readonly error: string };

/** The image while it's on screen (kept that long): `thumb` in a message, `full` in the lightbox. */
export function useImage(api: Api, image: ChatImage, size: ImageSize = 'thumb'): ImageState {
  const [state, setState] = useState<ImageState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    const held = holdImage(api, image, size);
    held.url.then(
      (url) => alive && setState({ status: 'ready', url }),
      (err: unknown) => alive && setState({ status: 'error', error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      alive = false;
      held.release();
    };
  }, [api, image.href, size]);
  return state;
}

// ---- pictures of images pasted into the box, by chip number (kept while the draft is)

const pending = new Map<number, string>();

/** Remember what a pasted image looks like (its chip may outlive the box that took it). */
export function keepPreview(n: number, file: Blob): void {
  pending.set(n, URL.createObjectURL(file));
}

export const previewOf = (n: number): string | undefined => pending.get(n);

/**
 * A pasted image as the lightbox shows it, before it's sent (`file`: the name Beluga saved it
 * under, so Open finds it): its picture is the one kept here, nothing to fetch.
 */
export function pendingImage(n: number, owner: string, file: string, label: string): ChatImage | undefined {
  const url = pending.get(n);
  if (!url) return undefined;
  const href = `${ATTACHMENT_SCHEME}${owner}/${file}`;
  for (const cache of Object.values(caches)) if (!cache.has(href)) cache.set(href, { url: Promise.resolve(url), users: 0, borrowed: true });
  return { href, owner, file, label };
}

// ---- the lightbox: one per window, opened from any message

interface Lightbox {
  readonly images: readonly ChatImage[];
  readonly index: number;
}

let open: Lightbox | undefined;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function openLightbox(images: readonly ChatImage[], index = 0): void {
  open = { images, index: Math.max(0, Math.min(index, images.length - 1)) };
  emit();
}

export function closeLightbox(): void {
  open = undefined;
  emit();
}

/** Show the next (1) or previous (-1) image of the same message. */
export function stepLightbox(delta: number): void {
  if (!open || open.images.length < 2) return;
  open = { ...open, index: (open.index + delta + open.images.length) % open.images.length };
  emit();
}

export function useLightbox(): Lightbox | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => open,
  );
}

/** Put the image on the clipboard as PNG, which every app pastes. */
export async function copyImage(url: string): Promise<void> {
  const blob = await (await fetch(url)).blob();
  const png =
    blob.type === 'image/png'
      ? blob
      : await new Promise<Blob>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d')?.drawImage(img, 0, 0);
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't convert the image"))), 'image/png');
          };
          img.onerror = () => reject(new Error("Couldn't read the image"));
          img.src = url;
        });
  await copyPng(png);
}
