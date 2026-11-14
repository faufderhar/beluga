import { type KeyboardEvent, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { Location, ViewerState } from '@beluga/core/store.js';
import type { FsEntry } from '@beluga/protocol.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { formatBytes } from '@beluga/shared/format.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Icon } from '../../components/Icon.js';
import { ActionsContext, type ActionItem } from '../../components/SpecMenu.js';
import { IconButton, Segmented, cx } from '../../components/ui.js';
import { useApi, useApp, useBeluga, useScopedKey } from '../../lib/beluga.js';
import { scrollWithin } from '../../lib/scroll-within.js';
import { ViewBoundary } from '../../lib/lazy-view.js';
import { localPathOf, openWithDefaultApp } from '../../lib/files.js';
import { focusFor, openFocus, showChange, usePanelRuntime } from '../../lib/panel.js';
import { SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN, clampShare } from '../../lib/panel-model.js';
import { setPrefs, usePrefs } from '../../lib/prefs.js';
import { chordLabel } from '../../lib/shortcuts-model.js';
import { STATE } from '../../views/DiffView.js';
import { useRowItems } from '../../views/FilesView.js';
import { type ReaderMode, hasRenderedLook, initialMode, isPdfFile } from '../../views/reader/reader-model.js';
import { EditTools } from '../../views/reader/EditTools.js';
import { ComponentPreview, PreviewToggle, useComponentPreview, usePreviewing } from '../../views/reader/component-preview.js';
import { pendingLine, revealLine } from '../../views/reader/reveal.js';
import { aheadOnHover, peekFirst } from '../../views/reader/streamed.js';
import { ContentResultsList, FlagToggles, type SearchFlags, useContentSearch, useNameSearch } from './ContentSearch.js';
import { useEditSession } from '../../views/reader/edit-store.js';
import { SCROLL_ROOT } from '../../components/markdown/md-dom.js';
import d from '../../views/diff.module.css';
import { ResizeHandle } from './ResizeHandle.js';
import { type TreeRow, ancestorsOf, foundRows, treeRows } from './tree.js';
import s from './panel.module.css';
import k from './content-search.module.css';
import { revealLabel } from '../../lib/os-words.js';
import { showWorktreeFolder, useRevealLabel } from '../../lib/remote-open.js';
import { ReaderContent } from '../../views/reader/reader-lazy.js';

/** The reader in its own chunk (views/reader/reader-lazy.tsx): fetched early, drawn at once once it's here (BLG-853), giving up on a stalled fetch instead of waiting (#370). */
const FileContent = ReaderContent;

/** Folders you opened in each workspace's tree, kept while the window is open. */
const opened = new Map<string, ReadonlySet<string>>();

/** How long the tree's arrows rest on a file before it shows. */
const SHOW_AFTER_MS = 120;

type SearchIn = 'names' | 'contents';
/** What the search box last searched (names or contents, and how), kept while the window is open. */
const lastSearch: { in: SearchIn; flags: SearchFlags } = { in: 'names', flags: { caseSensitive: false, regex: false, wholeWord: false } };

/** A name with what the search matched highlighted. */
function Marked({ name, marks }: { name: string; marks: TreeRow['marks'] }): ReactNode {
  if (!marks?.length) return name;
  const out: ReactNode[] = [];
  let at = 0;
  marks.forEach(([a, b], i) => {
    if (a > at) out.push(name.slice(at, a));
    out.push(
      <mark key={i} className={s.mark}>
        {name.slice(Math.max(a, at), b)}
      </mark>,
    );
    at = Math.max(at, b);
  });
  if (at < name.length) out.push(name.slice(at));
  return out;
}

/** The open file under the tree: Markdown formatted (or as source), code in color, images as they are. */
function Preview({ viewer, wsId, local, changed }: { viewer: ViewerState; wsId: string; local: string | undefined; changed: boolean }) {
  const api = useApi();
  const { client } = useBeluga();
  const selfId = useApp((st) => st.selfId);
  const [mode, setMode] = useState<ReaderMode>(() => (pendingLine(viewer) ? 'source' : initialMode(viewer)));
  const body = useRef<HTMLDivElement>(null);
  // Another file: from its top, as itself (as source when it opened at a line).
  useEffect(() => {
    setMode(pendingLine(viewer) ? 'source' : initialMode(viewer));
    body.current?.scrollTo({ top: 0 });
  }, [viewer.path]);
  const name = viewer.path.split('/').pop() || viewer.path;
  const dir = viewer.path.slice(0, viewer.path.length - name.length).replace(/\/$/, '');
  const editing = Boolean(useEditSession(viewer));
  const markdown = hasRenderedLook(viewer.path) && !viewer.image && !editing;
  // A component file, with Live previews on: drawn live beside its source.
  const component = useComponentPreview(viewer, wsId);
  const [previewing, setPreviewing] = usePreviewing(viewer.path);
  const drawing = Boolean(component && previewing && !editing);
  return (
    <section className={s.preview} aria-label={name}>
      <div className={s.previewHead}>
        <Icon name="file" size={13} className={s.fileIcon} />
        <span className={s.previewName} title={viewer.path}>
          {name}
        </span>
        {dir ? <span className={s.previewDir}>{dir}</span> : null}
        <span className={s.flex} />
        <EditTools viewer={viewer} wsId={wsId} selfId={selfId} compact />
        {markdown ? (
          <Segmented
            label="Show as"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'rendered', label: 'Preview' },
              { value: 'source', label: 'Source' },
            ]}
          />
        ) : null}
        {component && !editing ? <PreviewToggle previewing={previewing} onChange={setPreviewing} /> : null}
        {changed ? <IconButton icon="diff" label="Show Changes" onClick={() => showChange(client.store.getState(), viewer.path)} /> : null}
        {local ? <IconButton icon="external" label={isPdfFile(viewer.path) ? 'Open in Preview' : 'Open in Editor'} onClick={() => void openWithDefaultApp(client, local)} /> : null}
        <IconButton icon="expand" label="Open in full" keys={chordLabel('Cmd+Enter')} onClick={() => openFocus('file', wsId)} />
        <IconButton icon="x" label="Close" keys="Esc" onClick={() => void api.files.closeViewer()} />
      </div>
      <div ref={body} className={cx(s.previewBody, s.previewFile, 'selectable')} tabIndex={0} {...{ [SCROLL_ROOT]: '' }}>
        <ViewBoundary at={viewer.path}>
          <Suspense fallback={<div className={s.dimPad}>Opening…</div>}>
            {drawing && component ? <ComponentPreview previewRef={component} wsId={wsId} /> : <FileContent viewer={viewer} variant="panel" mode={mode} onMode={setMode} wrap editable onOpenInEditor={local ? () => void openWithDefaultApp(client, local) : undefined} />}
          </Suspense>
        </ViewBoundary>
      </div>
    </section>
  );
}

/**
 * The right panel's Files: the workspace's folder as a tree (search it by name or by contents),
 * and the file you pick, previewed under it. Double-click opens a file in its app; right-click for
 * the rest. On a project's page (`project`) it's the project's main folder: the same, without
 * Show Changes (that's a worktree's Changes tab).
 */
export function FilesTab({ wsId, project = false }: { wsId: string; project?: boolean }) {
  const api = useApi();
  const { client } = useBeluga();
  const revealWords = useRevealLabel();
  const prefs = usePrefs();
  const selfId = useApp((st) => st.selfId);
  const cache = useApp((st) => st.dirCache);
  const viewer = useApp((st) => st.viewer);
  const browserAt = useApp((st) => st.browser.at);
  const review = useApp((st) => (st.review?.workspaceId === wsId ? st.review.data : undefined));
  const rowItems = useRowItems();
  const share = shareNameOf(wsId);
  const at = (path: string): Location => ({ owner: selfId, share, path });
  const keyOf = (path: string): string => `${selfId}:${share}/${path}`;
  const entriesOf = (path: string): readonly FsEntry[] | undefined => cache[keyOf(path)];

  // Folders opened, per worktree on its computer (BLG-784).
  const openedKey = useScopedKey(wsId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => opened.get(openedKey) ?? new Set());
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [searchIn, setSearchInNow] = useState(lastSearch.in);
  const [flags, setFlagsNow] = useState(lastSearch.flags);
  const setSearchIn = (v: SearchIn): void => {
    setSearchInNow(v);
    lastSearch.in = v;
  };
  const setFlags = (f: SearchFlags): void => {
    setFlagsNow(f);
    lastSearch.flags = f;
  };
  const contents = searchIn === 'contents';
  const found = useContentSearch(wsId, query, flags, contents);
  const named = useNameSearch(wsId, query, flags, !contents);
  const list = useRef<HTMLDivElement>(null);
  const hitList = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // A line found in the contents: the file opens there.
  const openAt = (path: string, line: number): void => {
    revealLine(at(path), line);
    void api.files.open(at(path));
  };

  const load = (path: string): void => void api.files.loadDir(at(path));
  const expand = (next: ReadonlySet<string>): void => {
    opened.set(openedKey, next);
    setExpanded(next);
  };

  // The folder and every folder you've opened (they refresh each time you come back).
  useEffect(() => {
    for (const p of ['', ...expanded]) load(p);
  }, [wsId, expanded]);

  // Searching names: every file in the folder whose path matches, as a tree (the last answer while the next one comes).
  const q = contents ? '' : query.trim();

  // A file opened from the chat or a diff: show it in the tree.
  const shown = viewer && viewer.owner === selfId && viewer.share === share ? viewer : undefined;
  // Open full size, the file is across the center: no second, smaller copy of it here.
  const inFocus = usePanelRuntime((r) => r.focus?.wsId === wsId && r.focus.kind === 'file');
  // Clicked, read ahead, and not answered yet (on a computer, a round trip away): drawn at once
  // from the read-ahead until Beluga's own viewer has it (BLG-853).
  const [opening, setOpening] = useState<Location>();
  const answered = Boolean(opening && shown && shown.path === opening.path && !shown.loading);
  useEffect(() => {
    if (answered) setOpening(undefined);
  }, [answered]);
  const early: ViewerState | undefined = opening && !answered ? { ...opening, content: '', truncated: false, loading: true, scroll: 0 } : undefined;
  const previewed = inFocus ? undefined : (early ?? shown);
  useEffect(() => {
    if (!shown) return;
    const up = ancestorsOf(shown.path);
    if (up.some((p) => !expanded.has(p))) expand(new Set([...expanded, ...up]));
    setCursor(shown.path);
  }, [shown?.path]);
  // A folder link from the chat (it browses there): open it in the tree.
  useEffect(() => {
    if (!browserAt || browserAt.owner !== selfId || browserAt.share !== share || !browserAt.path) return;
    expand(new Set([...expanded, ...ancestorsOf(browserAt.path), browserAt.path]));
    setCursor(browserAt.path);
  }, [browserAt?.path, browserAt?.share]);
  useEffect(() => {
    scrollWithin(list.current?.querySelector('[data-cursor="true"]'));
  }, [cursor]);

  // Which files changed (marked in the tree, and Show Changes on them): read once if nothing has yet.
  const changedCount = useApp((st) => {
    const w = findWorkspace(st.projects, wsId);
    return (w?.status?.changed ?? 0) + (w?.status?.ahead ?? 0);
  });
  useEffect(() => {
    if (!review && changedCount) void api.workspaces.review(wsId);
  }, [wsId]);

  const changes = useMemo(() => {
    const files = new Map((review?.files ?? []).map((x) => [x.path, x.state] as const));
    const dirs = new Set([...files.keys()].flatMap(ancestorsOf));
    return { files, dirs };
  }, [review]);
  const foundTree = useMemo(() => foundRows(named.results?.files ?? []), [named.results]);
  const rows = q ? foundTree : treeRows(entriesOf, expanded);
  const canShowChange = (path: string): boolean => !project && changes.files.has(path);

  // The arrows show each file they land on (as Scratch does), once they rest a moment: held down,
  // they don't open every file on the way.
  const showSoon = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(showSoon.current), []);

  const toggle = (path: string): void => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expand(next);
  };
  const activate = (row: TreeRow): void => {
    clearTimeout(showSoon.current);
    setCursor(row.path);
    if (row.dir) return q ? undefined : toggle(row.path);
    const where = at(row.path);
    setOpening(peekFirst(where) ? where : undefined);
    void api.files.open(where).catch(() => setOpening(undefined));
  };
  const localOf = (path: string): string | undefined => localPathOf(client.store.getState(), at(path));
  const itemsFor = (row: TreeRow): ActionItem[] => {
    const base = rowItems({ label: row.name, dir: row.dir, target: at(row.path) }, () => activate(row));
    const local = localOf(row.path);
    if (row.dir) return base;
    return [
      base[0]!,
      ...(canShowChange(row.path) ? [{ label: 'Show Changes', icon: 'diff' as const, onSelect: () => void showChange(client.store.getState(), row.path) }] : []),
      { label: 'Open in Full', icon: 'expand', keys: chordLabel('Cmd+Enter'), onSelect: () => void api.files.open(at(row.path)).then(() => openFocus('file', wsId)) },
      ...(local ? [{ label: 'Open With Its App', icon: 'external' as const, onSelect: () => void openWithDefaultApp(client, local) }] : []),
      ...base.slice(1),
    ];
  };

  const onKey = (e: KeyboardEvent): void => {
    const nav = rows.filter((r) => r.kind === 'entry');
    const i = nav.findIndex((r) => r.path === cursor);
    const row = nav[i];
    const move = (to: number): void => {
      const next = nav[Math.max(0, Math.min(nav.length - 1, to))];
      if (!next) return;
      setCursor(next.path);
      clearTimeout(showSoon.current);
      if (!next.dir && next.path !== shown?.path) showSoon.current = setTimeout(() => void api.files.open(at(next.path)), SHOW_AFTER_MS);
    };
    if (e.key === 'Enter' || e.key === 'Escape') clearTimeout(showSoon.current);
    if (e.key === 'ArrowDown') (e.preventDefault(), move(i + 1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), move(i < 0 ? 0 : i - 1));
    else if (e.key === 'ArrowRight' && row?.dir) {
      e.preventDefault();
      if (!expanded.has(row.path)) toggle(row.path);
      else move(i + 1);
    } else if (e.key === 'ArrowLeft' && row) {
      e.preventDefault();
      if (row.dir && expanded.has(row.path)) toggle(row.path);
      else {
        const parent = ancestorsOf(row.path).pop();
        if (parent !== undefined) setCursor(parent);
      }
    } else if (e.key === 'Enter' && row) {
      e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && !row.dir) void api.files.open(at(row.path)).then(() => openFocus('file', wsId));
      else activate(row);
    } else if (e.key === 'Escape' && shown && !focusFor(wsId)) {
      e.preventDefault();
      e.stopPropagation();
      void api.files.closeViewer();
    }
  };

  const split = clampShare(prefs.panelSplit, SPLIT_MIN, SPLIT_MAX);
  const local = shown ? localOf(shown.path) : undefined;
  return (
    <div ref={box} className={s.stack}>
      <div className={s.top} style={previewed ? { flex: `0 0 ${Math.round(split * 100)}%` } : undefined}>
        <div className={s.filterRow}>
          <label className={s.filter}>
            <Icon name="search" size={12} />
            <input
              ref={field}
              value={query}
              placeholder={contents ? 'Search in files' : 'Search file names'}
              aria-label={contents ? 'Search in the files’ contents' : 'Search file names'}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) (e.preventDefault(), e.stopPropagation(), setQuery(''));
                else if (e.key === 'ArrowDown' && contents) (e.preventDefault(), hitList.current?.focus());
                else if (e.key === 'ArrowDown') (e.preventDefault(), list.current?.focus(), setCursor(rows.find((r) => r.kind === 'entry')?.path));
              }}
            />
            <FlagToggles flags={flags} onChange={setFlags} />
          </label>
          {contents ? null : <IconButton icon="chevronUp" label="Collapse all folders" onClick={() => expand(new Set())} disabled={!expanded.size} />}
          <IconButton icon="folder" label={revealWords} onClick={() => void showWorktreeFolder(client, wsId)} />
        </div>
        <div className={k.modeRow}>
          <Segmented
            label="Search"
            radio
            value={searchIn}
            onChange={(v) => {
              setSearchIn(v);
              field.current?.focus();
            }}
            options={[
              { value: 'names', label: 'Names', hint: 'Find files by name or path, anywhere in the folder' },
              { value: 'contents', label: 'Contents', hint: 'Search inside the files (ripgrep)' },
            ]}
          />
        </div>
        {contents ? (
          <ContentResultsList state={found} query={query} listRef={hitList} onOpen={openAt} onEscape={() => field.current?.focus()} />
        ) : (
          <div ref={list} className={cx(s.list, s.tree)} role="tree" aria-label="Files" tabIndex={0} onKeyDown={onKey}>
            {rows.map((row) => {
              const state = changes.files.get(row.path);
              const look = state ? STATE[state] : undefined;
              const on = row.path === cursor;
              return row.kind === 'loading' ? (
                <div key={`${row.path}…`} className={s.treeNote} style={{ paddingLeft: 10 + row.depth * 14 + 18 }}>
                  Loading…
                </div>
              ) : (
                <ActionsContext key={row.path} items={() => itemsFor(row)}>
                  <div
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-selected={on}
                    aria-expanded={row.dir ? row.open : undefined}
                    aria-label={row.name}
                    data-cursor={on}
                    className={cx(s.row, s.treeRow, on && s.rowOn, shown?.path === row.path && s.rowShown)}
                    style={{ paddingLeft: 6 + row.depth * 14 }}
                    title={row.path}
                    {...aheadOnHover(api, () => (row.dir ? undefined : at(row.path)))}
                    onClick={() => activate(row)}
                    onDoubleClick={() => {
                      const p = localOf(row.path);
                      if (!row.dir && p) void openWithDefaultApp(client, p);
                    }}
                  >
                    <span className={s.chevron}>{row.dir ? <Icon name={row.open ? 'chevronDown' : 'chevronRight'} size={9} /> : null}</span>
                    <Icon name={row.dir ? 'folder' : 'file'} size={13} className={row.dir ? s.dirIcon : s.fileIcon} />
                    <span className={cx(s.rowName, look?.tone)}>
                      <Marked name={row.name} marks={row.marks} />
                    </span>
                    {look ? <span className={cx(d.letter, look.tone)}>{look.letter}</span> : row.dir && changes.dirs.has(row.path) ? <span className={s.changedDot} title="Has changes" /> : null}
                    {!row.dir && !look && row.size !== undefined && on ? <span className={s.size}>{row.size < 1024 ? `${row.size} B` : formatBytes(row.size)}</span> : null}
                  </div>
                </ActionsContext>
              );
            })}
            {q ? <NameNote state={named} count={rows.filter((r) => !r.dir).length} /> : null}
          </div>
        )}
      </div>
      {previewed ? (
        <>
          <ResizeHandle
            axis="y"
            label="Resize the tree"
            onMove={(y) => {
              const r = box.current?.getBoundingClientRect();
              if (r) setPrefs({ panelSplit: clampShare((y - r.top) / r.height, SPLIT_MIN, SPLIT_MAX) });
            }}
            onReset={() => setPrefs({ panelSplit: SPLIT_DEFAULT })}
            onStep={(dir) => setPrefs({ panelSplit: clampShare(split - dir * 0.04, SPLIT_MIN, SPLIT_MAX) })}
          />
          <Preview viewer={previewed} wsId={wsId} local={local} changed={canShowChange(previewed.path)} />
        </>
      ) : null}
    </div>
  );
}

/** Under the names found: still looking, a pattern that didn't parse, none, or only the first ones. */
function NameNote({ state, count }: { state: ReturnType<typeof useNameSearch>; count: number }) {
  if (state.error) return <div className={cx(s.treeNote, k.error)}>{state.error}</div>;
  if (state.searching && !state.results) return <div className={s.treeNote}>Searching…</div>;
  if (!state.results) return null;
  if (!count) return <div className={s.treeNote}>No file names with “{state.query?.trim()}”</div>;
  return state.results.truncated ? <div className={s.treeNote}>The first {count.toLocaleString()} files shown; type more to narrow it</div> : null;
}
