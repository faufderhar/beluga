import { useEffect, useState } from 'react';
import type { EnvOverview } from '@beluga/core/env-vars.js';
import { Icon } from '../../components/Icon.js';
import { Button } from '../../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { openSheet } from '../../lib/sheets.js';
import { sameDeep } from '../../lib/stable.js';
import { ProjectEnvAsks } from './EnvAsks.js';
import { Section } from './HomeSection.js';
import s from '../project-home.module.css';

/** How many rows the section shows before Open Environment. */
const HOME_ENV = 3;

const names = (keys: readonly string[], max = 3): string => keys.slice(0, max).join(', ') + (keys.length > max ? ` and ${keys.length - max} more` : '');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A project's environment in names and counts, again whenever its names (or a worktree's) change. */
function useOverview(projectId: string, root: string): EnvOverview | undefined {
  const api = useApi();
  const keys = useApp((st) => [st.envKeys.projects[root], st.envKeys.global.length, st.envKeys.worktrees], sameDeep);
  const asks = useApp((st) => Object.keys(st.envAsks).length);
  const [overview, setOverview] = useState<EnvOverview>();
  const [again, setAgain] = useState(0);
  useEffect(() => {
    let live = true;
    api.env.overview(projectId).then(
      (o) => live && setOverview(o),
      () => live && setOverview(undefined),
    );
    return () => void (live = false);
  }, [projectId, keys, asks, again]);
  // Looked at again when the window comes back (a .env edited in another app meanwhile).
  useEffect(() => {
    const look = (): void => setAgain((n) => n + 1);
    window.addEventListener('focus', look);
    return () => window.removeEventListener('focus', look);
  }, []);
  return overview;
}

interface EnvLine {
  readonly id: string;
  readonly icon: 'alert' | 'file' | 'branch';
  readonly title: string;
  readonly detail: string;
  readonly open: () => void;
  readonly action?: { readonly label: string; readonly run: () => void };
}

/**
 * Project Home's Environment (BLG-926): what needs you first (names .env.example asks for that
 * nothing sets, worktrees that changed a .env or set their own; names it doesn't list only when
 * worktrees don't keep it in step), then a line of counts. Names only, never a value. Nothing to
 * show: no section.
 */
export function EnvSection({ projectId, root }: { projectId: string; root: string }) {
  const api = useApi();
  const { client } = useBeluga();
  const overview = useOverview(projectId, root);
  const hasAsks = useApp((st) => {
    const ws = st.projects.find((p) => p.id === projectId)?.workspaces ?? [];
    return ws.some((w) => st.envAsks[w.id]?.length) || (st.envSends ?? []).some((a) => a.projectId === projectId);
  });
  if (!overview) return null;
  const openEnv = (): void => openSheet({ kind: 'project_env', projectId });
  const example = overview.example;
  const lines: EnvLine[] = [
    ...(example?.missing.length
      ? [{ id: 'missing', icon: 'alert' as const, title: `${plural(example.missing.length, 'variable')} ${example.file ?? '.env.example'} asks for ${example.missing.length === 1 ? 'isn’t' : 'aren’t'} set`, detail: names(example.missing), open: openEnv }]
      : []),
    // Kept in step by the worktrees (the default), what it doesn't list is mended with the next one's work: nothing to do here.
    ...(example?.unlisted.length && !overview.exampleSync
      ? [
          {
            id: 'unlisted',
            icon: 'file' as const,
            title: example.file ? `${example.file} doesn’t list ${plural(example.unlisted.length, 'variable')}` : 'No .env.example yet',
            detail: example.file ? names(example.unlisted) : `So a new teammate knows what to set: ${names(example.unlisted)}`,
            open: openEnv,
            action: {
              label: example.file ? `Add to ${example.file}` : 'Create .env.example',
              run: () =>
                api.env.addToExample(projectId).then(
                  (added) => toast(client, added.length ? `Added ${names(added, 4)} to ${example.file ?? '.env.example'} with placeholders. Commit it from the main folder.` : 'It lists them all already', 'success'),
                  (err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'),
                ),
            },
          },
        ]
      : []),
    ...overview.worktrees.map((w) => ({ id: `wt:${w.id}`, icon: 'branch' as const, title: `${w.name} sets ${plural(w.keys.length, 'variable')} of its own`, detail: `${names(w.keys)}, over the project’s, in that worktree only`, open: () => openSheet({ kind: 'worktree_env', workspaceId: w.id }) })),
  ];
  const total = overview.own + (overview.dotenvOn ? overview.dotenv : 0);
  if (!lines.length && !hasAsks && !total) return null;
  const summary = [
    overview.dotenvOn ? `${plural(overview.dotenv, 'variable')} from ${overview.dotenvFiles.length ? overview.dotenvFiles.join(' and ') : '.env'}` : '.env off',
    overview.own ? `${overview.own} set in Beluga` : '',
    overview.everywhere ? `${overview.everywhere} of yours` : '',
  ].filter(Boolean).join(' · ');
  return (
    <Section
      title="Environment"
      count={total}
      hint={summary}
      action={
        <Button size="small" variant="quiet" icon="lock" onClick={openEnv}>
          Open Environment
        </Button>
      }
    >
      {hasAsks ? (
        <div role="listitem" className={s.envAsks}>
          <ProjectEnvAsks projectId={projectId} />
        </div>
      ) : null}
      {lines.slice(0, HOME_ENV).map((line) => (
        <div key={line.id} role="listitem" className={s.envLine}>
          <button type="button" className={s.row} onClick={line.open} aria-label={line.title}>
            <span className={s.rowIcon}>
              <Icon name={line.icon} size={13} />
            </span>
            <span className={s.rowMain}>
              <span className={s.rowTitle}>
                <span className={s.rowName}>{line.title}</span>
              </span>
              <span className={s.rowLast}>{line.detail}</span>
            </span>
            {line.action ? null : <Icon name="chevronRight" size={11} className={s.rowChevron} />}
          </button>
          {line.action ? (
            <Button size="small" variant="quiet" onClick={line.action.run}>
              {line.action.label}
            </Button>
          ) : null}
        </div>
      ))}
      {lines.length > HOME_ENV ? (
        <button type="button" className={s.more} onClick={openEnv}>
          {plural(lines.length - HOME_ENV, 'more thing')} in Environment
        </button>
      ) : null}
      {!lines.length && !hasAsks ? <p className={s.none}>All set.</p> : null}
    </Section>
  );
}
