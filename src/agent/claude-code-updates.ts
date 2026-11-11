import { rm } from 'node:fs/promises';
import path from 'node:path';
import { belugaHome } from '../core/home.js';
import { type ClaudeCodePin, claudeCodeBinary, claudeCodeDir, claudeCodePin, currentClaudeCode, installClaudeCode, newerVersion, recordClaudeCode, sameLine, skippedClaudeCode } from './claude-code.js';

/**
 * Claude Code kept current, quietly (BLG-873). A build pins the Claude Code it was made with; a
 * newer one in the same line (0.3.x, the line the build's SDK speaks) is fetched from the same npm
 * package, checked against npm's integrity, and started once with the SDK (asking for its models,
 * no message sent). Only one that answers is used, from the next run on: new models (a new Opus)
 * and the aliases that name them ("opus", the default) come with it, with no Beluga update and
 * nothing to do. One that fails its check is never tried again; the pin always stays as the fallback.
 */

/** npm's latest of this platform's Claude Code package, as a pin (undefined: couldn't ask). */
export async function latestClaudeCode(get: (url: string) => Promise<unknown> = getJson, platform: string = process.platform, arch: string = process.arch): Promise<ClaudeCodePin | undefined> {
  const name = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const meta = (await get(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`).catch(() => undefined)) as { version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } } | undefined;
  const version = meta?.version;
  const url = meta?.dist?.tarball;
  const integrity = meta?.dist?.integrity;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  if (typeof url !== 'string' || !url.startsWith('https://registry.npmjs.org/')) return undefined;
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) return undefined;
  return { version, url, integrity };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`npm said ${res.status}`);
  return res.json();
}

export type UpdateOutcome = 'updated' | 'current' | 'skipped' | 'failed';

export interface UpdateDeps {
  /** The build's pin (unset: this build's own claude-code.json). */
  readonly pin?: ClaudeCodePin;
  readonly home?: string;
  readonly latest?: () => Promise<ClaudeCodePin | undefined>;
  readonly install?: typeof installClaudeCode;
  /** Whether Beluga's SDK can run this binary (runtime/claude/probe.ts). */
  readonly works: (bin: string) => Promise<boolean>;
}

let running: Promise<UpdateOutcome> | undefined;

/**
 * Move to npm's newest Claude Code in the pin's line, when it's newer than the one in use and it
 * checks out. `updated`: the next run uses it (refresh the model list); `current`: nothing newer
 * (or no pin: development runs the SDK's own); `skipped`: it failed here before; `failed`: it
 * didn't check out now, and won't be tried again. One update at a time.
 */
export function updateClaudeCode(deps: UpdateDeps): Promise<UpdateOutcome> {
  running ??= update(deps).finally(() => (running = undefined));
  return running;
}

async function update(deps: UpdateDeps): Promise<UpdateOutcome> {
  const pin = deps.pin ?? claudeCodePin();
  if (!pin) return 'current';
  const home = deps.home ?? belugaHome();
  const now = currentClaudeCode(pin, home) ?? pin;
  const latest = await (deps.latest ?? latestClaudeCode)();
  if (!latest || !sameLine(latest.version, pin.version) || !newerVersion(latest.version, now.version)) return 'current';
  if (skippedClaudeCode(home).includes(latest.version)) return 'skipped';
  let bin: string;
  try {
    bin = await (deps.install ?? installClaudeCode)(latest, { home, keep: [pin.version, now.version] });
  } catch {
    // A download that failed (offline, a mismatch) is tried again next time.
    return 'failed';
  }
  if (!(await deps.works(bin).catch(() => false))) {
    recordClaudeCode(home, { skipped: latest.version });
    await rm(path.dirname(claudeCodeBinary(latest, home)), { recursive: true, force: true });
    return 'failed';
  }
  recordClaudeCode(home, { current: latest });
  // The one it moved on from goes, unless it's the pin (the fallback).
  if (now.version !== pin.version) await rm(path.join(claudeCodeDir(home), now.version), { recursive: true, force: true });
  return 'updated';
}
