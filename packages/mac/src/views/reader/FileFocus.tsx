import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ViewerState } from '@beluga/core/store.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { SHOWN_SCRATCH_DIRS } from '@beluga/shared/scratch-dir.js';
import { Icon } from '../../components/Icon.js';
import { IconButton, Kbd, Segmented } from '../../components/ui.js';
import { DocFind } from '../../components/markdown/DocFind.js';
import type { DocNav } from '../../components/markdown/MarkdownDoc.js';
import { useCopied } from '../../components/markdown/CodeBlock.js';
import { useApp, useBeluga } from '../../lib/beluga.js';
import { localPathOf, openWithDefaultApp, revealInFinder, saveFile } from '../../lib/files.js';
import { closeFocus, showPanelTab } from '../../lib/panel.js';
import { getPrefs, setPrefs, usePrefs } from '../../lib/prefs.js';
import { isViewable, scratchPlace, sortScratch, stepViewable } from '../../layout/panel/scratch-model.js';
import { SCROLL_ROOT } from '../../components/markdown/md-dom.js';
import { EditTools } from './EditTools.js';
import { useEditSession } from './edit-store.js';
import { FileContent } from './FileReader.js';
import { ComponentPreview, PreviewToggle, useComponentPreview, usePreviewing } from './component-preview.js';
import { pendingLine } from './reveal.js';
import { type ReaderMode, hasRenderedLook, hasText, initialMode } from './reader-model.js';
import r from './reader.module.css';
import { revealLabel } from '../../lib/os-words.js';
import { useRevealFileLabel } from '../../lib/remote-open.js';

/** Space, Page Up/Down, Home and End scroll the page even when nothing has the keyboard. */
const PAGE_KEYS = new Set([' ', 'PageDown', 'PageUp', 'Home', 'End']);

function usePageKeys(page: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = page.current;
      if (!el || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !PAGE_KEYS.has(e.key)) return;
      // Only when nothing has the keyboard: the page scrolls on its own, a field types, a button presses.
      if (e.target instanceof HTMLElement && e.target !== document.body) return;
      e.preventDefault();
      const pageBy = el.clientHeight * 0.9;
      const to =
        e.key === 'Home' ? 0 : e.key === 'End' ? el.scrollHeight : el.scrollTop + (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey) ? -pageBy : pageBy);
      el.scrollTo({ top: to });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** The keys go to something that uses them (a field, the editor, a video's own controls). */
const keysTaken = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('input, textarea, select, video, audio, [role="slider"], .cm-editor')));

/** The keyboard is in a list of files (a tree or a listbox) that steps through them with the arrows. */
const browsingList = (el: Element | null): boolean => el instanceof HTMLElement && Boolean(el.closest('[role="tree"], [role="listbox"]'));

/**
 * ← and → over a picture, video, PDF or web page from the workspace's Scratch: the previous or next
 * one of those in Scratch's own order (newest first, or viewable first), stepping over files that
 * can't be looked at and stopping at either end. The folder is looked at again on each press, so a
 * file that just landed is in the order too.
 */
function useScratchArrows(viewer: ViewerState, wsId: string, editing: boolean): void {
  const { client } = useBeluga();
  const selfId = useApp((st) => st.selfId);
  const now = useRef({ viewer, editing });
  now.current = { viewer, editing };
  useEffect(() => {
    let busy = false;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const { viewer: v, editing: busyEditing } = now.current;
      if (busyEditing || keysTaken(e.target) || v.owner !== selfId || v.share !== shareNameOf(wsId)) return;
      if (!isViewable(v.path) || !scratchPlace(v.path, SHOWN_SCRATCH_DIRS).root) return;
      e.preventDefault();
      if (busy) return;
      busy = true;
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      client.api.workspaces
        .scratch(wsId)
        .then((res) => {
          if (!res || now.current.viewer.path !== v.path) return;
          const order = sortScratch(res.files, getPrefs().scratchSort === 'viewable' ? 'viewable' : 'newest').map((f) => f.path);
          const next = stepViewable(order, v.path, dir);
          if (next) return client.api.files.open({ owner: v.owner, share: v.share, path: next });
          return undefined;
        })
        .catch(() => undefined)
        .finally(() => (busy = false));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wsId, selfId]);
}

/**
 * A file across the whole center: where it is, Rendered or Source for Markdown, wrap for code,
 * Copy, Open in Editor and Show in Finder, and the file itself in a page that scrolls (⌘F finds
 * in it; Esc goes back to the chat).
 */
export function FileFocus({ viewer, wsId }: { viewer: ViewerState; wsId: string }) {
  const { client } = useBeluga();
  // On a computer's page the file is downloaded instead (BLG-852).
  const revealFile = useRevealFileLabel();
  const prefs = usePrefs();
  const wsName = useApp((st) => findWorkspace(st.projects, wsId)?.name);
  const selfId = useApp((st) => st.selfId);
  const local = useApp((st) => localPathOf(st, viewer));
  // Opened from a project's page (its main folder's Files): Esc goes back to the project.
  const back = useApp((st) => (st.view.kind === 'project' ? 'Back to Project' : 'Back to Chat'));
  const page = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [mode, setModeNow] = useState<ReaderMode>(() => (pendingLine(viewer) ? 'source' : initialMode(viewer)));
  // Rendered ⇄ Source keeps your place (as a share of the way down the file).
  const place = useRef<number | undefined>(undefined);
  const setMode = (next: ReaderMode): void => {
    const el = page.current;
    place.current = el && el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : undefined;
    setModeNow(next);
  };
  useLayoutEffect(() => {
    const el = page.current;
    if (!el || place.current === undefined) return;
    el.scrollTop = place.current * (el.scrollHeight - el.clientHeight);
    place.current = undefined;
  }, [mode]);
  const [copied, copy] = useCopied();
  usePageKeys(page);

  // Another file opened here (a link in a document): it starts at its top, as itself. Stepping
  // through a list beside it (the panel's Files), the keyboard stays there, so ↑ and ↓ keep stepping.
  useEffect(() => {
    setModeNow(pendingLine(viewer) ? 'source' : initialMode(viewer));
    page.current?.scrollTo({ top: 0 });
    if (!browsingList(document.activeElement)) page.current?.focus({ preventScroll: true });
  }, [viewer.path]);

  const editing = Boolean(useEditSession(viewer));
  useScratchArrows(viewer, wsId, editing);
  // A component file, with Live previews on: drawn live beside its source.
  const component = useComponentPreview(viewer, wsId);
  const [previewing, setPreviewing] = usePreviewing(viewer.path);
  const drawing = Boolean(component && previewing && !editing);
  const markdown = hasRenderedLook(viewer.path);
  const isText = hasText(viewer);
  const showsCode = isText && (!markdown || mode === 'source') && !editing;
  const name = viewer.path.split('/').pop() || viewer.path;
  const folders = viewer.path.split('/').slice(0, -1);
  // Other files (not Markdown) open in the panel's Files, next to the chat.
  const nav: Partial<DocNav> = {
    openFile: (path) => {
      closeFocus();
      const state = client.store.getState();
      showPanelTab(state, 'files');
      void client.api.files.open({ ...viewer, path });
    },
    openDir: (path) => {
      closeFocus();
      showPanelTab(client.store.getState(), 'files');
      void client.api.files.browseTo({ ...viewer, path });
    },
  };
  return (
    <section className={r.focus} aria-label={name}>
      <header className={r.bar}>
        <button type="button" className={r.back} onClick={closeFocus} aria-label={back}>
          <Icon name="back" size={12} />
          {back}
          <Kbd>Esc</Kbd>
        </button>
        <span className={r.divider} />
        <nav className={r.crumbs} aria-label="Path" title={viewer.path}>
          <Icon name="file" size={13} className={r.crumbIcon} />
          {wsName ? <span className={r.crumb}>{wsName}</span> : null}
          {folders.map((f, i) => (
            <span key={`${f}:${i}`} className={r.crumb}>
              {f}
            </span>
          ))}
          <span className={r.crumbFile}>{name}</span>
          {viewer.by ? <span className={r.following}>following {viewer.by}</span> : null}
        </nav>
        <span className={r.flex} />
        {markdown && isText && !editing ? (
          <Segmented size="small"
            label="Show as"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'rendered', label: 'Rendered' },
              { value: 'source', label: 'Source' },
            ]}
          />
        ) : null}
        {component && !editing ? <PreviewToggle previewing={previewing} onChange={setPreviewing} /> : null}
        {showsCode && !drawing ? <IconButton size="small" icon="wrap" label={prefs.readerWrap ? 'Don’t wrap long lines' : 'Wrap long lines'} active={prefs.readerWrap} onClick={() => setPrefs({ readerWrap: !prefs.readerWrap })} /> : null}
        <EditTools viewer={viewer} wsId={wsId} selfId={selfId} />
        <span className={r.tools}>
          {isText ? <IconButton size="small" icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy the text'} onClick={() => copy(viewer.content)} /> : null}
          {local ? <IconButton size="small" icon="external" label="Open in Editor" onClick={() => void openWithDefaultApp(client, local)} /> : null}
          {local ? <IconButton size="small" icon="folder" label={revealFile} onClick={() => void revealInFinder(client, local)} /> : null}
          {!local ? <IconButton size="small" icon="download" label="Save a copy…" onClick={() => void saveFile(client, viewer)} /> : null}
        </span>
      </header>
      <div className={r.body}>
        <div ref={page} className={r.page} tabIndex={0} {...{ [SCROLL_ROOT]: '' }} aria-label={`${name}, ${markdown && mode === 'rendered' ? 'formatted' : 'contents'}`}>
          <div ref={content} className={r.pageInner}>
            {drawing && component ? <ComponentPreview previewRef={component} wsId={wsId} /> : <FileContent
              viewer={viewer}
              variant="focus"
              mode={mode}
              onMode={setMode}
              wrap={prefs.readerWrap}
              onOpenInEditor={local ? () => void openWithDefaultApp(client, local) : undefined}
              onSaveCopy={() => void saveFile(client, viewer)}
              nav={nav}
              editable
            />}
          </div>
        </div>
        {isText ? <DocFind root={content} version={`${viewer.path}\0${mode}\0${viewer.content.length}`} /> : null}
      </div>
    </section>
  );
}
