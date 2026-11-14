import type { DomainState } from './store.js';
import type { PrCheck, PullRequest } from './work-store.js';
import type { ForkOf } from '../workspaces/github.js';
import type { Workspace } from '../workspaces/types.js';

/**
 * Where a worktree's branch stands, in one word you can see at the top (Merged, Ready to merge,
 * Conflicts…), and its next steps: the first is the one to take, the rest go in its menu. Steps
 * Claude does are marked `claude`; the others are one click (git or GitHub does them). The Mac's
 * toolbar and the phone both draw it, so the two never disagree. It reads what Beluga knows: the
 * pull request GitHub reports, a merge here that stopped on conflicts, and git's status (which
 * also notices work merged outside Beluga, see `Status.landed`).
 */
export type BranchKind =
  | 'merged'
  | 'merge_conflict'
  | 'not_pushed'
  | 'conflicts'
  | 'checks_failing'
  | 'draft'
  | 'behind'
  | 'changes_requested'
  | 'auto_merge'
  | 'checks_running'
  | 'review'
  | 'blocked'
  | 'ready'
  | 'closed'
  | 'uncommitted'
  | 'unshipped'
  | 'clean';

/** merged: purple, as GitHub draws it. */
export type BranchTone = 'merged' | 'ok' | 'error' | 'warn' | 'wait' | 'info' | 'muted';

export type BranchStepId =
  | 'merge_pr'
  | 'merge_auto'
  | 'merge_admin'
  | 'cancel_auto'
  | 'update_branch'
  | 'mark_ready'
  | 'open_pr'
  | 'push'
  | 'resolve_pr'
  | 'fix_checks'
  | 'rerun_checks'
  | 'merge_claude'
  | 'review_claude'
  | 'commit'
  | 'pr'
  | 'pr_claude'
  | 'pr_custom'
  | 'pr_draft'
  | 'pr_original'
  | 'pr_own'
  | 'merge'
  | 'merge_base'
  | 'continue_after_merge'
  | 'archive'
  | 'delete';

export interface BranchStep {
  readonly id: BranchStepId;
  readonly label: string;
  readonly hint: string;
  /** Claude does it, in the worktree's conversation (it asks first). */
  readonly claude?: true;
  readonly danger?: true;
}

export interface BranchState {
  readonly kind: BranchKind;
  /** The pill: "Merged", "Ready to merge", "Conflicts". */
  readonly label: string;
  readonly tone: BranchTone;
  /** One line on why: "PR #12 merged into main on GitHub". */
  readonly detail: string;
  readonly branch: string;
  /** What it merges into ("main"). */
  readonly into: string;
  readonly pr?: { readonly number: number; readonly state: 'OPEN' | 'CLOSED' | 'MERGED' };
  /** The first is the main one. Empty: nothing to do (or the plan does it). */
  readonly steps: readonly BranchStep[];
}

export interface BranchOptions {
  /** Doing a plan's task: the plan merges it, so no merge or PR steps of its own. */
  readonly planned?: boolean;
}

/** "origin/main" → "main". */
const short = (ref: string): string => ref.replace(/^(refs\/heads\/|refs\/remotes\/)?origin\//, '');

/** Its project pushes somewhere and the GitHub CLI isn't known to be missing: PRs are the way to merge. */
export function onGitHub(state: Pick<DomainState, 'projects' | 'gh'>, ws: Workspace): boolean {
  const sync = state.projects.find((p) => p.id === ws.projectId)?.sync;
  return state.gh !== false && (!sync || Boolean(sync.upstream));
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How a finished check ends when it failed (GitHub's conclusions, lower case as parseChecks keeps them). */
const FAILED = new Set(['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

/** A check that finished and failed. */
export const checkFailed = (c: PrCheck): boolean => c.state === 'completed' && FAILED.has(c.conclusion ?? '');

/**
 * The GitHub Actions runs behind a PR's failed checks, by the run id in each check's page
 * (…/actions/runs/<id>/job/<job>): what Re-run Failed Checks runs again. Checks from other
 * services (a commit status) aren't Actions runs, so they aren't here.
 */
export function failedRunIds(pr: Pick<PullRequest, 'checkRuns'>): number[] {
  return runIdsOf(pr, checkFailed);
}

/**
 * The GitHub Actions runs behind a PR's checks that haven't finished (queued or running): what
 * Merge Now, Skipping Checks cancels once the PR merged, since nothing waits on them anymore.
 */
export function runningRunIds(pr: Pick<PullRequest, 'checkRuns'>): number[] {
  return runIdsOf(pr, (c) => c.state !== 'completed');
}

/** The Actions run ids (each once) in the pages of the checks that `keep` picks. */
function runIdsOf(pr: Pick<PullRequest, 'checkRuns'>, keep: (c: PrCheck) => boolean): number[] {
  const ids = (pr.checkRuns ?? []).filter(keep).map((c) => Number(/\/actions\/runs\/(\d+)/.exec(c.url ?? '')?.[1]));
  return [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))];
}

/**
 * What an open PR needs before anything else, from what GitHub says and what's only here. `push`:
 * this worktree has commits on no remote (BLG-617's count), so GitHub's checks and conflicts are
 * for an older commit and pushing is what runs them again; `resolve_pr`: it conflicts with its
 * base; `checks_running`: its checks still run, even if one already failed; `fix_checks`: they
 * failed and nothing runs. Undefined: none of these (or no open PR). GitHub's UNKNOWN mergeability
 * (still working it out) is never a conflict: only CONFLICTING sets `conflicts` (pr.ts).
 */
export type PrBlocker = 'push' | 'resolve_pr' | 'checks_running' | 'fix_checks';

/**
 * Commits here that its open PR doesn't have (BLG-840): what Merge on GitHub would leave out. The
 * count is status.unpushed (on no remote and not in the base), so main merged in here doesn't add
 * to it. Undefined: no open PR, or nothing missing from it.
 */
export function notOnPr(pr: Pick<PullRequest, 'number' | 'state'> | undefined, ws: Pick<Workspace, 'status'>): { readonly count: number; readonly number: number } | undefined {
  const count = ws.status?.unpushed ?? 0;
  return pr?.state === 'OPEN' && count > 0 ? { count, number: pr.number } : undefined;
}

/** "3 commits not on PR #398": the chip on a worktree and its row, and the phone's. */
export const notOnPrLabel = (gap: { readonly count: number; readonly number: number }): string => `${plural(gap.count, 'commit')} not on PR #${gap.number}`;

export function prBlocker(pr: PullRequest | undefined, ws: Pick<Workspace, 'status'>): PrBlocker | undefined {
  if (pr?.state !== 'OPEN') return undefined;
  if (notOnPr(pr, ws)) return 'push';
  if (pr.conflicts) return 'resolve_pr';
  if (pr.checks !== 'failing') return undefined;
  return (pr.checkRuns ?? []).some((c) => c.state !== 'completed') ? 'checks_running' : 'fix_checks';
}

/** The fork's original, when `pr` was opened there (Create PR on the original) rather than on the fork. */
export function prOnOriginal(fork: ForkOf | undefined, pr: Pick<PullRequest, 'url'> | undefined): ForkOf | undefined {
  return fork && pr && pr.url.toLowerCase().startsWith(`${fork.url.toLowerCase()}/pull/`) ? fork : undefined;
}

/** A worktree's branch, or undefined for what has none (chats, the main folder, archived ones, a detached HEAD). */
export function branchState(state: Pick<DomainState, 'projects' | 'gh' | 'prs' | 'conflicts'>, ws: Workspace, opts: BranchOptions = {}): BranchState | undefined {
  if (ws.kind !== 'worktree' || ws.archived || ws.pending || !ws.branch) return undefined;
  const project = state.projects.find((p) => p.id === ws.projectId);
  const into = short(ws.base ?? project?.base ?? 'main');
  const pr = state.prs[ws.id];
  const st = ws.status;
  const changed = st?.changed ?? 0;
  const planned = Boolean(opts.planned);
  const github = onGitHub(state, ws);
  // Its PR is on the fork's original (BLG-727): that repository's maintainers merge it.
  const original = prOnOriginal(project?.fork, pr);
  const originalName = project?.fork ? `${project.fork.owner}/${project.fork.repo}` : '';
  const at = (kind: BranchKind, label: string, tone: BranchTone, detail: string, steps: ReadonlyArray<BranchStep | false | undefined>): BranchState => ({
    kind,
    label,
    tone,
    detail,
    branch: ws.branch!,
    into,
    ...(pr ? { pr: { number: pr.number, state: pr.state } } : {}),
    steps: steps.filter((x): x is BranchStep => Boolean(x)),
  });

  const commit: BranchStep | false = changed > 0 && { id: 'commit', label: 'Commit…', hint: `Your agent commits the ${plural(changed, 'uncommitted change')} with a message`, claude: true };
  // Merged is done: putting it away leads; carrying on here (a new PR next) is the other way.
  const archive: BranchStep = { id: 'archive', label: 'Archive Worktree', hint: 'It’s done: put it away (the branch and the conversation are kept)' };
  // Commits pushed nowhere go with the branch (BLG-617): its hint says so, and the phone's confirm leads with Archive.
  const unpushed = st?.unpushed ?? 0;
  const remove: BranchStep = {
    id: 'delete',
    label: 'Delete Worktree…',
    hint: unpushed ? `${plural(unpushed, 'commit')} on ${ws.branch} ${unpushed === 1 ? 'was' : 'were'} never pushed or merged into ${into}: deleting loses ${unpushed === 1 ? 'it' : 'them'} and the conversation. Archive keeps both.` : 'Remove the folder and its branch for good',
    danger: true,
  };
  const finish: BranchStep[] = [archive, { id: 'continue_after_merge', label: 'Continue After Merge…', hint: `Keep working here instead: start ${ws.branch} again from the latest ${into}, keeping the conversation; the next change gets a new PR` }, remove];
  const auto: BranchStep = { id: 'merge_auto', label: 'Merge When Ready', hint: `Beluga merges PR #${pr?.number} once its checks pass, and tells you if they fail` };
  const admin: BranchStep = { id: 'merge_admin', label: 'Merge Now, Skipping Checks', hint: 'Past its checks and reviews, and stops the checks still running (needs admin rights on the repository)', danger: true };
  const openPr: BranchStep | false = Boolean(pr) && { id: 'open_pr', label: `Open PR #${pr?.number}`, hint: 'Its checks, review and every way to merge' };

  const conflicts = state.conflicts[ws.id] ?? [];
  if (conflicts.length) {
    return at('merge_conflict', 'Merge conflict', 'error', `Merging into ${into} stopped: ${plural(conflicts.length, 'file')} conflict${conflicts.length === 1 ? 's' : ''}`, [
      { id: 'merge_claude', label: 'Resolve Conflicts…', hint: 'Your agent finishes the merge: it resolves each conflict and commits', claude: true },
    ]);
  }

  if (pr?.state === 'MERGED') {
    if (original) return at('merged', 'Merged', 'merged', `PR #${pr.number} merged into ${originalName} on GitHub: Sync Fork on the project’s home brings it into your fork’s ${into}`, planned ? [] : finish);
    return at('merged', 'Merged', 'merged', `PR #${pr.number} merged into ${into} on GitHub, so this worktree is done: archive it, or continue here with a new PR${changed ? ` (${plural(changed, 'change')} since)` : ''}`, planned ? [] : finish);
  }
  // Continued after its PR merged: the commits already in the base are that PR's, so nothing new is here yet (not Merged again).
  if (ws.prDone !== undefined && st?.landed && !pr && !changed) {
    return at('clean', 'No changes', 'muted', `PR #${ws.prDone} went into ${into}: nothing new on ${ws.branch} yet, and the next change gets a new PR`, []);
  }
  // Merged outside Beluga (on GitHub with no PR it knows of, squashed, or by hand).
  if (st?.landed && pr?.state !== 'OPEN' && !changed) {
    return at('merged', 'Merged', 'merged', `Its commits are already in ${into}, so this worktree is done: archive it, or continue here`, planned ? [] : finish);
  }

  if (pr?.state === 'OPEN') {
    const n = `PR #${pr.number}`;
    const blocker = prBlocker(pr, ws);
    const fixChecks: BranchStep = { id: 'fix_checks', label: 'Fix Checks…', hint: 'Your agent reads the failing logs, fixes them and pushes', claude: true };
    // Work committed here and not pushed yet (BLG-840): merging on GitHub would leave it out, and what
    // GitHub says (failing, conflicts) is about an older commit. Pushing leads; merging waits for it.
    if (blocker === 'push') {
      const was = pr.conflicts ? `says it conflicts with ${into}` : pr.checks === 'failing' ? 'says its checks failed' : pr.checks === 'pending' ? 'is running checks' : 'shows';
      const them = unpushed === 1 ? 'it' : 'them';
      // Someone's fork's pull request (BLG-948): pushed to the fork when its author lets maintainers
      // edit it; otherwise a pull request of your own carries the fork's commits and these.
      const fork = pr.fork;
      if (fork && !fork.canPush) {
        return at('not_pushed', `${plural(unpushed, 'commit')} not on PR`, 'info', `${plural(unpushed, 'commit')} here ${unpushed === 1 ? 'isn’t' : 'aren’t'} on ${n}, and ${fork.owner}’s fork doesn’t let maintainers push to it`, [
          { id: 'pr_own', label: 'Open Your Own PR', hint: `A new pull request into ${into} with ${n}’s commits and your ${plural(unpushed, 'commit')}, on a branch of its own${changed ? ` (the ${plural(changed, 'uncommitted change')} get committed first)` : ''}` },
          commit,
          openPr,
        ]);
      }
      if (fork) {
        return at('not_pushed', `${plural(unpushed, 'commit')} not on PR`, 'info', `${plural(unpushed, 'commit')} here ${unpushed === 1 ? 'isn’t' : 'aren’t'} on ${n} yet: ${fork.owner}’s fork lets maintainers push to it`, [
          { id: 'push', label: `Push ${plural(unpushed, 'Commit')} to ${n}`, hint: `Pushes to ${fork.branch} on ${fork.owner}’s fork, which updates ${n}: GitHub runs its checks again` },
          { id: 'pr_own', label: 'Open Your Own PR', hint: `A new pull request into ${into} with ${n}’s commits and yours, instead` },
          commit,
          openPr,
        ]);
      }
      // The pill reads "3 commits not on PR #398" (its number is drawn beside it).
      return at('not_pushed', `${plural(unpushed, 'commit')} not on PR`, 'info', `${plural(unpushed, 'commit')} here ${unpushed === 1 ? 'isn’t' : 'aren’t'} on ${n} yet: merging it now would leave ${them} out, and what GitHub ${was} is for an older commit`, [
        { id: 'push', label: `Push ${plural(unpushed, 'Commit')} to ${n}`, hint: `Pushes ${ws.branch} to ${n}: GitHub runs its checks again and looks for conflicts with ${into}${changed ? ` (the ${plural(changed, 'uncommitted change')} stay here)` : ''}` },
        !original && !pr.draft && { id: 'merge_auto', label: 'Push and Merge When Ready', hint: `Pushes the ${plural(unpushed, 'commit')} to ${n}, then Beluga merges it once their checks pass` },
        commit,
        openPr,
      ]);
    }
    if (blocker === 'resolve_pr') {
      return at('conflicts', `Conflicts with ${into}`, 'error', `${n} conflicts with ${into}, which moved on since: GitHub can’t merge it until they’re resolved`, [
        { id: 'resolve_pr', label: 'Resolve Conflicts…', hint: `Your agent merges the latest ${into} in here, resolves the conflicts and pushes`, claude: true },
        openPr,
      ]);
    }
    const runs = pr.checkRuns ?? [];
    // One already failed while others still run: calm until they're done (a red Fix now would be early).
    if (blocker === 'checks_running') {
      const failed = runs.filter(checkFailed).length;
      const running = runs.filter((c) => c.state !== 'completed').length;
      return at('checks_running', 'Checks running', 'wait', `${n}’s checks are running: ${plural(running, 'check')} still going, ${failed} failed so far`, [openPr, fixChecks, admin, commit]);
    }
    if (blocker === 'fix_checks') {
      // Nothing changed here since they ran: a flaky test may just need another go.
      const rerun: BranchStep | false = failedRunIds(pr).length > 0 && { id: 'rerun_checks', label: 'Re-run Failed Checks', hint: `GitHub runs ${n}’s failed jobs again on the same commit: for a flaky test, nothing to fix` };
      const failed = runs.filter(checkFailed).map((c) => c.name);
      return at('checks_failing', 'Checks failed', 'error', `${n}’s checks failed on its latest commit${failed.length ? ` (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''})` : ''}`, [fixChecks, rerun, openPr, admin]);
    }
    if (pr.draft) {
      return at('draft', 'Draft', 'muted', `${n} is a draft: mark it ready for review to merge it`, [{ id: 'mark_ready', label: 'Mark Ready for Review', hint: `${n} leaves draft on GitHub` }, openPr, commit]);
    }
    // Merge When Ready: Beluga (or GitHub's auto-merge) merges it once its checks pass; it can be called off.
    if (ws.mergeWhenReady?.number === pr.number || pr.autoMerge) {
      const waitingFor = pr.checks === 'pending' || pr.checks === 'none' ? 'its checks pass' : pr.review === 'REVIEW_REQUIRED' ? 'it’s approved' : pr.mergeState === 'behind' ? `it has the latest ${into}` : `${into}’s rules let it`;
      return at('auto_merge', 'Merging when ready', 'wait', `${n} merges as soon as ${waitingFor}`, [
        { id: 'cancel_auto', label: 'Cancel Auto-Merge', hint: `${n} stays open: nothing merges by itself` },
        pr.mergeState === 'behind' && { id: 'update_branch', label: 'Update Branch', hint: `GitHub merges the latest ${into} into ${ws.branch}` },
        openPr,
        commit,
      ]);
    }
    if (pr.mergeState === 'behind') {
      return at('behind', `Behind ${into}`, 'warn', `${n} needs the latest ${into} before it can merge`, [
        { id: 'update_branch', label: 'Update Branch', hint: `GitHub merges the latest ${into} into ${ws.branch}` },
        { id: 'resolve_pr', label: 'Update with Your Agent…', hint: `Your agent merges ${into} in here, resolving anything in the way, and pushes`, claude: true },
        openPr,
      ]);
    }
    if (pr.review === 'CHANGES_REQUESTED') {
      return at('changes_requested', 'Changes requested', 'warn', `A reviewer asked for changes on ${n}`, [openPr, { id: 'review_claude', label: 'Ask Your Agent to Review…', hint: 'Your agent reviews the branch and suggests what to change', claude: true }, commit, admin]);
    }
    // On the original, its maintainers review and merge: open it there first; merging stays in the menu for those who can.
    if (original) {
      return at('review', `On ${originalName}`, 'wait', `${n} is on ${originalName}: its maintainers review and merge it${pr.checks === 'pending' ? ' (its checks are running)' : ''}`, [
        openPr,
        { id: 'merge_pr', label: 'Squash and Merge', hint: `On ${originalName}, if you can merge there` },
        commit,
      ]);
    }
    if (pr.checks === 'pending') return at('checks_running', 'Checks running', 'wait', `${n}’s checks are running`, [auto, admin, openPr, commit]);
    if (pr.review === 'REVIEW_REQUIRED') return at('review', 'Waiting for review', 'wait', `${n} needs an approving review`, [auto, admin, openPr, commit]);
    if (pr.mergeState === 'blocked') return at('blocked', 'Blocked', 'warn', `${into}’s rules don’t let ${n} merge yet`, [auto, admin, openPr, commit]);
    return at('ready', 'Ready to merge', 'ok', `${n} can merge into ${into}${changed ? ` · ${plural(changed, 'uncommitted change')} aren’t in it` : ''}`, [
      { id: 'merge_pr', label: 'Squash and Merge', hint: `One commit on ${into}, on GitHub` },
      openPr,
      commit,
      { id: 'review_claude', label: 'Ask Your Agent to Review…', hint: 'Your agent reviews the branch before you merge', claude: true },
    ]);
  }

  const ahead = st?.ahead ?? 0;
  const ship: BranchStep | false = !planned && (github
    ? { id: 'pr', label: 'Create PR', hint: `${changed ? 'Commits what’s left, pushes' : 'Pushes'} ${ws.branch} and opens a pull request into ${into}, titled from its commits` }
    : { id: 'merge', label: `Merge into ${into}…`, hint: `Shows what would merge into ${into} on this Mac and checks it first` });
  // Create PR's other ways, under its chevron.
  const prWays: BranchStep[] =
    !planned && github
      ? [
          { id: 'pr_claude', label: 'Create PR with Your Agent', hint: 'Your agent commits what belongs, then writes the title and description: what, why, how to test', claude: true },
          { id: 'pr_custom', label: 'Create PR with Instructions…', hint: 'Tell your agent anything extra for this one (a draft, an issue to mention…)', claude: true },
          { id: 'pr_draft', label: 'Create Draft PR', hint: `Like Create PR, as a draft: it can’t merge until it’s marked ready` },
          ...(project?.fork ? [{ id: 'pr_original' as const, label: `Create PR on ${originalName}`, hint: `Pushes ${ws.branch} to your fork and opens a pull request into ${originalName}’s ${project.fork.branch}, for its maintainers` }] : []),
          { id: 'merge_base', label: `Merge into ${into}…`, hint: `No pull request: ${changed ? 'commits what’s left, ' : ''}merges ${ws.branch} into origin/${into} and pushes it there` },
        ]
      : [];
  if (pr?.state === 'CLOSED' && !changed && !ahead) return at('closed', 'PR closed', 'muted', `PR #${pr.number} was closed without merging`, planned ? [] : [archive, remove]);
  // Work in progress, not a problem: a quiet grey pill, never a warning (Kayra: a small thing stays small).
  if (changed) return at('uncommitted', plural(changed, 'change'), 'muted', `${plural(changed, 'uncommitted change')}${ahead ? ` and ${plural(ahead, 'commit')}` : ''} not in ${into} yet`, github ? [ship, ...prWays, commit] : [commit, ship]);
  if (ahead) return at('unshipped', github ? `${plural(ahead, 'commit')} · no PR` : 'Ready to merge', github ? 'info' : 'ok', `${plural(ahead, 'commit')} on ${ws.branch} not in ${into} yet`, [ship, ...prWays]);
  return at('clean', 'No changes', 'muted', `Nothing on ${ws.branch} that isn’t in ${into}`, []);
}
