import type { Session } from '../core/session.js';
import type { WorkspaceController } from '../core/workspace-controller.js';
import { commitDetail, historyFilters, log } from '../workspaces/history.js';
import type { Args, Method } from './api.js';

/** What each `git.*` method does (see git-api.ts). */

type GitMethod = Extract<Method, `git.${string}`>;
type GitHandlers = { readonly [M in GitMethod]: (s: Session, ...args: Args<M>) => unknown };

const ctl = (s: Session): WorkspaceController => {
  if (!s.workspaces) throw new Error('Projects aren’t available here');
  return s.workspaces;
};

export const GIT_HANDLERS = {
  'git.fetch': (s, projectId) => ctl(s).mainSync.fetch(projectId),
  'git.fetchIfStale': (s, projectId) => ctl(s).mainSync.fetchIfStale(projectId),
  'git.updateMain': (s, projectId) => ctl(s).mainSync.update(projectId),
  'git.pushMain': (s, id) => {
    const c = ctl(s);
    return c.mainSync.push(c.manager.find(id)?.projectId ?? id);
  },
  'git.stashAndUpdate': (s, projectId) => ctl(s).mainSync.stashAndUpdate(projectId),
  'git.moveAndUpdate': async (s, projectId, name) => {
    const out = await ctl(s).mainSync.moveAndUpdate(projectId, name || undefined);
    ctl(s).open(out.wsId);
    return out;
  },
  'git.switchToDefault': async (s, projectId, mode) => {
    const out = await ctl(s).mainSync.switchToDefault(projectId, mode);
    if (out.wsId) ctl(s).open(out.wsId);
    return out;
  },
  'git.askClaude': (s, projectId, situation) => ctl(s).mainSync.askClaude(projectId, situation),
  'git.syncFork': (s, projectId) => ctl(s).mainSync.syncFork(projectId),
  'git.syncForkWithClaude': async (s, projectId, situation) => {
    const wsId = await ctl(s).mainSync.syncForkWithClaude(projectId, situation);
    if (wsId) ctl(s).open(wsId);
    return wsId;
  },
  'git.github': (s, projectId, force) => ctl(s).mainSync.githubInfo(projectId, force ?? false),
  'git.githubRepo': (s, projectId) => ctl(s).mainSync.githubRepo(projectId),
  'git.log': (s, id, opts) => {
    const manager = ctl(s).manager;
    // "default": the project's main (or master) and what it tracks, wherever the folder is.
    const sync = manager.list.find((p) => p.root && (p.id === id || p.workspaces.some((w) => w.id === id)))?.sync;
    return log(manager.historyDir(id), opts ?? {}, sync ? { branch: sync.branch, ...(sync.upstream ? { upstream: sync.upstream } : {}) } : undefined);
  },
  'git.commit': (s, id, hash) => commitDetail(ctl(s).manager.historyDir(id), hash),
  'git.mergePreview': (s, id) => ctl(s).manager.mergePreview(id),
  'git.filters': (s, id) => historyFilters(ctl(s).manager.historyDir(id)),
  'git.worktreeAt': async (s, projectId, hash, name) => {
    const c = ctl(s);
    const ws = await c.manager.createWorktreeAt(projectId, name?.trim() || `from-${hash.slice(0, 7)}`, hash);
    await c.refresh();
    c.open(ws.id);
    s.toast(`Worktree ${ws.name} is ready on ${ws.branch}, starting at ${hash.slice(0, 7)}`, 'success');
    return ws.id;
  },
} satisfies GitHandlers;
