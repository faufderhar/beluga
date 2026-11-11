import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunProcess } from '../../types.js';
import { endProcess, keepLines, niceForWorktree } from '../claude/claude-process.js';
import { codexCommand, pathVar } from '../codex/app-server.js';
import { CodexRpc } from '../codex/rpc.js';
import type { InitializeResponse } from '../opencode/acp.js';
import { acpHandshake } from '../opencode/connection.js';

/** `copilot --acp` for one run (or one side call): its JSON-RPC, its process, what it said it can do. */
export interface CopilotConnection {
  readonly rpc: CodexRpc;
  readonly proc: RunProcess;
  readonly init: InitializeResponse;
  /** Its last stderr lines, for a failure's details. */
  readonly stderr: () => readonly string[];
}

export interface CopilotConnectOptions {
  readonly cwd: string;
  /** Its whole environment (the run's env over Beluga's, with Beluga's instructions folder for it). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Copilot's own executable; unset: findCopilot(). */
  readonly bin?: string;
  /** Flags for this process: its model and effort, the reads it turns down (copilotArgs). */
  readonly args?: readonly string[];
}

/** How a run reaches Copilot: spawn it (tests hand a scripted one instead). */
export type CopilotConnect = (opts: CopilotConnectOptions) => Promise<CopilotConnection>;

const STDERR_KEEP = 40;

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where GitHub Copilot CLI is: BELUGA_COPILOT_PATH, then `copilot` on PATH (npm, Homebrew's cask,
 * its install script), then Homebrew's, npm's and the install script's own folders (the Mac app's
 * PATH may not have them). On Windows, copilot.exe on PATH, else npm's copilot.cmd. Undefined: not installed.
 */
export function findCopilot(env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform, runs: (file: string) => boolean = executable, home: string = os.homedir()): string | undefined {
  const set = env.BELUGA_COPILOT_PATH;
  if (set) return runs(set) ? set : undefined;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = pathVar(env).split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform === 'win32') return [...dirs.map((dir) => p.join(dir, 'copilot.exe')), ...dirs.map((dir) => p.join(dir, 'copilot.cmd'))].find(runs);
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', p.join(home, '.local/bin'), p.join(home, '.npm-global/bin')];
  return [...dirs, ...extra.filter((d) => !dirs.includes(d))].map((dir) => p.join(dir, 'copilot')).find(runs);
}

export const COPILOT_MISSING_WORDS = (where = process.platform === 'darwin' ? 'Mac' : 'computer'): string => `GitHub Copilot CLI isn’t installed on this ${where}. Install it (brew install --cask copilot-cli, or npm i -g @github/copilot), then try again.`;

/**
 * Files Copilot reads without asking that Beluga keeps from it: inside the folder it reads freely
 * (only writes, and commands that change things, ask), so a .env or a key is turned down outright.
 * Its templates (.env.example) are turned down too: Copilot's rules can't tell them apart.
 */
export const SECRET_READS = ['read(.env)', 'read(.env.*)', 'read(*.pem)', 'read(*.key)', 'read(id_rsa)', 'read(id_ed25519)', 'read(~/.ssh/**)', 'read(~/.aws/**)', 'read(~/.config/gh/**)', 'read(~/.copilot/config.json)'];

/** The model you set in Copilot itself (COPILOT_MODEL, or `model` in ~/.copilot/settings.json), when there's one. */
export function ownModel(env: Readonly<Record<string, string | undefined>> = process.env, home: string = os.homedir()): string | undefined {
  if (env.COPILOT_MODEL) return env.COPILOT_MODEL;
  try {
    const text = readFileSync(path.join(env.COPILOT_HOME ?? path.join(home, '.copilot'), 'settings.json'), 'utf8');
    return /"model"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * A run's flags: the picked model, else the one you set in Copilot, else `auto` (Copilot Free
 * takes only auto, and its default model answers a Free account's session with a 403); the effort
 * when a model was picked (each model takes its own levels); the secret reads it turns down.
 */
export function copilotArgs(opts: { readonly model?: string; readonly effort?: string; readonly own?: string }): string[] {
  const model = opts.model ?? (opts.own ? undefined : 'auto');
  const effort = opts.model && opts.model !== 'auto' && opts.effort ? ['--reasoning-effort', opts.effort] : [];
  return [...(model ? ['--model', model] : []), ...effort, ...SECRET_READS.flatMap((rule) => ['--deny-tool', rule])];
}

/** Spawn `copilot --acp` and shake hands. Its own question form is off (`--no-ask-user`): it can't reach you over ACP, so it asks in its answer. */
export const spawnCopilot: CopilotConnect = async ({ cwd, env, bin, args = [] }) => {
  const command = bin ?? findCopilot(env ?? process.env);
  if (!command) throw new Error(COPILOT_MISSING_WORDS());
  const how = codexCommand(command, ['--acp', '--stdio', '--no-ask-user', ...args]);
  const child = spawn(how.command, [...how.args], { cwd, env: { ...(env ?? process.env) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: how.shell });
  const lines: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => keepLines(lines, chunk, STDERR_KEEP));
  const spawned = await new Promise<Error | undefined>((resolve) => {
    child.once('spawn', () => resolve(undefined));
    child.once('error', resolve);
  });
  if (spawned || child.pid === undefined) throw new Error(`Couldn’t start Copilot (${spawned?.message ?? 'no process'}).`);
  niceForWorktree(child.pid, env);
  const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;
  const exited = running(child) ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve();
  const proc: RunProcess = { pid: child.pid, alive: () => running(child), kill: () => endProcess(child), exited };
  const rpc = new CodexRpc(child.stdout, child.stdin, { name: 'Copilot', jsonrpc: true });
  try {
    const init = await acpHandshake(rpc);
    return { rpc, proc, init, stderr: () => lines };
  } catch (err) {
    await proc.kill();
    throw new Error(`Copilot didn’t start: ${err instanceof Error ? err.message : String(err)}${lines.length ? ` (${lines.at(-1)})` : ''}`);
  }
};
