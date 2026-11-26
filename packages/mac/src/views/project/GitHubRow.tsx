import { useEffect, useState } from 'react';
import type { GitHubRepo } from '@beluga/workspaces/github.js';
import type { ActionItem } from '../../components/SpecMenu.js';
import { useApi } from '../../lib/beluga.js';
import type { GitHubInfo } from '@beluga/workspaces/github.js';
import { CommandLine, FormSheet } from '../../components/FormSheet.js';
import { Icon } from '../../components/Icon.js';
import { Button, IconButton, Tip, cx } from '../../components/ui.js';
import { openExternal } from '../../lib/system.js';
import { useGitHub } from '../history/use-history.js';
import s from './main-sync.module.css';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const compact = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The GitHub CLI isn't set up (or can't see this repository): how to set it up, then check again (also Issues'). */
export function ConnectGitHub({ onCheck, onClose }: { onCheck: () => Promise<boolean>; onClose: () => void }) {
  return (
    <FormSheet
      title="Connect GitHub"
      icon="pr"
      intro="Beluga reads a repository’s details (public or private, people, open pull requests) with GitHub’s command-line tool. Set it up once, in Terminal:"
      submitLabel="Check Again"
      onSubmit={async () => ((await onCheck()) ? onClose() : 'Still no answer from GitHub. Run both commands in Terminal (and make sure your account can see this repository), then check again.')}
      onCancel={onClose}
    >
      <div className={s.ghSteps}>
        <div>
          <div className={s.ghStepTitle}>1. Install it <span>· needs Homebrew</span></div>
          <CommandLine command="brew install gh" />
        </div>
        <div>
          <div className={s.ghStepTitle}>2. Sign in to GitHub <span>· it opens your browser</span></div>
          <CommandLine command="gh auth login" />
        </div>
      </div>
    </FormSheet>
  );
}

function Pills({ info, url }: { info: GitHubInfo; url: string }) {
  const visibility = info.visibility === 'private' ? 'Private' : info.visibility === 'internal' ? 'Internal' : 'Public';
  return (
    <>
      <Tip label={info.archived ? `${visibility}, archived` : `${visibility} repository`}>
        <span className={cx(s.ghPill, info.visibility !== 'public' && s.ghPrivate)}>
          <Icon name={info.visibility === 'public' ? 'globe' : 'lock'} size={11} />
          {visibility}
          {info.archived ? ' · archived' : ''}
        </span>
      </Tip>
      {info.people !== undefined ? (
        <Tip label={info.peopleKind === 'collaborators' ? 'People with access to the repository' : 'People who contributed (who has access isn’t visible to you)'}>
          <button type="button" className={s.ghPill} onClick={() => void openExternal(`${url}/${info.peopleKind === 'collaborators' ? 'settings/access' : 'graphs/contributors'}`)}>
            <Icon name="people" size={11} />
            {plural(info.people, info.peopleKind === 'collaborators' ? 'person' : 'contributor').replace('persons', 'people')}
          </button>
        </Tip>
      ) : null}
      {info.openPrs !== undefined ? (
        <Tip label="Open pull requests">
          <button type="button" className={s.ghPill} onClick={() => void openExternal(`${url}/pulls`)}>
            <Icon name="pr" size={11} />
            {info.openPrsMore ? `${info.openPrs}+ open PRs` : plural(info.openPrs, 'open PR')}
          </button>
        </Tip>
      ) : null}
      <Tip label={`${plural(info.stars, 'star')} · ${plural(info.forks, 'fork')} · ${plural(info.openIssues, 'open issue')}`}>
        <span className={s.ghPill}>★ {compact(info.stars)}</span>
      </Tip>
    </>
  );
}

/** The project's GitHub page and what GitHub says about it, in a row of pills (hidden for other remotes). */
export function GitHubRow({ projectId }: { projectId: string }) {
  const { state, refresh, loading } = useGitHub(projectId);
  const [connect, setConnect] = useState(false);
  if (state?.kind !== 'github') return null;
  const { repo, info } = state;
  return (
    <div className={s.ghRow} role="group" aria-label="GitHub">
      <Tip label={repo.url}>
        <Button size="small" icon="external" onClick={() => void openExternal(repo.url)}>
          GitHub
        </Button>
      </Tip>
      {info ? (
        <Pills info={info} url={repo.url} />
      ) : (
        <button type="button" className={s.link} onClick={() => setConnect(true)}>
          Connect GitHub for details…
        </button>
      )}
      {info ? <IconButton size="small" icon="refresh" label={loading ? 'Asking GitHub…' : 'Ask GitHub again'} className={cx(s.ghRefresh, loading && s.spinning)} onClick={() => void refresh()} /> : null}
      {connect ? (
        <ConnectGitHub
          onClose={() => setConnect(false)}
          onCheck={async () => {
            const now = await refresh();
            return now?.kind === 'github' && Boolean(now.info);
          }}
        />
      ) : null}
    </div>
  );
}

const repos = new Map<string, Promise<GitHubRepo | undefined>>();

/** "Open on GitHub" for a project's menu (only when its remote is on GitHub; read from the remote, no network). */
export function useGitHubMenuItems(projectId: string, hasRoot: boolean): ActionItem[] {
  const api = useApi();
  const [repo, setRepo] = useState<GitHubRepo>();
  useEffect(() => {
    if (!hasRoot) return;
    let alive = true;
    const job = repos.get(projectId) ?? api.git.githubRepo(projectId);
    repos.set(projectId, job);
    job.then(
      (r) => alive && setRepo(r ?? undefined),
      () => repos.delete(projectId),
    );
    return () => {
      alive = false;
    };
  }, [projectId, hasRoot]);
  return repo ? [{ label: 'Open on GitHub', icon: 'external', hint: repo.url, onSelect: () => void openExternal(repo.url) }] : [];
}
