import { Fragment, useMemo, useState } from 'react';
import { type DiffLine as Line, parseDiff } from '@beluga/shared/diff-lines.js';
import type { ChangedFile } from '@beluga/workspaces/git.js';
import { Icon } from '../components/Icon.js';
import { Button, Empty, Segmented, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { useMyAgentName } from '../lib/agent-words.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { joinPath } from '@beluga/shared/os-path.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { ActionsContext, ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { copyText } from '../lib/copy.js';
import { revealInFinder } from '../lib/files.js';
import { quoteInBox } from '../chat/message-menu.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { ChangedFileView, canShowFile, fileLookLabel, onlyAsFile, useChangeLocation } from './ChangedFile.js';
import { CommentButton, type DiffComments, useDiffComments, useWaitingHere } from './DiffComment.js';
import s from './diff.module.css';
import { revealLabel } from '../lib/os-words.js';
import { useRevealFileLabel } from '../lib/remote-open.js';

/** Side by side: deletions on the left, additions on the right, aligned within each change. */
function splitRows(lines: Line[]): Array<{ left?: Line; right?: Line; full?: Line }> {
  const rows: Array<{ left?: Line; right?: Line; full?: Line }> = [];
  let dels: Line[] = [];
  let adds: Line[] = [];
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ ...(dels[i] ? { left: dels[i] } : {}), ...(adds[i] ? { right: adds[i] } : {}) });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === 'del') dels.push(l);
    else if (l.kind === 'add') adds.push(l);
    else {
      flush();
      if (l.kind === 'ctx') rows.push({ left: l, right: l });
      else rows.push({ full: l });
    }
  }
  flush();
  return rows;
}

/** A changed file's letter and color (M, A, U, D, R). */
export const STATE: Record<ChangedFile['state'], { letter: string; tone: string }> = {
  modified: { letter: 'M', tone: s.modified! },
  added: { letter: 'A', tone: s.added! },
  untracked: { letter: 'U', tone: s.added! },
  deleted: { letter: 'D', tone: s.deleted! },
  renamed: { letter: 'R', tone: s.modified! },
};

/** Git's notes about a file, in words ("new file mode 100644" says it's a new file). */
export function noteOf(text: string): string {
  if (text.startsWith('new file')) return 'New file';
  if (text.startsWith('deleted file')) return 'File deleted';
  if (text.startsWith('rename from ')) return `Renamed from ${text.slice('rename from '.length)}`;
  if (text.startsWith('rename to ')) return `Renamed to ${text.slice('rename to '.length)}`;
  if (/^No newline at end of file/i.test(text)) return 'No newline at the end of the file';
  return text;
}

export type Commit = { readonly hash: string; readonly subject: string };

/** A commit's menu (click or right-click): copy it, or ask Claude about it. */
export function useCommitItems(): (c: Commit) => ActionItem[] {
  const agent = useMyAgentName();
  const { client, ui } = useBeluga();
  const actions = useActions();
  const say = (text: string): void => client.store.dispatch({ type: 'toast', text, level: 'success' });
  return (c) => {
    const view = client.store.getState().view;
    const ask = (): void => {
      if (view.kind === 'workspace') actions.run({ type: 'open_ws', id: view.id, tab: 'chat' });
      else if (view.kind === 'shared') actions.run({ type: 'open_shared', owner: view.owner, id: view.id, tab: 'chat' });
      setTimeout(() => quoteInBox(ui, `${c.hash} ${c.subject}`), 60);
    };
    return [
      { label: 'Copy Hash', icon: 'copy', onSelect: () => void copyText(c.hash).then(() => say(`Copied ${c.hash}`)) },
      { label: 'Copy Message', onSelect: () => void copyText(c.subject).then(() => say('Copied the commit message')) },
      { label: `Ask ${agent} About This Commit`, icon: 'claude', separate: true, onSelect: ask },
    ];
  };
}

/** A changed file's right-click menu: open it, find it in Finder, copy its path, ask Claude. */
export function useFileItems(): (f: ChangedFile, index: number) => ActionItem[] {
  const { client, ui } = useBeluga();
  // On a computer's page the file is downloaded instead (BLG-852).
  const revealFile = useRevealFileLabel();
  const actions = useActions();
  const say = (text: string): void => client.store.dispatch({ type: 'toast', text, level: 'success' });
  return (f, index) => {
    const state = client.store.getState();
    const view = state.view;
    const ws = view.kind === 'workspace' ? findWorkspace(state.projects, view.id) : undefined;
    const local = ws && f.state !== 'deleted' ? joinPath(ws.path, f.path) : undefined;
    const at = view.kind === 'workspace' ? { owner: state.selfId, share: shareNameOf(view.id), path: f.path } : view.kind === 'shared' ? (() => {
      const w = state.shared.find((x) => x.id === view.id && x.owner === view.owner);
      return w ? { owner: w.owner, share: w.share, path: f.path } : undefined;
    })() : undefined;
    const open = (): void => {
      if (!at) return;
      if (view.kind === 'workspace') actions.run({ type: 'open_ws', id: view.id, tab: 'files' });
      else if (view.kind === 'shared') actions.run({ type: 'open_shared', owner: view.owner, id: view.id, tab: 'files' });
      setTimeout(() => void client.api.files.open(at), 80);
    };
    const ask = (): void => {
      if (view.kind === 'workspace') actions.run({ type: 'open_ws', id: view.id, tab: 'chat' });
      else if (view.kind === 'shared') actions.run({ type: 'open_shared', owner: view.owner, id: view.id, tab: 'chat' });
      setTimeout(() => {
        const current = ui.get().buffer;
        const buffer = `${current}${current && !current.endsWith(' ') ? ' ' : ''}${f.path} `;
        ui.patch({ buffer, cursor: buffer.length });
        document.dispatchEvent(new CustomEvent('beluga:focus-composer'));
      }, 60);
    };
    return [
      { label: 'Show Changes', icon: 'diff', onSelect: () => actions.run({ type: 'review_file', index }) },
      ...(at && f.state !== 'deleted' ? [{ label: 'Open File', icon: 'file' as const, onSelect: open }] : []),
      ...(local ? [{ label: revealFile, icon: 'folder' as const, onSelect: () => void revealInFinder(client, local) }] : []),
      { label: 'Copy Path', icon: 'copy', separate: true, onSelect: () => void copyText(local ?? f.path).then(() => say('Copied the path')) },
      { label: 'Mention in Chat', icon: 'chat', onSelect: ask },
    ];
  };
}

/**
 * A diff, one column: the old and new line numbers, then the line. `compact` (the right panel):
 * one line number (the new one, or the old one for a removed line) and long lines wrap. Given
 * `comments`, a line's + comments on it (DiffComment.tsx), the box opening under it.
 */
export function UnifiedDiff({ lines, compact, comments }: { lines: readonly Line[]; compact?: boolean; comments?: DiffComments }) {
  const cols = compact ? 2 : 3;
  const picked = comments?.picked;
  return (
    <table className={cx(s.table, compact && s.compact)}>
      {/* Fixed layout takes its widths from here (the first row may be a hunk across both). */}
      {compact ? (
        <colgroup>
          <col className={s.numCol} />
          <col />
        </colgroup>
      ) : null}
      <tbody>
        {lines.map((l, i) =>
          l.kind === 'hunk' || l.kind === 'meta' ? (
            <tr key={i} className={cx(s.hunk, l.kind === 'meta' && s.note)}>
              <td colSpan={cols}>{l.kind === 'meta' ? noteOf(l.text) : l.text}</td>
            </tr>
          ) : (
            <Fragment key={i}>
              <tr className={cx(s[`l_${l.kind}`], comments?.marked.has(i) && s.commented, picked && i >= picked.from && i <= picked.to && s.picked)}>
                {compact ? (
                  <td className={s.num}>{l.new ?? l.old ?? ''}</td>
                ) : (
                  <>
                    <td className={s.num}>{l.old ?? ''}</td>
                    <td className={s.num}>{l.new ?? ''}</td>
                  </>
                )}
                <td className={s.text}>
                  {comments ? <CommentButton row={i} line={l} comments={comments} /> : null}
                  <span className={s.sign}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                  {l.text || ' '}
                </td>
              </tr>
              {picked?.to === i ? (
                <tr className={s.commentRow}>
                  <td colSpan={cols}>{comments?.box}</td>
                </tr>
              ) : null}
            </Fragment>
          ),
        )}
      </tbody>
    </table>
  );
}

/** Side by side, with a + on each side's lines to comment on them. */
function SplitDiff({ lines, comments }: { lines: readonly Line[]; comments: DiffComments }) {
  const rowOf = useMemo(() => new Map(lines.map((l, i) => [l, i])), [lines]);
  const rows = useMemo(() => splitRows([...lines]), [lines]);
  const picked = comments.picked;
  const on = (i: number | undefined): boolean => i !== undefined && !!picked && i >= picked.from && i <= picked.to;
  const endsPick = (l: Line | undefined): boolean => !!l && !!picked && rowOf.get(l) === picked.to;
  const side = (l: Line | undefined, n: number | undefined) => {
    const i = l ? rowOf.get(l) : undefined;
    return (
      <>
        <td className={cx(s.num, l && s[`l_${l.kind}`], i !== undefined && comments.marked.has(i) && s.commented, on(i) && s.picked)}>{n ?? ''}</td>
        <td className={cx(s.text, l ? s[`l_${l.kind}`] : s.blank, on(i) && s.picked)}>
          {l && i !== undefined ? <CommentButton row={i} line={l} comments={comments} /> : null}
          {l?.text ?? ''}
        </td>
      </>
    );
  };
  return (
    <table className={cx(s.table, s.split)}>
      <tbody>
        {rows.map((r, k) =>
          r.full ? (
            <tr key={k} className={cx(s.hunk, r.full.kind === 'meta' && s.note)}>
              <td colSpan={4}>{r.full.kind === 'meta' ? noteOf(r.full.text) : r.full.text}</td>
            </tr>
          ) : (
            <Fragment key={k}>
              <tr>
                {side(r.left, r.left?.old)}
                {side(r.right, r.right?.new)}
              </tr>
              {endsPick(r.left) || endsPick(r.right) ? (
                <tr className={s.commentRow}>
                  <td colSpan={4}>{comments.box}</td>
                </tr>
              ) : null}
            </Fragment>
          ),
        )}
      </tbody>
    </table>
  );
}

/** What changed in a workspace (or one shared with you): the files, then the selected file's diff. */
export function DiffView() {
  const agent = useMyAgentName();
  const actions = useActions();
  const review = useApp((st) => st.review);
  const view = useApp((st) => st.view);
  const [layout, setLayout] = useState<'unified' | 'split'>('unified');
  const prefs = usePrefs();
  const located = useChangeLocation(review?.data?.files[review.selected]?.path);
  const lines = useMemo(() => (review?.diff ? parseDiff(review.diff) : []), [review?.diff]);
  const comments = useDiffComments(review?.data?.files[review.selected]?.path, lines);
  const waiting = useWaitingHere();
  const files = review?.data?.files ?? [];
  const totals = files.reduce((t, f) => ({ add: t.add + f.added, del: t.del + f.removed }), { add: 0, del: 0 });
  const mine = view.kind === 'workspace';
  const fileItems = useFileItems();
  const commitItems = useCommitItems();
  if (!review || (review.loading && !review.data)) return <Empty icon="diff" title="Looking at what changed…" />;
  if (review.error) return <Empty icon="alert" title="Couldn't read the changes" detail={review.error} />;
  if (!files.length) return <Empty icon="check" title="Nothing has changed yet" detail={review.data ? `Everything matches ${review.data.base}.` : undefined} />;
  const file = files[review.selected];
  const at = file && canShowFile(file) ? located : undefined;
  // A picture or a PDF as itself; anything else its diff (Unified or Split) or the file (Markdown formatted).
  const asFile = !!at && !!file && (onlyAsFile(file.path) || prefs.changeLook === 'file');
  const mode = asFile ? 'file' : layout;
  // The message box is the conversation's: back there (out of the full-size diff, too) to send it.
  const toChat = (): void => {
    if (view.kind === 'workspace') actions.run({ type: 'open_ws', id: view.id, tab: 'chat' });
    else if (view.kind === 'shared') actions.run({ type: 'open_shared', owner: view.owner, id: view.id, tab: 'chat' });
    setTimeout(() => document.dispatchEvent(new CustomEvent('beluga:focus-composer')), 60);
  };
  const setMode = (m: 'unified' | 'split' | 'file'): void => {
    if (m === 'file') return setPrefs({ changeLook: 'file' });
    setLayout(m);
    setPrefs({ changeLook: 'diff' });
  };
  return (
    <div className={s.diff}>
      <aside className={s.files} aria-label="Changed files">
        <div className={s.filesHead}>
          <span>
            {files.length} file{files.length === 1 ? '' : 's'}
          </span>
          <span className={s.add}>+{totals.add}</span>
          <span className={s.del}>−{totals.del}</span>
        </div>
        {review.data?.commits.length ? (
          <div className={s.commits}>
            {review.data.commits.slice(0, 6).map((c) => (
              <ActionsContext key={c.hash} items={() => commitItems(c)}>
                <span className={s.commitWrap}>
                  <ActionsDropdown items={commitItems(c)} align="start">
                    <button type="button" className={s.commit} title={c.subject}>
                      <span className={s.hash}>{c.hash}</span> {c.subject}
                    </button>
                  </ActionsDropdown>
                </span>
              </ActionsContext>
            ))}
            {review.data.commits.length > 6 ? <div className={s.moreCommits}>and {review.data.commits.length - 6} earlier</div> : null}
          </div>
        ) : null}
        <div className={s.fileList} role="listbox" aria-label="Files">
          {files.map((f, i) => {
            const st = STATE[f.state];
            const name = f.path.split('/').pop();
            const dir = f.path.slice(0, f.path.length - (name?.length ?? 0));
            return (
              <ActionsContext key={f.path} items={() => fileItems(f, i)}>
              <div role="option" aria-selected={i === review.selected} className={cx(s.file, i === review.selected && s.fileOn)} onClick={() => actions.run({ type: 'review_file', index: i })} title={f.path}>
                <span className={cx(s.letter, st.tone)}>{st.letter}</span>
                <span className={s.fileName}>
                  {name}
                  <span className={s.dir}>{dir}</span>
                </span>
                <span className={s.add}>{f.added ? `+${f.added}` : ''}</span>
                <span className={s.del}>{f.removed ? `−${f.removed}` : ''}</span>
              </div>
              </ActionsContext>
            );
          })}
        </div>
        {mine ? (
          <div className={s.filesFoot}>
            <Button icon="claude" onClick={() => actions.run({ type: 'ws', id: view.id, action: 'review_claude' })}>
              Ask {agent} to review
            </Button>
          </div>
        ) : null}
      </aside>
      <section className={s.body} aria-label={file?.path ?? 'Diff'}>
        <div className={s.bodyHead}>
          <Icon name="file" size={13} />
          <span className={s.path}>{file?.path}</span>
          <span className={s.flex} />
          {file && onlyAsFile(file.path) ? null : (
            <Segmented
              label="Layout"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'unified', label: 'Unified' },
                { value: 'split', label: 'Split' },
                ...(at && file ? [{ value: 'file' as const, label: fileLookLabel(file.path), hint: 'The file as it is now' }] : []),
              ]}
            />
          )}
        </div>
        {waiting && mode !== 'file' ? (
          <div className={s.waiting}>
            <Icon name="chat" size={12} />
            {waiting} comment{waiting === 1 ? '' : 's'} waiting to send
            <span className={s.flex} />
            <Button size="small" variant="quiet" onClick={toChat}>
              Go to Chat
            </Button>
          </div>
        ) : null}
        <div className={cx(s.code, mode === 'file' && s.asFile, 'selectable')} tabIndex={0} aria-label={mode === 'file' ? 'The file' : 'The changes'}>
          {mode === 'file' && at ? (
            <ChangedFileView at={at} variant="focus" wrap={false} />
          ) : !review.diff ? (
            <div className={s.loadingDiff}>Loading the diff…</div>
          ) : mode === 'unified' ? (
            <UnifiedDiff lines={lines} comments={comments} />
          ) : (
            <SplitDiff lines={lines} comments={comments} />
          )}
        </div>
      </section>
    </div>
  );
}
