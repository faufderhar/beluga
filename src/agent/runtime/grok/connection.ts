import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunProcess } from '../../types.js';
import { endProcess, keepLines, niceForWorktree } from '../claude/claude-process.js';
import { codexCommand, pathVar } from '../codex/app-server.js';
import { CodexRpc } from '../codex/rpc.js';
import type { InitializeResponse } from '../opencode/acp.js';
import { acpHandshake } from '../opencode/connection.js';

/** One model as `initialize` lists it. */
export interface GrokModel {
  readonly modelId: string;
  readonly name?: string;
  readonly description?: string;
  readonly _meta?: {
    readonly totalContextTokens?: number;
    readonly reasoningEfforts?: ReadonlyArray<{ readonly value: string }>;
  };
}

/** What `initialize` says beyond ACP's own fields (recorded from Grok Build 1.0.77). */
export interface GrokInit extends InitializeResponse {
  readonly _meta?: {
    /** "cached_token" once you've signed in; null when you haven't. */
    readonly defaultAuthMethodId?: string | null;
    readonly modelState?: { readonly currentModelId?: string; readonly availableModels?: readonly GrokModel[] };
  };
}

/** `grok agent stdio` for one run (or one side call): its JSON-RPC, its process, what it said it can do. */
export interface GrokConnection {
  readonly rpc: CodexRpc;
  readonly proc: RunProcess;
  readonly init: GrokInit;
  /** Its last stderr lines, for a failure's details. */
  readonly stderr: () => readonly string[];
}

export interface GrokConnectOptions {
  readonly cwd: string;
  /** Its whole environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Grok's own executable; unset: findGrok(). */
  readonly bin?: string;
  /** Without the hook that makes every tool ask (only for asking what it offers: no session runs). */
  readonly ungated?: boolean;
}

/** How a run reaches Grok: spawn it (tests hand a scripted one instead). */
export type GrokConnect = (opts: GrokConnectOptions) => Promise<GrokConnection>;

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
 * Where Grok Build is: BELUGA_GROK_PATH, then where its installer puts it (~/.grok/bin), then
 * `grok` on PATH, then Homebrew's and the usual folders (the Mac app's PATH may not have them).
 * On Windows, grok.exe on PATH or in %USERPROFILE%\.grok\bin. Undefined: not installed.
 */
export function findGrok(env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform, runs: (file: string) => boolean = executable, home: string = os.homedir()): string | undefined {
  const set = env.BELUGA_GROK_PATH;
  if (set) return runs(set) ? set : undefined;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = pathVar(env).split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const own = p.join(home, '.grok/bin');
  if (platform === 'win32') return [own, ...dirs].map((dir) => p.join(dir, 'grok.exe')).find(runs);
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', p.join(home, '.local/bin')];
  return [own, ...dirs, ...extra.filter((d) => !dirs.includes(d))].map((dir) => p.join(dir, 'grok')).find(runs);
}

export const GROK_MISSING_WORDS = (where = process.platform === 'darwin' ? 'Mac' : 'computer'): string => `Grok Build isn’t installed on this ${where}. Install it (curl -fsSL https://x.ai/cli/install.sh | bash), then try again.`;

/**
 * Grok's hook that puts every tool call to Beluga. On its own Grok runs what it thinks is read-only
 * without asking (`read_file`, `grep`, `cat`, a command you once "always allowed"), so Beluga could
 * never turn down a read of a .env file. A PreToolUse hook answering `ask` sends every call,
 * those too, to `session/request_permission` (docs: 10-hooks.md, "Ask the user"). It's a plugin for
 * this one process (`--plugin-dir`, trusted because the caller names it): your Grok is unchanged.
 */
export function writeGatePlugin(parent: string = os.tmpdir(), node: string = process.execPath): string {
  const dir = mkdtempSync(path.join(parent, 'beluga-grok-gate-'));
  mkdirSync(path.join(dir, 'hooks'));
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'beluga-gate', version: '1.0.0', description: 'Puts every tool call to Beluga first.' }));
  const ask = `console.log(${JSON.stringify(JSON.stringify({ decision: 'ask', reason: 'Beluga decides' }))})`;
  writeFileSync(path.join(dir, 'hooks/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: node, args: ['-e', ask] }] }] } }));
  return dir;
}

/** Spawn `grok agent stdio` and shake hands. Its own process always (no shared leader), so killing it ends its tools. */
export const spawnGrok: GrokConnect = async ({ cwd, env, bin, ungated }) => {
  const command = bin ?? findGrok(env ?? process.env);
  if (!command) throw new Error(GROK_MISSING_WORDS());
  const gate = ungated ? undefined : writeGatePlugin();
  const dropGate = (): void => {
    if (gate) rmSync(gate, { recursive: true, force: true });
  };
  const how = codexCommand(command, ['agent', '--no-leader', ...(gate ? ['--plugin-dir', gate] : []), 'stdio']);
  const child = spawn(how.command, [...how.args], { cwd, env: { ...(env ?? process.env) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: how.shell });
  const lines: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => keepLines(lines, chunk, STDERR_KEEP));
  const spawned = await new Promise<Error | undefined>((resolve) => {
    child.once('spawn', () => resolve(undefined));
    child.once('error', resolve);
  });
  if (spawned || child.pid === undefined) {
    dropGate();
    throw new Error(`Couldn’t start Grok Build (${spawned?.message ?? 'no process'}).`);
  }
  niceForWorktree(child.pid, env);
  const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;
  const exited = running(child) ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve();
  const proc: RunProcess = { pid: child.pid, alive: () => running(child), kill: () => endProcess(child).finally(dropGate), exited };
  const rpc = new CodexRpc(child.stdout, child.stdin, { name: 'Grok Build', jsonrpc: true });
  try {
    const init = (await acpHandshake(rpc)) as GrokInit;
    return { rpc, proc, init, stderr: () => lines };
  } catch (err) {
    await proc.kill();
    throw new Error(`Grok Build didn’t start: ${err instanceof Error ? err.message : String(err)}${lines.length ? ` (${lines.at(-1)})` : ''}`);
  }
};
