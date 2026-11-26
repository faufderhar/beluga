import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GIT_LOCAL_ENV, dropGitLocalEnv } from '../src/core/git-env.js';

/** Beluga started from inside git never points its own git at that repository (a bisect made one bare). */
describe('git’s own variables', () => {
  it('cover git’s full list, as this git says it (older ones list one more)', () => {
    const said = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    expect(said.filter((k) => !(GIT_LOCAL_ENV as readonly string[]).includes(k))).toEqual([]);
  });

  it('are dropped, and with them gone `git init --bare` makes the folder it names, not the repository they pointed at', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'git-env-'));
    const real = path.join(base, 'real');
    execFileSync('git', ['init', '-q', real]);
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: path.join(real, '.git'), GIT_WORK_TREE: real };
    expect(dropGitLocalEnv(env).sort()).toEqual(['GIT_DIR', 'GIT_WORK_TREE']);
    execFileSync('git', ['init', '--bare', '-q', path.join(base, 'origin.git')], { env });
    expect(readFileSync(path.join(real, '.git', 'config'), 'utf8')).toMatch(/bare = false/);
    expect(readFileSync(path.join(base, 'origin.git', 'config'), 'utf8')).toMatch(/bare = true/);
  });

  // A process started with them set loads src/workspaces/git.ts before any code can drop them: the
  // demo made its worktree and commits in that repository (20 beluga/add-auth-N branches in beluga's).
  it('never reach a worktree Beluga makes, even when set as the process loaded', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'git-env-demo-'));
    const outer = path.join(base, 'outer');
    execFileSync('git', ['init', '-q', '-b', 'main', outer]);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'outer'], { cwd: outer });
    const script = path.join(base, 'run.mts');
    writeFileSync(script, `import { createDemoWorkspaces } from ${JSON.stringify(pathToFileURL(path.resolve('src/demo.ts')).href)};\nawait createDemoWorkspaces();\nprocess.exit(0);\n`);
    execFileSync(process.execPath, ['--import', 'tsx', script], { cwd: path.resolve('.'), env: { ...process.env, GIT_DIR: path.join(outer, '.git') }, stdio: 'ignore' });
    expect(execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: outer, encoding: 'utf8' }).trim()).toBe('main');
    expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: outer, encoding: 'utf8' }).match(/^worktree /gm)).toHaveLength(1);
  }, 60_000);

  it('the daemon and the demo drop them as they start', () => {
    expect(readFileSync('src/daemon/main.ts', 'utf8')).toMatch(/runDaemon[^]*?\{\n[^]*?dropGitLocalEnv\(\);/);
    expect(readFileSync('src/demo.ts', 'utf8')).toMatch(/createDemoWorkspaces\(\)[^{]*\{\n[^]*?dropGitLocalEnv\(\);/);
  });
});
