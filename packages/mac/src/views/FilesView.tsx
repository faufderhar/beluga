import { Fragment, Suspense, useEffect, useRef, useState } from 'react';
import type { BrowserRow, ViewerState } from '@beluga/core/store.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { formatBytes } from '@beluga/shared/format.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, Empty, IconButton, Segmented, cx } from '../components/ui.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { useActions } from '../lib/actions.js';
import { copyText } from '../lib/copy.js';
import { localPathOf, mentionOf, openWithDefaultApp, revealInFinder, saveFile } from '../lib/files.js';
import { SCROLL_ROOT } from '../components/markdown/md-dom.js';
import { type ReaderMode, hasRenderedLook, initialMode } from './reader/reader-model.js';
import { SearchField, SearchResults } from './SharedSearch.js';
import s from './files.module.css';
import { revealLabel } from '../lib/os-words.js';
import { useRevealFileLabel, useRevealLabel } from '../lib/remote-open.js';
import { groupChatOpen } from '../lib/group-chat.js';
import { ReaderContent } from './reader/reader-lazy.js';

export { LANG, ext } from './reader/reader-model.js';

/** The reader comes in its own chunk, the first time a file is opened. */
/** The reader in its own chunk (views/reader/reader-lazy.tsx): fetched early, drawn at once once it's here (BLG-853), giving up on a stalled fetch instead of waiting (#370). */
const FileContent = ReaderContent;

/** A decoded image (RGBA pixels) drawn at its size, scaled down to fit. */
export function Bitmap({ image }: { image: NonNullable<ViewerState['image']> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = image.width;
    c.height = image.height;
    const data = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
    c.getContext('2d')?.putImageData(data, 0, 0);
  }, [image]);
  return <canvas ref={ref} className={s.image} />;
}

/** The open file beside the folder list (a friend's, or yours), read the way the reader reads it. */
export function Viewer({ viewer }: { viewer: ViewerState }) {
  const api = useApi();
  const { client } = useBeluga();
  const [mode, setMode] = useState<ReaderMode>(() => initialMode(viewer));
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setMode(initialMode(viewer));
    body.current?.scrollTo({ top: 0 });
  }, [viewer.path]);
  const name = viewer.path.split('/').pop() || viewer.path;
  const markdown = hasRenderedLook(viewer.path) && !viewer.image;
  const local = useApp((st) => localPathOf(st, viewer));
  return (
    <section className={s.viewer} aria-label={name}>
      <div className={s.viewerHead}>
        <Icon name="file" size={14} />
        <span className={s.viewerName}>{name}</span>
        {viewer.by ? <span className={s.following}>following {viewer.by}</span> : null}
        <span className={s.flex} />
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
        <IconButton icon="download" label="Save a copy…" onClick={() => void saveFile(client, viewer)} />
        <IconButton icon="x" label="Close" onClick={() => void api.files.closeViewer()} />
      </div>
      <div ref={body} className={cx(s.viewerBody, 'selectable')} tabIndex={0} {...{ [SCROLL_ROOT]: '' }}>
        <Suspense fallback={<div className={s.loading}>Opening…</div>}>
          <FileContent viewer={viewer} variant="page" mode={mode} onMode={setMode} wrap={false} onOpenInEditor={local ? () => void openWithDefaultApp(client, local) : undefined} onSaveCopy={() => void saveFile(client, viewer)} />
        </Suspense>
      </div>
    </section>
  );
}

/** Right-click on a file or folder: open it, find it in Finder, copy its path, mention it, save it. */
export function useRowItems(): (row: BrowserRow, onOpen: () => void) => ActionItem[] {
  const { client, ui } = useBeluga();
  // On a computer's page: a file is downloaded, a folder's path copied (BLG-852).
  const revealFile = useRevealFileLabel();
  const revealFolder = useRevealLabel();
  const actions = useActions();
  return (row, onOpen) => {
    if (row.target === 'up') return [{ label: 'Back', icon: 'back', onSelect: onOpen }];
    const at = row.target;
    const state = client.store.getState();
    const local = localPathOf(state, at);
    const say = (text: string): void => client.store.dispatch({ type: 'toast', text, level: 'success' });
    const mention = (): void => {
      const v = state.view;
      // The conversation this folder belongs to (a workspace's own chat, else the room's group chat, else a new chat).
      if (v.kind === 'workspace') actions.run({ type: 'open_ws', id: v.id, tab: 'chat' });
      else if (v.kind === 'shared') actions.run({ type: 'open_shared', owner: v.owner, id: v.id, tab: 'chat' });
      else if (groupChatOpen(state)) actions.run({ type: 'view', view: { kind: 'room' } });
      else actions.run({ type: 'new_chat', projectId: 'chats' });
      // Added to that chat's own words, once its box shows them.
      setTimeout(() => {
        const current = ui.get().buffer;
        const buffer = `${current}${current && !current.endsWith(' ') ? ' ' : ''}${mentionOf(state, at)} `;
        ui.patch({ buffer, cursor: buffer.length });
        document.dispatchEvent(new CustomEvent('beluga:focus-composer'));
      }, 60);
    };
    return [
      { label: row.dir ? 'Open Folder' : 'Open', icon: row.dir ? 'folder' : 'file', onSelect: onOpen },
      ...(local ? [{ label: row.dir ? revealFolder : revealFile, icon: 'folder' as const, onSelect: () => void revealInFinder(client, local) }] : []),
      { label: 'Copy Path', icon: 'copy', separate: true, onSelect: () => void copyText(local ?? mentionOf(state, at)).then(() => say('Copied the path')) },
      { label: 'Mention in Chat', icon: 'chat', onSelect: mention },
      ...(row.dir ? [] : [{ label: 'Save a Copy…', icon: 'download' as const, separate: true, onSelect: () => void saveFile(client, at) }]),
    ];
  };
}

function Row({ row, selected, onOpen }: { row: BrowserRow; selected: boolean; onOpen: () => void }) {
  const up = row.target === 'up';
  const items = useRowItems();
  return (
    <ActionsContext items={() => items(row, onOpen)}>
    <div role="option" aria-selected={selected} tabIndex={-1} className={cx(s.row, selected && s.rowOn)} onClick={onOpen} title={row.label}>
      <Icon name={up ? 'up' : row.dir ? 'folder' : 'file'} size={14} className={row.dir ? s.dirIcon : s.fileIcon} />
      {/* Under its owner's name, a folder goes by its own name. */}
      <span className={s.rowName}>{up ? 'Back' : row.group && row.label.startsWith(`${row.group} · `) ? row.label.slice(row.group.length + 3) : row.label}</span>
      {!row.dir && row.size !== undefined ? <span className={s.size}>{row.size < 1024 ? `${row.size} B` : formatBytes(row.size)}</span> : null}
      {row.dir && !up ? <Icon name="chevronRight" size={10} className={s.chev} /> : null}
    </div>
    </ActionsContext>
  );
}

/** Shared files (everyone's folders), or a workspace's own Files tab. */
export function FilesView() {
  const api = useApi();
  const { client, ui } = useBeluga();
  const home = useApp((st) => st.home);
  const myShares = useApp((st) => st.myShares);
  const view = useApp((st) => st.view);
  const browser = useApp((st) => st.browser);
  const viewer = useApp((st) => st.viewer);
  const selfId = useApp((st) => st.selfId);
  const shared = useApp((st) => st.shared);
  const list = useRef<HTMLDivElement>(null);
  // Arrow keys move the selection; keep it in view.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [browser.cursor]);

  // A workspace's Files tab starts at its folder.
  const wsId = view.kind === 'workspace' ? view.id : undefined;
  useEffect(() => {
    if (wsId) void api.files.browseTo({ owner: selfId, share: shareNameOf(wsId), path: '' });
  }, [wsId]);

  // A workspace shared with you: its files, and a search over them (names and contents).
  const sharedWs = view.kind === 'shared' ? shared.find((w) => w.id === view.id && w.owner === view.owner) : undefined;
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState<string>();
  useEffect(() => {
    setTyped('');
    setSearch(undefined);
    if (sharedWs && browser.at?.share !== sharedWs.share) void api.files.browseTo({ owner: sharedWs.owner, share: sharedWs.share, path: '' });
  }, [sharedWs?.id]);

  const open = (i: number): void => {
    client.store.dispatch({ type: 'browser_cursor', delta: i - browser.cursor });
    void api.files.enter(i);
  };
  const crumbs = browser.at ? [browser.at.share.startsWith('ws-') ? (shared.find((w) => w.share === browser.at!.share)?.name ?? 'This workspace') : browser.at.share, ...browser.at.path.split('/').filter(Boolean)] : ['Folders shared with you'];

  return (
    <div className={s.files}>
      <section className={s.browser} aria-label="Files">
        {sharedWs ? <SearchField value={typed} onChange={setTyped} onSearch={setSearch} /> : null}
        <div className={s.crumbs}>
          {(sharedWs && search ? [`Results for “${search}”`] : crumbs).map((c, i) => (
            <span key={i} className={s.crumb}>
              {i ? <Icon name="chevronRight" size={9} /> : null}
              {/* Every folder above this one is a click away. */}
              {browser.at && !search && i < crumbs.length - 1 ? (
                <button type="button" className={s.crumbLink} onClick={() => void api.files.browseTo({ ...browser.at!, path: crumbs.slice(1, i + 1).join('/') })}>
                  {c}
                </button>
              ) : (
                c
              )}
            </span>
          ))}
          {browser.loading ? <span className={s.dim}>…</span> : null}
        </div>
        {sharedWs && search ? (
          <SearchResults id={sharedWs.id} owner={sharedWs.owner} share={sharedWs.share} query={search} />
        ) : (
        <div
          ref={list}
          className={s.list}
          role="listbox"
          tabIndex={0}
          aria-label="Files"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              client.store.dispatch({ type: 'browser_cursor', delta: e.key === 'ArrowDown' ? 1 : -1 });
            } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
              e.preventDefault();
              void api.files.enter(browser.cursor);
            } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
              e.preventDefault();
              void api.files.up();
            }
          }}
        >
          {browser.error ? <div className={s.error}>{browser.error}</div> : null}
          {browser.rows.length ? (
            browser.rows.map((r, i) => (
              <Fragment key={`${r.label}:${i}`}>
                {/* The top of Files: each person's folders under their name. */}
                {r.group && r.target !== 'up' && r.group !== browser.rows[i - 1]?.group ? (
                  <div className={s.group} role="presentation">
                    <Avatar name={r.group} id={r.target.owner} size={16} />
                    <span>{r.group}</span>
                  </div>
                ) : null}
                <Row row={r} selected={i === browser.cursor} onOpen={() => open(i)} />
              </Fragment>
            ))
          ) : browser.loading ? null : (
            <Empty icon="folder" title={browser.at ? 'This folder is empty' : 'Nothing shared yet'} detail={browser.at ? undefined : 'When friends (or people in your room) share folders with you, they show up here.'} action={browser.at ? undefined : <Button onClick={() => ui.openMenu({ kind: 'share_folder', launchDir: home, mine: myShares })}>Share a folder…</Button>} />
          )}
        </div>
        )}
      </section>
      {viewer ? <Viewer viewer={viewer} /> : <div className={s.noViewer}><Empty icon="file" title="Pick a file to open it" detail="Markdown shows formatted, code with colors, images as they are. Files update live when they change." /></div>}
    </div>
  );
}
