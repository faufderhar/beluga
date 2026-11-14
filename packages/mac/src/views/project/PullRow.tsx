import { memo, useEffect, useRef, useState } from 'react';
import type { GhPull, PullsList } from '@beluga/core/issues/model.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { type ActionItem, ActionsContext, ActionsDropdown } from '../../components/SpecMenu.js';
import { Button, IconButton, Tip, cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { copyText } from '../../lib/copy.js';
import { keepSeen, lastSeen } from '../../lib/last-seen.js';
import { makeAhead } from '../../lib/make-ahead.js';
import { ago } from '../../tasks/tasks-model.js';
import s from '../../issues/issues.module.css';
import pr from './pull-row.module.css';

/** A project's open pull requests on GitHub (anyone's), for its home: read through the core, kept a little while. */

const lists = new Map<string, { readonly job: Promise<PullsList>; readonly at: number }>();
const UI_TTL_MS = 30_000;

/** A project's open pull requests; what was read last time shows at once while it's read again. */
export function usePullList(projectId: string): PullsList | undefined {
  return usePulls(projectId).list;
}

/** usePullList, with asking GitHub again (Ask GitHub Again), whether it's asking, and why it failed. */
export function usePulls(projectId: string): { readonly list?: PullsList; readonly loading: boolean; readonly error?: string; readonly refresh: () => void } {
  const api = useApi();
  const [got, setGot] = useState<{ readonly id: string; readonly list: PullsList }>();
  const [asking, setAsking] = useState<{ readonly id: string; readonly force: boolean; readonly n: number }>({ id: projectId, force: false, n: 0 });
  const [state, setState] = useState<{ readonly id: string; readonly loading: boolean; readonly error?: string }>({ id: projectId, loading: false });
  const current = useRef(projectId);
  current.current = projectId;
  useEffect(() => {
    const force = asking.id === projectId && asking.force;
    const kept = lists.get(projectId);
    const fresh = !force && kept && Date.now() - kept.at < UI_TTL_MS;
    const job = fresh ? kept.job : api.issues.pulls(projectId, force ? { force: true } : undefined);
    if (!fresh) lists.set(projectId, { job, at: Date.now() });
    setState({ id: projectId, loading: true });
    job.then(
      (list) => {
        keepSeen(`pulls:${projectId}`, list);
        if (current.current !== projectId) return;
        setGot({ id: projectId, list });
        setState({ id: projectId, loading: false });
      },
      (err: unknown) => {
        lists.delete(projectId);
        if (current.current === projectId) setState({ id: projectId, loading: false, error: err instanceof Error ? err.message : String(err) });
      },
    );
  }, [projectId, asking]);
  const list = got?.id === projectId ? got.list : lastSeen<PullsList>(`pulls:${projectId}`);
  const here: { readonly loading: boolean; readonly error?: string } = state.id === projectId ? state : { loading: true };
  return {
    ...(list ? { list } : {}),
    loading: here.loading,
    ...(here.error ? { error: here.error } : {}),
    refresh: () => setAsking((a) => ({ id: projectId, force: true, n: a.n + 1 })),
  };
}

/** Checks and review as one small mark each (words in the tooltip): the row stays a title and a line. */
const CHECKS: Record<Exclude<GhPull['checks'], 'none'>, Mark> = {
  passing: { label: 'Checks pass', icon: 'check', tone: 'ok' },
  failing: { label: 'Checks fail', icon: 'x', tone: 'error' },
  pending: { label: 'Checks running', icon: 'clock', tone: 'claude' },
};

/** "Review required" is where every pull request starts: no mark. */
const REVIEW: Partial<Record<NonNullable<GhPull['review']>, Mark>> = {
  APPROVED: { label: 'Approved', icon: 'review', tone: 'ok' },
  CHANGES_REQUESTED: { label: 'Changes requested', icon: 'review', tone: 'warn' },
};

interface Mark {
  readonly label: string;
  readonly icon: IconName;
  readonly tone: 'ok' | 'error' | 'warn' | 'claude';
}

function MarkIcon({ mark }: { mark: Mark }) {
  return (
    <Tip label={mark.label}>
      <span className={cx(pr.mark, pr[`mark_${mark.tone}`])} role="img" aria-label={mark.label}>
        <Icon name={mark.icon} size={13} />
      </span>
    </Tip>
  );
}

/**
 * One open pull request: its title, then its number, author and branch (Draft first when it is
 * one); marks for its review and checks, and when it last moved. One on a branch of the project's
 * worktrees opens that worktree; any other opens on GitHub, and its Open in Worktree (BLG-633),
 * there in place of the marks while you're on the row, checks its branch out in a new worktree.
 */
export const PullRow = memo(function PullRow({ projectId, pull }: { projectId: string; pull: GhPull }) {
  const actions = useActions();
  const api = useApi();
  const { client } = useBeluga();
  // A fork's PR whose branch name was taken here is checked out as pr-<n> (as the daemon's openPull matches it).
  const mine = (branch: string | undefined): boolean => branch === pull.branch || (Boolean(pull.fork) && branch === `pr-${pull.number}`);
  const ws = useApp((st) => st.projects.find((p) => p.id === projectId)?.workspaces.find((w) => w.kind === 'worktree' && !w.archived && mine(w.branch))?.id);
  const onGitHub = (): void => actions.openLink({ kind: 'url', url: pull.url });
  const open = (): void => (ws ? actions.run({ type: 'open_ws', id: ws }) : onGitHub());
  // Its worktree's row and page show the moment you click (BLG-942), before the daemon has asked GitHub
  // anything; git fetches the branch behind them. A failure takes them away and says why in a toast.
  const checkOut = (): void => {
    const ahead = makeAhead(client, projectId, `pr-${pull.number}`, pull.base ? { base: `origin/${pull.base}` } : {});
    void api.issues.openPull(projectId, pull.number, ahead ? { id: ahead.id } : undefined).catch((err: unknown) => {
      ahead?.drop();
      toast(client, `Couldn’t open #${pull.number} in a worktree: ${err instanceof Error ? err.message : String(err)}`, 'error');
    });
  };
  const menu = (): ActionItem[] => [
    ws ? { label: 'Open the Worktree', icon: 'branch', onSelect: open } : { label: 'Open in Worktree', icon: 'branch', onSelect: checkOut },
    { label: 'Open on GitHub', icon: 'external', separate: true, onSelect: onGitHub },
    { label: 'Copy Link', icon: 'copy', onSelect: () => void copyText(pull.url).then(() => toast(client, `Copied the link to #${pull.number}`, 'success')) },
  ];
  const checks = pull.checks === 'none' ? undefined : CHECKS[pull.checks];
  const review = pull.draft || !pull.review ? undefined : REVIEW[pull.review];
  return (
    <ActionsContext items={menu}>
      <div
        role="listitem"
        tabIndex={0}
        className={cx(s.row, s.rowCompact, !ws && pr.canCheckOut)}
        onClick={open}
        onKeyDown={(e) => e.key === 'Enter' && open()}
        aria-label={`#${pull.number} ${pull.title}${pull.draft ? ', draft' : ''}${ws ? ', in a worktree' : ''}`}
        data-pull={pull.number}
      >
        <span className={cx(s.state, !pull.draft && s.state_open)} role="img" aria-label={pull.draft ? 'Draft' : 'Open'}>
          <Icon name="pr" size={15} />
        </span>
        <span className={s.rowMain}>
          <span className={s.rowTop}>
            <span className={s.rowTitle}>{pull.title}</span>
          </span>
          <span className={s.rowSub}>
            {pull.draft ? 'Draft · ' : ''}#{pull.number}
            {pull.author ? ` · ${pull.author}` : ''}
            {pull.branch ? ` · ${pull.branch}` : ''}
          </span>
        </span>
        <span className={pr.tail}>
          <span className={pr.info}>
            {ws ? (
              <Tip label="You have a worktree on this branch: a click opens it">
                <span className={cx(pr.mark, pr.mark_branch)} role="img" aria-label="In a worktree">
                  <Icon name="branch" size={13} />
                </span>
              </Tip>
            ) : null}
            {review ? <MarkIcon mark={review} /> : null}
            {checks ? <MarkIcon mark={checks} /> : null}
            <span className={pr.when}>{ago(pull.updatedAt)}</span>
          </span>
          {ws ? null : (
            <span className={pr.act} onClick={(e) => e.stopPropagation()}>
              <Tip label={pull.fork ? 'Check it out from the fork in a new worktree (pushing there won’t change it)' : `Check out ${pull.branch} in a new worktree: pushing there updates the pull request`}>
                <Button size="small" variant="quiet" icon="branch" onClick={checkOut} aria-label={`Open #${pull.number} in a worktree`}>
                  Open in Worktree
                </Button>
              </Tip>
            </span>
          )}
        </span>
        <span className={s.rowMore} onClick={(e) => e.stopPropagation()}>
          <ActionsDropdown items={menu()}>
            <IconButton icon="more" label={`What to do with #${pull.number}`} />
          </ActionsDropdown>
        </span>
      </div>
    </ActionsContext>
  );
});
