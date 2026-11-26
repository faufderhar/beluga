import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDirArgs, findAcpCommand, spawnAcp } from '../acp/connection.js';
import type { AcpConnect, AcpConnectOptions, AcpConnection } from '../acp/spec.js';
import { rulesFreeArgs } from './rules-free.js';
import { AGY_MISSING_WORDS, ANTIGRAVITY } from './spec.js';

export { AGY_MISSING_WORDS };

/** `agy acp` for one run (or one side call): its JSON-RPC, its process, what it said it can do. */
export type AgyConnection = AcpConnection;
/**
 * How `agy acp` is started. A look, not a run (a status check, a quota read, a side call): nothing
 * of it is yours to keep, so its log (`acp-server-<time>-<pid>.log`) goes once it has stopped. A
 * run's log stays.
 */
export type AgyConnectOptions = AcpConnectOptions;
/** How a run reaches Antigravity: spawn it (tests hand a scripted one instead). */
export type AgyConnect = AcpConnect;

/** Where `agy acp` keeps its conversations: ~/.gemini/antigravity-cli. */
export function agyDataDir(home: string = os.homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli');
}

/** Where it writes a log per process, named by its pid. */
export const agyLogDir = (dir: string = agyDataDir()): string => path.join(dir, 'log');

/** Removes one process's own log (only one named for its pid). */
export async function dropAgyLog(pid: number, dir: string = agyLogDir()): Promise<number> {
  const mine = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith('acp-server-') && n.endsWith(`-${pid}.log`));
  await Promise.all(mine.map((n) => fs.rm(path.join(dir, n), { force: true }).catch(() => undefined)));
  return mine.length;
}

/**
 * Where the Antigravity CLI (`agy`) is: BELUGA_AGY_PATH, then `agy` on PATH, then its install
 * script's folder (~/.local/bin) and Homebrew's (the Mac app's PATH may not have them). On
 * Windows, agy.exe on PATH. Undefined: not installed.
 */
export function findAgy(env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform, runs?: (file: string) => boolean, home: string = os.homedir()): string | undefined {
  return findAcpCommand(ANTIGRAVITY, env, platform, runs, home);
}

/** Flags for a run: the folders it may work in besides its own (`--add-dir`, one each). */
export function agyArgs(opts: { readonly addDirs?: readonly string[] } = {}): string[] {
  return addDirArgs(ANTIGRAVITY, opts.addDirs ?? []);
}

/** Spawn `agy acp` and shake hands. It signs in with what Antigravity already has (its keyring): never here. A look's log goes once it has stopped. */
export const spawnAgy: AgyConnect = spawnAcp(ANTIGRAVITY, { afterLook: (pid) => dropAgyLog(pid), launch: () => rulesFreeArgs() });
