import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

/** A plan's branch in git: made from main once, task branches merged into it (--no-ff), never twice. */

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function branch(dir: string, name: string, file: string, text: string, from = 'main'): void {
  sh(dir, 'checkout', '-q', '-b', name, from);
  writeFileSync(path.join(dir, file), text);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', `work on ${name}`);
  sh(dir, 'checkout', '-q', 'main');
}

async function project() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'klaud-planbranch-'));
  const dir = path.join(base, 'code', 'app');
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 'Tess');
  writeFileSync(path.join(dir, 'shared.txt'), 'one\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'init');
  const store = new WorkspaceStore(path.join(base, 'home'));
  store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  const manager = new WorkspaceManager(store);
  await manager.refresh();
  return { base, dir, manager, id: manager.list.find((p) => p.root)!.id };
}

const has = (dir: string, ref: string, file: string): boolean => sh(dir, 'ls-tree', '--name-only', ref).split('\n').includes(file);

describe('a plan’s branch', () => {
  it('is made from main once; one that’s there is adopted', async () => {
    const { dir, manager, id } = await project();
    expect(await manager.planBranch(id, 'plan/payments')).toEqual({ made: true });
    expect(sh(dir, 'rev-parse', 'plan/payments')).toBe(sh(dir, 'rev-parse', 'main'));
    branch(dir, 'klaud/x', 'x.txt', 'x\n', 'plan/payments');
    sh(dir, 'branch', '-f', 'plan/payments', 'klaud/x');
    expect(await manager.planBranch(id, 'plan/payments')).toEqual({ made: false });
    expect(has(dir, 'plan/payments', 'x.txt')).toBe(true);
    await expect(manager.planBranch(id, 'main')).rejects.toThrow(/isn’t a plan branch/);
  });

  it('a milestone’s branches merge in --no-ff in a hidden worktree that goes; merged ones are never merged again', async () => {
    const { dir, manager, id } = await project();
    await manager.planBranch(id, 'plan/p');
    branch(dir, 'klaud/a', 'a.txt', 'a\n', 'plan/p');
    branch(dir, 'klaud/b', 'b.txt', 'b\n', 'plan/p');
    expect(await manager.mergeIntoPlan(id, 'plan/p', ['klaud/a', 'klaud/b'])).toEqual({ ok: true, branch: 'plan/p' });
    expect(has(dir, 'plan/p', 'a.txt') && has(dir, 'plan/p', 'b.txt')).toBe(true);
    expect(sh(dir, 'rev-list', '--merges', '--count', 'main..plan/p').trim()).toBe('2');
    expect(sh(dir, 'worktree', 'list')).not.toContain('plan-p');
    const head = sh(dir, 'rev-parse', 'plan/p');
    await manager.mergeIntoPlan(id, 'plan/p', ['klaud/a']);
    expect(sh(dir, 'rev-parse', 'plan/p')).toBe(head);
    expect(sh(dir, 'rev-parse', 'main')).not.toBe(head);
  });

  it('a retired task branch is deleted with git branch -d against the plan branch: merged ones go, unmerged work stays', async () => {
    const { dir, manager, id } = await project();
    await manager.planBranch(id, 'plan/p');
    branch(dir, 'klaud/a', 'a.txt', 'a\n', 'plan/p');
    branch(dir, 'klaud/b', 'b.txt', 'b\n', 'plan/p');
    await manager.mergeIntoPlan(id, 'plan/p', ['klaud/a']);
    // Merged into the plan's branch (not main, where the main folder is): deleted.
    await manager.dropBranch(id, 'klaud/a', 'plan/p');
    expect(sh(dir, 'branch', '--list', 'klaud/a').trim()).toBe('');
    // Its work not in the plan's branch: git refuses, the branch and its commit stay.
    await expect(manager.dropBranch(id, 'klaud/b', 'plan/p')).rejects.toThrow(/not fully merged/);
    expect(sh(dir, 'branch', '--list', 'klaud/b').trim()).toBe('klaud/b');
    // The one-off upstream isn't left in the repo's config.
    expect(() => sh(dir, 'config', '--get', 'branch.klaud/b.merge')).toThrow();
  });

  it('a worktree built on a task branch (blocked_by) builds on the plan branch once that one is merged and deleted', async () => {
    const { dir, manager, id } = await project();
    await manager.planBranch(id, 'plan/p');
    branch(dir, 'klaud/h5', 'h5.txt', 'h5\n', 'plan/p');
    const h6 = await manager.createWorktree(id, 'h6', 'klaud/h5');
    expect(h6.base).toBe('klaud/h5');
    await manager.mergeIntoPlan(id, 'plan/p', ['klaud/h5']);
    await manager.dropBranch(id, 'klaud/h5', 'plan/p');
    expect(manager.find(h6.id)?.base).toBe('plan/p');
    await manager.refresh();
    expect(manager.find(h6.id)?.base).toBe('plan/p');
    // Its base deleted some other way: the merge preview says so, not "0 commits".
    branch(dir, 'klaud/x', 'x.txt', 'x\n', 'plan/p');
    const h7 = await manager.createWorktree(id, 'h7', 'klaud/x');
    sh(dir, 'branch', '-D', 'klaud/x');
    await expect(manager.mergePreview(h7.id)).rejects.toThrow(/klaud\/x, which isn’t there any more/);
  });

  it('checked out somewhere already: merged there (kept); with uncommitted changes it says so', async () => {
    const { base, dir, manager, id } = await project();
    await manager.planBranch(id, 'plan/p');
    const there = path.join(base, 'elsewhere');
    sh(dir, 'worktree', 'add', '-q', there, 'plan/p');
    branch(dir, 'klaud/a', 'a.txt', 'a\n', 'plan/p');
    writeFileSync(path.join(there, 'shared.txt'), 'dirty\n');
    await expect(manager.mergeIntoPlan(id, 'plan/p', ['klaud/a'])).rejects.toThrow(/uncommitted changes/);
    sh(there, 'checkout', '--', 'shared.txt');
    expect(await manager.mergeIntoPlan(id, 'plan/p', ['klaud/a'])).toMatchObject({ ok: true });
    expect(existsSync(path.join(there, 'a.txt'))).toBe(true);
  });

  it('a conflict is left in the hidden worktree to fix', async () => {
    const { dir, manager, id } = await project();
    await manager.planBranch(id, 'plan/p');
    branch(dir, 'klaud/a', 'shared.txt', 'a\n', 'plan/p');
    branch(dir, 'klaud/b', 'shared.txt', 'b\n', 'plan/p');
    const res = await manager.mergeIntoPlan(id, 'plan/p', ['klaud/a', 'klaud/b']);
    expect(res).toMatchObject({ ok: false, merging: 'klaud/b', files: ['shared.txt'] });
    if (res.ok) return;
    expect(res.dir.startsWith(manager.basesDir + path.sep)).toBe(true);
    writeFileSync(path.join(res.dir, 'shared.txt'), 'a and b\n');
    expect(await manager.mergeIntoPlan(id, 'plan/p', ['klaud/a', 'klaud/b'])).toMatchObject({ ok: true });
    expect(sh(dir, 'show', 'plan/p:shared.txt')).toBe('a and b\n');
    expect(await manager.inDefaultBranch(id, 'klaud/a')).toBe(false);
    expect(await manager.mergeBranchIntoMain(id, 'plan/p')).toEqual({ ok: true });
    expect(await manager.inDefaultBranch(id, 'klaud/a')).toBe(true);
  });
});
