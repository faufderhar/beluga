import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunProcess } from '../../types.js';
import { endProcess, keepLines, niceForWorktree } from '../claude/claude-process.js';
import { codexCommand, pathVar } from '../codex/app-server.js';
import { CodexRpc } from '../codex/rpc.js';
import { acpHandshake } from '../opencode/connection.js';
import type { AcpExtension } from './extension.js';
import { endGroup, groupOf, ownGroups } from './group.js';
import type { AcpAgentSpec, AcpConnect, AcpConnection } from './spec.js';
import { acpWire } from './wire.js';

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
 * Where an ACP agent's executable is: its variable (`pathVar`) outright, then PATH, then its own
 * folders (`searchDirs`: the Mac app's PATH may not have them). On Windows, its `.exe`. Undefined:
 * not installed.
 */
export function findAcpCommand(spec: Pick<AcpAgentSpec, 'command' | 'pathVar' | 'searchDirs'>, env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform, runs: (file: string) => boolean = executable, home: string = os.homedir()): string | undefined {
  const set = spec.pathVar ? env[spec.pathVar] : undefined;
  if (set) return runs(set) ? set : undefined;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = pathVar(env).split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const extra = (spec.searchDirs?.(platform, home) ?? []).filter((d) => !dirs.includes(d));
  const name = platform === 'win32' ? `${spec.command}.exe` : spec.command;
  return [...dirs, ...extra].map((dir) => p.join(dir, name)).find(runs);
}

/** Flags for a run: the folders it may work in besides its own (its `addDirFlag`, one each). */
export function addDirArgs(spec: Pick<AcpAgentSpec, 'addDirFlag'>, dirs: readonly string[]): string[] {
  const flag = spec.addDirFlag;
  return flag ? dirs.flatMap((dir) => [flag, dir]) : [];
}

/** How long a process gets to go on SIGTERM before what's left is killed outright. */
const GRACE_MS = 2_000;

/** Resolves once `p` is there, or after `ms`. */
const within = (p: Promise<void>, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void p.then(() => (clearTimeout(timer), resolve()));
  });

/**
 * Spawn an ACP agent's server and shake hands. It signs in with what it already has: never here.
 * Its line goes through the wire (wire.ts): a stuck run or a sign-in it waits on ends with why.
 * On macOS and Linux it gets a process group of its own, and ending it ends what it started too.
 */
export function spawnAcp(spec: AcpAgentSpec, hooks: Pick<AcpExtension, 'afterLook' | 'launch'> = {}): AcpConnect {
  const start = startAcp(spec, hooks);
  return async (opts) => {
    const command = opts.bin ?? findAcpCommand(spec, opts.env ?? process.env);
    if (!command) throw new Error(spec.missingWords(process.platform === 'darwin' ? 'Mac' : 'computer'));
    if (older.has(command)) return start(command, [], opts);
    const newer = (await hooks.launch?.().catch(() => undefined)) ?? [];
    if (!newer.length) return start(command, [], opts);
    try {
      return await start(command, newer, opts);
    } catch (err) {
      if (!(err instanceof UnknownFlagError)) throw err;
      older.add(command);
      return start(command, [], opts);
    }
  };
}

/** An agent that wouldn't start because it doesn't know a flag it was given. */
class UnknownFlagError extends Error {}

/** What a command-line tool says of a flag it doesn't take (Go's flag package, and the usual words). */
export const UNKNOWN_FLAG = /provided but not defined|unknown (flag|option|argument)|unrecognized (flag|option|argument)|unexpected argument/i;

/** Executables that didn't take their extension's `launch` flags: started without them from then on. */
const older = new Set<string>();

/** One start of an agent's server, with `newer` (its extension's launch flags) after its own args. */
function startAcp(spec: AcpAgentSpec, hooks: Pick<AcpExtension, 'afterLook'>) {
  return async (command: string, newer: readonly string[], { cwd, env, args = [], look = false }: Parameters<AcpConnect>[0]): Promise<AcpConnection> => {
    const how = codexCommand(command, [...spec.args, ...newer, ...args]);
    const grouped = ownGroups() && !how.shell;
    const child = spawn(how.command, [...how.args], { cwd, env: { ...(env ?? process.env), ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: how.shell, detached: grouped });
    const lines: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => keepLines(lines, chunk, STDERR_KEEP));
    const stderrDone = new Promise<void>((resolve) => child.stderr.once('close', () => resolve()));
    const spawned = await new Promise<Error | undefined>((resolve) => {
      child.once('spawn', () => resolve(undefined));
      child.once('error', resolve);
    });
    if (spawned || child.pid === undefined) throw new Error(`Couldn’t start ${spec.label} (${spawned?.message ?? 'no process'}).`);
    niceForWorktree(child.pid, env);
    const pid = child.pid;
    const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;
    const exited = running(child) ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve();
    let ending: Promise<void> | undefined;
    /** Ends it for sure: its whole group where it has one (what it left running too), else the one process. */
    const endAll = (): Promise<void> =>
      (ending ??= (async () => {
        if (!grouped) return endProcess(child, GRACE_MS);
        await endGroup(groupOf(pid), GRACE_MS);
        if (running(child)) await endProcess(child, GRACE_MS);
        await within(exited, GRACE_MS);
      })());
    const proc: RunProcess = { pid, alive: () => running(child), kill: () => endAll().then(() => void (look && hooks.afterLook?.(pid))), exited };
    const wire = acpWire(child.stdout, child.stdin, { label: spec.label, signInFix: spec.signInFix, ...(spec.limits ? { limits: spec.limits } : {}), end: () => void proc.kill() });
    /** How it exited, when it did on its own: said when nothing here knows better. */
    let exitWhy: string | undefined;
    child.once('exit', (code, signal) => {
      wire.stop();
      exitWhy = `${spec.label} exited before the turn ended (${signal ? `stopped by ${signal}` : `exit code ${code}`})`;
      // What it started may still be there: a group's leftovers go with it.
      if (grouped) void endAll();
    });
    const cause = (): string | undefined => wire.cause() ?? exitWhy;
    const rpc = new CodexRpc(wire.fromAgent, wire.toAgent, { name: spec.label, jsonrpc: true });
    try {
      const init = await acpHandshake(rpc);
      return { rpc, proc, init, stderr: () => lines, cause: () => (rpc.isClosed ? cause() : wire.cause()), onNotice: wire.onNotice };
    } catch (err) {
      await proc.kill();
      // What it said on its way out (a flag it doesn't know) may come in after it exited.
      await Promise.race([stderrDone, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      if (newer.length && lines.some((l) => UNKNOWN_FLAG.test(l))) throw new UnknownFlagError(lines.find((l) => UNKNOWN_FLAG.test(l)));
      throw new Error(`${spec.label} didn’t start: ${wire.cause() ?? (err instanceof Error ? err.message : String(err))}${lines.length ? ` (${lines.at(-1)})` : ''}`);
    }
  };
}
