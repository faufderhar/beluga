/**
 * Files and folders dragged onto the window from outside (Finder, Explorer), with their paths.
 *
 * On a Mac and on Linux the app takes these drags itself and reports them (Tauri's
 * onDragDropEvent). On Windows that is off (tauri.windows.conf.json): while it's on, the page gets
 * no drag of its own, so a panel tab couldn't be dragged to another group (Dockview). There the
 * page gets the drag as a browser would, and since a page's files carry no path, the app is asked
 * where they are (src-tauri/src/drop_paths.rs).
 *
 * Either way the listener hears the same thing, positions in the app's drop units (appDropScale).
 */

import { appDropScale } from '../chat/drop-model.js';
import { type KeyPlatform, keyPlatform } from './shortcuts-model.js';

export interface DropPosition {
  readonly x: number;
  readonly y: number;
}

export type FileDropEvent =
  | { readonly type: 'enter' | 'over'; readonly position: DropPosition }
  | { readonly type: 'drop'; readonly position: DropPosition; readonly paths: readonly string[] }
  | { readonly type: 'leave' };

export type FileDropListener = (e: FileDropEvent) => void;

/** A drag that carries files (never one of the page's own: a tab, a card, a row). */
export const carriesFiles = (types: Iterable<string> | undefined): boolean => !!types && [...types].includes('Files');

/**
 * Whether a box's own drop handler (the page's onDrop) takes a drag of files. Not when the app
 * already hands that drop over by path: on Windows the page sees every drop from Explorer, and a
 * box listening with onFileDrop gets it there too, so taking it here as well attached it twice.
 * On a Mac and Linux the page never sees a drop from outside, so its handler only meets its own drags.
 */
export const boxTakesFiles = (o: { readonly platform: KeyPlatform; readonly inApp: boolean; readonly hearsAppDrops: boolean }): boolean =>
  !(o.platform === 'windows' && o.inApp && o.hearsAppDrops);

/** Where the pointer is in the page (CSS pixels), in the app's drop units. */
export const dropPosition = (clientX: number, clientY: number, scale: number): DropPosition => ({ x: clientX * (scale || 1), y: clientY * (scale || 1) });

/** How long the app has to say where dropped files are before the drop is given up. */
const PATHS_WAIT_MS = 3000;

interface WebViewBridge {
  postMessageWithAdditionalObjects?: (message: unknown, objects: ArrayLike<unknown>) => void;
}

const listeners = new Set<FileDropListener>();
const tell = (e: FileDropEvent): void => {
  for (const l of [...listeners]) l(e);
};

let started = false;
let dropCount = 0;
const waiting = new Map<number, (paths: readonly string[]) => void>();

/** The paths of the page's dropped files, from the app; none when it can't say. */
function pathsOf(files: readonly File[]): Promise<readonly string[]> {
  const bridge = (globalThis as { chrome?: { webview?: WebViewBridge } }).chrome?.webview;
  if (!files.length || !bridge?.postMessageWithAdditionalObjects) return Promise.resolve([]);
  const id = ++dropCount;
  return new Promise((resolve) => {
    const done = (paths: readonly string[]): void => {
      if (!waiting.delete(id)) return;
      clearTimeout(timer);
      resolve(paths);
    };
    const timer = setTimeout(() => done([]), PATHS_WAIT_MS);
    waiting.set(id, done);
    try {
      // A string: the app's own handler for the page's messages takes nothing else, and ours comes after it.
      bridge.postMessageWithAdditionalObjects?.(`beluga-drop:${id}`, files);
    } catch {
      done([]);
    }
  });
}

/** Listen to the page's own drags, once for the window. */
function startPageDrops(): void {
  if (started) return;
  started = true;
  void import('@tauri-apps/api/event').then(({ listen }) =>
    listen<{ id: number; paths: string[] }>('file-drop-paths', (e) => waiting.get(e.payload.id)?.(e.payload.paths)),
  );
  let inside = false;
  const at = (e: DragEvent): DropPosition => dropPosition(e.clientX, e.clientY, appDropScale());
  const over = (e: DragEvent): void => {
    if (!carriesFiles(e.dataTransfer?.types)) return;
    // Ours to take: left alone, the window would open the file in place of Beluga.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    tell({ type: inside ? 'over' : 'enter', position: at(e) });
    inside = true;
  };
  document.addEventListener('dragenter', over);
  document.addEventListener('dragover', over);
  document.addEventListener('dragleave', (e) => {
    // Leaving the window, not going from one element to the next.
    if (!inside || e.relatedTarget) return;
    inside = false;
    tell({ type: 'leave' });
  });
  document.addEventListener('drop', (e) => {
    if (!carriesFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    inside = false;
    const position = at(e);
    const files = [...(e.dataTransfer?.files ?? [])];
    void pathsOf(files).then((paths) => tell(paths.length ? { type: 'drop', position, paths } : { type: 'leave' }));
  });
}

/** Hear files dragged over and dropped on this window; the answer stops it. Only in the app. */
export async function onFileDrop(listener: FileDropListener): Promise<() => void> {
  if (keyPlatform() === 'windows') {
    listeners.add(listener);
    startPageDrops();
    return () => void listeners.delete(listener);
  }
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent((e: { readonly payload: FileDropEvent }) => listener(e.payload));
}
