import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunProcess } from '../../types.js';
import { endProcess, keepLines, niceForWorktree } from '../claude/claude-process.js';
import { CodexRpc } from './rpc.js';

/** `codex app-server` for one run (or one side call): its JSON-RPC and its process. */
export interface CodexConnection {
  readonly rpc: CodexRpc;
  readonly proc: RunProcess;
  /** Its last stderr lines, for a failure's details. */
  readonly stderr: () => readonly string[];
}

export interface ConnectOptions {
  readonly cwd: string;
  /** Its whole environment (the run's env over Beluga's). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Codex's own executable; unset: findCodex(). */
  readonly bin?: string;
  /** Your own `codex` flags (Settings › Agents › Launch flags), on your own runs only. */
  readonly args?: readonly string[];
}

/** How a Codex run reaches its app-server: spawn it (tests hand a scripted one instead). */
export type CodexConnect = (opts: ConnectOptions) => Promise<CodexConnection>;

const STDERR_KEEP = 40;
const INIT_TIMEOUT_MS = 20_000;

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** PATH as Windows may spell it ("Path"): its variable names are the same in any letter case. */
export const pathVar = (env: Readonly<Record<string, string | undefined>>): string => env.PATH ?? Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';

/**
 * Where Codex is: BELUGA_CODEX_PATH, then the Codex app's own binary (self-contained), then `codex`
 * on PATH (the npm shim, which can lose its platform binary on an upgrade). On Windows, codex.exe
 * on PATH, else npm's codex.cmd (never the extensionless shim npm puts beside it, a script for
 * sh that Windows can't start). Undefined: not installed.
 */
export function findCodex(env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform, runs: (file: string) => boolean = executable): string | undefined {
  const set = env.BELUGA_CODEX_PATH;
  if (set) return runs(set) ? set : undefined;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = pathVar(env).split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform === 'win32') {
    const exes = dirs.map((dir) => p.join(dir, 'codex.exe'));
    const shims = dirs.map((dir) => p.join(dir, 'codex.cmd'));
    return [...exes, ...shims].find(runs);
  }
  const apps = ['/Applications/Codex.app/Contents/Resources/codex', path.join(os.homedir(), 'Applications/Codex.app/Contents/Resources/codex')];
  return [...apps, ...dirs.map((dir) => p.join(dir, 'codex'))].find(runs);
}

/** A Windows batch file (npm's codex.cmd): only cmd.exe starts one. */
const isBatch = (file: string): boolean => /\.(cmd|bat)$/i.test(file);

/**
 * How to start `file` with `args`: as it is, or for a .cmd/.bat through cmd.exe (shell), with the
 * file and every argument in double quotes so spaces ("C:\Program Files") and cmd's own
 * characters (&, |, ^) stay part of them.
 */
export function codexCommand(file: string, args: readonly string[]): { readonly command: string; readonly args: readonly string[]; readonly shell: boolean } {
  if (!isBatch(file)) return { command: file, args, shell: false };
  const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  return { command: [file, ...args].map(quote).join(' '), args: [], shell: true };
}

/** Say hello as Beluga: required before any other request. */
export async function handshake(rpc: CodexRpc, version = '0'): Promise<void> {
  await rpc.request('initialize', { clientInfo: { name: 'beluga', title: 'Beluga', version }, capabilities: null }, INIT_TIMEOUT_MS);
  rpc.notify('initialized');
}

/** `codex app-server`'s arguments: your flags first, where codex reads its global options (`-c key=value`). */
export const appServerArgs = (extra: readonly string[] = []): string[] => [...extra, 'app-server'];

/** Spawn `codex app-server` and shake hands. */
export const spawnAppServer: CodexConnect = async ({ cwd, env, bin, args }) => {
  const command = bin ?? findCodex(env ?? process.env);
  if (!command) throw new Error(`Codex isn’t installed on this ${process.platform === 'darwin' ? 'Mac' : 'computer'}. Install the Codex app or \`npm i -g @openai/codex\`, then try again.`);
  // The real file, not a link to it: Codex runs itself again under the sandbox by this path, and a link in your home would be out of reach below full.
  const how = codexCommand(realPathOf(command), appServerArgs(args));
  const child = spawn(how.command, [...how.args], { cwd, env: { ...(env ?? process.env) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: how.shell });
  const lines: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => keepLines(lines, chunk, STDERR_KEEP));
  const spawned = await new Promise<Error | undefined>((resolve) => {
    child.once('spawn', () => resolve(undefined));
    child.once('error', resolve);
  });
  if (spawned || child.pid === undefined) throw new Error(`Couldn’t start Codex (${spawned?.message ?? 'no process'}).`);
  niceForWorktree(child.pid, env);
  const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;
  const exited = running(child) ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve();
  const proc: RunProcess = { pid: child.pid, alive: () => running(child), kill: () => endProcess(child), exited };
  const rpc = new CodexRpc(child.stdout, child.stdin);
  try {
    await handshake(rpc);
  } catch (err) {
    await proc.kill();
    throw new Error(`Codex didn’t start: ${err instanceof Error ? err.message : String(err)}${lines.length ? ` (${lines.at(-1)})` : ''}`);
  }
  return { rpc, proc, stderr: () => lines };
};

function realPathOf(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}
