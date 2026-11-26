import os from 'node:os';
import type { RuntimeStatus } from '../types.js';
import { findAcpCommand, spawnAcp } from './connection.js';
import type { AcpExtension } from './extension.js';
import { type AcpSession, acpSignedOut, sessionModelRows } from './parts.js';
import type { AcpAgentSpec, AcpConnect } from './spec.js';

export interface AcpStatusDeps {
  readonly bin?: string;
  readonly connect?: AcpConnect;
  /** Drops the session it opened to look (tests: a fake; none with a scripted `connect`, else the extension's). */
  readonly drop?: (sessionId: string) => Promise<unknown>;
  readonly now?: number;
}

const CACHE_MS = 60_000;
const cached = new Map<string, { readonly at: number; readonly status: Promise<RuntimeStatus> }>();

/**
 * An ACP agent on this computer: not installed, not signed in, or ready with the models it offers.
 * It opens a session to find out (no message is sent, so nothing of your quota is used), then drops
 * it. Kept a minute per agent. Never signs in.
 */
export async function acpStatus(spec: AcpAgentSpec, ext: Pick<AcpExtension, 'dropSession' | 'afterLook' | 'defaultModel' | 'launch'>, deps: AcpStatusDeps = {}): Promise<RuntimeStatus> {
  const now = deps.now ?? Date.now();
  const hit = cached.get(spec.id);
  if (!deps.connect && hit && now - hit.at < CACHE_MS) return hit.status;
  const status = check(spec, ext, deps);
  if (!deps.connect) cached.set(spec.id, { at: now, status });
  return status;
}

async function check(spec: AcpAgentSpec, ext: Pick<AcpExtension, 'dropSession' | 'afterLook' | 'defaultModel' | 'launch'>, deps: AcpStatusDeps): Promise<RuntimeStatus> {
  const bin = deps.bin ?? (deps.connect ? undefined : findAcpCommand(spec));
  if (!bin && !deps.connect) return { state: 'missing', fix: spec.installFix, models: [] };
  const cwd = os.tmpdir();
  const conn = await (deps.connect ?? spawnAcp(spec, ext))({ cwd, look: true, ...(bin ? { bin } : {}) }).catch(() => undefined);
  if (!conn) return { state: 'missing', fix: spec.installFix, models: [] };
  /** The session it opened to look: dropped once the agent has stopped, or it would write it back as it exits. */
  let opened: string | undefined;
  const drop = deps.drop ?? (deps.connect || !ext.dropSession ? undefined : (id: string) => ext.dropSession!(id));
  try {
    const s = await conn.rpc.request<AcpSession>('session/new', { cwd, mcpServers: [] }, 60_000);
    opened = s.sessionId;
    return { state: 'ready', models: sessionModelRows(s, ext.defaultModel) };
  } catch (err) {
    if (acpSignedOut(err)) return { state: 'signed_out', fix: spec.signInFix, models: [] };
    // Anything else (no network, a timeout): it's there and signed in as far as Beluga can tell; a run says what's wrong.
    return { state: 'ready', models: ext.defaultModel ? sessionModelRows(undefined, true) : [] };
  } finally {
    await conn.proc.kill();
    if (opened && drop) void drop(opened).catch(() => false);
  }
}

/** Forget what was found (an agent just added, installed or removed): the next look asks again. */
export function forgetAcpStatus(): void {
  cached.clear();
}
