import { type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon.js';
import { inApp, webServed } from '../lib/boot.js';
import { toast, useApi, useBeluga, useMachine, useScopedKey } from '../lib/beluga.js';
import { cx } from '../components/ui.js';
import { type DropVerdict, type Sending, envAsk, planDrop, sendFiles, sentShare } from './attachments.js';
import { openSheet } from '../lib/sheets.js';
import { currentMachines } from '../machines/use-machines.js';
import { type Box, MAX_DROPPED, dropHits, droppedFiles, sameBox } from './drop-model.js';
import { imageLinksIn } from '@beluga/shared/attachment-links.js';
import { type RefKey, boxRef, plainRefs, refKey, referencedImages, withoutRef } from './image-refs.js';
import { keepPreview, openLightbox, pendingImage, previewOf } from './images.js';
import { plainWorktrees, toBox, worktreeNamesOf } from './worktree-box.js';
import { type ImageInText, type PathInfo, insertText, usePastePaths } from './paste-paths.js';
import s from './composer.module.css';
import img from './images.module.css';

/**
 * What goes with a message besides its words, the same in every message box (a conversation's
 * and a plan's): images pasted, dropped, or named by their path in pasted text wait as thumbnails,
 * with an "[image N]" in the words where they go; other files whose paths were pasted wait as
 * chips. Kept per conversation, so switching away and back keeps them.
 *
 * Beluga numbers images for the whole session; the box numbers its own from 1 (a removed one's
 * number goes to the next image), and its "[image N]" say those. They go out with the session's
 * numbers beside them (`take`), so the links say what the box did.
 *
 * Files dragged from Finder anywhere on the conversation (the element marked `data-drop-zone`
 * around the box) go in the same way: the app takes the drop and hands over their paths.
 */

/** Images waiting to be sent, per conversation. */
const waitingImages = new Map<string, readonly number[]>();
/** Other files (their paths were pasted) waiting to go with the message, per conversation. */
const waitingFiles = new Map<string, readonly PathInfo[]>();
/** The file name each image came with (the end of it shows on its chip in the words). */
const imageNames = new Map<number, string>();
/** The name Beluga saved each image under (for opening it full size before it goes). */
const imageFiles = new Map<number, string>();
/** The number each waiting image has in its box (by Beluga's number), per conversation. */
const boxNumbers = new Map<string, Map<number, number>>();
const numbersOf = (channel: string): Map<number, number> => {
  let m = boxNumbers.get(channel);
  if (!m) boxNumbers.set(channel, (m = new Map()));
  return m;
};

/**
 * Image `n` waits in `channel`'s box: its number there (the one it has if it already waits, else
 * the lowest that no waiting image has and no "[image N]" in the words says).
 */
function numberIn(channel: string, n: number, words: string): number {
  const numbers = numbersOf(channel);
  const waiting = waitingImages.get(channel) ?? [];
  const had = numbers.get(n);
  if (had !== undefined && waiting.includes(n)) return had;
  const taken = new Set([...waiting.filter((x) => x !== n).map((x) => numbers.get(x)), ...referencedImages(words)]);
  let k = 1;
  while (taken.has(k)) k++;
  numbers.set(n, k);
  return k;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Files that aren't images (a served page uploads them, web-files.ts). */
const othersOf = (files: FileList | undefined): File[] => [...(files ?? [])].filter((f) => !f.type.startsWith('image/'));

const imagesOf = (items: DataTransferItemList | undefined): File[] =>
  [...(items ?? [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));

export interface Attachments {
  readonly images: readonly number[];
  readonly files: readonly PathInfo[];
  /** Something is being dragged over the box (or, from Finder, over the conversation). */
  readonly dropping: boolean;
  /** Over the conversation while files from Finder are dragged on it: where they'll go. */
  readonly dropTarget: React.ReactNode;
  /** For the box around the words: drop images on it. */
  readonly dropProps: Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;
  /** For the text field. */
  readonly onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Add image files (a paste, a drop). */
  readonly attach: (files: readonly File[]) => Promise<void>;
  /**
   * The message to send for what was typed: its images where their references are (those whose
   * reference was taken out go after it) and other files' paths. They leave the box; `putBack`
   * returns them if sending fails. Commands ("/…") go as typed, and attachments stay. `images`:
   * the ones going (only their "[image N]" become links; one typed by hand stays words), and
   * `shown` the number each has in the box, which its "[image N]" says (both for
   * `attachments.expand`).
   */
  readonly take: (typed: string) => { readonly text: string; readonly images: readonly number[]; readonly shown: readonly number[]; readonly putBack: () => void };
  /** For the text field's keydown: an "[image N]" goes whole (its picture too), and arrows step over it. True when it was handled. */
  readonly onRefKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /**
   * A message that went (a queued one pulled back to edit): your images linked in it wait again
   * as thumbnails, and their links become "[image N]". → the words for the box.
   */
  readonly restore: (sent: string) => Promise<string>;
  /** The thumbnails and file chips, for above the words. */
  readonly waiting: React.ReactNode;
}

/**
 * `text`/`setText`: the words in the box (the composer keeps them in the window's UI state, the
 * plan chat in its own).
 */
export function useAttachments({ channel, box, text, setText }: { channel: string; box: RefObject<HTMLTextAreaElement | null>; text: () => string; setText: (text: string, cursor: number) => void }): Attachments {
  // What waits in the box is kept per computer too (BLG-784): `channel` stays what the computer calls it.
  const memo = useScopedKey(channel);
  const { client } = useBeluga();
  const api = useApi();
  const selfId = client.store.getState().selfId;
  const [images, setImagesState] = useState<readonly number[]>(() => waitingImages.get(memo) ?? []);
  useEffect(() => setImagesState(waitingImages.get(memo) ?? []), [memo]);
  const setImages = (next: readonly number[]): void => {
    waitingImages.set(memo, next);
    setImagesState(next);
  };
  const pendingImages = images.filter((n) => previewOf(n));
  const [files, setFilesState] = useState<readonly PathInfo[]>(() => waitingFiles.get(memo) ?? []);
  useEffect(() => setFilesState(waitingFiles.get(memo) ?? []), [memo]);
  const setFiles = (next: readonly PathInfo[]): void => {
    if (next.length) waitingFiles.set(memo, next);
    else waitingFiles.delete(memo);
    setFilesState(next);
  };
  const [dropping, setDropping] = useState(false);
  // A chat on one of your computers (BLG-793): files dropped from this Mac go there, this one on its way.
  const machine = useMachine();
  const { home } = useBeluga();
  const [sending, setSending] = useState<Sending>();

  /** The number image `n` has in this box. */
  const shownOf = (n: number): number => numbersOf(memo).get(n) ?? n;
  /** How the words refer to a waiting image (it becomes a link to it when sent). */
  const imageRef = (n: number): string => boxRef(shownOf(n), imageNames.get(n));
  /** The image whose "[image N]" says `shown` (undefined: none waits with that number). */
  const imageShown = (shown: number): number | undefined => (waitingImages.get(memo) ?? []).find((n) => shownOf(n) === shown);
  /** Image `n` waits too, numbered in this box (before its reference goes in the words). */
  const addWaiting = (n: number): void => {
    numberIn(memo, n, text());
    const waiting = waitingImages.get(memo) ?? [];
    if (!waiting.includes(n)) setImages([...waiting, n]);
  };

  /** "[image N]" goes in the words where the cursor is (or `where`), so you can say what it shows. → where the cursor is after it. */
  const placeRef = (n: number, where?: number): number => {
    const now = text();
    const el = box.current;
    const at = Math.min(where ?? (el && document.activeElement === el ? el.selectionStart : now.length), now.length);
    const before = now.slice(0, at);
    const after = now.slice(at);
    const chip = `${before && !/\s$/.test(before) ? ' ' : ''}${imageRef(n)}${after && !/^\s/.test(after) ? ' ' : after ? '' : ' '}`;
    setText(before + chip + after, before.length + chip.length);
    requestAnimationFrame(() => el?.setSelectionRange(before.length + chip.length, before.length + chip.length));
    return before.length + chip.length;
  };

  const attach = async (picked: readonly File[]): Promise<void> => {
    for (const file of picked) {
      const ext = (/image\/(png|jpe?g|gif|webp)/.exec(file.type)?.[1] ?? 'png') as 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp';
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      let added: { n: number; chip: string; file?: string };
      try {
        added = await api.attachments.add(ext, btoa(bin));
        // A pasted picture is just "image.png": the name Beluga saved it under tells them apart.
        const named = file.name && !/^image\.\w+$/i.test(file.name) ? file.name : added.file;
        if (named) imageNames.set(added.n, named);
        if (added.file) imageFiles.set(added.n, added.file);
        keepPreview(added.n, file);
      } catch (err) {
        toast(client, `Couldn't add ${file.name || 'the image'}: ${errorText(err)}`, 'error');
        continue;
      }
      addWaiting(added.n);
      placeRef(added.n);
    }
  };

  /** An image file on this Mac, waiting to go: its number (undefined when it couldn't be added, said in a toast). */
  const addImageFile = async (f: PathInfo): Promise<number | undefined> => {
    try {
      const added = await api.attachments.addFile(f.path);
      imageNames.set(added.n, f.name);
      imageFiles.set(added.n, added.file);
      const shown = await api.attachments.read(selfId, added.file);
      keepPreview(added.n, new Blob([Uint8Array.from(atob(shown.data), (c) => c.charCodeAt(0))], { type: shown.mime }));
      addWaiting(added.n);
      return added.n;
    } catch (err) {
      toast(client, `Couldn't add ${f.name}: ${errorText(err)}`, 'error');
      return undefined;
    }
  };

  /** Files on this Mac: images wait as thumbnails (referenced at `at`, else where the cursor is), others as chips. */
  const addPaths = async (picked: readonly PathInfo[], at?: number): Promise<void> => {
    const others = picked.filter((f) => !f.image);
    if (others.length) setFiles([...(waitingFiles.get(memo) ?? []), ...others.filter((f) => !(waitingFiles.get(memo) ?? []).some((w) => w.path === f.path))]);
    let cursor = at;
    for (const f of picked.filter((x) => x.image)) {
      const n = await addImageFile(f);
      if (n !== undefined) cursor = placeRef(n, cursor);
    }
  };

  /**
   * Files dropped in a page the web port served: uploaded to the computer Beluga runs on, then
   * waiting as chips with their path there (the agent reads them from there).
   */
  const uploadOthers = async (picked: readonly File[]): Promise<void> => {
    const { uploadFiles } = await import('../lib/web-files.js');
    const sent = await uploadFiles(picked.slice(0, MAX_DROPPED), (file, err) => toast(client, `Couldn't upload ${file.name}: ${errorText(err)}`, 'error'));
    if (sent.length) await addPaths(sent.map((u) => ({ path: u.path, name: u.name, kind: 'file' as const, size: u.size, image: false })));
    box.current?.focus();
  };

  /**
   * Paths dropped from Finder on a chat that runs on one of your computers (BLG-793): the files
   * are on this Mac, so each goes there first, then waits by its path there.
   */
  const sendThere = async (there: string, paths: readonly string[]): Promise<void> => {
    let infos: readonly PathInfo[];
    try {
      infos = await home.call('local.statFiles', paths.slice(0, MAX_DROPPED));
    } catch (err) {
      return toast(client, `Couldn't add what you dropped: ${errorText(err)}`, 'error');
    }
    const { files: picked, skipped } = droppedFiles(infos);
    if (skipped) toast(client, picked.length ? `Only files go with a message: ${skipped} left out` : 'Only files go with a message (not folders)', 'warn');
    if (!picked.length) return;
    // The env send's rules (BLG-854): keys and credential folders stay here; an env file asks first.
    let checks: readonly DropVerdict[];
    try {
      checks = await home.call('machines.upload.check', picked.map((f) => f.path));
    } catch (err) {
      return toast(client, `Couldn't add what you dropped: ${errorText(err)}`, 'error');
    }
    const plan = planDrop(picked, checks);
    for (const r of plan.refused) toast(client, `${r.name} stays on this Mac: ${r.reason}`, 'warn');
    const go = async (files: readonly PathInfo[], env: boolean): Promise<void> => {
      const arrived = await sendFiles(
        (machine, n, file, off) => home.call('machines.upload.send', machine, n, file, off, env ? { env: true } : undefined),
        there,
        files,
        setSending,
        (f, err) => toast(client, `Couldn't send ${f.name}: ${errorText(err)}`, 'error'),
      );
      if (arrived.length) await addPaths(arrived);
      box.current?.focus();
    };
    if (plan.send.length) await go(plan.send, false);
    if (plan.ask.length) openSheet(envAsk(plan.ask, currentMachines().find((m) => m.id === there)?.name ?? 'that computer', () => void go(plan.ask, true)));
  };

  /** Paths dropped from Finder: the files among them go as a paste of their paths would. */
  const dropPaths = async (paths: readonly string[]): Promise<void> => {
    if (machine) return sendThere(machine, paths);
    let infos: readonly PathInfo[];
    try {
      infos = await api.local.statFiles(paths.slice(0, MAX_DROPPED));
    } catch (err) {
      return toast(client, `Couldn't add what you dropped: ${errorText(err)}`, 'error');
    }
    const { files: picked, skipped } = droppedFiles(infos);
    if (skipped) toast(client, picked.length ? `Only files go with a message: ${skipped} left out` : 'Only files go with a message (not folders)', 'warn');
    if (!picked.length) return;
    await addPaths(picked);
    box.current?.focus();
  };
  const latestDrop = useRef(dropPaths);
  latestDrop.current = dropPaths;

  // Finder drops: the app takes them (the page never sees the files), so listen to it. Each box
  // answers for its own conversation only, and not while it can't be written in.
  const [dragOver, setDragOver] = useState<Box>();
  useEffect(() => {
    if (!inApp()) return;
    let off: (() => void) | undefined;
    let alive = true;
    const zoneAt = (x: number, y: number): Box | undefined => {
      const el = box.current;
      if (!el || el.disabled || el.readOnly) return undefined;
      const r = (el.closest('[data-drop-zone]') ?? el.parentElement)?.getBoundingClientRect();
      const at = r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : undefined;
      return dropHits(at, x, y, window.devicePixelRatio || 1) ? at : undefined;
    };
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === 'leave') return setDragOver(undefined);
        const here = zoneAt(p.position.x, p.position.y);
        if (p.type === 'drop') {
          setDragOver(undefined);
          if (here && p.paths.length) void latestDrop.current(p.paths);
        } else setDragOver((was) => (sameBox(was, here) ? was : here));
      });
      if (alive) off = un;
      else un();
    });
    return () => {
      alive = false;
      off?.();
      setDragOver(undefined);
    };
  }, [memo]);

  const pastePaths = usePastePaths(
    box,
    // Only paths of files on this Mac: images wait as thumbnails (referenced where the cursor was), others as chips.
    (picked, at) => void addPaths(picked, at),
    // Words naming images: the words go in, each image's path (quotes and all) becomes its reference.
    async (pasted: string, found: readonly ImageInText[], at) => {
      let words = '';
      let from = 0;
      for (const hit of found) {
        const n = await addImageFile(hit.info);
        words += pasted.slice(from, hit.start) + (n === undefined ? pasted.slice(hit.start, hit.end) : imageRef(n));
        from = hit.end;
      }
      words += pasted.slice(from);
      if (box.current) insertText(box.current, words, at);
    },
  );

  /** The waiting images full size (the lightbox: Esc or a click outside closes), from image `n`. */
  const openImages = (n: number): void => {
    const all = pendingImages.flatMap((x) => {
      const file = imageFiles.get(x);
      const shown = file ? pendingImage(x, selfId, file, `image ${shownOf(x)}`) : undefined;
      return shown ? [{ n: x, shown }] : [];
    });
    const at = all.findIndex((x) => x.n === n);
    if (at >= 0) openLightbox(all.map((x) => x.shown), at);
  };

  const removeImage = (n: number): void => {
    setImages(images.filter((x) => x !== n));
    const now = text();
    const next = withoutRef(now, shownOf(n));
    if (next !== now) setText(next, next.length);
    box.current?.focus();
  };

  const onRefKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const el = e.currentTarget;
    if (e.metaKey || e.ctrlKey || e.altKey || (e.shiftKey && e.key.startsWith('Arrow'))) return false;
    if (e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
    const edit = refKey(el.value, el.selectionStart, el.selectionEnd, e.key as RefKey);
    if (!edit) return false;
    e.preventDefault();
    if (edit.kind === 'move') {
      el.setSelectionRange(edit.cursor, edit.cursor);
      return true;
    }
    // Through the field's own editing, so ⌘Z brings it back.
    insertText(el, '', { start: edit.start, end: edit.end });
    const left = referencedImages(el.value);
    const gone = edit.images.filter((k) => !left.includes(k)).map(imageShown);
    if (gone.length) setImages((waitingImages.get(memo) ?? []).filter((n) => !gone.includes(n)));
    return true;
  };

  const restore = async (sent: string): Promise<string> => {
    let out = '';
    let at = 0;
    for (const link of imageLinksIn(sent)) {
      out += sent.slice(at, link.start);
      at = link.end;
      if (link.owner !== selfId) {
        out += sent.slice(link.start, link.end);
        continue;
      }
      try {
        const { n } = await api.attachments.reattach(link.file);
        if (!imageNames.has(n)) imageNames.set(n, link.file);
        imageFiles.set(n, link.file);
        if (!previewOf(n)) {
          const shown = await api.attachments.read(selfId, link.file);
          keepPreview(n, new Blob([Uint8Array.from(atob(shown.data), (c) => c.charCodeAt(0))], { type: shown.mime }));
        }
        // Numbered against what's in the box and what this message has put back so far.
        numberIn(memo, n, text() + out);
        const waiting = waitingImages.get(memo) ?? [];
        if (!waiting.includes(n)) setImages([...waiting, n]);
        out += imageRef(n);
      } catch {
        // Gone from this Mac: the link stays as it was.
        out += sent.slice(link.start, link.end);
      }
    }
    // Worktrees' links back short, as they were typed.
    return toBox(out + sent.slice(at), worktreeNamesOf(client.store.getState().projects));
  };

  const take = (boxed: string): { text: string; images: readonly number[]; shown: readonly number[]; putBack: () => void } => {
    // Worktrees' links written short in the box go out whole ("worktree:wt-…").
    const typed = plainWorktrees(boxed, worktreeNamesOf(client.store.getState().projects));
    if (typed.startsWith('/')) return { text: typed, images: [], shown: [], putBack: () => undefined };
    const pictures = pendingImages;
    const placed = referencedImages(typed);
    const unplaced = pictures.filter((n) => !placed.includes(shownOf(n)));
    // Other files go as their paths (Claude reads them from this Mac).
    const others = files;
    // The chips' names stay in the box: out they go as "[image N]".
    const words = plainRefs(typed);
    const out = pictures.length || others.length ? [words, unplaced.map((n) => boxRef(shownOf(n))).join(' '), others.map((f) => `\`${f.path}\``).join('\n')].filter(Boolean).join('\n\n') : words;
    if (pictures.length) setImages([]);
    if (others.length) setFiles([]);
    return {
      text: out,
      images: pictures,
      shown: pictures.map(shownOf),
      putBack: () => {
        if (pictures.length) setImages(pictures);
        if (others.length) setFiles(others);
      },
    };
  };

  const waiting = (
    <>
      {pendingImages.length ? (
        <div className={img.pending} role="group" aria-label="Images to send">
          {pendingImages.map((n) => (
            <div key={n} className={img.pendingItem}>
              <button type="button" className={img.pendingOpen} aria-label={`Open image ${shownOf(n)}`} onClick={() => openImages(n)}>
                <img src={previewOf(n)} alt={`image ${shownOf(n)}`} draggable={false} />
              </button>
              <span className={img.pendingLabel}>{shownOf(n)}</span>
              <button type="button" className={img.pendingRemove} aria-label={`Remove image ${shownOf(n)}`} onClick={() => removeImage(n)}>
                <Icon name="x" size={9} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {sending ? (
        <div className={s.fileChips} role="status" aria-label={`Sending ${sending.name}`}>
          <span className={cx(s.fileChip, s.fileSending)} title={`Sending ${sending.name} to the computer this chat runs on`}>
            <Icon name="up" size={11} />
            <span className={s.fileName}>{sending.name}</span>
            <span className={s.fileProgress}>{sentShare(sending)}</span>
          </span>
        </div>
      ) : null}
      {files.length ? (
        <div className={s.fileChips} role="list" aria-label="Files to send">
          {files.map((f) => (
            <span key={f.path} role="listitem" className={s.fileChip} title={f.path}>
              <Icon name="file" size={11} />
              <span className={s.fileName}>{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x.path !== f.path))}>
                <Icon name="x" size={9} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );

  const dropTarget = dragOver
    ? createPortal(
        <div className={s.dropTarget} style={{ left: dragOver.left, top: dragOver.top, width: dragOver.right - dragOver.left, height: dragOver.bottom - dragOver.top }} aria-hidden>
          <div className={s.dropTargetLabel}>
            <Icon name="image" size={16} />
            Drop to attach
          </div>
        </div>,
        document.body,
      )
    : null;

  return {
    images: pendingImages,
    files,
    dropping: dropping || Boolean(dragOver),
    dropTarget,
    dropProps: {
      onDragOver: (e) => {
        if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/')) || (webServed() && [...e.dataTransfer.types].includes('Files'))) {
          e.preventDefault();
          setDropping(true);
        }
      },
      onDragLeave: () => setDropping(false),
      onDrop: (e) => {
        const dropped = imagesOf(e.dataTransfer.items);
        const others = webServed() ? othersOf(e.dataTransfer.files) : [];
        setDropping(false);
        if (!dropped.length && !others.length) return;
        e.preventDefault();
        if (dropped.length) void attach(dropped);
        if (others.length) void uploadOthers(others);
      },
    },
    onPaste: (e) => {
      // For your stats (the Usage tab): how much text you pasted, never what.
      const chars = e.clipboardData.getData('text/plain').length;
      if (chars) void api.stats.note({ kind: 'paste', chars: Math.min(chars, 10_000_000), channel }).catch(() => undefined);
      const pasted = imagesOf(e.clipboardData.items);
      if (!pasted.length) return void pastePaths(e);
      e.preventDefault();
      void attach(pasted);
    },
    attach,
    take,
    onRefKey,
    restore,
    waiting,
  };
}
