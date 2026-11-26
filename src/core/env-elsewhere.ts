// Variables kept in other places in Beluga (BLG-977): a key pasted in one project that has the
// shape of a key another project keeps (a Ratel key kept with Ratel, pasted in Beluga) takes that
// key's name. Only for naming what was pasted: no value from here ever goes back to a screen.
import type { ElsewhereVar } from '../shared/key-detect.js';
import type { Project } from '../workspaces/types.js';

/** What env.json keeps, as far as this needs it. */
interface Kept {
  readonly projects: Readonly<Record<string, { readonly vars: Readonly<Record<string, string>>; readonly dotenv?: boolean }>>;
  readonly worktrees: Readonly<Record<string, { readonly vars: Readonly<Record<string, string>> }>>;
}

/** The place a paste is in: its project's folder and its worktree, both left out (they're already "yours"). */
interface Here {
  readonly projectRoot?: string;
  readonly wsId?: string;
}

/** At most this many projects' .env files are read for one paste. */
const MAX_PROJECTS = 40;

/**
 * Every variable kept in another project or worktree, each value once, with where it's kept.
 * `dotenv` reads a project's .env (only for projects that load theirs).
 */
export function varsElsewhere(kept: Kept, projects: readonly Project[], here: Here, dotenv: (root: string) => Readonly<Record<string, string>>): ElsewhereVar[] {
  const out: ElsewhereVar[] = [];
  const values = new Set<string>();
  const push = (vars: Readonly<Record<string, string>>, place: string): void => {
    for (const [name, value] of Object.entries(vars)) {
      if (!value || values.has(value)) continue;
      values.add(value);
      out.push({ name, value, place });
    }
  };
  for (const project of projects.slice(0, MAX_PROJECTS)) {
    const saved = kept.projects[project.root];
    for (const ws of project.workspaces ?? []) {
      if (ws.id === here.wsId) continue;
      const own = kept.worktrees[ws.id]?.vars;
      if (own) push(own, `${project.name} › ${ws.name}`);
    }
    if (project.root === here.projectRoot) continue;
    if (saved) push(saved.vars, project.name);
    if (saved?.dotenv !== false) push(dotenv(project.root), project.name);
  }
  return out;
}
