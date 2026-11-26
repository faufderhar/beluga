import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunProcess } from '../../types.js';
import { endProcess, keepLines, niceForWorktree } from '../claude/claude-process.js';
import { codexCommand, pathVar } from '../codex/app-server.js';
import { CodexRpc } from '../codex/rpc.js';
import { type FolderReader, nodeGlobalBinDirs } from '../version-managers.js';
import { ACP_VERSION, type InitializeResponse } from './acp.js';

/** `opencode acp` for one run (or one side call): its JSON-RPC, its process, what it said it can do. */
export interface OpenCodeConnection {
  readonly rpc: CodexRpc;
  readonly proc: RunProcess;
  readonly init: InitializeResponse;
  /** Its last stderr lines, for a failure's details. */
  readonly stderr: () => readonly string[];
  /** Each line of its log as it's written (`--print-logs`, warnings and errors): a provider failing while OpenCode retries says so only there. */
  readonly onLog?: (fn: (line: string) => void) => void;
}

export interface OpenCodeConnectOptions {
  readonly cwd: string;
  /** Its whole environment (the run's env over Beluga's, with Beluga's config for it). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** OpenCode's own executable; unset: findOpenCode(). */
  readonly bin?: string;
  /** Without your OpenCode plugins (`--pure`): side calls, which only answer. */
  readonly pure?: boolean;
}

/** How a run reaches OpenCode: spawn it (tests hand a scripted one instead). */
export type OpenCodeConnect = (opts: OpenCodeConnectOptions) => Promise<OpenCodeConnection>;

const STDERR_KEEP = 40;
const INIT_TIMEOUT_MS = 30_000;

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where OpenCode is: BELUGA_OPENCODE_PATH, then where its install script puts it (~/.opencode/bin),
 * then `opencode` on PATH (npm, Homebrew, bun), then the folders the Mac app's PATH may not have:
 * Homebrew's, bun's, and npm's global ones under nvm, fnm, Volta, pnpm or a prefix of your own
 * (#568). On Windows, opencode.exe on PATH, else npm's opencode.cmd. Undefined: not installed.
 */
export function findOpenCode(env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform, runs: (file: string) => boolean = executable, home: string = os.homedir(), fs?: FolderReader): string | undefined {
  const set = env.BELUGA_OPENCODE_PATH;
  if (set) return runs(set) ? set : undefined;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = pathVar(env).split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform === 'win32') return [...dirs.map((dir) => p.join(dir, 'opencode.exe')), ...dirs.map((dir) => p.join(dir, 'opencode.cmd'))].find(runs);
  const own = p.join(home, '.opencode/bin/opencode');
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', p.join(home, '.bun/bin'), p.join(home, '.local/bin'), ...nodeGlobalBinDirs(env, home, platform, fs)];
  return [own, ...[...dirs, ...extra.filter((d) => !dirs.includes(d))].map((dir) => p.join(dir, 'opencode'))].find(runs);
}

export const OPENCODE_MISSING_WORDS = (where = process.platform === 'darwin' ? 'Mac' : 'computer'): string => `OpenCode isn’t installed on this ${where}. Install it (brew install sst/tap/opencode, or npm i -g opencode-ai), then try again.`;

/** Say hello as Beluga: required before any other request. No file or terminal access is offered: OpenCode uses its own tools, each one asked about. */
export async function acpHandshake(rpc: CodexRpc, version = '0'): Promise<InitializeResponse> {
  return rpc.request<InitializeResponse>('initialize', { protocolVersion: ACP_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'beluga', title: 'Beluga', version } }, INIT_TIMEOUT_MS);
}

/** Spawn `opencode acp` and shake hands. */
export const spawnOpenCode: OpenCodeConnect = async ({ cwd, env, bin, pure }) => {
  const command = bin ?? findOpenCode(env ?? process.env);
  if (!command) throw new Error(OPENCODE_MISSING_WORDS());
  // Its log on stderr (warnings and errors): over ACP, a provider that keeps failing is only retried, never said.
  const how = codexCommand(command, ['acp', '--print-logs', '--log-level', 'WARN', ...(pure ? ['--pure'] : [])]);
  const child = spawn(how.command, [...how.args], { cwd, env: { ...(env ?? process.env) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: how.shell });
  const lines: string[] = [];
  const watchers: Array<(line: string) => void> = [];
  let partial = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    keepLines(lines, chunk, STDERR_KEEP);
    const all = (partial + chunk).split('\n');
    partial = all.pop() ?? '';
    for (const line of all) for (const fn of watchers) fn(line);
  });
  const spawned = await new Promise<Error | undefined>((resolve) => {
    child.once('spawn', () => resolve(undefined));
    child.once('error', resolve);
  });
  if (spawned || child.pid === undefined) throw new Error(`Couldn’t start OpenCode (${spawned?.message ?? 'no process'}).`);
  niceForWorktree(child.pid, env);
  const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;
  const exited = running(child) ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve();
  const proc: RunProcess = { pid: child.pid, alive: () => running(child), kill: () => endProcess(child), exited };
  const rpc = new CodexRpc(child.stdout, child.stdin, { name: 'OpenCode', jsonrpc: true });
  try {
    const init = await acpHandshake(rpc);
    return { rpc, proc, init, stderr: () => lines, onLog: (fn) => void watchers.push(fn) };
  } catch (err) {
    await proc.kill();
    throw new Error(`OpenCode didn’t start: ${err instanceof Error ? err.message : String(err)}${lines.length ? ` (${lines.at(-1)})` : ''}`);
  }
};
