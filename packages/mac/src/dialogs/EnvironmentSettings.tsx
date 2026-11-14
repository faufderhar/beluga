import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { useMyAgentName } from '../lib/agent-words.js';
import { openSheet } from '../lib/sheets.js';
import { thisComputer } from '../lib/os-words.js';
import { EnvEditor, envErrorText } from './EnvEditor.js';
import { Group, Row, Switch } from './settings-controls.js';
import e from './env-settings.module.css';

export { EnvEditor } from './EnvEditor.js';

/** A switch that saves at once, and goes back if saving fails. */
export function useSaved(initial: boolean | undefined, save: (on: boolean) => Promise<unknown>): [boolean, (on: boolean) => void, string | undefined] {
  const [on, setOn] = useState(initial ?? false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (initial !== undefined) setOn(initial);
  }, [initial]);
  const set = (next: boolean): void => {
    setOn(next);
    setError(undefined);
    save(next).catch((err: unknown) => {
      setOn(!next);
      setError(envErrorText(err));
    });
  };
  return [on, set, error];
}

/** What env.get says for a place, for the groups beside the editor (loaded once each). */
export function useScope(projectId: string): Awaited<ReturnType<ReturnType<typeof useApi>['env']['get']>> | undefined {
  const api = useApi();
  const [scope, setScope] = useState<Awaited<ReturnType<typeof api.env.get>>>();
  useEffect(() => {
    let live = true;
    void api.env.get(projectId || undefined).then((s) => live && setScope(s));
    return () => void (live = false);
  }, [projectId]);
  return scope;
}

/** Your agent and .env files, and the database its views use: for you everywhere, or one project. */
export function EnvAgentGroups({ projectId }: { projectId: string }) {
  const api = useApi();
  const scope = useScope(projectId);
  const [claudeDotenv, setClaudeDotenv, error] = useSaved(scope?.claudeDotenv, (on) => api.env.claudeDotenv(projectId || undefined, on));
  return (
    <>
      <DatabaseTest projectId={projectId} />
      <Group title="Your agent">
        <Row
          label="Read .env files without asking"
          detail={
            error ??
            (projectId
              ? 'In this project, and it gets the .env values too. Off: it asks you each time it wants one. A friend’s request never gets them.'
              : 'In every project. Off: your agent asks you each time (or as each project says). A friend’s request never gets them.')
          }
        >
          <Switch label="Your agent reads .env files without asking" on={claudeDotenv} onChange={setClaudeDotenv} />
        </Row>
      </Group>
    </>
  );
}

/**
 * Whether the database your Claude's views would use here answers: the same lookup they make
 * (DATABASE_URL and the like, or Supabase's variables), so a pass here works for them too.
 */
function DatabaseTest({ projectId }: { projectId: string }) {
  const api = useApi();
  const [result, setResult] = useState<{ ok: true; from: string } | { ok: false; message: string } | 'testing' | undefined>(undefined);
  const test = (): void => {
    setResult('testing');
    api.env.testDatabase(projectId || undefined).then(setResult, (err: unknown) => setResult({ ok: false, message: envErrorText(err) }));
  };
  return (
    <Group title="Database">
      <Row
        label="Postgres for your agent’s views"
        detail={
          result === undefined || result === 'testing'
            ? 'Uses DATABASE_URL (or POSTGRES_URL…), or a Supabase project’s URL and SUPABASE_DB_PASSWORD, from here or the project’s .env.'
            : result.ok
              ? `Connected, using ${result.from}.`
              : result.message
        }
      >
        <Button size="small" icon={result !== undefined && result !== 'testing' && result.ok ? 'check' : undefined} disabled={result === 'testing'} onClick={test}>
          {result === 'testing' ? 'Testing…' : 'Test Connection'}
        </Button>
      </Row>
    </Group>
  );
}

/** Each project, with how many it sets, opening its own Environment (BLG-926). */
function ProjectList() {
  const projects = useApp((st) => st.projects).filter((p) => p.root);
  const envKeys = useApp((st) => st.envKeys);
  if (!projects.length) return null;
  return (
    <Group title="Projects">
      {projects.map((p) => {
        const n = envKeys.projects[p.root]?.keys.length ?? 0;
        const off = envKeys.projects[p.root]?.dotenv === false;
        return (
          <button key={p.id} type="button" className={e.projectRow} onClick={() => openSheet({ kind: 'project_env', projectId: p.id })}>
            <ProjectIcon id={p.id} name={p.name} size={18} />
            <span className={e.projectName}>{p.name}</span>
            <span className={e.muted}>{[n ? `${n} set in Beluga` : '', off ? '.env off' : '.env'].filter(Boolean).join(' · ')}</span>
            <Icon name="chevronRight" size={12} className={e.sourceIcon} />
          </button>
        );
      })}
    </Group>
  );
}

/**
 * Settings › Environment: your variables, given to every shell, setup and run command, and your
 * agent; each project's own (over yours) open from the list below, in its Environment.
 */
export function EnvironmentSettings() {
  const agent = useMyAgentName();
  return (
    <>
      <p className={e.intro}>
        Yours, for every project: given to your shells, setup and run commands, and your {agent}, never to a friend’s request. They stay on {thisComputer()}. A project’s own variables and its .env win over these; open one below to see what it sets.
      </p>
      <EnvEditor projectId="" />
      <ProjectList />
      <EnvAgentGroups projectId="" />
    </>
  );
}
