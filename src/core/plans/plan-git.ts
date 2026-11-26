import { type CombineResult, type MergeResult, isAncestor, tryGit } from '../../workspaces/git.js';
import { createPr, explainMergeError, findPr, hasGh, mergePr, pushForPr } from '../../workspaces/pr.js';
import type { PlanPr } from './model.js';
import type { WorkspaceController } from '../workspace-controller.js';

/**
 * What a plan does in git: its branch (plan/<slug>, from main), passed milestones merged into it,
 * merged worktrees cleared away, and the branch reaching main as one pull request (or merged here).
 * The pilot only sees this (tests give it a fake).
 */
export interface PlanGit {
  /** The plan's branch, made from main unless it's there → whether it was made. */
  ensureBranch(projectId: string, branch: string): Promise<{ readonly made: boolean }>;
  /** Merge task branches into the plan's branch (--no-ff; those already in it skipped). */
  mergeInto(projectId: string, into: string, branches: readonly string[]): Promise<CombineResult>;
  /** Main as GitHub has it now (fetched): what the plan's branch catches up with when its PR conflicts. */
  mainRef(projectId: string): Promise<string>;
  /** Whether a branch is in main already. */
  inMain(projectId: string, branch: string): Promise<boolean>;
  /** A merged task's worktree goes: archived (its conversation kept), its branch deleted only if it's in `into` (git branch -d). */
  retire(projectId: string, workspaceId: string | undefined, branch: string | undefined, into: string): Promise<void>;
  /** The branch's pull request (undefined: none). Throws when GitHub couldn't tell. */
  findPr(projectId: string, branch: string): Promise<PlanPr | undefined>;
  openPr(projectId: string, branch: string, title: string, body: string): Promise<PlanPr>;
  /** Push the plan's branch to GitHub (what was merged into it here since the PR opened goes in too). */
  push(projectId: string, branch: string): Promise<void>;
  /** Merge it now, or (auto) once its checks and reviews pass. Throws gh's error. */
  mergePr(projectId: string, number: number, opts?: { readonly auto?: boolean }): Promise<void>;
  /** Merge the branch into the project's main folder (on main). */
  mergeLocal(projectId: string, branch: string): Promise<MergeResult>;
  /** Of `branches`, those that are there and not in `into`: work a milestone would pass without. */
  notIn?(projectId: string, into: string, branches: readonly string[]): Promise<string[]>;
}

export function planGitOf(controller: WorkspaceController): PlanGit {
  const m = controller.manager;
  const root = (projectId: string): string => m.repoProject(projectId).root;
  return {
    ensureBranch: (projectId, branch) => m.planBranch(projectId, branch),
    notIn: async (projectId, into, branches) => {
      const at = root(projectId);
      const out: string[] = [];
      for (const b of branches) if ((await tryGit(at, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) && !(await isAncestor(at, b, into))) out.push(b);
      return out;
    },
    mergeInto: (projectId, into, branches) => m.mergeIntoPlan(projectId, into, branches),
    mainRef: (projectId) => m.latestBase(projectId),
    inMain: (projectId, branch) => m.inDefaultBranch(projectId, branch),
    retire: async (projectId, workspaceId, branch, into) => {
      const ws = workspaceId ? m.find(workspaceId) : undefined;
      if (ws && !ws.archived) await controller.archive(ws.id, false, { quiet: true });
      // Never -D: a branch with work not in the plan's branch stays.
      if (branch) await m.dropBranch(projectId, branch, into).catch(() => undefined);
    },
    findPr: (projectId, branch) => findPr(root(projectId), branch),
    openPr: async (projectId, branch, title, body) => createPr(root(projectId), { base: await m.defaultBranchName(projectId), head: branch, title, body }),
    // A merge commit, keeping each milestone's merges.
    push: async (projectId, branch) => void (await pushForPr(root(projectId), branch)),
    mergePr: async (projectId, number, opts) => {
      if (!(await hasGh())) throw new Error('Merging on GitHub needs the GitHub CLI (gh), signed in');
      // GitHub's no, in plain words (a review is required, it conflicts…).
      await mergePr(root(projectId), number, { method: 'merge', ...(opts?.auto ? { auto: true } : {}) }).catch((err: unknown) => {
        throw new Error(explainMergeError(err instanceof Error ? err.message : String(err), 'merge').message);
      });
    },
    mergeLocal: (projectId, branch) => m.mergeBranchIntoMain(projectId, branch),
  };
}
