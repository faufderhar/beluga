import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { Review } from '@beluga/workspaces/git.js';
import { parseDiff } from '@beluga/shared/diff-lines.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Icon } from '../../components/Icon.js';
import { ActionsContext, ActionsDropdown } from '../../components/SpecMenu.js';
import { Button, Empty, IconButton, Segmented, Tip, cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { useMyAgentName } from '../../lib/agent-words.js';
import { focusFor, openFocus, showPanelTab, forgetChangeAsk, peekChangeAsk, usePanelRuntime } from '../../lib/panel.js';
import { SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN, clampShare } from '../../lib/panel-model.js';
import { dirOf, groupByFolder, shownOrder } from '../../lib/changes-model.js';
import { setPrefs, usePrefs } from '../../lib/prefs.js';
import { chordLabel } from '../../lib/shortcuts-model.js';
import { useWsBusy, whileBusy } from '../../lib/ws-busy.js';
import { STATE, UnifiedDiff, useCommitItems, useFileItems } from '../../views/DiffView.js';
import { type ChangeLook, ChangedFileView, canShowFile, changeLocation, fileLookLabel, onlyAsFile, useChangeLocation } from '../../views/ChangedFile.js';
import { aheadOnHover, readAhead } from '../../views/reader/streamed.js';
import { useDiffComments } from '../../views/DiffComment.js';
import d from '../../views/diff.module.css';
import { ResizeHandle } from './ResizeHandle.js';
import { showGitTrouble } from '../../lib/git-trouble.js';
import s from './panel.module.css';
import { shortcutKeys } from '../../lib/shortcuts.js';
import { useFirstPaintMark } from '../../lib/first-paint.js';

/** The last answer Claude finished in this workspace (its edits may have changed what's shown). */
function useLastTurn(wsId: string): string {
  const channel = `ws:${wsId}`;
  return useApp((st) => {
    for (let i = st.log.length - 1; i >= 0; i--) {
      const l = st.log[i]!;
      if (l.type === 'agent' && l.channel === channel && l.status === 'done') return l.id;
    }
    return '';
  });
}

/**
 * What changed, kept fresh while you stay in the chat: it loads when you open the tab and again
 * whenever the workspace's git status moves or Claude finishes a turn. The list on screen stays
 * put while it reloads (no flash of "loading").
 */
function useChanges(wsId: string): { data: Review | undefined; loading: boolean; error: string | undefined; reload: () => void } {
  const api = useApi();
  const review = useApp((st) => st.review);
  const status = useApp((st) => {
    const ws = findWorkspace(st.projects, wsId);
    return ws?.status ? `${ws.status.changed}:${ws.status.ahead}:${ws.status.behind}` : '';
  });
  const turn = useLastTurn(wsId);
  const reload = (): void => void api.workspaces.review(wsId);
  useEffect(reload, [wsId, status, turn]);
  const last = useRef<Review | undefined>(undefined);
  const mine = review?.workspaceId === wsId ? review : undefined;
  if (mine?.data) last.current = mine.data;
  return { data: mine?.data ?? last.current, loading: !!mine?.loading, error: mine?.error, reload };
}

function Summary({ data, loading, grouped, onReload }: { data: Review; loading: boolean; grouped: boolean; onReload: () => void }) {
  const totals = data.files.reduce((t, f) => ({ add: t.add + f.added, del: t.del + f.removed }), { add: 0, del: 0 });
  const commitItems = useCommitItems();
  const [showCommits, setShowCommits] = useState(false);
  return (
    <div className={s.summary}>
      <div className={s.summaryRow}>
        <span className={s.summaryTitle}>
          {data.files.length} file{data.files.length === 1 ? '' : 's'} changed
        </span>
        <span className={d.add}>+{totals.add}</span>
        <span className={d.del}>−{totals.del}</span>
        <span className={s.flex} />
        <IconButton icon="folder" label={grouped ? 'Show as One List' : 'Group by Folder'} active={grouped} aria-pressed={grouped} onClick={() => setPrefs({ changesByFolder: !grouped })} />
        <IconButton icon="refresh" label={loading ? 'Looking for changes…' : 'Look again'} className={cx(loading && s.spinning)} onClick={onReload} />
      </div>
      <div className={s.summaryMeta}>
        <span className={s.base} title={data.base}>
          vs {/^[0-9a-f]{40}$/.test(data.base) ? data.base.slice(0, 7) : data.base}
        </span>
        {data.commits.length ? (
          <button type="button" className={s.disclose} aria-expanded={showCommits} onClick={() => setShowCommits(!showCommits)}>
            <Icon name={showCommits ? 'chevronDown' : 'chevronRight'} size={9} />
            {data.commits.length} commit{data.commits.length === 1 ? '' : 's'} ahead
          </button>
        ) : null}
      </div>
      {showCommits ? (
        <div className={s.commits}>
          {data.commits.slice(0, 20).map((c) => (
            <ActionsContext key={c.hash} items={() => commitItems(c)}>
              <span className={s.commitWrap}>
                <ActionsDropdown items={commitItems(c)} align="start">
                  <button type="button" className={s.commit} title={c.subject}>
                    <span className={d.hash}>{c.hash}</span>
                    <span className={s.commitSubject}>{c.subject}</span>
                  </button>
                </ActionsDropdown>
              </span>
            </ActionsContext>
          ))}
          {data.commits.length > 20 ? <div className={s.dim}>and {data.commits.length - 20} earlier</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Commit, a pull request, Claude's review: what you do with changes, right under them. */
function Actions({ wsId }: { wsId: string }) {
  const agent = useMyAgentName();
  const actions = useActions();
  const api = useApi();
  // Shared with the toolbar's Create PR, and kept per worktree when you switch to another.
  const opening = useWsBusy(wsId);
  const ws = useApp((st) => findWorkspace(st.projects, wsId));
  const pr = useApp((st) => st.prs[wsId]);
  if (!ws) return null;
  const changed = ws.status?.changed ?? 0;
  const ahead = ws.status?.ahead ?? 0;
  const worktree = ws.kind === 'worktree';
  const run = (action: 'commit' | 'pr' | 'review_claude'): void => actions.run({ type: 'ws', id: wsId, action });
  const quick = (draft = false): void => void whileBusy(wsId, async () => showGitTrouble(wsId, await api.workbench.quickPr(wsId, draft ? { draft: true } : {}), draft ? 'pr_draft' : 'pr'));
  return (
    <div className={s.actions}>
      {worktree && changed ? (
        <Tip label={`Commit ${changed} changed file${changed === 1 ? '' : 's'}`} keys={shortcutKeys('ws-commit')}>
          <Button size="small" variant="primary" icon="check" onClick={() => run('commit')}>
            Commit
          </Button>
        </Tip>
      ) : null}
      {worktree && pr ? (
        <Tip label="Open it, fix checks, or update it" keys={shortcutKeys('ws-pr')}>
          <Button size="small" icon="pr" onClick={() => run('pr')}>
            {`PR #${pr.number}`}
          </Button>
        </Tip>
      ) : worktree && (ahead || changed) ? (
        <>
          <Tip label="Pushes and opens a pull request, titled from its commits">
            <Button size="small" icon="pr" disabled={opening} onClick={() => quick()}>
              {opening ? 'Opening…' : 'Create PR'}
            </Button>
          </Tip>
          <ActionsDropdown
            items={[
              { label: `Create PR with ${agent}`, hint: 'Your agent writes the title and description: what, why, how to test', icon: 'claude', onSelect: () => void api.workbench.createPr(wsId) },
              { label: 'Create PR with Instructions…', hint: 'Tell your agent anything extra for this one', icon: 'claude', onSelect: () => requestAnimationFrame(() => run('pr')) },
              { label: 'Create Draft PR', hint: 'It can’t merge until it’s marked ready', icon: 'pr', onSelect: () => quick(true) },
            ]}
          >
            <Button size="small" variant="quiet" disabled={opening} aria-label="Other ways to create the pull request">
              <Icon name="chevronDown" size={11} />
            </Button>
          </ActionsDropdown>
        </>
      ) : null}
      <Tip label="Ask your agent to check everything: bugs, security, tests and quality" keys={shortcutKeys('ws-review')}>
        <Button size="small" variant="quiet" icon="claude" onClick={() => run('review_claude')}>
          Review
        </Button>
      </Tip>
    </div>
  );
}

/** Diffs read ahead under the pointer (workspaces.diffAhead), for the changes they were read in. */
const diffsAhead = new Map<string, { readonly diff: string; readonly data: object; readonly at: number }>();
const DIFF_AHEAD_MS = 10_000;

function readDiffAhead(api: ReturnType<typeof useApi>, wsId: string, path: string, index: number, data: object | undefined): void {
  if (!data) return;
  void api.workspaces.diffAhead(index).then(
    (diff) => {
      if (typeof diff !== 'string') return;
      if (diffsAhead.size >= 32) diffsAhead.delete(diffsAhead.keys().next().value as string);
      diffsAhead.set(`${wsId}\0${path}`, { diff, data, at: Date.now() });
    },
    () => undefined,
  );
}

/** A diff read ahead for these very changes, moments ago. */
function peekDiff(wsId: string, path: string, data: object): string | undefined {
  const ahead = diffsAhead.get(`${wsId}\0${path}`);
  return ahead && ahead.data === data && Date.now() - ahead.at < DIFF_AHEAD_MS ? ahead.diff : undefined;
}

/**
 * The selected file, compact: its diff, or the file as itself (Markdown formatted, a picture or a
 * PDF only as itself), with the way to see it full size or in Files.
 */
function FileDiff({ wsId, path, onClose }: { wsId: string; path: string; onClose: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const prefs = usePrefs();
  const review = useApp((st) => st.review);
  const at = useChangeLocation(path);
  const file = review?.data?.files[review.selected];
  const current = file?.path === path ? review?.diff : undefined;
  // Keep showing the last diff of this file while it reloads.
  const last = useRef<{ path: string; diff: string } | undefined>(undefined);
  if (current !== undefined) last.current = { path, diff: current };
  // Picked a moment ago and read ahead: drawn now, while the pick goes to where it runs (BLG-853).
  const diff = current ?? (last.current?.path === path ? last.current.diff : undefined) ?? (review?.data ? peekDiff(wsId, path, review.data) : undefined);
  const lines = useMemo(() => (diff ? parseDiff(diff) : []), [diff]);
  const comments = useDiffComments(path, lines);
  useFirstPaintMark('beluga:diff-shown', path, lines.length > 0);
  const name = path.split('/').pop() ?? path;
  const mine = file?.path === path ? file : undefined;
  const st = mine ? STATE[mine.state] : undefined;
  const showable = !!at && (!mine || canShowFile(mine));
  const look: ChangeLook = showable && (onlyAsFile(path) || prefs.changeLook === 'file') ? 'file' : 'diff';
  const showInFiles = (): void => {
    if (!at) return;
    showPanelTab(client.store.getState(), 'files');
    void api.files.open(at);
  };
  return (
    <section className={s.preview} aria-label={`Changes in ${name}`}>
      <div className={s.previewHead}>
        {st ? <span className={cx(d.letter, st.tone)}>{st.letter}</span> : <Icon name="file" size={13} />}
        <span className={s.previewName} title={path}>
          {name}
        </span>
        {mine ? (
          <span className={s.previewCounts}>
            {mine.added ? <span className={d.add}>+{mine.added}</span> : null}
            {mine.removed ? <span className={d.del}>−{mine.removed}</span> : null}
          </span>
        ) : null}
        <span className={s.flex} />
        {showable && !onlyAsFile(path) ? (
          <Segmented
            label="Show"
            value={look}
            onChange={(v) => setPrefs({ changeLook: v })}
            options={[
              { value: 'diff', label: 'Changes', hint: 'What changed, line by line' },
              { value: 'file', label: fileLookLabel(path), hint: 'The file as it is now' },
            ]}
          />
        ) : null}
        {showable ? <IconButton icon="folder" label="Show in Files" onClick={showInFiles} /> : null}
        <IconButton icon="expand" label="Open in full" keys={chordLabel('Cmd+Enter')} onClick={() => openFocus('diff', wsId)} />
        <IconButton icon="x" label="Close" keys="Esc" onClick={onClose} />
      </div>
      {look === 'file' && at ? (
        <div className={cx(s.previewBody, s.previewFile, 'selectable')} tabIndex={0}>
          <ChangedFileView at={at} variant="panel" />
        </div>
      ) : (
        <div className={cx(s.previewBody, d.code, 'selectable')} tabIndex={0}>{diff === undefined ? <div className={s.dimPad}>Loading the diff…</div> : lines.length ? <UnifiedDiff lines={lines} compact comments={comments} /> : <div className={s.dimPad}>{diff || 'No differences in the text.'}</div>}</div>
      )}
    </section>
  );
}

/** The right panel's Changes: the changed files and, picked one, its diff under them. */
export function ChangesTab({ wsId }: { wsId: string }) {
  const api = useApi();
  const { client } = useBeluga();
  const prefs = usePrefs();
  const fileItems = useFileItems();
  const { data, loading, error, reload } = useChanges(wsId);
  const selected = useApp((st) => (st.review?.workspaceId === wsId ? st.review.selected : -1));
  const reviewLoading = useApp((st) => st.review?.workspaceId === wsId && st.review.loading);
  // Show Changes from the Files tab: that file, once the list is here.
  const [asked] = useState(() => peekChangeAsk(wsId));
  useEffect(forgetChangeAsk, []);
  const [open, setOpen] = useState<string>();
  const inFocus = usePanelRuntime((r) => r.focus?.wsId === wsId && r.focus.kind === 'diff');
  const box = useRef<HTMLDivElement>(null);
  const files = useMemo(() => data?.files ?? [], [data]);
  const at = open ? files.findIndex((f) => f.path === open) : -1;
  // Grouped by folder (a button at the top): each folder folds; the arrows walk what's shown.
  const grouped = prefs.changesByFolder;
  const groups = useMemo(() => (grouped ? groupByFolder(files) : []), [files, grouped]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const order = grouped ? shownOrder(groups, folded) : files.map((_, i) => i);
  const fold = (dir: string): void => setFolded((was) => (was.has(dir) ? new Set([...was].filter((x) => x !== dir)) : new Set([...was, dir])));
  // The file you're looking at is never hidden in a folded folder.
  useEffect(() => {
    if (open && grouped && folded.has(dirOf(open))) fold(dirOf(open));
  }, [open, grouped]);
  // A reload of this workspace's changes (Claude edited, a commit) selects the first file again:
  // once it's done, go back to the one you're looking at, or close it if it's gone.
  const wasLoading = useRef(reviewLoading);
  useEffect(() => {
    const reloaded = wasLoading.current && !reviewLoading;
    wasLoading.current = reviewLoading;
    if (!reloaded || !open || selected < 0) return;
    if (at < 0) setOpen(undefined);
    else if (at !== selected) void api.workspaces.selectFile(at);
  }, [reviewLoading]);
  // A file picked elsewhere (the full-size diff's own list): show that one here too.
  useEffect(() => {
    if (!open || reviewLoading || selected < 0) return;
    const picked = files[selected]?.path;
    if (picked && picked !== open) setOpen(picked);
  }, [selected]);

  // Changed files shown as themselves: the one under the pointer, and the next one after a pick, are read ahead (BLG-791).
  const asFiles = prefs.changeLook === 'file';
  const ahead = (path: string | undefined): void => {
    const where = asFiles && path ? changeLocation(client.store.getState(), path) : undefined;
    if (where) readAhead(api, where);
  };
  const show = (i: number): void => {
    const f = files[i];
    if (!f) return;
    setOpen(f.path);
    void api.workspaces.selectFile(i);
    const k = order.indexOf(i);
    if (k >= 0) ahead(files[order[k + 1] ?? -1]?.path);
  };
  // The arrows move the highlight; the list scrolls to keep it in sight.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  const answered = useRef(false);
  useEffect(() => {
    if (!asked || answered.current || !data || reviewLoading) return;
    answered.current = true;
    const i = files.findIndex((f) => f.path === asked);
    if (i >= 0) show(i);
  }, [data, reviewLoading]);
  const onKey = (e: KeyboardEvent): void => {
    const i = at < 0 ? -1 : at;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const pos = order.indexOf(i);
      const next = pos < 0 ? (e.key === 'ArrowDown' ? 0 : order.length - 1) : pos + (e.key === 'ArrowDown' ? 1 : -1);
      const to = order[Math.max(0, Math.min(order.length - 1, next))];
      if (to !== undefined) show(to);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (i >= 0) openFocus('diff', wsId);
    } else if (e.key === 'Enter' && i < 0 && order.length) {
      e.preventDefault();
      show(order[0]!);
    } else if (e.key === 'Escape' && open && !focusFor(wsId)) {
      // (In the focus view, Esc goes back to the chat first.)
      e.preventDefault();
      e.stopPropagation();
      setOpen(undefined);
    }
  };

  if (!data && error) return <Empty icon="alert" title="Couldn’t read the changes" detail={error} />;
  if (!data) return <div className={s.dimPad}>Looking at what changed…</div>;
  if (!files.length && !data.commits.length) {
    return (
      <div className={s.emptyTab}>
        <Empty icon="check" title="No changes yet" detail={`Everything matches ${data.base}. Your agent’s edits show up here as they happen.`} />
      </div>
    );
  }
  const split = clampShare(prefs.panelSplit, SPLIT_MIN, SPLIT_MAX);
  // A changed file's row: in a folder, just its name (the folder says where).
  const fileRow = (f: Review['files'][number], i: number, inFolder: boolean) => {
    const st = STATE[f.state];
    const name = f.path.split('/').pop() ?? f.path;
    const dir = inFolder ? '' : dirOf(f.path);
    const on = f.path === open;
    const items = (): ReturnType<typeof fileItems> => fileItems(f, i).map((it, k) => (k === 0 ? { ...it, onSelect: () => show(i) } : it));
    return (
      <ActionsContext key={f.path} items={items}>
        <div
          role="option"
          aria-selected={on}
          className={cx(s.row, inFolder && s.rowInFolder, on && s.rowOn)}
          title={f.path}
          {...aheadOnHover(api, () => {
            // Shown as its diff: the diff is worked out ahead instead (BLG-853).
            if (!asFiles && !onlyAsFile(f.path) && !on) readDiffAhead(api, wsId, f.path, i, data);
            return asFiles && canShowFile(f) ? changeLocation(client.store.getState(), f.path) : undefined;
          })}
          onClick={() => show(i)} onDoubleClick={() => (show(i), openFocus('diff', wsId))}>
          <span className={cx(d.letter, st.tone)}>{st.letter}</span>
          <span className={s.rowName}>
            {name}
            {dir ? <span className={s.rowDir}>{dir}</span> : null}
          </span>
          <span className={s.rowCounts}>
            {f.added ? <span className={d.add}>+{f.added}</span> : null}
            {f.removed ? <span className={d.del}>−{f.removed}</span> : null}
          </span>
        </div>
      </ActionsContext>
    );
  };
  // Open full size, the diff is across the center: no second, smaller copy of it here.
  const shown = inFocus ? undefined : open;
  return (
    <div ref={box} className={s.stack}>
      <div className={s.top} style={shown ? { flex: `0 0 ${Math.round(split * 100)}%` } : undefined}>
        <Summary data={data} loading={loading} grouped={grouped} onReload={reload} />
        <div ref={listRef} className={s.list} role="listbox" aria-label="Changed files" tabIndex={0} onKeyDown={onKey}>
          {grouped
            ? groups.map((g) => {
                const shut = folded.has(g.dir);
                return (
                  <div key={g.dir} role="group" aria-label={g.dir || 'Top level'}>
                    <button type="button" tabIndex={-1} className={s.folderRow} aria-expanded={!shut} title={g.dir || 'Top level'} onClick={() => fold(g.dir)}>
                      <Icon name={shut ? 'chevronRight' : 'chevronDown'} size={9} />
                      <Icon name="folder" size={13} />
                      <span className={cx(s.rowName, !g.dir && s.dim)}>{g.dir || 'Top level'}</span>
                      <span className={s.rowCounts}>
                        <span className={s.dim}>{g.files.length}</span>
                        {g.added ? <span className={d.add}>+{g.added}</span> : null}
                        {g.removed ? <span className={d.del}>−{g.removed}</span> : null}
                      </span>
                    </button>
                    {shut ? null : g.files.map(({ file, index }) => fileRow(file, index, true))}
                  </div>
                );
              })
            : files.map((f, i) => fileRow(f, i, false))}
        </div>
        {shown ? null : <Actions wsId={wsId} />}
      </div>
      {shown ? (
        <>
          <ResizeHandle
            axis="y"
            label="Resize the list"
            onMove={(y) => {
              const r = box.current?.getBoundingClientRect();
              if (r) setPrefs({ panelSplit: clampShare((y - r.top) / r.height, SPLIT_MIN, SPLIT_MAX) });
            }}
            onReset={() => setPrefs({ panelSplit: SPLIT_DEFAULT })}
            onStep={(dir) => setPrefs({ panelSplit: clampShare(split - dir * 0.04, SPLIT_MIN, SPLIT_MAX) })}
          />
          <FileDiff wsId={wsId} path={shown} onClose={() => setOpen(undefined)} />
          <Actions wsId={wsId} />
        </>
      ) : null}
    </div>
  );
}
