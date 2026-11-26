import { useEffect, useMemo, useState } from 'react';
import type { GhRun, GhWorkflow } from '@beluga/core/ci/model.js';
import { fileName, isLive, runTone, sortRuns, statusWords } from '@beluga/core/ci/model.js';
import { repoSlug } from '@beluga/core/issues/model.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { CodeLines } from '../components/markdown/CodeLines.js';
import { Button, Empty, EmptyActions, IconButton, Segmented, Tip, cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { ago } from '../tasks/tasks-model.js';
import { useTasksPrefs } from '../tasks/use-tasks.js';
import { issuesProject } from '../issues/issues-model.js';
import { ConnectGitHub } from '../views/project/GitHubRow.js';
import { RunMark, RunRow } from './parts.js';
import { useCiActions, useRuns, useWorkflows } from './use-ci.js';
import { NowText, Ticking } from './now.js';
import { WorkflowGraph } from './WorkflowGraph.js';
import t from '../tasks/tasks.module.css';
import s from './ci.module.css';
import arr from '../lib/arrive.module.css';
import { useLateArrival } from '../lib/last-seen.js';
import { NoProjects } from '../work/NoProjects.js';

type Page = 'runs' | 'workflows';

const PAGES: ReadonlyArray<{ readonly value: Page; readonly label: string; readonly hint: string; readonly icon: 'pulse' | 'graph' }> = [
  { value: 'runs', label: 'Runs', hint: 'The latest workflow runs, live while they run', icon: 'pulse' },
  { value: 'workflows', label: 'Workflows', hint: 'Each workflow file as a graph: what starts it, its jobs, what needs what', icon: 'graph' },
];

/**
 * Actions: one project's GitHub Actions at a time (the switcher changes it). Runs: the latest,
 * running ones on top, every few seconds while one runs; a workflow narrows them. Workflows: each
 * file drawn as a graph, with how its last run went. A run opens into its page.
 */
export function ActionsView() {
  const view = useApp((st) => st.view);
  const allProjects = useApp((st) => st.projects);
  const projects = useMemo(() => allProjects.filter((p) => p.root && !p.error), [allProjects]);
  const tasksPrefs = useTasksPrefs();
  const { openList, openOnGitHub } = useCiActions();
  const api = useApi();
  const projectId = issuesProject(projects, view.kind === 'actions' ? view.projectId : undefined, tasksPrefs.project);
  const page: Page = view.kind === 'actions' && view.page === 'workflows' ? 'workflows' : 'runs';
  const here = projects.find((p) => p.id === projectId);
  const [workflow, setWorkflow] = useState('');
  const [connect, setConnect] = useState(false);
  useEffect(() => setWorkflow(''), [projectId]);
  const { list, loading, error, refresh } = useRuns(projectId, workflow ? { workflow } : {});
  // Nothing kept from last time: the list settles in once GitHub answers.
  const late = useLateArrival(projectId ?? '', list !== undefined);
  // The workflows: the Workflows page, and the Runs page's filter.
  const flows = useWorkflows(projectId);
  const runs = useMemo(() => (list?.kind === 'github' ? sortRuns(list.runs) : []), [list]);
  const live = runs.some(isLive);

  // The clock sits in Ticking (in both returns, so it's the same one): only the time text is drawn again each second.
  if (!projects.length || !here || !projectId)
    return (
      <Ticking live={live}>
        <NoProjects icon="pulse" detail="Actions come from a project’s GitHub repository. Add a project to see them here." />
      </Ticking>
    );

  const repo = list && list.kind !== 'none' ? list.repo : undefined;
  const known = flows.data?.workflows ?? [];
  const named = (path: string): string => known.find((f) => f.path === path)?.name ?? fileName(path);
  return (
    <Ticking live={live}>
      <div className={t.view}>
        <div className={t.bar}>
          <div className={t.barGroup}>
            <PickMenu<string>
              label="Project"
              choices={projects.map((p) => ({ value: p.id, label: p.name, mark: <ProjectIcon id={p.id} name={p.name} size={16} /> }))}
              chosen={[here.id]}
              onPick={(id) => openList(id, page === 'workflows' ? 'workflows' : undefined)}
            >
              <button type="button" className={t.projectSwitch} aria-label={`Project: ${here.name}`}>
                <ProjectIcon id={here.id} name={here.name} size={18} />
                <span className={t.projectName}>{here.name}</span>
                <Icon name="chevronDown" size={11} />
              </button>
            </PickMenu>
            <Segmented<Page> size="small" label="Show" value={page} onChange={(p) => openList(projectId, p === 'workflows' ? 'workflows' : undefined)} options={PAGES} />
            {page === 'runs' && known.length + (workflow ? 1 : 0) > 1 ? (
              <PickMenu<string>
                label="Workflow"
                choices={[{ value: '', label: 'All Workflows' }, ...known.filter((f) => f.id).map((f) => ({ value: f.path, label: f.name, hint: fileName(f.path) }))]}
                chosen={[workflow]}
                onPick={setWorkflow}
              >
                <button type="button" className={s.filter} aria-label="Workflow">
                  <Icon name="graph" size={12} />
                  {workflow ? named(workflow) : 'All Workflows'}
                  <Icon name="chevronDown" size={10} />
                </button>
              </PickMenu>
            ) : null}
          </div>
          <div className={cx(t.barGroup, t.barActions)}>
            {live ? (
              <span className={s.liveTag}>
                <span className={s.liveDot} aria-hidden="true" />
                Live
              </span>
            ) : null}
            <IconButton size="small" icon="refresh" label={loading || flows.loading ? 'Asking GitHub…' : 'Ask GitHub Again'} className={cx((loading || flows.loading) && s.spinning)} onClick={() => (refresh(), flows.refresh())} disabled={!repo} />
            {repo ? (
              <Tip label={`${repo.url}/actions`}>
                <Button size="small" icon="external" onClick={() => openOnGitHub(`${repo.url}/actions`)}>
                  GitHub
                </Button>
              </Tip>
            ) : null}
          </div>
        </div>
        <div className={t.body}>
          {error && !list ? (
            <Empty icon="alert" title="Couldn’t read the runs" detail={error} action={<Button size="small" onClick={refresh}>Try Again</Button>} />
          ) : !list ? (
            <Empty icon="pulse" title="Asking GitHub…" detail={`For ${here.name}’s workflow runs`} />
          ) : list.kind === 'none' ? (
            <Empty icon="pulse" title="This project isn’t on GitHub" detail="Actions come from the GitHub repository a project’s origin remote points to. Push it to GitHub, or pick another project." />
          ) : list.kind === 'no_gh' ? (
            <Empty
              icon="pulse"
              title="Connect GitHub"
              detail={`Beluga reads ${repoSlug(list.repo)}’s Actions with GitHub’s command-line tool, signed in as you. Set it up once, then check again.`}
              action={
                <EmptyActions>
                  <Button size="small" variant="primary" onClick={() => setConnect(true)}>
                    Connect GitHub…
                  </Button>
                </EmptyActions>
              }
            />
          ) : list.kind === 'error' ? (
            <Empty icon="alert" title="Couldn’t read the runs" detail={list.message} action={<Button size="small" onClick={refresh}>Try Again</Button>} />
          ) : page === 'workflows' ? (
            <Workflows projectId={projectId} flows={flows} runs={runs} />
          ) : !runs.length ? (
            <Empty icon="pulse" title={workflow ? 'No runs of this workflow yet' : 'No runs yet'} detail={workflow ? 'Pick another workflow, or All Workflows.' : `Nothing has run in ${repoSlug(list.repo)}. Add a workflow under .github/workflows and push it.`} />
          ) : (
            <div className={cx(s.list, late && arr.arrive)} role="table" aria-label={`${here.name}’s workflow runs`}>
              {runs.map((run) => (
                <RunRow key={run.id} projectId={projectId} run={run} />
              ))}
            </div>
          )}
        </div>
        {list?.kind === 'github' && runs.length && page === 'runs' ? (
          <div className={t.foot}>
            {runs.filter(isLive).length ? `${runs.filter(isLive).length} running · ` : ''}
            {runs.length}
            {list.more ? '+' : ''} runs · {repoSlug(list.repo)} · from GitHub <NowText>{(now) => ago(list.fetchedAt, now)}</NowText>
            {live ? ' · watching, every few seconds' : ''}
          </div>
        ) : null}
        {connect ? (
          <ConnectGitHub
            onClose={() => setConnect(false)}
            onCheck={async () => {
              const got = await api.ci.runs(projectId, { force: true }).catch(() => undefined);
              refresh();
              return got?.kind === 'github';
            }}
          />
        ) : null}
      </div>
    </Ticking>
  );
}

/** Each workflow as a card: its name and file, how its last run went, and its graph (or its YAML). */
function Workflows({ projectId, flows, runs }: { projectId: string; flows: ReturnType<typeof useWorkflows>; runs: readonly GhRun[] }) {
  const late = useLateArrival(projectId, flows.data !== undefined);
  if (flows.error && !flows.data) return <Empty icon="alert" title="Couldn’t read the workflows" detail={flows.error} action={<Button size="small" onClick={flows.refresh}>Try Again</Button>} />;
  if (!flows.data) return <Empty icon="graph" title="Reading the workflows…" detail="From the project’s folder, and GitHub" />;
  const list = flows.data.workflows;
  if (!list.length) return <Empty icon="graph" title="No workflows yet" detail="Workflows live in .github/workflows. Ask your agent to set one up, then push it." />;
  return (
    <div className={cx(s.flows, late && arr.arrive)}>
      {list.map((f) => (
        <WorkflowCard key={f.path} projectId={projectId} flow={f} last={runs.find((r) => r.path === f.path)} />
      ))}
    </div>
  );
}

function WorkflowCard({ projectId, flow, last }: { projectId: string; flow: GhWorkflow; last?: GhRun }) {
  const { openRun, openOnGitHub } = useCiActions();
  const [yamlShown, setYamlShown] = useState(false);
  const off = flow.state !== 'active' && flow.state !== 'not_pushed';
  return (
    <section className={s.flow} aria-label={flow.name}>
      <header className={s.flowHead}>
        <span className={s.flowName}>{flow.name}</span>
        <span className={s.flowPath}>{flow.path}</span>
        {flow.state === 'not_pushed' ? <span className={s.badge}>Not pushed yet</span> : off ? <span className={s.badge}>Turned off</span> : null}
        <span className={t.grow} />
        {last ? (
          <Tip label={`Last run: ${statusWords(last)}, ${ago(last.createdAt)}`}>
            <button type="button" className={s.flowLast} onClick={() => openRun(projectId, last.id)}>
              <RunMark tone={runTone(last)} size={14} />
              <span className={s.flowLastTitle}>{last.title}</span>
              <span className={s.when}>{ago(last.createdAt)}</span>
            </button>
          </Tip>
        ) : null}
        <Segmented<'graph' | 'yaml'> size="small"
          label="Show as"
          iconOnly
          value={yamlShown ? 'yaml' : 'graph'}
          onChange={(v) => setYamlShown(v === 'yaml')}
          options={[
            { value: 'graph', label: 'Graph', icon: 'graph' },
            { value: 'yaml', label: 'YAML', icon: 'file' },
          ]}
        />
        {flow.url ? <IconButton size="small" icon="external" label="Open on GitHub" onClick={() => openOnGitHub(flow.url)} /> : null}
      </header>
      {flow.file === undefined ? (
        <p className={s.graphNote}>GitHub didn’t give Beluga this file.</p>
      ) : yamlShown ? (
        <div className={s.yaml}>
          <CodeLines text={flow.file} lang="yaml" />
        </div>
      ) : (
        <WorkflowGraph text={flow.file} path={flow.path} title={flow.name} />
      )}
    </section>
  );
}
