import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { type ReactNode, useEffect, useState } from 'react';
import type { MergePreview } from '@beluga/workspaces/merge-preview.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Button, cx } from '../../components/ui.js';
import { Checkbox } from '../../components/Alert.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { type CheckTone, reviewMerge } from '../../lib/merge-review.js';
import { askBeforeWork } from '../../lib/work-confirm.js';
import { timeAgo } from '../../views/history/history-model.js';
import s from './merge-review.module.css';

/**
 * Merge, the careful way: before anything changes, where it goes (this branch → main, in your
 * main folder), the commits and files it brings, and checks for what would stop it. The green
 * button only works when every check passes; nothing is pushed.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const SHOWN_COMMITS = 5;
const NO_KEYS: readonly string[] = [];

const TONE_ICON: Record<CheckTone, IconName> = { ok: 'check', info: 'info', block: 'alert' };

function usePreview(wsId: string): { preview?: MergePreview; error?: string } {
  const api = useApi();
  const [state, setState] = useState<{ preview?: MergePreview; error?: string }>({});
  // Checked again when the worktree changes (a commit made from here, say).
  const status = useApp((st) => JSON.stringify(st.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId)?.status ?? null));
  useEffect(() => {
    let alive = true;
    api.git.mergePreview(wsId).then(
      (preview) => alive && setState({ preview }),
      (err: unknown) => alive && setState({ error: errorText(err) }),
    );
    return () => {
      alive = false;
    };
  }, [wsId, status]);
  return state;
}

function Flow({ preview, home }: { preview: MergePreview; home: string }) {
  const folder = home && preview.folder.startsWith(home) ? `~${preview.folder.slice(home.length)}` : preview.folder;
  return (
    <div className={s.flow} aria-label={`From ${preview.from} into ${preview.into}`}>
      <div className={s.end}>
        <span className={s.endLabel}>From this worktree</span>
        <span className={s.branch} title={preview.from}>
          <Icon name="branch" size={12} />
          <span className={s.branchName}>{preview.from}</span>
        </span>
      </div>
      <span className={s.arrow} aria-hidden="true">
        <Icon name="arrowRight" size={14} />
      </span>
      <div className={s.end}>
        <span className={s.endLabel}>Into your main folder</span>
        <span className={cx(s.branch, s.target)} title={`${preview.into} in ${folder}`}>
          <Icon name="branch" size={12} />
          <span className={s.branchName}>{preview.into}</span>
        </span>
        <span className={s.folder} title={preview.folder}>
          {folder}
        </span>
      </div>
    </div>
  );
}

function Commits({ preview }: { preview: MergePreview }) {
  if (!preview.commitCount) return null;
  const more = preview.commitCount - Math.min(preview.commits.length, SHOWN_COMMITS);
  return (
    <section className={s.section} aria-label="What merges">
      <div className={s.summary}>
        <strong>{plural(preview.commitCount, 'commit')}</strong>
        {preview.files ? (
          <>
            <span className={s.dot}>·</span>
            {plural(preview.files, 'file')}
            <span className={s.added}>+{preview.insertions.toLocaleString()}</span>
            <span className={s.removed}>−{preview.deletions.toLocaleString()}</span>
          </>
        ) : null}
      </div>
      <ul className={s.commits}>
        {preview.commits.slice(0, SHOWN_COMMITS).map((c) => (
          <li key={c.hash} className={s.commit} title={`${c.subject}\n${c.author} · ${c.hash.slice(0, 7)}`}>
            <span className={s.subject}>{c.subject}</span>
            <span className={s.meta}>{timeAgo(c.when * 1000)}</span>
          </li>
        ))}
      </ul>
      {more > 0 ? <div className={s.more}>and {plural(more, 'earlier commit')}</div> : null}
    </section>
  );
}

function Body({ ws, close, children }: { ws: Workspace; close: () => void; children: (title: ReactNode, body: ReactNode, buttons: ReactNode) => ReactNode }) {
  const api = useApi();
  const home = useApp((st) => st.home);
  const { preview, error } = usePreview(ws.id);
  const review = preview ? reviewMerge(preview) : undefined;
  // Variables kept for this chat (keys pasted into it, BLG-965): the project keeps them unless you untick it.
  const ownVars = useApp((st) => st.envKeys.worktrees?.[ws.id] ?? NO_KEYS);
  const projectName = useApp((st) => st.projects.find((p) => p.id === ws.projectId)?.name ?? 'the project');
  const [keepVars, setKeepVars] = useState(true);
  const go = (): void => {
    if (!review?.canMerge) return;
    close();
    const first = keepVars && ownVars.length ? api.env.carryWorktree(ws.id) : Promise.resolve(0);
    void first.catch(() => 0).then(() => api.workspaces.merge(ws.id));
  };
  const fix = (kind: 'commit' | 'claude'): void => {
    close();
    if (kind === 'commit') askBeforeWork(ws.id, 'commit');
    else void api.workspaces.askClaudeToMerge(ws.id);
  };
  const into = preview?.into ?? 'main';
  const title = `Merge into ${into}`;
  const body = error ? (
    <p className={s.error}>Couldn’t look at this branch: {error}</p>
  ) : !preview || !review ? (
    <p className={s.loading}>Checking what would merge…</p>
  ) : (
    <>
      <Flow preview={preview} home={home} />
      <Commits preview={preview} />
      <ul className={s.checks} aria-label="Checks">
        {review.checks.map((c) => (
          <li key={c.id} className={cx(s.check, s[c.tone])} data-check={c.id} data-tone={c.tone}>
            <Icon name={TONE_ICON[c.tone]} size={13} className={s.checkIcon} />
            <span className={s.checkText}>{c.text}</span>
            {c.fix ? (
              <Button size="small" onClick={() => fix(c.fix!)}>
                {c.fix === 'commit' ? 'Commit…' : 'Ask Your Agent…'}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {ownVars.length ? (
        <div className={s.vars} data-merge-vars>
          <Checkbox
            checked={keepVars}
            onChange={setKeepVars}
            label={
              <>
                Keep {ownVars.slice(0, 3).map((k, i) => (
                  <span key={k}>
                    {i ? ', ' : ''}
                    <code>{k}</code>
                  </span>
                ))}
                {ownVars.length > 3 ? ` and ${ownVars.length - 3} more` : ''} for {projectName}
              </>
            }
            detail={`Pasted into this chat, so only it has ${ownVars.length === 1 ? 'it' : 'them'} now. Kept, ${ownVars.length === 1 ? 'it joins' : 'they join'} ${projectName}’s variables and every new chat and worktree gets ${ownVars.length === 1 ? 'it' : 'them'}. Off: only this worktree keeps ${ownVars.length === 1 ? 'it' : 'them'}.`}
          />
        </div>
      ) : null}
      <p className={s.note}>A merge commit is made in your main folder, so its files change. Nothing is pushed.</p>
    </>
  );
  const buttons = (
    <div className={s.buttons}>
      <Button onClick={close}>
        Cancel
      </Button>
      <Button variant="merge" icon="merge" disabled={!review?.canMerge} onClick={go} data-merge-confirm>
        {review?.confirm ?? 'Merge'}
      </Button>
    </div>
  );
  return <>{children(title, body, buttons)}</>;
}

export function MergeReview({ ws, anchor, close }: { ws: Workspace; anchor: HTMLElement | null; close: () => void }) {
  const head = (title: ReactNode, Title: typeof Dialog.Title | typeof Popover.Title) => (
    <div className={s.head}>
      <span className={s.icon} aria-hidden="true">
        <Icon name="merge" size={16} />
      </span>
      <Title className={s.title}>{title}</Title>
    </div>
  );
  if (!anchor) {
    return (
      <Dialog.Root open onOpenChange={(open) => (open ? undefined : close())}>
        <Dialog.Portal>
          <Dialog.Overlay className={s.overlay} />
          <Dialog.Content className={cx(s.panel, s.sheet)} aria-describedby={undefined}>
            <Body ws={ws} close={close}>
              {(title, body, buttons) => (
                <>
                  {head(title, Dialog.Title)}
                  {body}
                  {buttons}
                </>
              )}
            </Body>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
  return (
    <Popover.Root open onOpenChange={(open) => (open ? undefined : close())}>
      <Popover.Anchor virtualRef={{ current: anchor }} />
      <Popover.Portal>
        <Popover.Content
          className={s.panel}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-label="Merge"
          // Its own button pressed again closes it (see askBeforeWork), instead of closing and reopening.
          onPointerDownOutside={(e) => (anchor.contains(e.target as Node) ? e.preventDefault() : undefined)}
        >
          <Body ws={ws} close={close}>
            {(title, body, buttons) => (
              <>
                {head(title, Popover.Title)}
                {body}
                {buttons}
              </>
            )}
          </Body>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
