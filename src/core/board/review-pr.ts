import type { Action, AppState, Store } from '../store.js';
import type { Issue, IssueStatus } from './model.js';

/**
 * Open a PR when the work is ready (BLG-927): a worktree's task moving to In Review is the sign its
 * work is done, so with the setting on, that worktree's agent opens a draft pull request, the way
 * Create PR with your agent does. A turn that ends mid-task only commits, as always.
 */

export interface ReviewPrDeps {
  readonly store: Store;
  /** The board's tasks as they are now (seeds which are already in review, so only a move fires). */
  readonly issues: () => readonly Issue[];
  /** Ask the worktree's agent for the pull request (Workbench.createPr; queued behind a running turn). */
  readonly openPr: (workspaceId: string, extra: string) => void;
}

/** What the agent is asked on top of the pull-request instructions. */
export const reviewPrNote = (issue: Pick<Issue, 'key'>): string =>
  `Its task ${issue.key} just moved to In Review, so Beluga asked for this pull request by itself: open it as a draft (gh pr create --draft), so the owner looks before anyone is asked to review.`;

/**
 * The worktree whose agent should open a draft PR now that `issue` changed from `before`, if any:
 * the setting is on, the task just reached In Review, and its worktree here has no pull request yet.
 */
export function reviewPrFor(state: Pick<AppState, 'prefs' | 'projects' | 'prs' | 'gh'>, issue: Issue, before: IssueStatus | undefined): string | undefined {
  if (!state.prefs.prOnReview || state.gh === false) return undefined;
  if (issue.status !== 'in_review' || before === 'in_review') return undefined;
  // A plan's task ships with its plan's pull request; a task with a PR already has one to review.
  if (issue.plan || issue.pr || issue.worktreeGone) return undefined;
  const id = issue.carriedBy ?? issue.worktrees.at(-1);
  const ws = id ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) : undefined;
  if (!ws || ws.kind !== 'worktree' || !ws.branch || ws.archived) return undefined;
  // Its open PR is kept current by pushing; one closed by hand stays closed. After a merge (Continue After Merge) the next one is new.
  const pr = state.prs[ws.id];
  if (pr && pr.state !== 'MERGED') return undefined;
  return ws.id;
}

export class ReviewPr {
  /** Each task's status as last seen: only a move into In Review opens one. */
  private readonly seen = new Map<string, IssueStatus>();
  /** Once per task and worktree for this run, however often it goes back and forth. */
  private readonly asked = new Set<string>();
  private readonly off: () => void;

  constructor(private readonly deps: ReviewPrDeps) {
    for (const issue of deps.issues()) this.seen.set(issue.id, issue.status);
    // After the action has reached everyone (never inside its dispatch).
    this.off = deps.store.onAction((a) => queueMicrotask(() => this.onAction(a)));
  }

  stop(): void {
    this.off();
  }

  private onAction(action: Action): void {
    if (action.type !== 'board_issue') return;
    const { issue } = action;
    const before = this.seen.get(issue.id);
    this.seen.set(issue.id, issue.status);
    // A teammate's change to a shared task: their Beluga decides about their own worktrees.
    if (action.origin === 'team') return;
    const ws = reviewPrFor(this.deps.store.getState(), issue, before);
    if (!ws || this.asked.has(`${issue.id}:${ws}`)) return;
    this.asked.add(`${issue.id}:${ws}`);
    this.deps.openPr(ws, reviewPrNote(issue));
  }
}
