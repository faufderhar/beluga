import { useMemo, useState } from 'react';
import { repoSlug } from '@beluga/core/issues/model.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button, Empty, EmptyActions, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp } from '../lib/beluga.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { ago } from '../tasks/tasks-model.js';
import { useTasksPrefs } from '../tasks/use-tasks.js';
import { ConnectGitHub } from '../views/project/GitHubRow.js';
import { PullRow, usePulls } from '../views/project/PullRow.js';
import { issuesProject } from './issues-model.js';
import t from '../tasks/tasks.module.css';
import s from './issues.module.css';
import arr from '../lib/arrive.module.css';
import { useLateArrival } from '../lib/last-seen.js';
import { NoProjects } from '../work/NoProjects.js';

/**
 * Pull Requests: one project's open pull requests on GitHub at a time (anyone's, the switcher
 * changes the project), the most recently active first. Each is the row Project Home shows: one
 * on a worktree's branch opens that worktree, any other checks out in a new one or opens on GitHub.
 */
export function PullsView() {
  const view = useApp((st) => st.view);
  const allProjects = useApp((st) => st.projects);
  const projects = useMemo(() => allProjects.filter((p) => p.root && !p.error), [allProjects]);
  const tasksPrefs = useTasksPrefs();
  const actions = useActions();
  const api = useApi();
  const projectId = issuesProject(projects, view.kind === 'pulls' ? view.projectId : undefined, tasksPrefs.project);
  const here = projects.find((p) => p.id === projectId);
  const [connect, setConnect] = useState(false);
  const { list, loading, error, refresh } = usePulls(projectId ?? '');
  // Nothing kept from last time: the list settles in once GitHub answers.
  const late = useLateArrival(projectId ?? '', list !== undefined);

  if (!projects.length || !here || !projectId) return <NoProjects icon="pr" detail="Pull requests come from a project’s GitHub repository. Add a project to see them here." />;

  const repo = list && list.kind !== 'none' ? list.repo : undefined;
  const onGitHub = (url: string): void => actions.openLink({ kind: 'url', url });
  const openList = (id: string): void => actions.run({ type: 'view', view: { kind: 'pulls', projectId: id } });
  return (
    <div className={t.view}>
      <div className={t.bar}>
        <div className={t.barGroup}>
          <PickMenu<string>
            label="Project"
            choices={projects.map((p) => ({ value: p.id, label: p.name, mark: <ProjectIcon id={p.id} name={p.name} size={16} /> }))}
            chosen={[here.id]}
            onPick={openList}
          >
            <button type="button" className={t.projectSwitch} aria-label={`Project: ${here.name}`}>
              <ProjectIcon id={here.id} name={here.name} size={18} />
              <span className={t.projectName}>{here.name}</span>
              <Icon name="chevronDown" size={11} />
            </button>
          </PickMenu>
        </div>
        <div className={cx(t.barGroup, t.barActions)}>
          <IconButton size="small" icon="refresh" label={loading ? 'Asking GitHub…' : 'Ask GitHub Again'} className={cx(loading && s.spinning)} onClick={refresh} disabled={!repo} />
          {repo ? (
            <Tip label={`${repo.url}/pulls`}>
              <Button size="small" icon="external" onClick={() => onGitHub(`${repo.url}/pulls`)}>
                GitHub
              </Button>
            </Tip>
          ) : null}
        </div>
      </div>
      <div className={t.body}>
        {error && !list ? (
          <Empty icon="alert" title="Couldn’t read the pull requests" detail={error} action={<Button size="small" onClick={refresh}>Try Again</Button>} />
        ) : !list ? (
          <Empty icon="pr" title="Asking GitHub…" detail={`For ${here.name}’s pull requests`} />
        ) : list.kind === 'none' ? (
          <Empty icon="pr" title="This project isn’t on GitHub" detail="Pull requests come from the GitHub repository a project’s origin remote points to. Push it to GitHub, or pick another project." />
        ) : list.kind === 'no_gh' ? (
          <Empty
            icon="pr"
            title="Connect GitHub"
            detail={`Beluga reads ${repoSlug(list.repo)}’s pull requests with GitHub’s command-line tool, signed in as you. Set it up once, then check again.`}
            action={
              <EmptyActions>
                <Button size="small" variant="primary" onClick={() => setConnect(true)}>
                  Connect GitHub…
                </Button>
              </EmptyActions>
            }
          />
        ) : list.kind === 'error' ? (
          <Empty icon="alert" title="Couldn’t read the pull requests" detail={list.message} action={<Button size="small" onClick={refresh}>Try Again</Button>} />
        ) : !list.pulls.length ? (
          <Empty icon="pr" title="No open pull requests" detail={`Nothing waiting for review in ${repoSlug(list.repo)}.`} />
        ) : (
          <div className={cx(s.list, late && arr.arrive)} role="list" aria-label={`${here.name}’s open pull requests`}>
            {list.pulls.map((pull) => (
              <PullRow key={pull.number} projectId={projectId} pull={pull} />
            ))}
          </div>
        )}
      </div>
      {list?.kind === 'github' && list.pulls.length ? (
        <div className={t.foot}>
          {list.pulls.length} open · {repoSlug(list.repo)} · from GitHub {ago(list.fetchedAt)}
          {list.total > list.pulls.length ? (
            <>
              {' · the most recently active: '}
              <button type="button" className={t.footLink} onClick={() => onGitHub(`${list.repo.url}/pulls`)}>
                {list.total - list.pulls.length} more on GitHub
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {connect ? (
        <ConnectGitHub
          onClose={() => setConnect(false)}
          onCheck={async () => {
            const now = await api.issues.pulls(projectId, { force: true }).catch(() => undefined);
            refresh();
            return now?.kind === 'github';
          }}
        />
      ) : null}
    </div>
  );
}
