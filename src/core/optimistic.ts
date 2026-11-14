import type { Project, Workspace } from '../workspaces/types.js';

/**
 * What the sidebar shows ahead of the disk: archiving, deleting and making worktrees (and
 * deleting projects) take a while on disk, but you see them take effect at once. While the work
 * runs, the published projects are the real ones with these on top; when it ends they come off
 * (the disk agrees by then), and when it fails they come off too, so what you see goes back.
 */
export interface Ahead {
  /** Workspaces going: archived ones show as archived, deleted ones not at all (by id). */
  readonly leaving: ReadonlyMap<string, 'archive' | 'delete'>;
  /** Projects being deleted (by id): out of the sidebar already. */
  readonly projects: ReadonlySet<string>;
  /** Worktrees being made: a row under their project already (`pending`), by the id they'll have. */
  readonly making: ReadonlyMap<string, Workspace>;
}

export const nothingAhead = (): { leaving: Map<string, 'archive' | 'delete'>; projects: Set<string>; making: Map<string, Workspace> } => ({ leaving: new Map(), projects: new Set(), making: new Map() });

/** The worktree's row while it's being made: its name and project, nothing on disk yet. `forkedFrom`: a fork of that workspace. */
export function pendingWorktree(o: { id: string; project: Pick<Project, 'id' | 'root' | 'base'>; name: string; base?: string; forkedFrom?: string; now?: number }): Workspace {
  return { id: o.id, projectId: o.project.id, projectRoot: o.project.root, name: o.name, path: '', kind: 'worktree', base: o.base ?? o.project.base, createdAt: o.now ?? Date.now(), external: false, pending: true, ...(o.forkedFrom ? { forkedFrom: o.forkedFrom } : {}) };
}

/** The projects as they'll be once the work running now is done. */
export function withAhead(projects: readonly Project[], ahead: Ahead): Project[] {
  if (!ahead.leaving.size && !ahead.projects.size && !ahead.making.size) return [...projects];
  return projects
    .filter((p) => !ahead.projects.has(p.id))
    .map((p) => {
      const real = new Set(p.workspaces.map((w) => w.id));
      // Made by now: the real one replaces its row (same id, so a window showing it stays).
      const made = [...ahead.making.values()].filter((w) => w.projectId === p.id && !real.has(w.id));
      const touched = made.length > 0 || p.workspaces.some((w) => ahead.leaving.has(w.id));
      if (!touched) return p;
      const workspaces = p.workspaces.flatMap((w): Workspace[] => {
        const going = ahead.leaving.get(w.id);
        if (going === 'delete') return [];
        return going === 'archive' && !w.archived ? [{ ...w, archived: true }] : [w];
      });
      // Where the real one will be (the newest worktree, right after the main checkout), so its row doesn't jump once it's made.
      const at = workspaces.findIndex((w) => w.archived || w.kind !== 'main');
      const cut = at < 0 ? workspaces.length : at;
      return { ...p, workspaces: [...workspaces.slice(0, cut), ...made, ...workspaces.slice(cut)] };
    });
}
