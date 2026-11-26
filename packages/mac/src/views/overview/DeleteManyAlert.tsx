import { useEffect, useState } from 'react';
import type { ThreadChildren } from '@beluga/shared/threads.js';
import type { DeletePlan } from '@beluga/workspaces/types.js';
import { Alert } from '../../components/Alert.js';
import { DELETE_CHECK_MS } from '../../dialogs/native/ConfirmAlert.js';
import { useThreadsChoice } from '../../dialogs/native/ThreadsChoice.js';
import { useApi } from '../../lib/beluga.js';
import type { OverviewItem } from './overview-model.js';
import { deleteWords, needsUnpushedCheck, pickedWords, unpushedLosses } from './overview-selection.js';
import m from '../../dialogs/native/menus.module.css';

/**
 * What each picked worktree's branch would lose, asked once the alert opens: the map fills as
 * answers come; `done` once all answered or DELETE_CHECK_MS passed (a late answer still lands).
 */
function useDeletePlans(items: readonly OverviewItem[]): { readonly plans: ReadonlyMap<string, DeletePlan | null>; readonly done: boolean } {
  const api = useApi();
  const ids = items.filter(needsUnpushedCheck).map((i) => i.ws.id);
  const key = ids.join('\n');
  const [plans, setPlans] = useState<ReadonlyMap<string, DeletePlan | null>>(new Map());
  const [late, setLate] = useState(false);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => live && setLate(true), DELETE_CHECK_MS);
    for (const id of ids) {
      const put = (plan: DeletePlan | null): void => {
        if (live) setPlans((was) => new Map([...was, [id, plan]]));
      };
      api.workspaces.deletePlan(id).then(
        (plan) => put(plan ?? null),
        () => put(null),
      );
    }
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, key]);
  return { plans, done: late || ids.every((id) => plans.has(id)) };
}

/**
 * "Delete these for good?" for several Overview rows at once: what goes, which worktrees would
 * lose commits nobody pushed (named, before you can say yes), and their threads' question once.
 */
export function DeleteManyAlert({ items, onCancel, onDelete }: { items: readonly OverviewItem[]; onCancel: () => void; onDelete: (children?: ThreadChildren) => void }) {
  const threads = useThreadsChoice(
    items.map((i) => i.ws.id),
    'delete',
  );
  const { plans, done } = useDeletePlans(items);
  const losses = unpushedLosses(items, plans);
  const what = pickedWords(items);
  const live = items.filter((i) => !i.archived && i.ws.kind === 'worktree').length;
  return (
    <Alert
      icon="alert"
      tone="danger"
      title={losses.length ? `Delete ${what} and unpushed work?` : `Delete ${what} permanently?`}
      message={
        <>
          <p>{deleteWords(items)}</p>
          {losses.length ? (
            <>
              <p>
                {losses.length === 1 ? 'This one has' : 'These have'} commits that were never pushed or merged. Deleting loses them:
              </p>
              <ul className={m.subjects}>
                {losses.map((l) => (
                  <li key={l.id}>
                    <strong>{l.name}</strong>: {l.plan.unpushed} {l.plan.unpushed === 1 ? 'commit' : 'commits'} on <code>{l.plan.branch}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p>You can’t undo this.{live ? ` To keep the work, archive ${items.length === 1 ? 'it' : 'them'} instead.` : ''}</p>
          {!done ? <p className={m.muted}>Checking for commits that were never pushed…</p> : null}
        </>
      }
      confirm={{ label: losses.length ? 'Delete Anyway' : 'Delete', destructive: true, disabled: !done, onClick: () => onDelete(threads.children) }}
      onCancel={onCancel}
    >
      {threads.box}
    </Alert>
  );
}
