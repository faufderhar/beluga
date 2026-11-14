import { Icon } from '../components/Icon.js';
import { useApi, useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { useSaved, useScope } from './EnvironmentSettings.js';
import { Group, Row, Switch } from './settings-controls.js';
import e from './env-settings.module.css';

/**
 * A project's worktrees and its env: new keys back to the main folder, .env.example kept in step
 * by each worktree (caught up when it's made, then what it adds or removes; BLG-925), and the worktrees with variables of their own (BLG-924).
 */
export function EnvWorktreeGroups({ projectId }: { projectId: string }) {
  const api = useApi();
  const scope = useScope(projectId);
  const [newKeysBack, setNewKeysBack, backError] = useSaved(scope?.newKeysBack, (on) => api.env.newKeysBack(projectId, on));
  const [exampleSync, setExampleSync, exampleError] = useSaved(scope?.exampleSync, (on) => api.env.exampleSync(projectId, on));
  const own = useApp((st) => {
    const p = st.projects.find((x) => x.id === projectId);
    return (p?.workspaces ?? []).filter((w) => w.kind === 'worktree' && !w.archived && st.envKeys.worktrees?.[w.id]?.length).map((w) => ({ id: w.id, name: w.name, count: st.envKeys.worktrees![w.id]!.length }));
  }, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  return (
    <>
      <Group title="Worktrees">
        <Row label="New keys go to the main folder" detail={backError ?? 'A key a worktree adds to its .env (one the main folder doesn’t have) is added there too, so the next worktree works. A changed value is asked about: copy it there, or save it in Beluga.'}>
          <Switch label="New keys from worktrees go to the main folder's .env" on={newKeysBack} onChange={setNewKeysBack} />
        </Row>
        <Row label="Keep .env.example in step" detail={exampleError ?? 'Each worktree lists its .env names in its own .env.example, with placeholders instead of values, so it goes out with that work. The main folder’s is never changed.'}>
          <Switch label="Keep .env.example in step with worktrees' .env" on={exampleSync} onChange={setExampleSync} />
        </Row>
      </Group>
      <Group title="Set for one worktree">
        {own.length ? (
          own.map((w) => (
            <button key={w.id} type="button" className={e.projectRow} onClick={() => openSheet({ kind: 'worktree_env', workspaceId: w.id })}>
              <Icon name="branch" size={13} className={e.sourceIcon} />
              <span className={e.projectName}>{w.name}</span>
              <span className={e.muted}>{w.count === 1 ? '1 variable' : `${w.count} variables`}</span>
              <Icon name="chevronRight" size={12} className={e.sourceIcon} />
            </button>
          ))
        ) : (
          <div className={e.empty}>None. A worktree’s ••• › Environment… sets variables for it alone, over the project’s.</div>
        )}
      </Group>
    </>
  );
}
