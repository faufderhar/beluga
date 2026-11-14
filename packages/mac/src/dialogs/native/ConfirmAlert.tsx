import { useEffect, useState } from 'react';
import type { ArchivePreview } from '@beluga/workspaces/archive.js';
import { formatBytes } from '@beluga/shared/format.js';
import type { EnvChange } from '@beluga/workspaces/env.js';
import type { DeletePlan } from '@beluga/workspaces/types.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Alert, Checkbox } from '../../components/Alert.js';
import { useApi, useApp } from '../../lib/beluga.js';
import type { NativeMenuProps } from './index.js';
import { count, usePick } from './pick.js';
import { useThreadsChoice } from './ThreadsChoice.js';
import s from './menus.module.css';

const NO_ENV: readonly EnvChange[] = [];
const NO_KEYS: readonly string[] = [];

/** The keys that differ in one env file, as small tags: +NEW, ~CHANGED, −REMOVED. */
export function EnvKeys({ change }: { change: EnvChange }) {
  if (change.binary) return <span className={s.muted}>the file differs</span>;
  return (
    <span className={s.keys}>
      {change.added.map((k) => (
        <span key={`+${k}`} className={s.keyAdded} title="Added in this worktree">
          +{k}
        </span>
      ))}
      {change.changed.map((k) => (
        <span key={`~${k}`} className={s.keyChanged} title="Changed in this worktree">
          ~{k}
        </span>
      ))}
      {change.removed.map((k) => (
        <span key={`-${k}`} className={s.keyRemoved} title="Removed in this worktree">
          −{k}
        </span>
      ))}
    </span>
  );
}

/** What archiving a worktree would clear (asked once the dialog opens; undefined until then). */
function useArchivePlan(id: string, worktree: boolean): ArchivePreview | undefined {
  const api = useApi();
  const [plan, setPlan] = useState<ArchivePreview | undefined>();
  useEffect(() => {
    if (!worktree) return;
    let live = true;
    api.workspaces.archivePlan(id).then(
      (p) => live && setPlan(p ?? undefined),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id, worktree]);
  return plan;
}

/** How long Delete waits on the unpushed-commits check before letting you choose anyway: a busy Beluga can answer very late. */
export const DELETE_CHECK_MS = 10_000;

/**
 * What deleting a worktree would lose that archiving keeps: `null` once asked and there's nothing,
 * undefined while asking, `'late'` when no answer came within DELETE_CHECK_MS (an answer after that
 * still replaces it).
 */
function useDeletePlan(id: string, worktree: boolean): DeletePlan | null | undefined | 'late' {
  const api = useApi();
  const [plan, setPlan] = useState<DeletePlan | null | undefined | 'late'>(worktree ? undefined : null);
  useEffect(() => {
    if (!worktree) return;
    let live = true;
    const timer = setTimeout(() => live && setPlan((p) => (p === undefined ? 'late' : p)), DELETE_CHECK_MS);
    api.workspaces.deletePlan(id).then(
      (p) => live && setPlan(p ?? null),
      () => live && setPlan(null),
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, worktree]);
  return plan;
}

/**
 * Archive or delete a workspace: what happens, in a sentence; archiving keeps everything of
 * yours (uncommitted work too) and says how much space it frees; env changes the main folder
 * doesn't have are listed and copied back if you like.
 */
export function ConfirmAlert({ menu, close }: NativeMenuProps<'confirm'>) {
  const api = useApi();
  const threads = useThreadsChoice(menu.id, menu.action);
  const pick = usePick(threads.children ? { ...menu, children: threads.children } : menu);
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  const env = useApp((st) => st.envChanges[menu.id] ?? NO_ENV);
  // Variables set for this worktree alone (BLG-924): carried to the project unless you untick it.
  const ownVars = useApp((st) => st.envKeys.worktrees?.[menu.id] ?? NO_KEYS);
  const projectName = useApp((st) => st.projects.find((p) => p.id === ws?.projectId)?.name ?? 'the project');
  const [copyEnv, setCopyEnv] = useState(true);
  const [saveEnv, setSaveEnv] = useState(false);
  const [carry, setCarry] = useState(true);
  const [removeToo, setRemoveToo] = useState(false);
  const plan = useArchivePlan(menu.id, menu.action !== 'delete' && ws?.kind === 'worktree' && !ws.archived);
  const lose = useDeletePlan(menu.id, menu.action === 'delete' && ws?.kind === 'worktree' && !ws.external);
  if (!ws) return null;
  const changed = ws.status?.changed ?? 0;
  const table = env.length
    ? {
        caption: 'Env changes the main folder doesn’t have',
        columns: ['File', 'Keys'],
        rows: env.map((c) => [<code key="f">{c.file}</code>, <EnvKeys key="k" change={c} />]),
      }
    : undefined;
  const removed = env.flatMap((c) => c.removed);
  // Where its env changes go before it does: the main folder's file, Beluga, both, or nowhere (BLG-369),
  // and its own variables to the project's (BLG-924), so nothing it worked out is lost.
  const envBox =
    env.length || ownVars.length ? (
      <>
        {ownVars.length ? <Checkbox checked={carry} onChange={setCarry} label={`Carry its ${ownVars.length === 1 ? 'variable' : `${ownVars.length} variables`} to ${projectName}`} detail={`${ownVars.slice(0, 4).join(', ')}${ownVars.length > 4 ? '…' : ''}: set for this worktree only. ${projectName}’s own get them (same name: this worktree’s wins)`} /> : null}
        {env.length ? <Checkbox checked={copyEnv} onChange={setCopyEnv} label="Copy its .env changes into the main folder’s .env" detail="Added and changed keys: every new worktree starts with them" /> : null}
        {env.length && copyEnv && removed.length ? <Checkbox checked={removeToo} onChange={setRemoveToo} label={`Also remove ${removed.slice(0, 3).join(', ')}${removed.length > 3 ? '…' : ''} there`} detail="Taken out in this worktree. Off: the main folder keeps them" /> : null}
        {env.length ? <Checkbox checked={saveEnv} onChange={setSaveEnv} label="Save its .env changes in Beluga" detail="The project’s own variables: every run gets them, and the file stays as it is" /> : null}
      </>
    ) : null;
  const boxes =
    envBox || threads.box ? (
      <>
        {threads.box}
        {envBox}
      </>
    ) : null;
  const withEnv = copyEnv && env.length > 0;
  const all = withEnv && removeToo && removed.length ? '-all' : '';
  /** Carry its variables and save in Beluga first (it reads the worktree's files, so before they go), then the option. */
  const go = (option: string): void => {
    const first = [...(carry && ownVars.length ? [api.env.carryWorktree(menu.id)] : []), ...(saveEnv && env.length ? [api.workspaces.saveEnvInBeluga(menu.id)] : [])];
    void Promise.allSettled(first).then(() => pick(option));
  };

  if (menu.action === 'delete') {
    const worktree = ws.kind === 'worktree' && !ws.external;
    const remove = (): void => go(withEnv ? `confirm-delete-env${all}` : 'confirm-delete');
    // Delete waits until it's known whether unpushed commits would go with it, and says so (BLG-946).
    const asking = lose === undefined;
    // No answer in time: Delete is yours to choose, with Archive (which keeps everything) beside it.
    const late = lose === 'late';
    const archiveInstead = (): void => go(withEnv ? `confirm-archive-env${all}` : 'confirm-archive');
    // Commits pushed nowhere (BLG-617): say how many, and Archive (which keeps them) is the main button.
    if (lose && lose !== 'late') {
      const it = lose.unpushed === 1 ? 'it' : 'them';
      return (
        <Alert
          icon="alert"
          tone="danger"
          title={`Delete “${ws.name}” and its unpushed work?`}
          message={
            <>
              <p>
                <strong>{count(lose.unpushed, 'commit')}</strong> on <code>{lose.branch}</code> {lose.unpushed === 1 ? 'was' : 'were'} never pushed or merged into <code>{lose.into}</code>. Deleting loses {it}, with the folder and the conversation, and you can’t undo it.
              </p>
              {lose.subjects.length ? (
                <ul className={s.subjects}>
                  {lose.subjects.map((subject, i) => (
                    <li key={i}>{subject}</li>
                  ))}
                </ul>
              ) : null}
              <p>{ws.archived ? `It’s archived: the branch and the conversation are kept as long as it stays that way.` : `Archive keeps the branch and the conversation, and still frees the space.`}</p>
            </>
          }
          table={table}
          confirm={ws.archived ? { label: 'Keep It', onClick: close } : { label: 'Archive Instead', onClick: archiveInstead }}
          alternative={{ label: 'Delete Anyway', destructive: true, onClick: remove }}
          onCancel={close}
        >
          {boxes}
        </Alert>
      );
    }
    return (
      <Alert
        icon="alert"
        tone="danger"
        title={`Delete “${ws.name}”?`}
        message={
          <>
            <p>
              {worktree ? (
                <>
                  This deletes the worktree folder, its branch <code>{ws.branch ?? ''}</code> and the conversation.
                </>
              ) : (
                'This removes it from Beluga and deletes the conversation.'
              )}
            </p>
            <p>You can’t undo this.</p>
            {asking ? <p className={s.muted}>Checking for commits that were never pushed…</p> : null}
            {late ? <p className={s.muted}>Beluga couldn’t finish checking for commits that were never pushed. {ws.archived ? 'Keep it archived if you’re not sure.' : 'If you’re not sure, Archive keeps the branch and the conversation.'}</p> : null}
          </>
        }
        table={table}
        confirm={{ label: 'Delete', destructive: true, disabled: asking, onClick: remove }}
        {...(late && !ws.archived ? { alternative: { label: 'Archive Instead', onClick: archiveInstead } } : {})}
        onCancel={close}
      >
        {boxes}
      </Alert>
    );
  }

  const worktree = ws.kind === 'worktree';
  const freed = plan?.dropBytes ? ` (${formatBytes(plan.dropBytes)} here)` : '';
  const message = (
    <>
      <p>
        {worktree ? (
          <>
            Everything of yours is kept: {changed ? <strong>{count(changed, 'uncommitted file')}</strong> : 'uncommitted changes'}, new files, and ignored files like <code>.env</code>. Its dependencies, builds and caches are cleared to save space{freed}, and the folder goes.
          </>
        ) : (
          'The chat leaves the sidebar. You can restore it from Overview.'
        )}
      </p>
      {worktree ? (
        <p>
          Its branch <code>{ws.branch ?? ''}</code> and the conversation stay. Restoring brings the folder back as it was{plan?.remake.length ? <> and runs the project’s setup to make the rest again</> : null}.
        </p>
      ) : null}
    </>
  );
  // With env changes, "copy them first" goes before whichever way you archive.
  const archive = (): void => go(withEnv ? `confirm-archive-env${all}` : 'confirm-archive');
  const commitAndArchive = (): void => {
    if (withEnv) void api.workspaces.applyEnvBack(menu.id, Boolean(all)).then(() => go('confirm-commit-archive'));
    else go('confirm-commit-archive');
  };
  return (
    <Alert
      icon="archive"
      tone="info"
      title={`Archive “${ws.name}”?`}
      message={message}
      table={table}
      confirm={{ label: 'Archive', onClick: archive }}
      {...(changed ? { alternative: { label: 'Commit & Archive', onClick: commitAndArchive } } : {})}
      onCancel={close}
    >
      {boxes}
    </Alert>
  );
}
