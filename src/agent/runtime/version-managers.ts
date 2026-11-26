import { execFile } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Version managers (mise, asdf) put a CLI on PATH as a shim. `mise activate` adds its install
 * folders from a prompt hook, which never runs in the `$SHELL -ilc` the Mac app reads your PATH
 * from, so a tool installed with one can be missing from the daemon's PATH (#548). Their shim
 * folders are where it still is. (POSIX only: Windows starts apps with your PATH already.)
 */
export function versionManagerShimDirs(env: Readonly<Record<string, string | undefined>>, home: string): string[] {
  const p = path.posix;
  const mise = env.MISE_DATA_DIR || p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'mise');
  const asdf = env.ASDF_DATA_DIR || p.join(home, '.asdf');
  return [p.join(mise, 'shims'), p.join(asdf, 'shims')];
}

/** How the folder search lists a folder (tests hand a made-up one). It may throw: read as empty. */
export interface FolderReader {
  /** A folder's entries' names. */
  readonly list: (dir: string) => readonly string[];
}

const realDisk: FolderReader = { list: (dir) => readdirSync(dir) };

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)/;

/** Node versions in a version manager's folder (`v22.11.0`), the newest first. */
function nodeVersions(dir: string, fs: FolderReader): string[] {
  let names: readonly string[];
  try {
    names = fs.list(dir);
  } catch {
    return [];
  }
  const parts = (name: string): number[] => (VERSION.exec(name) ?? []).slice(1).map(Number);
  return names.filter((n) => VERSION.test(n)).sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    return (y[0]! - x[0]!) || (y[1]! - x[1]!) || (y[2]! - x[2]!);
  });
}

/**
 * Where `npm i -g` puts a command when it isn't Homebrew's Node (#568): under a Node version
 * manager (nvm's and fnm's versions, newest first; Volta's and pnpm's folders), a prefix you set
 * yourself (NPM_CONFIG_PREFIX, or the ~/.npm-global npm's docs suggest), and mise's and asdf's
 * shims. Never reads npm's config file: it can hold your registry tokens. Your shell adds these to PATH, but the Mac app falls back to a bare PATH when your
 * shell takes too long to say its own, and a lazily loaded nvm never adds them there. (POSIX only.)
 */
export function nodeGlobalBinDirs(env: Readonly<Record<string, string | undefined>>, home: string, platform: NodeJS.Platform = process.platform, fs: FolderReader = realDisk): string[] {
  const p = path.posix;
  const nvm = env.NVM_DIR || p.join(home, '.nvm');
  const fnmHomes = env.FNM_DIR ? [env.FNM_DIR] : [...(platform === 'darwin' ? [p.join(home, 'Library/Application Support/fnm')] : []), p.join(env.XDG_DATA_HOME || p.join(home, '.local/share'), 'fnm'), p.join(home, '.fnm')];
  const pnpm = env.PNPM_HOME || (platform === 'darwin' ? p.join(home, 'Library/pnpm') : p.join(env.XDG_DATA_HOME || p.join(home, '.local/share'), 'pnpm'));
  const prefixes = [env.NPM_CONFIG_PREFIX || env.npm_config_prefix, p.join(home, '.npm-global')].filter((d): d is string => !!d);
  const dirs = [
    ...prefixes.map((d) => p.join(d, 'bin')),
    p.join(env.VOLTA_HOME || p.join(home, '.volta'), 'bin'),
    pnpm,
    ...nodeVersions(p.join(nvm, 'versions/node'), fs).map((v) => p.join(nvm, 'versions/node', v, 'bin')),
    ...fnmHomes.flatMap((dir) => nodeVersions(p.join(dir, 'node-versions'), fs).map((v) => p.join(dir, 'node-versions', v, 'installation/bin'))),
    ...versionManagerShimDirs(env, home),
  ];
  return [...new Set(dirs)];
}

/** A mise shim, seen through its link: mise itself, a multi-call binary that reads its own name to know what to run. */
export const isMiseBinary = (realFile: string): boolean => /^mise(\.exe)?$/i.test(path.basename(realFile));

const WHICH_TIMEOUT_MS = 5_000;

const runs = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The installed tool a mise shim stands for, as mise picks it in `cwd` (a project may pin its own
 * version): `mise which <tool>`. Undefined when mise can't say.
 */
export function miseWhich(mise: string, tool: string, opts: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> }): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(mise, ['which', tool], { cwd: opts.cwd, env: { ...opts.env }, timeout: WHICH_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      const found = err ? undefined : stdout.split('\n')[0]?.trim();
      resolve(found && path.isAbsolute(found) && runs(found) ? found : undefined);
    });
  });
}
