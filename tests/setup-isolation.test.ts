import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { DEFAULT_ROOTS, WorkspaceStore } from '../src/workspaces/store.js';

it('a fresh workspace store discovers only projects in the temporary test home', async () => {
  const home = os.homedir();
  expect(path.basename(path.dirname(home))).toMatch(/^beluga-test-/);
  expect(process.env.GIT_CONFIG_GLOBAL).toBe(path.join(home, '.gitconfig'));
  expect(process.env.XDG_CONFIG_HOME).toBe(path.join(home, '.config'));
  expect(DEFAULT_ROOTS.every((root) => path.dirname(root) === home)).toBe(true);

  // No projects.json yet: exercise default discovery, as a daemon or an old saved chat does.
  const manager = new WorkspaceManager(new WorkspaceStore(path.join(home, 'state')));
  await manager.refresh();
  expect(manager.list.filter((project) => project.root)).toEqual([]);
});
