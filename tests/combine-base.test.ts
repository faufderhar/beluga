import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { combineBranches, neededBranches } from '../src/workspaces/git.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

/** A task that builds on several unmerged branches starts from them combined (beluga/<key>-base). */

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-combine-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 'Tess');
  writeFileSync(path.join(dir, 'shared.txt'), 'one\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'init');
  return dir;
}

/** A branch from `from` with one commit writing `file`. */
function branch(dir: string, name: string, file: string, text: string, from = 'main'): void {
  sh(dir, 'checkout', '-q', '-b', name, from);
  writeFileSync(path.join(dir, file), text);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', `work on ${name}`);
  sh(dir, 'checkout', '-q', 'main');
}

const hidden = (): string => path.join(mkdtempSync(path.join(os.tmpdir(), 'klaud-bases-')), 'kld-10-base');
const has = (dir: string, ref: string, file: string): boolean => sh(dir, 'ls-tree', '--name-only', ref).split('\n').includes(file);
const parents = (dir: string, ref: string): number => sh(dir, 'rev-list', '--parents', '-n', '1', ref).trim().split(' ').length - 1;

describe('combining the branches a task builds on', () => {
  it('two unmerged branches: the first with the other merged in (--no-ff); the hidden worktree goes', async () => {
    const dir = repo();
    branch(dir, 'beluga/kld-9', 'nine.txt', '9\n');
    branch(dir, 'beluga/kld-27', 'twenty-seven.txt', '27\n');
    const at = hidden();
    const res = await combineBranches(dir, at, 'beluga/kld-10-base', ['beluga/kld-9', 'beluga/kld-27']);
    expect(res).toEqual({ ok: true, branch: 'beluga/kld-10-base' });
    expect(has(dir, 'beluga/kld-10-base', 'nine.txt') && has(dir, 'beluga/kld-10-base', 'twenty-seven.txt')).toBe(true);
    expect(parents(dir, 'beluga/kld-10-base')).toBe(2);
    expect(sh(dir, 'merge-base', '--is-ancestor', 'beluga/kld-9', 'beluga/kld-10-base')).toBe('');
    expect(existsSync(at)).toBe(false);
    expect(sh(dir, 'worktree', 'list')).not.toContain('kld-10-base');
  });

  it('three unmerged branches: all three in, one merge commit each for the others', async () => {
    const dir = repo();
    branch(dir, 'a', 'a.txt', 'a\n');
    branch(dir, 'b', 'b.txt', 'b\n');
    branch(dir, 'c', 'c.txt', 'c\n');
    expect(await combineBranches(dir, hidden(), 'beluga/kld-12-base', ['a', 'b', 'c'])).toMatchObject({ ok: true });
    for (const f of ['a.txt', 'b.txt', 'c.txt']) expect(has(dir, 'beluga/kld-12-base', f)).toBe(true);
    expect(sh(dir, 'rev-list', '--merges', '--count', 'a..beluga/kld-12-base').trim()).toBe('2');
  });

  it('a branch already in another one (KLD-31 contains KLD-27) is needed once; one already in main not at all', async () => {
    const dir = repo();
    branch(dir, 'beluga/kld-27', 'x.txt', '27\n');
    branch(dir, 'beluga/kld-31', 'y.txt', '31\n', 'beluga/kld-27');
    branch(dir, 'beluga/kld-9', 'z.txt', '9\n');
    branch(dir, 'beluga/kld-5', 'w.txt', '5\n');
    sh(dir, 'merge', '-q', '--no-ff', '--no-edit', 'beluga/kld-5');
    expect(await neededBranches(dir, ['beluga/kld-27', 'beluga/kld-31', 'beluga/kld-9', 'beluga/kld-5'], 'main')).toEqual(['beluga/kld-31', 'beluga/kld-9']);
    // Combined anyway, a branch already in is skipped (no second merge).
    expect(await combineBranches(dir, hidden(), 'beluga/kld-40-base', ['beluga/kld-31', 'beluga/kld-27'])).toMatchObject({ ok: true });
    expect(sh(dir, 'rev-parse', 'beluga/kld-40-base').trim()).toBe(sh(dir, 'rev-parse', 'beluga/kld-31').trim());
    // Two names for one commit: the first counts.
    sh(dir, 'branch', 'same', 'beluga/kld-9');
    expect(await neededBranches(dir, ['beluga/kld-9', 'same'])).toEqual(['beluga/kld-9']);
  });

  it('a conflict is left in the hidden worktree; fixed there, running it again commits and finishes', async () => {
    const dir = repo();
    branch(dir, 'beluga/kld-9', 'shared.txt', 'nine\n');
    branch(dir, 'beluga/kld-27', 'shared.txt', 'twenty-seven\n');
    branch(dir, 'beluga/kld-30', 'thirty.txt', '30\n');
    const at = hidden();
    const first = await combineBranches(dir, at, 'beluga/kld-10-base', ['beluga/kld-9', 'beluga/kld-27', 'beluga/kld-30']);
    expect(first).toEqual({ ok: false, branch: 'beluga/kld-10-base', dir: at, merging: 'beluga/kld-27', files: ['shared.txt'] });
    expect(readFileSync(path.join(at, 'shared.txt'), 'utf8')).toContain('<<<<<<<');
    // Not fixed yet: still the conflict (with the branch it was merging).
    expect(await combineBranches(dir, at, 'beluga/kld-10-base', ['beluga/kld-9', 'beluga/kld-27', 'beluga/kld-30'])).toMatchObject({ ok: false, merging: 'beluga/kld-27', files: ['shared.txt'] });
    // Claude's fix-up: markers gone (no git).
    writeFileSync(path.join(at, 'shared.txt'), 'nine and twenty-seven\n');
    expect(await combineBranches(dir, at, 'beluga/kld-10-base', ['beluga/kld-9', 'beluga/kld-27', 'beluga/kld-30'])).toEqual({ ok: true, branch: 'beluga/kld-10-base' });
    expect(sh(dir, 'show', 'beluga/kld-10-base:shared.txt')).toBe('nine and twenty-seven\n');
    expect(has(dir, 'beluga/kld-10-base', 'thirty.txt')).toBe(true);
    expect(existsSync(at)).toBe(false);
  });

  it('a conflict in a file with a Chinese name: its markers are seen, and once fixed it is added as it is', async () => {
    const dir = repo();
    // git quotes this name by default (core.quotepath): "docs/\345\257\271\347\250\277-v39/H5.md".
    const file = path.join('docs', '对稿-v39', 'H5.md');
    for (const [name, text] of [['beluga/h5', 'h5\n'], ['beluga/h6', 'h6\n']] as const) {
      sh(dir, 'checkout', '-q', '-b', name, 'main');
      mkdirSync(path.join(dir, 'docs', '对稿-v39'), { recursive: true });
      writeFileSync(path.join(dir, file), text);
      sh(dir, 'add', '.');
      sh(dir, 'commit', '-qm', `work on ${name}`);
      sh(dir, 'checkout', '-q', 'main');
    }
    const at = hidden();
    const first = await combineBranches(dir, at, 'plan/app', ['beluga/h5', 'beluga/h6']);
    expect(first).toMatchObject({ ok: false, merging: 'beluga/h6', files: [file.split(path.sep).join('/')] });
    // Not fixed yet: the markers are found in it, not passed over.
    expect(await combineBranches(dir, at, 'plan/app', ['beluga/h5', 'beluga/h6'])).toMatchObject({ ok: false, merging: 'beluga/h6' });
    writeFileSync(path.join(at, file), 'h5 and h6\n');
    expect(await combineBranches(dir, at, 'plan/app', ['beluga/h5', 'beluga/h6'])).toEqual({ ok: true, branch: 'plan/app' });
    expect(sh(dir, 'show', 'plan/app:docs/对稿-v39/H5.md')).toBe('h5 and h6\n');
  });

  it('through the manager: beluga/<key>-base in a hidden worktree that never shows as the project’s; one branch needed is just that one', async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-combine-m-')));
    const dir = path.join(base, 'code', 'app');
    mkdirSync(dir, { recursive: true });
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 't@t');
    sh(dir, 'config', 'user.name', 'Tess');
    writeFileSync(path.join(dir, 'shared.txt'), 'one\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-qm', 'init');
    branch(dir, 'beluga/kld-9', 'shared.txt', 'nine\n');
    branch(dir, 'beluga/kld-27', 'shared.txt', 'twenty-seven\n');
    branch(dir, 'beluga/kld-31', 'more.txt', '31\n', 'beluga/kld-27');
    const store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
    const manager = new WorkspaceManager(store);
    await manager.refresh();
    const project = manager.list.find((p) => p.root)!;
    expect(await manager.combineBase(project.id, 'KLD-40', ['beluga/kld-27', 'beluga/kld-31'])).toEqual({ ok: true, branch: 'beluga/kld-31' });
    const res = await manager.combineBase(project.id, 'KLD-10', ['beluga/kld-9', 'beluga/kld-27']);
    expect(res).toMatchObject({ ok: false, branch: 'beluga/kld-10-base', merging: 'beluga/kld-27', files: ['shared.txt'] });
    if (res.ok) return;
    expect(res.dir.startsWith(manager.basesDir + path.sep)).toBe(true);
    expect(sh(dir, 'worktree', 'list')).toContain('kld-10-base');
    await manager.refresh();
    expect(manager.list.find((p) => p.id === project.id)!.workspaces.map((w) => w.path)).not.toContain(res.dir);
  });
});
