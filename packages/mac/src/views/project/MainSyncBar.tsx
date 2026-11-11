import { useEffect, useState } from 'react';
import { activityOf } from '@beluga/ui/workspace-models.js';
import type { StashUpdateOutcome, UpdateOutcome } from '@beluga/workspaces/sync.js';
import type { Project } from '@beluga/workspaces/types.js';
import { Alert } from '../../components/Alert.js';
import { Icon } from '../../components/Icon.js';
import { Button, Dot, Tip, cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { useMyAgentName } from '../../lib/agent-words.js';
import { type MainLine, agoText } from './home-model.js';
import s from './main-sync.module.css';

/**
 * Under the project's name: Update main (fetch and fast-forward), Fetch and when it last did, the
 * main folder being on another branch (Switch to main), and Claude updating main. What can't
 * simply fast-forward asks: set your changes aside, move them to a worktree, or let Claude do it
 * (in a worktree of its own; in the main folder only for what's stuck in its files). A fork also
 * gets Sync Fork when the original has new commits (BLG-726): GitHub brings them into the fork,
 * then main updates here.
 */

type Dialog =
  | { readonly kind: 'dirty'; readonly files: readonly string[]; readonly behind: number }
  /** `inMain`: stuck in the main folder's own files, so Claude works there (else in a worktree). */
  | { readonly kind: 'claude'; readonly title: string; readonly message: string; readonly inMain?: boolean }
  | { readonly kind: 'conflicts'; readonly files: readonly string[]; readonly message: string }
  | { readonly kind: 'switch'; readonly dirty: number }
  /** Sync fork stopped: the fork and the original change the same lines. */
  | { readonly kind: 'fork'; readonly message: string };

/** A fetch that failed, as the dialog that offers Claude (git's own words go along). */
const fetchDialog = (message: string, detail?: string): Dialog => ({ kind: 'claude', title: 'Couldn’t fetch', message: detail && !message.includes(detail) ? `${message} Git said: ${detail}` : message });

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Re-render every so often (for "fetched 3 min ago"). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** A conversation where Claude is updating main right now (its workspace id, and whether it's in a worktree). */
function useClaudeUpdating(project: Project): { id: string; worktree: boolean } | undefined {
  const ws = useApp((st) => project.workspaces.find((w) => w.purpose === 'sync_main' && !w.archived && activityOf(st.log, `ws:${w.id}`).running));
  return ws ? { id: ws.id, worktree: ws.kind === 'worktree' } : undefined;
}

export function MainSyncBar({ project, line }: { project: Project; line: MainLine }) {
  const agent = useMyAgentName();
  const api = useApi();
  const { client } = useBeluga();
  const actions = useActions();
  const sync = project.sync;
  const [busy, setBusy] = useState<'update' | 'switch' | 'claude' | 'fork'>();
  const [dialog, setDialog] = useState<Dialog>();
  const now = useNow(30_000);
  const claude = useClaudeUpdating(project);
  const branch = line.branch ?? 'main';

  // Opening the home fetches when the last fetch is a few minutes old (quietly).
  useEffect(() => {
    void api.git.fetchIfStale(project.id).catch(() => undefined);
  }, [project.id]);

  if (!sync) return null;
  const upstream = sync.upstream ?? `origin/${branch}`;

  const run = async <T,>(what: 'update' | 'switch' | 'claude' | 'fork', job: () => Promise<T>): Promise<T | undefined> => {
    setBusy(what);
    try {
      return await job();
    } catch (err) {
      toast(client, errorText(err), 'error');
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  /** What an update came back with that needs you (the rest the core already said in a toast). */
  const decide = (out: UpdateOutcome | StashUpdateOutcome): void => {
    if ('restored' in out && !out.restored) {
      setDialog({ kind: 'conflicts', files: out.conflicts ?? [], message: `${branch} is up to date, but putting your changes back conflicted with the new commits. Your changes are safe in the stash “${out.stash?.message ?? 'beluga'}”, and the files have conflict markers.` });
      return;
    }
    switch (out.kind) {
      case 'dirty':
        setDialog({ kind: 'dirty', files: out.files, behind: out.behind });
        return;
      case 'diverged':
        setDialog({ kind: 'claude', title: `${out.branch} and ${out.upstream} have both moved on`, message: `${out.branch} has ${plural(out.ahead, 'commit')} that ${out.ahead === 1 ? 'isn’t' : 'aren’t'} on ${out.upstream}, and ${out.upstream} has ${plural(out.behind, 'new commit')}. Bringing them together takes a merge or a rebase.` });
        return;
      case 'busy':
        setDialog({ kind: 'claude', inMain: true, title: `A ${out.operation} is stopped halfway in main`, message: `The main folder is in the middle of a ${out.operation} (there are conflicts to resolve). Your agent can finish it and then update ${branch}.` });
        return;
      case 'failed':
        setDialog({ kind: 'claude', title: `Couldn’t update ${branch}`, message: out.message });
        return;
      case 'fetch_failed':
        setDialog(fetchDialog(out.message, out.detail));
        return;
      default:
    }
  };

  const update = (): void => void run('update', () => api.git.updateMain(project.id)).then((out) => out && decide(out));
  const syncFork = (): void =>
    void run('fork', () => api.git.syncFork(project.id)).then((out) => {
      if (out?.kind === 'synced') decide(out.update);
      else if (out?.kind === 'conflict') setDialog({ kind: 'fork', message: out.message });
    });
  const forkWithClaude = (): void => {
    const said = dialog?.kind === 'fork' ? dialog.message : undefined;
    setDialog(undefined);
    void run('claude', () => api.git.syncForkWithClaude(project.id, said));
  };
  const fetchNow = (): void => void api.git.fetch(project.id).catch((err: unknown) => toast(client, errorText(err), 'error'));
  /** What the dialog said goes along, so Claude starts from git's own words. */
  const askClaude = (): void => {
    const said = dialog && 'message' in dialog ? `${dialog.kind === 'claude' ? `${dialog.title}: ` : ''}${dialog.message}`.slice(0, 2000) : undefined;
    setDialog(undefined);
    void run('claude', () => api.git.askClaude(project.id, said));
  };
  const stashAndUpdate = (): void => {
    setDialog(undefined);
    void run('update', () => api.git.stashAndUpdate(project.id)).then((out) => out && decide(out));
  };
  const moveAndUpdate = (): void => {
    setDialog(undefined);
    void run('update', () => api.git.moveAndUpdate(project.id)).then((out) => out && decide(out.outcome));
  };
  const switchTo = (mode: 'clean' | 'stash' | 'move'): void => {
    setDialog(undefined);
    void run('switch', () => api.git.switchToDefault(project.id, mode)).then((out) => {
      if (!out) return;
      if (out.kind === 'dirty') setDialog({ kind: 'switch', dirty: out.files?.length || sync.dirty || 1 });
      else if (out.kind === 'conflicts') setDialog({ kind: 'conflicts', files: out.files ?? [], message: out.message ?? '' });
      else if (out.kind === 'failed') toast(client, out.message ?? `Couldn’t switch to ${branch}`, 'error');
    });
  };

  const diverged = sync.ahead > 0 && sync.behind > 0;
  const showUpdate = Boolean(sync.upstream) && (line.canUpdate || diverged || Boolean(sync.operation));
  const fork = project.fork;
  const original = fork ? `${fork.owner}/${fork.repo}` : '';
  // Only when there's something to bring in (unknown counts too: GitHub didn't say).
  const showFork = Boolean(fork) && (fork?.behind ?? 1) > 0;
  const fetchedLabel = sync.fetching ? 'Fetching…' : sync.fetchedAt ? `fetched ${agoText(sync.fetchedAt, now)}` : 'never fetched';

  return (
    <div className={s.wrap}>
      {line.elsewhere ? (
        <div className={s.callout} role="note" aria-label="Main folder branch">
          <Icon name="branch" size={13} className={s.calloutIcon} />
          <span className={s.calloutText}>
            <strong>{line.elsewhere}.</strong> Updating and History here are about {branch}{sync.dirty ? `; the folder has ${plural(sync.dirty, 'uncommitted change')}` : ''}.
          </span>
          <Tip label={sync.dirty ? 'Choose what happens to the uncommitted changes first' : `Check out ${branch} in the main folder`}>
            <Button size="small" disabled={busy === 'switch'} onClick={() => (sync.dirty ? setDialog({ kind: 'switch', dirty: sync.dirty }) : switchTo('clean'))}>
              {busy === 'switch' ? 'Switching…' : `Switch to ${branch}`}
            </Button>
          </Tip>
        </div>
      ) : null}
      {claude ? (
        <div className={cx(s.callout, s.calloutClaude)} role="status" aria-label="Your agent is updating main">
          <Dot tone="claude" live />
          <span className={s.calloutText}>
            <strong>Your agent is updating {branch}.</strong> {claude.worktree ? 'It works in a worktree of its own and leaves the main folder to you.' : 'It may only sync git here: fetch, merge, stash, resolve conflicts.'} Nothing is pushed.
          </span>
          <Button size="small" onClick={() => actions.run({ type: 'open_ws', id: claude.id, tab: 'chat' })}>
            Open
          </Button>
        </div>
      ) : null}
      <div className={s.bar}>
        {showUpdate ? (
          <Tip label={diverged ? `Both sides moved on: choose how to bring them together` : `Fetch ${upstream} and fast-forward ${branch}${sync.onDefault ? '' : ' (the folder stays where it is)'}`}>
            <Button size="small" variant="primary" icon="download" disabled={busy === 'update' || Boolean(claude)} onClick={update}>
              {busy === 'update' ? 'Updating…' : `Update ${branch}`}
            </Button>
          </Tip>
        ) : null}
        {showFork && fork ? (
          <Tip label={`Bring ${original}’s new commits into your fork’s ${fork.forkBranch} on GitHub, then update ${branch} here`}>
            <Button size="small" variant={showUpdate ? undefined : 'primary'} icon="merge" disabled={busy === 'fork' || Boolean(claude)} onClick={syncFork}>
              {busy === 'fork' ? 'Syncing…' : 'Sync Fork'}
            </Button>
          </Tip>
        ) : null}
        {sync.upstream ? (
          <Tip label={`Fetch ${sync.remote ?? 'origin'} now (Beluga also fetches quietly every 15 minutes)`}>
            <Button size="small" variant="quiet" icon="refresh" className={cx(sync.fetching && s.spinning)} disabled={sync.fetching} onClick={fetchNow}>
              Fetch
            </Button>
          </Tip>
        ) : null}
        {showFork && fork?.behind ? (
          <span className={s.status} aria-label={`${plural(fork.behind, 'new commit')} on ${original}`}>
            {fork.behind} new on {original}
          </span>
        ) : null}
        {sync.fetchError ? (
          <Tip label={`${sync.fetchError.message} Click to let your agent look into it.`}>
            <button type="button" className={cx(s.status, s.statusWarn, s.statusButton)} onClick={() => setDialog(fetchDialog(sync.fetchError!.message))}>
              <Icon name="alert" size={12} />
              {sync.fetchError.reason === 'auth' ? 'Sign-in needed to fetch' : sync.fetchError.reason === 'offline' ? 'Couldn’t reach the remote' : sync.fetchError.reason === 'https_broken' ? 'https doesn’t work here' : 'Couldn’t fetch'}
            </button>
          </Tip>
        ) : sync.upstream ? (
          <span className={s.status} title={sync.fetchedAt ? new Date(sync.fetchedAt).toLocaleString() : undefined}>
            {fetchedLabel}
          </span>
        ) : null}
      </div>
      {dialog?.kind === 'dirty' ? (
        <Alert
          title="Your uncommitted changes are in the way"
          icon="alert"
          message={`${upstream} has ${plural(dialog.behind, 'new commit')}, and some change files you’ve edited in main. Beluga can stash your changes, update, and put them back, or move them to a worktree of their own first.`}
          table={{ caption: 'Changed in main', columns: ['File'], rows: dialog.files.slice(0, 8).map((f) => [<code key={f}>{f}</code>]) }}
          confirm={{ label: 'Stash and Update', onClick: stashAndUpdate }}
          alternative={{ label: 'Move to Worktree', onClick: moveAndUpdate }}
          onCancel={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'claude' ? (
        <Alert
          title={dialog.title}
          icon="claude"
          tone="info"
          message={
            <>
              {dialog.message}
              <span className={s.alertNote}>
                {dialog.inMain
                  ? ' Your agent can do it in the main folder: it may only sync git there (fetch, merge or rebase, stash, resolve conflicts), keeps your changes, never pushes, and explains what it did.'
                  : ' Your agent works it out in a worktree of its own, leaves the main folder and your changes alone, never pushes, and tells you the step left, if any.'}
              </span>
            </>
          }
          confirm={{ label: `Let ${agent} Handle It`, onClick: askClaude }}
          onCancel={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'conflicts' ? (
        <Alert
          title="Your changes conflicted with the update"
          icon="alert"
          message={dialog.message}
          {...(dialog.files.length ? { table: { caption: 'Conflicts in', columns: ['File'], rows: dialog.files.slice(0, 8).map((f) => [<code key={f}>{f}</code>]) } } : {})}
          confirm={{ label: `Let ${agent} Handle It`, onClick: askClaude }}
          cancel="I’ll Handle It"
          onCancel={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'fork' ? (
        <Alert
          title={`Your fork and ${original} conflict`}
          icon="claude"
          tone="info"
          message={
            <>
              {dialog.message}
              <span className={s.alertNote}> Your agent merges {original} in, in a worktree of its own, resolves the conflicts, and opens a pull request into your fork’s {fork?.forkBranch ?? branch}. Nothing goes to {original}.</span>
            </>
          }
          confirm={{ label: `Let ${agent} Handle It`, onClick: forkWithClaude }}
          onCancel={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'switch' ? (
        <Alert
          title={`Switch the main folder to ${branch}?`}
          icon="branch"
          message={`It has ${plural(dialog.dirty, 'uncommitted change')} on ${sync.current ?? 'a detached HEAD'}. Move ${sync.current ?? 'that work'} and its changes to a worktree of their own (recommended), or bring the changes along to ${branch}.`}
          confirm={{ label: 'Move to Worktree', onClick: () => switchTo('move') }}
          alternative={{ label: 'Bring Them Along', onClick: () => switchTo('stash') }}
          onCancel={() => setDialog(undefined)}
        />
      ) : null}
    </div>
  );
}
