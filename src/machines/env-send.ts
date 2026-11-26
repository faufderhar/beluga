import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type EnvSendAlways, type EnvSendAsk, type EnvSendChoice, MAX_ENV_SEND_BYTES, MAX_ENV_SEND_FILES } from '../shared/env-send.js';

export type { EnvSendAlways, EnvSendAsk, EnvSendChoice } from '../shared/env-send.js';
import { isEnvFileName, scanEnvFiles } from '../workspaces/env.js';
import { THIS_COMPUTER } from '../shared/assistant.js';

/**
 * A project's .env files for a worktree made on one of your computers (BLG-800). When your app makes
 * a worktree there (the door sees the call answered, door.ts) and the computer's project folder lacks
 * env files this Mac's has, you're asked with their names only: Send Once, Always for This Project,
 * or Don't Send. Sent over the same end-to-end link the app drives the computer on, and written 0600
 * into the computer's project folder (so its copyEnvFiles gives them to every new worktree) and into
 * the new worktree. Values are never logged, never in an ask, never on the phone.
 *
 * Only files env.ts calls env files go (templates skipped), and never what's refused whatever you
 * choose: keys and certificates, anything in .ssh, .aws or ~/.beluga, links (a .env pointing at a key).
 */

/** Folders whose files never leave this Mac, wherever they are in a path. */
const REFUSED_DIRS = new Set(['.ssh', '.aws', '.beluga', '.klaud', '.klaude', '.gnupg', '.kube', '.docker', '.azure', '.gcloud', '.config']);
/** Keys, certificates and credential stores by their names. */
const KEY_NAME = /^(id_[\w-]+|known_hosts|authorized_keys|credentials)$|\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|gpg|asc|ppk|kdbx|age)$/i;

/** Why a project-relative path never leaves this Mac (none: it may, when it's an env file). */
export function refusedEnvPath(rel: string): string | undefined {
  if (!rel || path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0')) return 'not a path inside the project';
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'not a path inside the project';
  if (parts.slice(0, -1).some((d) => REFUSED_DIRS.has(d))) return `keys and credentials stay on ${THIS_COMPUTER}`;
  const name = parts[parts.length - 1]!;
  if (KEY_NAME.test(name)) return `keys and certificates stay on ${THIS_COMPUTER}`;
  if (!isEnvFileName(name)) return 'only .env files are sent';
  return undefined;
}

/**
 * Why a file of this Mac (its whole path) never goes to a computer, whatever you say (a drop on a
 * chat there, BLG-854): keys and certificates, and anything in the credential folders above. None:
 * it may go (an env file only once you say so).
 */
export function refusedOnThisMac(absPath: string): string | undefined {
  const parts = absPath.split(/[\\/]/).filter(Boolean);
  if (parts.slice(0, -1).some((d) => REFUSED_DIRS.has(d))) return `keys and credentials stay on ${THIS_COMPUTER}`;
  if (KEY_NAME.test(parts.at(-1) ?? '')) return `keys and certificates stay on ${THIS_COMPUTER}`;
  return undefined;
}

/** `dir` is `top` or inside it. */
const inside = (top: string, dir: string): boolean => dir === top || dir.startsWith(top + path.sep);

/** Nothing in ~/.beluga leaves this Mac, wherever a project is. */
const belugaHome = (): string => path.join(os.homedir(), '.beluga');

/** The env files of a checkout that may be sent: what env.ts finds, less every refused path. */
export async function sendableEnvFiles(root: string): Promise<string[]> {
  return (await scanEnvFiles(root)).filter((rel) => !refusedEnvPath(rel));
}

export interface EnvFilePayload {
  readonly path: string;
  /** The file's bytes, base64. */
  readonly data: string;
}

/**
 * Read files to send, each checked again: a refused path, a link, something that isn't a plain file,
 * one too big, or one that leads outside the project is left out.
 */
export async function readForSending(root: string, files: readonly string[], home = belugaHome()): Promise<EnvFilePayload[]> {
  const top = await realpath(root);
  const beluga = await realpath(home).catch(() => home);
  const out: EnvFilePayload[] = [];
  for (const rel of files.slice(0, MAX_ENV_SEND_FILES)) {
    if (refusedEnvPath(rel)) continue;
    const file = path.join(root, rel);
    try {
      const st = await lstat(file);
      if (!st.isFile() || st.size > MAX_ENV_SEND_BYTES) continue;
      const real = await realpath(file);
      if (!inside(top, path.dirname(real)) || inside(beluga, real)) continue;
      out.push({ path: rel, data: (await readFile(file)).toString('base64') });
    } catch {
      // gone since it was listed
    }
  }
  return out;
}

/**
 * On the computer: write sent env files into each folder (its project folder, then the worktree),
 * 0600, never over a file that's there. Refused paths, and anything leading outside a folder, are
 * refused here too. → the paths written in the first folder that took them.
 */
export async function writeSentEnv(folders: readonly string[], files: readonly EnvFilePayload[]): Promise<string[]> {
  const written = new Set<string>();
  for (const dir of folders) {
    if (!existsSync(dir)) continue;
    const top = await realpath(dir);
    for (const f of files.slice(0, MAX_ENV_SEND_FILES)) {
      if (refusedEnvPath(f.path)) continue;
      const bytes = Buffer.from(f.data, 'base64');
      if (bytes.length > MAX_ENV_SEND_BYTES) continue;
      const target = path.join(top, f.path);
      // A folder on the way that's a link out of the project: nothing is made or written there.
      if (!inside(top, await realpath(await nearestThere(path.dirname(target))))) continue;
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (!inside(top, await realpath(path.dirname(target)))) continue;
      // 'wx': never over a file (or a link) that's there.
      const handle = await open(target, 'wx', 0o600).catch(() => undefined);
      if (!handle) continue;
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      await chmod(target, 0o600);
      written.add(f.path);
    }
  }
  return [...written].sort();
}

/** The nearest folder of `dir`'s that exists (itself, or a parent). */
async function nearestThere(dir: string): Promise<string> {
  let at = dir;
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}

/** "git@github.com:o/r.git", "https://github.com/o/r" → "github.com/o/r", to match a project across computers. */
export function sameRepoKey(url: string): string {
  return url
    .trim()
    .replace(/\.git\/?$/, '')
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** A project's origin URL (none: no git, or no origin). */
export function originOf(root: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile('git', ['config', '--get', 'remote.origin.url'], { cwd: root, timeout: 5_000, encoding: 'utf8' }, (err, out) => resolve(err ? undefined : out.trim() || undefined));
    child.stdin?.end();
  });
}

/** What a computer says about the project of a worktree just made there: names only. */
export interface EnvHere {
  readonly project: { readonly name: string; readonly remote?: string };
  readonly files: readonly string[];
}

interface LocalProject {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

export interface EnvSendDeps {
  /** Where Always for This Project is kept (~/.beluga/env-send.json). */
  readonly file: string;
  readonly projects: () => readonly LocalProject[];
  readonly machineName: (id: string) => string;
  /** A call on the computer over its link (door.ts). */
  readonly call: (machineId: string, method: string, args: readonly unknown[]) => Promise<unknown>;
  /** The asks now, for the app's screens (never the phone's). */
  readonly publish: (asks: readonly EnvSendAsk[]) => void;
  readonly origin?: (root: string) => Promise<string | undefined>;
  /** Names and counts only: a value never reaches it. */
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

export class EnvSend {
  private asks: EnvSendAsk[] = [];

  constructor(private readonly deps: EnvSendDeps) {}

  /** A worktree was made on a computer: send, ask, or nothing to do. */
  async offer(machineId: string, workspaceId: string): Promise<'none' | 'asked' | 'sent'> {
    const here = (await this.deps.call(machineId, 'machines.env.here', [workspaceId])) as EnvHere | undefined;
    if (!here?.project) return 'none';
    const local = await this.localProject(here.project);
    if (!local) return 'none';
    const theirs = new Set(here.files);
    const files = (await sendableEnvFiles(local.root)).filter((f) => !theirs.has(f));
    if (!files.length) return 'none';
    if (this.always().some((a) => a.root === local.root)) {
      await this.send(machineId, [workspaceId], local.root, files);
      return 'sent';
    }
    const same = this.asks.find((a) => a.machineId === machineId && a.projectId === local.id);
    const ask: EnvSendAsk = same
      ? { ...same, workspaceIds: [...new Set([...same.workspaceIds, workspaceId])], files: [...new Set([...same.files, ...files])].sort() }
      : { id: randomUUID(), machineId, machineName: this.deps.machineName(machineId), workspaceIds: [workspaceId], projectId: local.id, projectName: local.name, files, at: (this.deps.now ?? Date.now)() };
    this.asks = [...this.asks.filter((a) => a !== same), ask];
    this.deps.publish(this.asks);
    return 'asked';
  }

  /** Your answer to an ask → the files sent (none for Don't Send). */
  async decide(askId: string, choice: EnvSendChoice): Promise<{ sent: string[] }> {
    const ask = this.asks.find((a) => a.id === askId);
    if (!ask) throw new Error('That ask was already answered');
    this.asks = this.asks.filter((a) => a !== ask);
    this.deps.publish(this.asks);
    if (choice === 'never') return { sent: [] };
    const local = this.deps.projects().find((p) => p.id === ask.projectId);
    if (!local) throw new Error(`${ask.projectName} is no longer a project here`);
    if (choice === 'always') this.keep([...this.always().filter((a) => a.root !== local.root), { root: local.root, name: local.name, at: (this.deps.now ?? Date.now)() }]);
    return { sent: await this.send(ask.machineId, ask.workspaceIds, local.root, ask.files) };
  }

  list(): readonly EnvSendAsk[] {
    return this.asks;
  }

  /** The projects set to Always for This Project. */
  always(): EnvSendAlways[] {
    try {
      const raw = JSON.parse(readFileSync(this.deps.file, 'utf8')) as { always?: EnvSendAlways[] };
      return Array.isArray(raw.always) ? raw.always.filter((a) => typeof a?.root === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Take Always back for a project: asked again next time. */
  forget(root: string): EnvSendAlways[] {
    this.keep(this.always().filter((a) => a.root !== root));
    return this.always();
  }

  private keep(always: readonly EnvSendAlways[]): void {
    writeFileSync(this.deps.file, `${JSON.stringify({ always }, null, 2)}\n`, { mode: 0o600 });
  }

  private async send(machineId: string, workspaceIds: readonly string[], root: string, files: readonly string[]): Promise<string[]> {
    const payload = await readForSending(root, files);
    if (!payload.length) return [];
    const res = (await this.deps.call(machineId, 'machines.env.receive', [workspaceIds, payload])) as { written?: string[] } | undefined;
    const written = res?.written ?? [];
    this.deps.log?.(`env-send: ${written.length} env file(s) written on ${this.deps.machineName(machineId)}: ${written.join(', ')}`);
    return written;
  }

  /** This Mac's project for theirs: the same origin, else (neither has one) the same name. */
  private async localProject(theirs: EnvHere['project']): Promise<LocalProject | undefined> {
    const projects = this.deps.projects();
    const origin = this.deps.origin ?? originOf;
    if (theirs.remote) {
      const key = sameRepoKey(theirs.remote);
      const same: LocalProject[] = [];
      for (const p of projects) {
        const mine = await origin(p.root);
        if (mine && sameRepoKey(mine) === key) same.push(p);
      }
      return same.find((p) => p.name.toLowerCase() === theirs.name.toLowerCase()) ?? same[0];
    }
    for (const p of projects) if (p.name.toLowerCase() === theirs.name.toLowerCase() && !(await origin(p.root))) return p;
    return undefined;
  }
}

/** Which EnvSend serves a session (the app's daemon), so the API reaches it. */
const all = new WeakMap<object, EnvSend>();
export const attachEnvSend = (session: object, envSend: EnvSend): void => void all.set(session, envSend);
export function needEnvSend(session: object): EnvSend {
  const it = all.get(session);
  if (!it) throw new Error('Sending env files to your computers needs the Beluga daemon running.');
  return it;
}

interface Projects {
  readonly projects: readonly { readonly name: string; readonly root: string; readonly workspaces: readonly { readonly id: string; readonly path: string }[] }[];
}

/** On the computer: the project of a worktree made here, and the env files its folder has (names only). */
export async function envHere(state: Projects, workspaceId: string): Promise<EnvHere | undefined> {
  const project = state.projects.find((p) => p.workspaces.some((w) => w.id === workspaceId));
  if (!project) return undefined;
  const remote = await originOf(project.root);
  return { project: { name: project.name, ...(remote ? { remote } : {}) }, files: await scanEnvFiles(project.root) };
}

/** On the computer: env files your app sent, into each worktree's project folder and the worktree itself. */
export async function receiveEnv(state: Projects, workspaceIds: readonly string[], files: readonly EnvFilePayload[]): Promise<{ written: string[] }> {
  const folders: string[] = [];
  for (const id of workspaceIds) {
    const project = state.projects.find((p) => p.workspaces.some((w) => w.id === id));
    const ws = project?.workspaces.find((w) => w.id === id);
    if (!project || !ws) continue;
    for (const dir of [project.root, ws.path]) if (!folders.includes(dir)) folders.push(dir);
  }
  if (!folders.length) throw new Error('That worktree is gone from this computer');
  return { written: await writeSentEnv(folders, files) };
}
