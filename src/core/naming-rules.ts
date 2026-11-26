import { type NamingRules, patchRules } from '../shared/naming.js';
import type { ProjectFileName } from '../workspaces/scripts.js';
import { saveProjectNaming } from '../workspaces/scripts.js';

/** A change to a project's naming rules (shared/naming.ts): a value sets one, null clears it, left out keeps it. */
export interface NamingPatch {
  readonly branchPrefix?: string | null;
  readonly prTitle?: string | null;
}

export interface NamingDeps {
  readonly project: { readonly name: string; readonly root: string; readonly scripts?: { readonly naming?: NamingRules } };
  readonly yours?: Readonly<Record<string, NamingRules>>;
  readonly setYours: (all: Readonly<Record<string, NamingRules>>) => void;
  readonly saveTeam?: (root: string, naming: NamingRules | undefined) => ProjectFileName;
}

/**
 * Save a project's naming rules (BLG-1033), yours (prefs, by project name) or the team's (its
 * beluga.json "naming"). Saving for the team drops your own rules for it, so the file is what counts.
 * → where they went.
 */
export function setProjectNaming(deps: NamingDeps, patch: NamingPatch, team = false): 'yours' | ProjectFileName {
  const { project } = deps;
  const { [project.name]: mine, ...others } = deps.yours ?? {};
  if (team) {
    const file = (deps.saveTeam ?? saveProjectNaming)(project.root, patchRules({ ...project.scripts?.naming, ...mine }, patch));
    if (mine) deps.setYours(others);
    return file;
  }
  const next = patchRules(mine, patch);
  deps.setYours(next ? { ...others, [project.name]: next } : others);
  return 'yours';
}
