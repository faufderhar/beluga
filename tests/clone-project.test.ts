import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/core/session.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import { isMainCheckout } from '../src/workspaces/discovery.js';
import { cloneError, cloneProject } from '../src/workspaces/new-project.js';

// git.ts reads its environment once: before it loads, https://git.example.test/ is pointed at local
// repositories with git's own url.<base>.insteadOf, so real clones run without a network.
const repos = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const p = await import('node:path');
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'beluga-clone-repos-'));
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.file://${dir}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://git.example.test/';
  return dir;
});

const gitIn = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-clone-'));
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

/** A repository at https://git.example.test/<name>.git, with one commit (or none). */
function remote(name: string, empty = false): string {
  const dir = path.join(repos, `${name}.git`);
  mkdirSync(dir);
  gitIn(dir, 'init', '--quiet', '--initial-branch=trunk');
  if (!empty) {
    writeFileSync(path.join(dir, 'app.js'), 'hi\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, ...ID, 'commit', '--quiet', '-m', 'first');
  }
  return `https://git.example.test/${name}.git`;
}

describe('cloning a project from its git address', () => {
  it('clones into the folder under the repository name, a main checkout ready for worktrees', async () => {
    const url = remote('shop');
    const parent = tmp();
    const dir = await cloneProject(`  ${url} `, parent);
    expect(dir).toBe(path.join(parent, 'shop'));
    expect(isMainCheckout(dir)).toBe(true);
    expect(readFileSync(path.join(dir, 'app.js'), 'utf8')).toBe('hi\n');
    expect(gitIn(dir, 'branch', '--show-current')).toBe('trunk');
  });

  it('picks name-2 when the folder is taken, never cloning over it', async () => {
    const url = remote('blog');
    const parent = tmp();
    mkdirSync(path.join(parent, 'blog'));
    writeFileSync(path.join(parent, 'blog', 'mine.txt'), 'keep');
    const dir = await cloneProject(url, parent);
    expect(dir).toBe(path.join(parent, 'blog-2'));
    expect(readFileSync(path.join(parent, 'blog', 'mine.txt'), 'utf8')).toBe('keep');
  });

  it('gives an empty repository a first commit on main', async () => {
    const dir = await cloneProject(remote('fresh', true), tmp());
    expect(gitIn(dir, 'branch', '--show-current')).toBe('main');
    expect(gitIn(dir, 'log', '--format=%s')).toBe('Start fresh');
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# fresh\n');
  });

  it('refuses what is not a git address, and never passes an option to git', async () => {
    await expect(cloneProject('not a url', tmp())).rejects.toThrow(/isn't a git address/);
    await expect(cloneProject('--upload-pack=touch /tmp/x', tmp())).rejects.toThrow(/isn't a git address/);
    await expect(cloneProject('file:///etc', tmp())).rejects.toThrow(/isn't a git address/);
  });

  it('leaves no folder behind when the clone fails, and says why in plain words', async () => {
    const parent = tmp();
    await expect(cloneProject('https://git.example.test/missing.git', parent)).rejects.toThrow(/Cloning failed|Can't find/);
    expect(existsSync(path.join(parent, 'missing'))).toBe(false);
  });
});

describe('projects.clone', () => {
  /** A session with these projects, whose controller records what it was asked to add. */
  const session = (projects: { id: string; root: string }[]) => {
    const added: string[] = [];
    const workspaces = { addProject: async (dir: string) => (added.push(dir), { project: { id: 'new-id', name: path.basename(dir) } }) };
    const store = { getState: () => ({ projects }) };
    return { s: { workspaces, store } as unknown as Session, added };
  };

  it('clones and adds a repository that is new here', async () => {
    const url = remote('notes');
    const parent = tmp();
    const { s, added } = session([]);
    expect(await HANDLERS['projects.clone'](s, url, parent)).toEqual({ id: 'new-id', path: path.join(parent, 'notes') });
    expect(added).toEqual([path.join(parent, 'notes')]);
  });

  it('opens the project you already have of that repository, however its address is written', async () => {
    const url = remote('wiki');
    const mine = await cloneProject(url, tmp());
    gitIn(mine, 'remote', 'set-url', 'origin', 'git@git.example.test:wiki.git');
    const parent = tmp();
    const { s, added } = session([{ id: 'wiki-id', root: mine }]);
    expect(await HANDLERS['projects.clone'](s, 'https://git.example.test/wiki', parent)).toEqual({ id: 'wiki-id', path: mine, existed: true });
    expect(added).toEqual([]);
    expect(existsSync(path.join(parent, 'wiki'))).toBe(false);
  });
});

describe("git's trouble cloning, in plain words", () => {
  const url = 'https://github.com/o/r';
  it.each([
    ['git@github.com: Permission denied (publickey).', /SSH key/],
    ['fatal: could not read Username for https://github.com: terminal prompts disabled', /sign-in/],
    ['remote: Repository not found.', /Can't find/],
    ['fatal: unable to access: Could not resolve host: github.com', /Can't reach/],
    ['fatal: something odd', /^Cloning failed: something odd$/],
  ])('%s', (out, words) => expect(cloneError(out, url)).toMatch(words));
});
