import * as Popover from '@radix-ui/react-popover';
import { type ReactNode, useRef } from 'react';
import type { AppState } from '@beluga/core/store.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { Alert } from '../../components/Alert.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Button } from '../../components/ui.js';
import { useApi, useApp } from '../../lib/beluga.js';
import type { AskedWork } from '../../lib/work-confirm.js';
import { MergeReview } from './MergeReview.js';
import s from './work-confirm.module.css';
import { primaryKey } from '../../lib/shortcuts-model.js';

/**
 * Before a workspace action that starts Claude working or changes git: what will happen, in a
 * sentence or two, then Start / Cancel. Anchored to its toolbar button when that's on screen
 * (a popover, as Safari's and Xcode's toolbar items do); otherwise a small alert.
 */

interface Words {
  readonly title: string;
  readonly message: ReactNode;
  readonly confirm: string;
  readonly icon: IconName;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What each action does, in this workspace's terms. */
export function wordsFor(state: AppState, ws: Workspace, action: AskedWork): Words {
  const project = state.projects.find((p) => p.id === ws.projectId);
  const branch = ws.branch ?? ws.name;
  const changed = ws.status?.changed ?? 0;
  const ahead = ws.status?.ahead ?? 0;
  switch (action) {
    case 'review_claude':
      return {
        title: 'Ask your agent to review this worktree?',
        message: (
          <>
            <p>Your agent’s sub-agents check correctness, security, tests and quality, then give a verdict in the chat: what changed, what they found, and whether it’s ready to merge.</p>
            <p className={s.quiet}>It may add a missing test or fix something small along the way; anything it changes shows in Changes for you to look over.</p>
          </>
        ),
        confirm: 'Start Review',
        icon: 'review',
      };
    case 'commit':
      return {
        title: 'Commit all changes?',
        message: (
          <p>
            Commits {plural(changed, 'changed file')} on <strong>{branch}</strong> with the message “Work from Beluga”. Nothing is pushed.
          </p>
        ),
        confirm: 'Commit',
        icon: 'commit',
      };
    case 'merge':
      return {
        title: `Merge into ${project?.name ?? 'the project'}’s main folder?`,
        message: (
          <p>
            Merges {plural(ahead, 'commit')} from <strong>{branch}</strong> into the main folder, so its files change. Nothing is pushed.
          </p>
        ),
        confirm: 'Merge',
        icon: 'merge',
      };
    case 'merge_claude': {
      const files = state.conflicts[ws.id]?.length ?? 0;
      return {
        title: 'Ask your agent to solve the conflict?',
        message: <p>Your agent merges {branch} into the main folder, resolves the conflict{files ? ` in ${plural(files, 'file')}` : ''} keeping both sides’ intent, runs the tests and commits the merge.</p>,
        confirm: 'Solve Conflict',
        icon: 'merge',
      };
    }
    case 'compact':
      return {
        title: 'Compact this conversation?',
        message: <p>Your agent summarizes what matters so far and carries on from that summary, so it has room to keep going.</p>,
        confirm: 'Compact',
        icon: 'gauge',
      };
    case 'fix_checks': {
      const pr = state.prs[ws.id];
      return {
        title: 'Ask your agent to fix the failing checks?',
        message: <p>Your agent reads why {pr ? `pull request #${pr.number}’s` : 'the pull request’s'} checks failed, fixes the code, runs the tests, then commits and pushes to the pull request.</p>,
        confirm: 'Fix Checks',
        icon: 'wand',
      };
    }
    case 'resolve_pr': {
      const pr = state.prs[ws.id];
      return {
        title: 'Ask your agent to resolve the merge conflicts?',
        message: (
          <>
            <p>{pr ? `Pull request #${pr.number}` : 'The pull request'} conflicts with its base, so GitHub can’t merge it. In this chat, your agent merges the latest base into <strong>{branch}</strong>, resolves each conflict keeping both sides’ intent, runs the tests, then commits and pushes.</p>
            <p className={s.quiet}>Once it’s pushed, the checks run again and you can merge.</p>
          </>
        ),
        confirm: 'Resolve Conflicts',
        icon: 'merge',
      };
    }
    case 'continue_after_merge': {
      const pr = state.prs[ws.id];
      return {
        title: 'Continue working after the merge?',
        message: (
          <>
            <p>{pr ? `Pull request #${pr.number}` : 'The pull request'} is done. <strong>{branch}</strong> starts again from the latest base, and the conversation stays, so the next change gets a new pull request.</p>
            <p className={s.quiet}>If the branch has work that isn’t merged yet, nothing is lost: your agent brings the base in instead.</p>
          </>
        ),
        confirm: 'Continue',
        icon: 'branch',
      };
    }
  }
}

/** Do it (the confirmation was the asking). */
export function startWork(api: ReturnType<typeof useApi>, wsId: string, action: AskedWork): void {
  const w = api.workspaces;
  switch (action) {
    case 'review_claude':
      return void w.askClaudeToReview(wsId);
    case 'commit':
      return void w.commit(wsId);
    case 'merge':
      return void w.merge(wsId);
    case 'merge_claude':
      return void w.askClaudeToMerge(wsId);
    case 'compact':
      return void w.compact(wsId);
    case 'fix_checks':
      return void api.workbench.fixChecks(wsId);
    case 'resolve_pr':
      return void api.workbench.resolvePrConflicts(wsId);
    case 'continue_after_merge':
      return void api.workbench.continueAfterMerge(wsId);
  }
}

/** The toolbar button for this action in this workspace, else its ⋯ (where the action is), if on screen. */
function toolbarButton(wsId: string, action: AskedWork): HTMLElement | null {
  const find = (tool: string): HTMLElement | null => {
    const el = document.querySelector<HTMLElement>(`[data-tool="${tool}"][data-tool-ws="${CSS.escape(wsId)}"]`);
    return el && el.getClientRects().length ? el : null;
  };
  return find(action) ?? find('more');
}

export function WorkConfirm({ wsId, action, close }: { wsId: string; action: AskedWork; close: () => void }) {
  const api = useApi();
  const state = useApp((st) => st);
  const ws = findWorkspace(state.projects, wsId);
  const start = useRef<HTMLButtonElement>(null);
  if (!ws) return null;
  // Merging gets a closer look: where it goes, what comes along, and what would stop it.
  if (action === 'merge') return <MergeReview ws={ws} anchor={toolbarButton(ws.id, action)} close={close} />;
  const words = wordsFor(state, ws, action);
  const go = (): void => {
    close();
    startWork(api, ws.id, action);
  };
  const anchor = toolbarButton(ws.id, action);
  if (!anchor) return <Alert icon={words.icon} tone="info" title={words.title} message={words.message} confirm={{ label: words.confirm, onClick: go }} onCancel={close} />;
  return (
    <Popover.Root open onOpenChange={(open) => (open ? undefined : close())}>
      <Popover.Anchor virtualRef={{ current: anchor }} />
      <Popover.Portal>
        <Popover.Content
          className={s.popover}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-label={words.title}
          onOpenAutoFocus={(e) => (e.preventDefault(), start.current?.focus())}
          // Its own button pressed again closes it (see askBeforeWork), instead of closing and reopening.
          onPointerDownOutside={(e) => (anchor.contains(e.target as Node) ? e.preventDefault() : undefined)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || primaryKey(e) || e.shiftKey) return;
            if ((e.target as HTMLElement).tagName === 'BUTTON' && e.target !== start.current) return;
            e.preventDefault();
            go();
          }}
        >
          <div className={s.head}>
            <span className={s.icon} aria-hidden="true">
              <Icon name={words.icon} size={16} />
            </span>
            <Popover.Title className={s.title}>{words.title}</Popover.Title>
          </div>
          <Popover.Description asChild>
            <div className={s.message}>{words.message}</div>
          </Popover.Description>
          <div className={s.buttons}>
            <Button onClick={close}>
              Cancel
            </Button>
            <Button ref={start} variant="primary" onClick={go}>
              {words.confirm}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
