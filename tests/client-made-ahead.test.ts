import { describe, expect, it } from 'vitest';
import { ClientStore } from '../src/client/client-store.js';
import { pendingWorktree } from '../src/core/optimistic.js';
import { Store, initialState } from '../src/core/store.js';
import type { Project } from '../src/workspaces/types.js';

/**
 * BLG-942: a new worktree shows on this screen the moment you ask for it (its row and its "being
 * made" page), whatever the core is busy with, and the core's own picture of it takes over under
 * the same id.
 */

const project = { id: 'api', name: 'bob-api', root: '/tmp/bob-api', base: 'origin/main', workspaces: [{ id: 'main-api', projectId: 'api', projectRoot: '/tmp/bob-api', name: 'main', path: '/tmp/bob-api', kind: 'main', createdAt: 0, external: false }] } as unknown as Project;

function rig() {
  const core = new Store(initialState('test', 'ask'));
  core.dispatch({ type: 'projects', projects: [project] });
  const screen = new ClientStore(core);
  const made = pendingWorktree({ id: 'wt-0123456789ab', project, name: 'pr-12' });
  const rows = () => screen.getState().projects[0]!.workspaces.filter((w) => w.id === made.id);
  return { core, screen, made, rows };
}

describe('a worktree made ahead on this screen', () => {
  it('shows its row and its page at once, before the core has heard of it', () => {
    const { screen, made, rows } = rig();
    screen.makeAhead(made);
    expect(rows()).toEqual([expect.objectContaining({ pending: true, name: 'pr-12' })]);
    expect(screen.getState().view).toEqual({ kind: 'workspace', id: made.id, tab: 'chat' });
  });

  it('stays while the core sends other news, and the core’s own row takes its place: never two', () => {
    const { core, screen, made, rows } = rig();
    screen.makeAhead(made);
    core.dispatch({ type: 'projects_loaded' });
    core.dispatch({ type: 'projects', projects: [project] });
    expect(rows()).toHaveLength(1);
    // The core makes it, under the same id: its row (made, now) is the one shown.
    core.dispatch({ type: 'projects', projects: [{ ...project, workspaces: [...project.workspaces, { ...made, pending: undefined, path: '/tmp/wt', branch: 'pr-12' }] }] });
    expect(rows()).toEqual([expect.objectContaining({ branch: 'pr-12' })]);
    expect(rows()[0]!.pending).toBeUndefined();
    expect(screen.getState().view).toMatchObject({ kind: 'workspace', id: made.id });
  });

  it('the core’s navigation to it doesn’t take you back once you moved on', () => {
    const { screen, made } = rig();
    screen.makeAhead(made);
    screen.dispatch({ type: 'view', view: { kind: 'overview' } });
    screen.applyIntent({ type: 'navigate', view: { kind: 'workspace', id: made.id, tab: 'chat' } });
    expect(screen.getState().view).toEqual({ kind: 'overview' });
  });

  it('asking failed: its row goes, and its page with it', () => {
    const { screen, made, rows } = rig();
    const ahead = screen.makeAhead(made);
    ahead.drop();
    expect(rows()).toEqual([]);
    expect(screen.getState().view).not.toMatchObject({ kind: 'workspace', id: made.id });
  });
});
