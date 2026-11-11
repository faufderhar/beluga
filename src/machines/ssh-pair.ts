import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Adding a computer you can already SSH into (BLG-781): a host name and one click, from the app
 * (Settings › Your Computers › Add Over SSH) or `beluga connect you@host --pair`. Over your own ssh
 * (your keys, your agent, ~/.ssh/config; BatchMode, so it never asks for or keeps a password), it
 * installs Beluga there when it's missing, starts it, and runs `beluga pair --computer --json`
 * there. Its link is joined here as any pairing is, and the four pictures it prints over SSH must
 * match the ones the link showed, before you're asked to add it.
 */

/** Where the install script links `beluga` (often not on PATH for a command run over ssh). */
const REMOTE_PATH = 'PATH="$HOME/.local/bin:$PATH"';
export const remoteBeluga = (command: string): string => `sh -c '${REMOTE_PATH} exec beluga ${command}'`;
export const INSTALL_LINE = 'curl -fsSL https://github.com/beluga-labs/beluga/releases/latest/download/install.sh | sh';
/** Keeps a dead link from hanging, and has ssh notice a dead network in under a minute. */
export const SSH_KEEPALIVE = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=20'] as const;
/** From the daemon nobody can type: keys and the agent only, never a password prompt. */
const BATCH = ['-o', 'BatchMode=yes'] as const;

/** A host ssh takes as a host, never as one of its options. */
export function checkHost(host: string): string {
  const h = host.trim();
  if (!h) throw new Error('Which computer? user@host, or a Host from ~/.ssh/config.');
  if (h.startsWith('-') || /\s/.test(h) || h.length > 255) throw new Error(`"${host}" isn't a host to connect to.`);
  return h;
}

/** The hosts named in an ssh config (`Host` lines; patterns with * ? or ! are left out). */
export function sshHosts(config: string): string[] {
  const out: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    for (const name of m[1]!.split(/\s+/)) if (!/[*?!]/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The hosts in ~/.ssh/config, to pick from. */
export function listSshHosts(home = os.homedir()): string[] {
  try {
    return sshHosts(readFileSync(path.join(home, '.ssh', 'config'), 'utf8'));
  } catch {
    return [];
  }
}

export interface Ran {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

export interface SshPairDeps {
  /** The ssh program. */
  readonly ssh: string;
  readonly signal?: AbortSignal;
  /** Says what it's doing ("Installing Beluga on mini…"). */
  readonly step?: (text: string) => void;
  /** How long to wait for the computer's pictures over SSH once the link answered. */
  readonly fingerprintWaitMs?: number;
}

/** Run one ssh command to its end. */
export function runSsh(ssh: string, args: readonly string[], signal?: AbortSignal): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(ssh, [...args], { stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => void (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => void (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const notInstalled = (r: Ran): boolean => r.code === 127 || /beluga: (command )?not found|not found: beluga/i.test(r.err);
const unreachable = (host: string, r: Ran): Error => new Error(`ssh couldn't reach ${host} with your keys:\n${r.err.trim() || `exit ${r.code}`}`);

/** What the computer said over SSH while it paired (`beluga pair --computer --json`). */
type PairLine = { link: string; code: string; expiresAt: number } | { waiting: string; fingerprint: string } | { end: string; app?: string };

/** A pairing open on the computer, over SSH: its link, and the pictures it shows once your app dials. */
export interface SshPairing {
  readonly link: string;
  /** The four pictures the computer printed, once it has (undefined if it didn't within the wait). */
  fingerprint(): Promise<string | undefined>;
  /** How it ended there (`joined`, `declined`…), once it has. */
  readonly ended: Promise<string>;
  /** Stop it (the pairing on the computer ends with its process). */
  stop(): void;
}

/**
 * Make sure Beluga is on `host` and running, then open a pairing there; resolves with its link
 * while the pairing waits for your app.
 */
export async function openSshPairing(hostTyped: string, deps: SshPairDeps): Promise<SshPairing> {
  const host = checkHost(hostTyped);
  const base = [...SSH_KEEPALIVE, ...BATCH, host];
  deps.step?.(`Looking for Beluga on ${host}…`);
  let version = await runSsh(deps.ssh, [...base, remoteBeluga('version')], deps.signal);
  if (notInstalled(version)) {
    deps.step?.(`Installing Beluga on ${host}…`);
    const installed = await runSsh(deps.ssh, [...base, INSTALL_LINE], deps.signal);
    if (installed.code !== 0) throw new Error(`Beluga couldn't be installed on ${host}:\n${(installed.err || installed.out).trim().slice(-600)}`);
    version = await runSsh(deps.ssh, [...base, remoteBeluga('version')], deps.signal);
  }
  if (version.code === 255) throw unreachable(host, version);
  if (version.code !== 0) throw new Error(`Beluga on ${host} didn't answer:\n${(version.err || version.out).trim().slice(-600)}`);
  deps.step?.(`Starting Beluga on ${host}…`);
  const up = await runSsh(deps.ssh, [...base, remoteBeluga('up')], deps.signal);
  if (up.code !== 0) throw new Error(`Beluga didn't start on ${host}:\n${(up.err || up.out).trim().slice(-600)}`);
  deps.step?.(`Opening a pairing on ${host}…`);
  return pairOver(deps, base, host);
}

/** `beluga pair --computer --json` on the computer, kept running while the pairing is open. */
function pairOver(deps: SshPairDeps, base: readonly string[], host: string): Promise<SshPairing> {
  const child: ChildProcess = spawn(deps.ssh, [...base, remoteBeluga('pair --computer --json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = (): void => void child.kill('SIGTERM');
  deps.signal?.addEventListener('abort', stop, { once: true });
  let err = '';
  child.stderr!.on('data', (d: Buffer) => void (err += d.toString()));
  let shown: ((fp: string) => void) | undefined;
  const fingerprint = new Promise<string>((r) => (shown = r));
  let finish!: (how: string) => void;
  const ended = new Promise<string>((r) => (finish = r));
  return new Promise((resolve, reject) => {
    let buffer = '';
    let opened = false;
    child.stdout!.on('data', (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        let msg: PairLine;
        try {
          msg = JSON.parse(line) as PairLine;
        } catch {
          continue;
        }
        if ('link' in msg && typeof msg.link === 'string' && !opened) {
          opened = true;
          resolve({
            link: msg.link,
            fingerprint: () => Promise.race([fingerprint, new Promise<undefined>((r) => void setTimeout(() => r(undefined), deps.fingerprintWaitMs ?? 5_000).unref())]),
            ended,
            stop,
          });
        } else if ('fingerprint' in msg && typeof msg.fingerprint === 'string') shown?.(msg.fingerprint);
        else if ('end' in msg && typeof msg.end === 'string') finish(msg.end);
      }
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      deps.signal?.removeEventListener('abort', stop);
      finish('closed');
      if (!opened) reject(code === 255 ? unreachable(host, { code, out: '', err }) : new Error(`No pairing from ${host}:\n${err.trim().slice(-600) || `exit ${code}`}`));
    });
  });
}
