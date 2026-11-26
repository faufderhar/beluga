import { useEffect, useMemo, useRef, useState } from 'react';
import type { GhIssueState } from '@beluga/core/issues/model.js';
import { repoSlug } from '@beluga/core/issues/model.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button, Empty, EmptyActions, IconButton, Segmented, Tip, cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { currentSheet } from '../lib/sheets.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { ago } from '../tasks/tasks-model.js';
import { useTasksPrefs } from '../tasks/use-tasks.js';
import { ConnectGitHub } from '../views/project/GitHubRow.js';
import { issuesProject, searchWords } from './issues-model.js';
import { IssueRow } from './parts.js';
import { setIssuesPrefs, useIssueActions, useIssueList, useIssuesPrefs } from './use-issues.js';
import t from '../tasks/tasks.module.css';
import s from './issues.module.css';
import arr from '../lib/arrive.module.css';
import { useLateArrival } from '../lib/last-seen.js';
import { NoProjects } from '../work/NoProjects.js';
import { primaryKey } from '../lib/shortcuts-model.js';

const STATES: ReadonlyArray<{ readonly value: GhIssueState; readonly label: string; readonly hint: string }> = [
  { value: 'open', label: 'Open', hint: 'Issues still open on GitHub' },
  { value: 'closed', label: 'Closed', hint: 'Fixed, or closed for another reason' },
];

/**
 * Issues: one project's GitHub issues at a time (the one you're in; the switcher changes it),
 * open or closed, newest activity first; the search box asks GitHub ("login 500", "label:bug").
 * Each shows what Beluga is doing about it. An issue opens into its page, where Claude can
 * investigate it, fix it, or put it on the board; right-click does the same from here.
 */
export function IssuesView() {
  const view = useApp((st) => st.view);
  const allProjects = useApp((st) => st.projects);
  const projects = useMemo(() => allProjects.filter((p) => p.root && !p.error), [allProjects]);
  const tasksPrefs = useTasksPrefs();
  const prefs = useIssuesPrefs();
  const { openList, openOnGitHub } = useIssueActions();
  const api = useApi();
  const projectId = issuesProject(projects, view.kind === 'issues' ? view.projectId : undefined, tasksPrefs.project);
  const here = projects.find((p) => p.id === projectId);
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [connect, setConnect] = useState(false);
  const find = useRef<HTMLInputElement>(null);
  const { list, loading, error, refresh } = useIssueList(projectId, prefs.state, search);
  // Nothing kept from last time: the list settles in once GitHub answers.
  const late = useLateArrival(projectId ?? '', list !== undefined);

  // GitHub is asked once typing pauses.
  useEffect(() => {
    const words = searchWords(typed);
    if (words === search) return;
    const timer = setTimeout(() => setSearch(words), 450);
    return () => clearTimeout(timer);
  }, [typed, search]);
  // Another project: a fresh search.
  useEffect(() => {
    setTyped('');
    setSearch('');
  }, [projectId]);
  // ⌘F searches.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || currentSheet() || !primaryKey(e) || e.key.toLowerCase() !== 'f') return;
      e.preventDefault();
      find.current?.focus();
      find.current?.select();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!projects.length || !here || !projectId) return <NoProjects icon="issue" detail="Issues come from a project’s GitHub repository. Add a project to see them here." />;

  const repo = list && list.kind !== 'none' ? list.repo : undefined;
  return (
    <div className={t.view}>
      <div className={t.bar}>
        <div className={t.barGroup}>
          <PickMenu<string>
            label="Project"
            choices={projects.map((p) => ({ value: p.id, label: p.name, mark: <ProjectIcon id={p.id} name={p.name} size={16} /> }))}
            chosen={[here.id]}
            onPick={(id) => openList(id)}
          >
            <button type="button" className={t.projectSwitch} aria-label={`Project: ${here.name}`}>
              <ProjectIcon id={here.id} name={here.name} size={18} />
              <span className={t.projectName}>{here.name}</span>
              <Icon name="chevronDown" size={11} />
            </button>
          </PickMenu>
          <Segmented<GhIssueState> size="small" label="Show" value={prefs.state} onChange={(state) => setIssuesPrefs({ state })} options={STATES} />
        </div>
        <div className={cx(t.barGroup, t.barActions)}>
          <label className={cx(t.find, s.find)}>
            <Icon name="search" size={12} />
            <input
              ref={find}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Search issues"
              aria-label="Search issues on GitHub"
              onKeyDown={(e) => {
                if (e.key === 'Enter') setSearch(searchWords(typed));
                if (e.key === 'Escape') (setTyped(''), setSearch(''), (e.target as HTMLInputElement).blur());
              }}
            />
            {typed ? (
              <button type="button" className={t.findClear} aria-label="Clear the search" onClick={() => (setTyped(''), setSearch(''))}>
                <Icon name="x" size={10} />
              </button>
            ) : null}
          </label>
          <IconButton size="small" icon="refresh" label={loading ? 'Asking GitHub…' : 'Ask GitHub Again'} className={cx(loading && s.spinning)} onClick={refresh} disabled={!repo} />
          {repo ? (
            <Tip label={`${repo.url}/issues`}>
              <Button size="small" icon="external" onClick={() => openOnGitHub(`${repo.url}/issues`)}>
                GitHub
              </Button>
            </Tip>
          ) : null}
        </div>
      </div>
      <div className={t.body}>
        {error ? (
          <Empty icon="alert" title="Couldn’t read the issues" detail={error} action={<Button size="small" onClick={refresh}>Try Again</Button>} />
        ) : !list ? (
          <Empty icon="issue" title="Asking GitHub…" detail={`For ${here.name}’s issues`} />
        ) : list.kind === 'none' ? (
          <Empty icon="issue" title="This project isn’t on GitHub" detail="Issues come from the GitHub repository a project’s origin remote points to. Push it to GitHub, or pick another project." />
        ) : list.kind === 'no_gh' ? (
          <Empty
            icon="issue"
            title="Connect GitHub"
            detail={`Beluga reads ${repoSlug(list.repo)}’s issues with GitHub’s command-line tool, signed in as you. Set it up once, then check again.`}
            action={
              <EmptyActions>
                <Button size="small" variant="primary" onClick={() => setConnect(true)}>
                  Connect GitHub…
                </Button>
              </EmptyActions>
            }
          />
        ) : list.kind === 'error' ? (
          <Empty icon="alert" title="Couldn’t read the issues" detail={list.message} action={<Button size="small" onClick={refresh}>Try Again</Button>} />
        ) : !list.issues.length ? (
          <Empty
            icon={prefs.state === 'open' && !search ? 'task' : 'issue'}
            title={search ? 'Nothing matches' : prefs.state === 'open' ? 'No open issues' : 'No closed issues'}
            detail={search ? 'Try other words, or the other tab.' : prefs.state === 'open' ? `Nothing waiting in ${repoSlug(list.repo)}.` : `Nothing closed in ${repoSlug(list.repo)} yet.`}
          />
        ) : (
          <div className={cx(s.list, late && arr.arrive)} role="table" aria-label={`${here.name}’s ${prefs.state} issues`}>
            {list.issues.map((issue) => (
              <IssueRow key={issue.number} projectId={projectId} repo={list.repo} issue={issue} />
            ))}
          </div>
        )}
      </div>
      {list?.kind === 'github' && list.issues.length ? (
        <div className={t.foot}>
          {list.issues.length}
          {list.more ? '+' : ''} {prefs.state} · {repoSlug(list.repo)} · from GitHub {ago(list.fetchedAt)}
          {list.more ? ' · the most recently updated: search to find others' : ''}
        </div>
      ) : null}
      {connect ? (
        <ConnectGitHub
          onClose={() => setConnect(false)}
          onCheck={async () => {
            const now = await api.issues.list(projectId, { state: prefs.state, force: true }).catch(() => undefined);
            refresh();
            return now?.kind === 'github';
          }}
        />
      ) : null}
    </div>
  );
}
