import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceError } from './manager.js';
import { git, tryGit } from './git.js';
import { cloneableOrigin, repoName } from '../shared/repo-key.js';

/** Where new projects go unless you pick somewhere: the first of these that exists, else ~/Projects. */
const HOMES = ['Projects', 'projects', 'Developer', 'code', 'Code', 'dev', 'repos', 'GitHub'];

export function defaultProjectsHome(home = os.homedir()): string {
  for (const rel of HOMES) {
    const dir = path.join(home, rel);
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // not this one
    }
  }
  return path.join(home, 'Projects');
}

/** Why a project name won't do as a folder name, or undefined when it's fine. */
export function badProjectName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Give it a name';
  if (n.length > 100) return 'That name is too long';
  if (n === '.' || n === '..' || n.startsWith('.')) return "A name can't start with a dot";
  if (/[/\\:\0]/.test(n)) return "A name can't have / \\ or : in it";
  return undefined;
}

const isEmptyDir = (dir: string): boolean => readdirSync(dir).every((f) => f === '.DS_Store');

/** What a folder made into a project leaves out of git when it has no .gitignore of its own (.env files still reach worktrees: env.ts copies them). */
const GITIGNORE = ['.DS_Store', 'node_modules/', '.env', '.env.*', '!.env.example', ''].join('\n');

/** Git won't commit without a name and email: borrow the Mac's user name when none is set. */
async function author(dir: string): Promise<string[]> {
  if ((await tryGit(dir, ['config', 'user.email']))?.trim()) return [];
  const me = os.userInfo().username;
  return ['-c', `user.name=${me}`, '-c', `user.email=${me}@localhost`];
}

/**
 * Make a folder a git project where it is: git on `main`, a .gitignore when it has none, a README
 * when it's empty, and what's in it in a first commit, so worktrees can branch from it straight away.
 * Your home folder and the disk itself are refused. When it fails, nothing it made is left behind.
 */
export async function initProject(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new WorkspaceError(`${abs} isn't there`);
  // Home, or a folder holding it (the disk too): from there home is inside, not up and out.
  const toHome = path.relative(abs, os.homedir());
  if (!toHome.startsWith('..') && !path.isAbsolute(toHome)) {
    throw new WorkspaceError(`${abs} is too big to be one project. Pick the folder of the project itself.`);
  }
  if (existsSync(path.join(abs, '.git'))) throw new WorkspaceError(`${path.basename(abs)} is already a git project`);
  const name = path.basename(abs);
  const wrote = [
    ...(existsSync(path.join(abs, '.gitignore')) ? [] : [{ file: '.gitignore', text: GITIGNORE }]),
    ...(isEmptyDir(abs) ? [{ file: 'README.md', text: `# ${name}\n` }] : []),
  ];
  try {
    await git(abs, ['init', '--initial-branch=main']);
    for (const w of wrote) writeFileSync(path.join(abs, w.file), w.text);
    await git(abs, ['add', '-A']);
    await git(abs, [...(await author(abs)), 'commit', '-m', `Start ${name}`], 120_000);
  } catch (e) {
    rmSync(path.join(abs, '.git'), { recursive: true, force: true });
    for (const w of wrote) rmSync(path.join(abs, w.file), { force: true });
    throw e;
  }
  return abs;
}

/**
 * Start a new project: a folder `name` in `parent` (your code folder unless you pick one), git on
 * `main` with a README in a first commit, so worktrees can branch from it straight away.
 * An empty folder that's already there is used; one with files in it is refused.
 */
export async function createProject(name: string, parent?: string): Promise<string> {
  const bad = badProjectName(name);
  if (bad) throw new WorkspaceError(bad);
  const n = name.trim();
  const dir = path.resolve(parent || defaultProjectsHome(), n);
  const existed = existsSync(dir);
  if (existed && (!statSync(dir).isDirectory() || !isEmptyDir(dir))) throw new WorkspaceError(`${dir} is already there, with files in it. Add it as a project instead.`);
  mkdirSync(dir, { recursive: true });
  try {
    await git(dir, ['init', '--initial-branch=main']);
    writeFileSync(path.join(dir, 'README.md'), `# ${n}\n`);
    await git(dir, ['add', 'README.md']);
    await git(dir, [...(await author(dir)), 'commit', '-m', `Start ${n}`]);
  } catch (e) {
    // Leave nothing half-made behind (but never a folder that was there before).
    if (!existed) rmSync(dir, { recursive: true, force: true });
    else rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    throw e;
  }
  return dir;
}

/** How long a clone may take before it's given up (a big repository over a slow line). */
const CLONE_MS = 15 * 60_000;

/** `parent/name`, or `name-2`… when that's taken. */
function freeFolder(parent: string, name: string): string {
  let dir = path.join(parent, name);
  for (let i = 2; existsSync(dir); i++) dir = path.join(parent, `${name}-${i}`);
  return dir;
}

/** git's trouble cloning `address`, in plain words. */
export function cloneError(output: string, address: string): string {
  if (/permission denied \(publickey\)|host key verification failed/i.test(output)) return "This Mac's SSH key can't get at that repository. Try its https address, or add your key where it's hosted.";
  if (/could not read username|authentication failed|terminal prompts disabled|denied to|403/i.test(output)) {
    return "That repository needs a sign-in git doesn't have here. If it's on GitHub, run gh auth login and gh auth setup-git in a terminal, then try again.";
  }
  if (/repository not found|not found|does not exist/i.test(output)) return "Can't find that repository: check the address, or it may be private.";
  if (/could not resolve host|network is unreachable|timed out|connection refused/i.test(output)) return `Can't reach ${address} right now.`;
  if (/no space left/i.test(output)) return 'This Mac is out of disk space.';
  const last = output.trim().split('\n').filter(Boolean).pop();
  return last ? `Cloning failed: ${last.replace(/^fatal:\s*/, '').slice(0, 200)}` : 'Cloning failed';
}

/**
 * A project from its git address: cloned into `parent` (your code folder unless you pick one) under
 * the repository's own name (name-2… when that's taken). Git never asks for a password (git.ts): an
 * address it can't read fails in plain words and leaves no folder behind. An empty repository gets
 * a README in a first commit on main, so worktrees can branch from it straight away.
 */
export async function cloneProject(url: string, parent?: string): Promise<string> {
  const address = url.trim();
  if (!cloneableOrigin(address)) throw new WorkspaceError("That isn't a git address. Paste one like https://github.com/owner/repo or git@github.com:owner/repo.git");
  const name = repoName(address);
  if (!name) throw new WorkspaceError("That address doesn't end in a repository's name");
  const home = path.resolve(parent || defaultProjectsHome());
  mkdirSync(home, { recursive: true });
  const dir = freeFolder(home, name);
  try {
    await git(home, ['clone', '--quiet', '--', address, dir], CLONE_MS);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new WorkspaceError(cloneError(e instanceof Error ? e.message : String(e), address));
  }
  if (!(await tryGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']))) {
    await git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    await git(dir, ['add', 'README.md']);
    await git(dir, [...(await author(dir)), 'commit', '-m', `Start ${name}`]);
  }
  return dir;
}
