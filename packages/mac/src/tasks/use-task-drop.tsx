import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { inApp, webServed } from '../lib/boot.js';
import { toast, useApi, useBeluga } from '../lib/beluga.js';
import { type Box, MAX_DROPPED, appDropScale, droppedFiles, sameBox } from '../chat/drop-model.js';
import t from './tasks.module.css';

/**
 * Files dragged from Finder onto a task (its page, its card on the board, its row in the list): each
 * is added to it as a file for the work (kept by Beluga, listed under Files, given to its Claude).
 * Anything marked `data-task-drop` (the task's id) and `data-task-key` takes them. The app takes
 * Finder drops (the page never sees the files), so this listens to it, as the composer does.
 */

/** The props that make an element take files dropped for its task. */
export const taskDropProps = (issue: { readonly id: string; readonly key: string }): Record<string, string> => ({ 'data-task-drop': issue.id, 'data-task-key': issue.key });

interface Over {
  readonly id: string;
  readonly key: string;
  readonly box: Box;
}

/** What's under the drag at `x`, `y` (CSS pixels), if it takes files. */
function overAt(x: number, y: number): Over | undefined {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-task-drop]');
  const id = el?.dataset.taskDrop;
  if (!el || !id) return undefined;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return undefined;
  return { id, key: el.dataset.taskKey ?? 'this task', box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
}

const message = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error: /, '') : String(err));

/** Listens for Finder drops while mounted → the overlay to render (over what the drag is on). */
export function useTaskFileDrop(): ReactNode {
  const api = useApi();
  const { client } = useBeluga();
  const [over, setOver] = useState<Over>();

  const add = async (target: Over, paths: readonly string[]): Promise<void> => {
    let picked;
    try {
      picked = droppedFiles(await api.local.statFiles(paths.slice(0, MAX_DROPPED)), { folders: false });
    } catch (err) {
      return toast(client, `Couldn’t add what you dropped: ${message(err)}`, 'error');
    }
    const { files } = picked;
    const skipped = picked.folders.length + picked.missing;
    if (!files.length) return toast(client, 'Only files can be added to a task (not folders)', 'warn');
    let added = 0;
    for (const f of files) {
      try {
        await api.board.addProof(target.id, { kind: f.image ? 'image' : 'file', title: f.name.slice(0, 120), path: f.path, context: true });
        added++;
      } catch (err) {
        toast(client, `Couldn’t add ${f.name}: ${message(err)}`, 'error');
      }
    }
    const left = skipped ? ` (${skipped} folder${skipped === 1 ? '' : 's'} left out)` : '';
    if (added) toast(client, `Added ${added === 1 ? files[0]!.name : `${added} files`} to ${target.key}${left}`, 'success');
  };
  const latest = useRef(add);
  latest.current = add;

  // In a page the web port served, the browser's own drag and drop: the files are uploaded to the
  // computer Beluga runs on first, then added by their path there.
  useEffect(() => {
    if (inApp() || !webServed()) return;
    const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const onOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      const here = overAt(e.clientX, e.clientY);
      if (!here) return setOver(undefined);
      e.preventDefault();
      setOver((was) => (was?.id === here.id && sameBox(was.box, here.box) ? was : here));
    };
    const onLeave = (e: DragEvent): void => {
      if (!e.relatedTarget) setOver(undefined);
    };
    const onDrop = (e: DragEvent): void => {
      const here = hasFiles(e) ? overAt(e.clientX, e.clientY) : undefined;
      setOver(undefined);
      if (!here) return;
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])].slice(0, MAX_DROPPED);
      void import('../lib/web-files.js')
        .then(({ uploadFiles }) => uploadFiles(files, (file, err) => toast(client, `Couldn’t upload ${file.name}: ${message(err)}`, 'error')))
        .then((sent) => (sent.length ? latest.current(here, sent.map((u) => u.path)) : undefined));
    };
    document.addEventListener('dragover', onOver);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragover', onOver);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, [client]);

  useEffect(() => {
    if (!inApp()) return;
    let off: (() => void) | undefined;
    let alive = true;
    void import('../lib/file-drop.js').then(async ({ onFileDrop }) => {
      const un = await onFileDrop((p) => {
        if (p.type === 'leave') return setOver(undefined);
        const here = overAt(p.position.x / appDropScale(), p.position.y / appDropScale());
        if (p.type === 'drop') {
          setOver(undefined);
          if (here && p.paths.length) void latest.current(here, p.paths);
        } else setOver((was) => (was?.id === here?.id && sameBox(was?.box, here?.box) ? was : here));
      });
      if (alive) off = un;
      else un();
    });
    return () => {
      alive = false;
      off?.();
      setOver(undefined);
    };
  }, []);

  if (!over) return null;
  const { box } = over;
  // A card or a row: a slim outline with a small label; a page: the whole page, a bigger one.
  const small = box.bottom - box.top < 160;
  return createPortal(
    <div className={cx(t.fileDrop, small && t.fileDropSmall)} style={{ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }} aria-hidden>
      <div className={t.fileDropLabel}>
        <Icon name="file" size={small ? 12 : 16} />
        Add to {over.key}
      </div>
    </div>,
    document.body,
  );
}
