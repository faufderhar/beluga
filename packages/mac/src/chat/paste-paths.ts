import { type RefObject, useRef } from 'react';
import type { PathInfo } from '@beluga/core/attachments.js';
import { inApp } from '../lib/boot.js';
import { useApi, useBeluga } from '../lib/beluga.js';
import { candidatePaths, imagePathsIn, pathsInPaste, pickPaths } from './paste-paths-model.js';
import { toBox, worktreeNamesOf } from './worktree-box.js';

/**
 * A pasted file path becomes the file: "/Users/…/CleanShot … .png" (quoted, with escaped
 * spaces, ~/…, or a file:// URL; one or more, one per line) is checked with Beluga, and when
 * every one is a file here the box attaches them instead of the words. In other text, each
 * image's path (plain, quoted or “smart quoted”) becomes that image and the words stay.
 * Anything else, and ⌘⇧V (Edit › Paste as Plain Text), pastes the text as it is.
 */

export type { PathInfo };

// ---- ⌘⇧V: the text, as it is. The key can reach the page (a paste event follows) and the menu
// bar (its item runs pastePlain) in either order: whichever is second within a moment does nothing.

const ECHO_MS = 400;
let plainKeyAt = 0;
let plainDoneAt = 0;
let plainBy: 'page' | 'menu' | undefined;

if (typeof document !== 'undefined') {
  document.addEventListener(
    'keydown',
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') plainKeyAt = Date.now();
    },
    true,
  );
}

/** Put text where the cursor is in a text field, as typing would (undo works, React hears it). */
export function insertText(el: HTMLTextAreaElement | HTMLInputElement, text: string, at?: { start: number; end: number }): void {
  el.focus();
  if (at) el.setSelectionRange(at.start, at.end);
  if (document.execCommand('insertText', false, text)) return;
  el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Edit › Paste as Plain Text: the clipboard's words into the focused field. */
export async function pastePlain(): Promise<void> {
  if (plainBy === 'page' && Date.now() - plainDoneAt < ECHO_MS) return;
  const el = document.activeElement;
  if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return;
  const text = inApp() ? await (await import('@tauri-apps/plugin-clipboard-manager')).readText() : await navigator.clipboard.readText();
  if (!text) return;
  plainBy = 'menu';
  plainDoneAt = Date.now();
  insertText(el, text);
}

/** An image's path in pasted text: `start`–`end` of the text is it (quotes and all). */
export interface ImageInText {
  readonly start: number;
  readonly end: number;
  readonly info: PathInfo;
}

/**
 * The paste handler for a message box. `onFiles` gets the files (images and others) and where
 * the cursor was, when the paste is only their paths; `onText` gets other text that names images
 * here, with where they are in it, to put in the box (at `at`) with the images in place of their
 * paths. Text naming no file here goes into the box unchanged. Returns true when it took the
 * paste (the caller doesn't handle it then).
 */
export function usePastePaths(
  ref: RefObject<HTMLTextAreaElement | null>,
  onFiles: (files: readonly PathInfo[], at: number) => void,
  onText?: (text: string, images: readonly ImageInText[], at: { start: number; end: number }) => void,
): (e: React.ClipboardEvent<HTMLTextAreaElement>) => boolean {
  const api = useApi();
  const { client } = useBeluga();
  const latest = useRef(onFiles);
  latest.current = onFiles;
  const latestText = useRef(onText);
  latestText.current = onText;
  return (e) => {
    const plain = Date.now() - plainKeyAt < ECHO_MS;
    if (plain) {
      // The menu already pasted it: this is the echo.
      if (plainBy === 'menu' && Date.now() - plainDoneAt < ECHO_MS) {
        e.preventDefault();
        return true;
      }
      plainBy = 'page';
      plainDoneAt = Date.now();
      return false;
    }
    const text = e.clipboardData.getData('text/plain');
    const paths = text ? pathsInPaste(text) : undefined;
    const el = ref.current;
    const spots = !paths && text && latestText.current ? imagePathsIn(text) : [];
    if (el && !paths && !spots.length) {
      // A worktree's link (Copy Link): written short, so its chip is as wide as its name (BLG-887).
      const boxed = text.includes('worktree:') ? toBox(text, worktreeNamesOf(client.store.getState().projects)) : text;
      if (boxed === text) return false;
      e.preventDefault();
      insertText(el, boxed, { start: el.selectionStart, end: el.selectionEnd });
      return true;
    }
    if (!el || (!paths && !spots.length)) return false;
    e.preventDefault();
    const at = { start: el.selectionStart, end: el.selectionEnd };
    const asText = (): void => {
      if (ref.current) insertText(ref.current, text, at);
    };
    if (!paths) {
      // Words with images' paths in them: ask which readings are images here.
      const asked = candidatePaths(spots);
      api.local.statFiles(asked).then(
        (infos) => {
          const found = new Map(asked.map((p, i) => [p, infos[i]] as const));
          const picks = pickPaths(spots, (p) => found.get(p)?.kind === 'file' && Boolean(found.get(p)?.image));
          if (!picks.length || !latestText.current) return asText();
          latestText.current(text, picks.map((p) => ({ start: p.start, end: p.end, info: found.get(p.path)! })), at);
        },
        () => asText(),
      );
      return true;
    }
    api.local.statFiles(paths).then(
      (infos) => {
        if (!infos.every((f) => f.kind === 'file')) return asText();
        // The words the paths would have replaced go, as a paste would.
        const box = ref.current;
        if (at.end > at.start && box) {
          box.focus();
          box.setSelectionRange(at.start, at.end);
          document.execCommand('delete');
        }
        latest.current(infos, at.start);
      },
      () => asText(),
    );
    return true;
  };
}
