import { z } from 'zod';
import { BRANCH_PREFIX_DEFAULT, BRANCH_PREFIX_RE } from './branch-prefix.js';

/**
 * Naming rules (BLG-1033): how new worktrees' branches start, and how pull request titles are
 * written. Each has a global value (Settings) and a per-project one, yours (Project Settings) or the
 * team's (beluga.json "naming"). The worktree's folder and label follow its branch name.
 * Data only, so the screens and the daemon resolve them the same way.
 */

export const PR_TITLE_RULE_MAX = 300;

/** A project's rules: unset is "no rule here, use the next one"; an empty branch prefix is "no prefix". */
export const NamingRules = z.object({
  branchPrefix: z.string().regex(BRANCH_PREFIX_RE).optional(),
  prTitle: z.string().trim().min(1).max(PR_TITLE_RULE_MAX).optional(),
});
export type NamingRules = z.infer<typeof NamingRules>;

/** Where a rule in force comes from. */
export type NamingSource = 'yours' | 'team' | 'settings' | 'default';

export interface ResolvedRule {
  readonly value: string;
  readonly source: NamingSource;
}

export interface ResolvedNaming {
  readonly branchPrefix: ResolvedRule;
  /** Unset: Beluga's built-in title advice only. */
  readonly prTitle?: ResolvedRule;
}

/** The prefs naming reads (Settings › Workspaces and Pull requests; per project by project name). */
export interface NamingPrefs {
  readonly branchPrefix?: string;
  readonly prTitleRule?: string;
  readonly projectNaming?: Readonly<Record<string, NamingRules>>;
}

/** A project as naming sees it: its name, and what its beluga.json says. */
export interface NamingProject {
  readonly name: string;
  readonly scripts?: { readonly naming?: NamingRules };
}

/** Your rule for this project, then the team's beluga.json, then your Settings, then Beluga's default. */
export function namingFor(prefs: NamingPrefs, project?: NamingProject): ResolvedNaming {
  const yours = project ? prefs.projectNaming?.[project.name] : undefined;
  const team = project?.scripts?.naming;
  const branchPrefix: ResolvedRule =
    yours?.branchPrefix !== undefined
      ? { value: yours.branchPrefix, source: 'yours' }
      : team?.branchPrefix !== undefined
        ? { value: team.branchPrefix, source: 'team' }
        : prefs.branchPrefix !== undefined
          ? { value: prefs.branchPrefix, source: prefs.branchPrefix === BRANCH_PREFIX_DEFAULT ? 'default' : 'settings' }
          : { value: BRANCH_PREFIX_DEFAULT, source: 'default' };
  const title = yours?.prTitle?.trim() ? { value: yours.prTitle.trim(), source: 'yours' as const } : team?.prTitle?.trim() ? { value: team.prTitle.trim(), source: 'team' as const } : prefs.prTitleRule?.trim() ? { value: prefs.prTitleRule.trim(), source: 'settings' as const } : undefined;
  return { branchPrefix, ...(title ? { prTitle: title } : {}) };
}

/** The words that carry a pull request title rule, for the PR prompt and a worktree's run. */
export const prTitleRuleText = (rule: string): string => `Pull request title rule (follow it; it wins over any other title advice): ${rule.trim()}`;

/** A project's rules with one change: null clears a rule, undefined leaves it. → undefined when none are left. */
export function patchRules(current: NamingRules | undefined, patch: { readonly branchPrefix?: string | null; readonly prTitle?: string | null }): NamingRules | undefined {
  const pick = <K extends keyof NamingRules>(key: K): NamingRules[K] | undefined => (patch[key] === null ? undefined : patch[key] !== undefined ? (patch[key] as NamingRules[K]) : current?.[key]);
  const branchPrefix = pick('branchPrefix');
  const prTitle = pick('prTitle')?.trim() || undefined;
  const next = { ...(branchPrefix !== undefined ? { branchPrefix } : {}), ...(prTitle ? { prTitle } : {}) };
  return Object.keys(next).length ? next : undefined;
}
