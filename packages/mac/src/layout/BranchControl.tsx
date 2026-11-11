import { useState } from 'react';
import type { BranchState, BranchStep, BranchTone } from '@beluga/core/branch-state.js';
import type { MergeMethod } from '@beluga/workspaces/pr.js';
import { lastMethod, rememberMethod } from '../dialogs/native/PullRequestSheet.js';
import { Icon, type IconName } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi } from '../lib/beluga.js';
import { MERGE_METHODS } from '../lib/pr-checks.js';
import { showGitTrouble } from '../lib/git-trouble.js';
import { openSheet } from '../lib/sheets.js';
import { askBeforeWork } from '../lib/work-confirm.js';
import { useWsBusy, whileBusy } from '../lib/ws-busy.js';
import s from './BranchControl.module.css';

const PILL_ICON: Record<BranchTone, IconName> = { merged: 'merge', ok: 'check', error: 'alert', warn: 'alert', wait: 'clock', info: 'branch', muted: 'branch' };

export type BranchFold = 'none' | 'pill' | 'all';

const STEP_ICON: Partial<Record<BranchStep['id'], IconName>> = { merge_pr: 'merge', merge: 'merge', merge_base: 'merge', merge_auto: 'clock', cancel_auto: 'x', update_branch: 'refresh', mark_ready: 'check', open_pr: 'pr', continue_after_merge: 'branch', archive: 'archive', delete: 'x', commit: 'commit', pr: 'pr', pr_draft: 'pr', pr_original: 'pr', push: 'up', rerun_checks: 'refresh' };

const STEP_SHORT: Partial<Record<BranchStep['id'], string>> = { pr: 'Create PR', open_pr: 'Open PR', pr_draft: 'Draft PR', pr_original: 'Create PR', pr_claude: 'Create PR', pr_custom: 'Create PR', merge_pr: 'Merge', merge: 'Merge', merge_base: 'Merge', merge_auto: 'Auto-merge', merge_admin: 'Merge', cancel_auto: 'Cancel', update_branch: 'Update', mark_ready: 'Ready', review_claude: 'Review', fix_checks: 'Fix Checks', resolve_pr: 'Resolve Conflicts', merge_claude: 'Resolve Conflicts', push: 'Push', rerun_checks: 'Re-run' };

/**
 * A step in a word or two, for the folded toolbar: the icon alone didn't say enough ("PR" alone didn't
 * either), and a bare "Resolve" or "Fix" read as the review comments or anything at all (BLG-753).
 */
export const shortLabel = (step: BranchStep): string => STEP_SHORT[step.id] ?? step.label.replace(/…$/, '').split(' ')[0]!;

/**
 * Folded, a quiet pill (no pull request, nothing to fix: "3 changes") is only an icon that reads as
 * a warning, so it goes: its words move to the step's tip.
 */
export const pillHidden = (branch: BranchState, fold: BranchFold): boolean => fold !== 'none' && !branch.pr && Boolean(branch.steps[0]) && (branch.tone === 'muted' || branch.tone === 'info');

interface BranchProps {
  wsId: string;
  branch: BranchState;
  fold?: BranchFold;
}

/**
 * Where a worktree's branch stands, as a small pill beside its name on the title line (Merged in
 * purple, Ready to merge in green, Conflicts in red…, its pull request's number too). It sits with
 * the name rather than the buttons, so the right side keeps only what you can do. It opens the pull
 * request when there is one. Folded (`pill` or `all`), it keeps its icon and number, its words in its tip.
 */
export function BranchPill({ wsId, branch, fold = 'none' }: BranchProps) {
  const actions = useActions();
  if (pillHidden(branch, fold)) return null;
  const pill = (
    <span className={cx(s.pill, s[`pill_${branch.tone}`])} data-branch-state={branch.kind}>
      <Icon name={PILL_ICON[branch.tone]} size={10} />
      {fold === 'none' ? branch.label : null}
      {branch.pr ? <span className={s.pillPr}>#{branch.pr.number}</span> : null}
    </span>
  );
  return (
    <Tip label={`${fold === 'none' ? '' : `${branch.label}: `}${branch.detail}${branch.pr ? ' · open the pull request' : ''}`}>
      {branch.pr ? (
        <button type="button" className={s.pillButton} onClick={() => actions.run({ type: 'ws', id: wsId, action: 'pr' })}>
          {pill}
        </button>
      ) : (
        pill
      )}
    </Tip>
  );
}

/**
 * The step a worktree's branch needs next, as one button. Its chevron has the other steps: one-click
 * ones (git or GitHub does them) and the ones Claude does, marked with Claude's icon. In a narrow
 * toolbar it folds: `all` keeps the step's icon and one short word ("PR", "Merge"), the full words
 * moving to its tip. Where the branch stands is the BranchPill beside the worktree's name.
 */
export function BranchControl({ wsId, branch, fold = 'none' }: BranchProps) {
  const api = useApi();
  const actions = useActions();
  const [method, setMethod] = useState<MergeMethod>(lastMethod);
  // This worktree's, not the component's: it's the same one when you switch to another worktree.
  const busy = useWsBusy(wsId);
  const [main, ...rest] = branch.steps;

  const merge = (how: MergeMethod, mode?: 'auto' | 'admin'): void => {
    setMethod(how);
    rememberMethod(how);
    // Workbench says how it went (a toast), and GitHub's new state shows here.
    // Couldn't reach GitHub (gh logged out, no network): the card says why and how to fix it.
    void whileBusy(wsId, async () => showGitTrouble(wsId, await api.workbench.mergePr(wsId, { method: how, ...(mode ? { [mode]: true } : {}) }), 'none'));
  };
  const run = (step: BranchStep): void => {
    if (busy) return;
    switch (step.id) {
      case 'merge_pr':
        return merge(method);
      case 'merge_auto':
        return merge(method, 'auto');
      case 'merge_admin':
        return merge(method, 'admin');
      case 'cancel_auto':
        return void whileBusy(wsId, () => api.workbench.cancelMergeWhenReady(wsId));
      case 'push':
        // Straight to GitHub; trouble reaching it opens its card (Try Again just says it's set up).
        return void whileBusy(wsId, async () => showGitTrouble(wsId, await api.workbench.pushPr(wsId), 'none'));
      case 'rerun_checks':
        return void whileBusy(wsId, async () => showGitTrouble(wsId, await api.workbench.rerunChecks(wsId), 'none'));
      case 'update_branch':
      case 'mark_ready':
        return void whileBusy(wsId, async () => showGitTrouble(wsId, await api.workbench.prStep(wsId, step.id === 'mark_ready' ? 'ready' : 'update_branch'), 'none'));
      case 'resolve_pr':
      case 'fix_checks':
      case 'continue_after_merge':
        return askBeforeWork(wsId, step.id);
      case 'open_pr':
      case 'pr_custom':
        return actions.run({ type: 'ws', id: wsId, action: 'pr' });
      case 'pr':
      case 'pr_draft':
        // Straight to GitHub, no Claude in between (Workbench toasts how it went; trouble reaching GitHub opens its card).
        return void whileBusy(wsId, async () => showGitTrouble(wsId, await api.workbench.quickPr(wsId, step.id === 'pr_draft' ? { draft: true } : {}), step.id === 'pr_draft' ? 'pr_draft' : 'pr'));
      case 'pr_original':
        // Into the fork's original (BLG-727): pushed to the fork, opened there for its maintainers.
        return void whileBusy(wsId, async () => showGitTrouble(wsId, await api.workbench.quickPr(wsId, { original: true }), 'pr_original'));
      case 'pr_claude':
        return void api.workbench.createPr(wsId);
      case 'merge_base':
        // It pushes to the shared branch, which isn't easily undone: say so first.
        return openSheet({
          kind: 'confirm',
          title: `Merge ${branch.branch} into ${branch.into}?`,
          message: `No pull request: ${step.hint.replace(/^No pull request: /, '')}. Everyone pulling ${branch.into} gets it; your main folder isn’t touched.`,
          confirm: `Merge into ${branch.into}`,
          run: () => void whileBusy(wsId, async () => showGitTrouble(wsId, await api.workbench.mergeToBase(wsId), 'merge_base')),
        });
      default:
        return actions.run({ type: 'ws', id: wsId, action: step.id });
    }
  };
  const iconOf = (step: BranchStep): IconName => (step.claude ? 'claude' : (STEP_ICON[step.id] ?? 'branch'));
  const labelOf = (step: BranchStep): string => (step.id === 'merge_pr' ? (MERGE_METHODS.find((m) => m.method === method)?.label ?? step.label) : step.label);

  // Squash, merge commit or rebase: picking one merges that way (and is remembered).
  const methods: ActionItem[] = main?.id === 'merge_pr' ? MERGE_METHODS.map((m) => ({ label: m.label, hint: m.hint, checked: m.method === method, onSelect: () => void merge(m.method) })) : [];
  const items: ActionItem[] = [
    ...methods,
    ...rest.map((step, i) => ({ label: labelOf(step), hint: step.claude ? `Agent · ${step.hint}` : step.hint, icon: iconOf(step), ...(step.danger ? { danger: true } : {}), separate: i === 0 && methods.length > 0, onSelect: () => requestAnimationFrame(() => run(step)) })),
  ];
  if (!main) return null;
  const hidePill = pillHidden(branch, fold);
  const variant = main.id === 'merge_pr' || main.id === 'merge' ? 'merge' : 'primary';

  return (
    <span className={s.wrap} role="group" aria-label={`Branch: ${branch.label}`}>
      <Tip label={`${hidePill ? `${branch.detail} · ` : ''}${fold === 'all' ? `${labelOf(main)}: ` : ''}${main.claude ? `Agent · ${main.hint}` : main.hint}`}>
        <Button variant={variant} icon={iconOf(main)} aria-label={fold === 'all' ? labelOf(main) : undefined} className={cx(s.main, items.length > 0 && s.mainSplit, branch.tone === 'error' && s.mainError, branch.tone === 'merged' && s.mainMerged)} disabled={busy} data-branch-step={main.id} data-tool-ws={wsId} onClick={() => run(main)}>
          {busy ? (fold === 'all' ? '…' : 'Working…') : fold === 'all' ? shortLabel(main) : labelOf(main)}
        </Button>
      </Tip>
      {items.length ? (
        <ActionsDropdown items={items} align="end">
          <Button variant={variant} className={cx(s.more, branch.tone === 'error' && s.mainError, branch.tone === 'merged' && s.mainMerged)} disabled={busy} aria-label="Other steps for this branch" data-branch-more={wsId}>
            <Icon name="chevronDown" size={11} />
          </Button>
        </ActionsDropdown>
      ) : null}
    </span>
  );
}
