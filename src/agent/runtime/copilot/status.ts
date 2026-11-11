import os from 'node:os';
import type { ConfigOption, SessionResponse } from '../opencode/acp.js';
import type { RuntimeStatus } from '../types.js';
import { type CopilotConnect, copilotArgs, findCopilot, spawnCopilot } from './connection.js';
import { dropCopilotSession } from './sessions.js';

export const COPILOT_MISSING = 'Install GitHub Copilot CLI: brew install --cask copilot-cli, or npm i -g @github/copilot';
export const COPILOT_SIGN_IN = 'Run copilot login in Terminal to sign in with your GitHub account';
export const COPILOT_NO_ACCESS = 'Your GitHub account has no Copilot here: turn on Copilot Free (or a plan) at github.com/settings/copilot';

/** Copilot's words for "nobody is signed in" (ACP's auth_required, -32000). */
export const COPILOT_SIGNED_OUT = /auth(entication)?[ _]required|not (logged|signed) in|no (github )?(token|credentials)|copilot login|401\b|unauthorized(?!: not authorized to use)/i;
/** A signed-in account Copilot won't serve (no Copilot on it, or not the model asked for). */
export const COPILOT_NOT_ALLOWED = /not authorized to use this copilot feature|403\b/i;

/** Copilot's Auto, which every plan takes (Free takes nothing else). */
export const AUTO_MODEL = { value: 'auto', label: 'Auto', description: 'Copilot picks the model' } as const;

/** A session's models as picker rows: Auto first, then each it offers. */
export function modelRows(options: readonly ConfigOption[] | undefined): RuntimeStatus['models'] {
  const offered = options?.find((o) => o.id === 'model' || o.category === 'model')?.options ?? [];
  return [AUTO_MODEL, ...offered.filter((o) => o.value !== 'auto').map((o) => ({ value: o.value, label: o.name, description: o.description ?? '' }))];
}

const CACHE_MS = 60_000;
let cached: { readonly at: number; readonly status: Promise<RuntimeStatus> } | undefined;

/**
 * Copilot on this Mac (BLG-873): not installed, not signed in (or an account with no Copilot), or
 * ready with its models. It opens a session to find out (no message is sent, so nothing is used
 * of your plan), then drops it. Kept a minute. Never signs in.
 */
export async function copilotStatus(deps: { readonly bin?: string; readonly connect?: CopilotConnect; readonly now?: number } = {}): Promise<RuntimeStatus> {
  const now = deps.now ?? Date.now();
  if (!deps.connect && cached && now - cached.at < CACHE_MS) return cached.status;
  const status = check(deps);
  if (!deps.connect) cached = { at: now, status };
  return status;
}

async function check(deps: { readonly bin?: string; readonly connect?: CopilotConnect }): Promise<RuntimeStatus> {
  const bin = deps.bin ?? (deps.connect ? undefined : findCopilot());
  if (!bin && !deps.connect) return { state: 'missing', fix: COPILOT_MISSING, models: [] };
  const cwd = os.tmpdir();
  // On Auto, which every plan takes: a 403 then means the account has no Copilot, not a model your plan lacks.
  const conn = await (deps.connect ?? spawnCopilot)({ cwd, args: copilotArgs({}), ...(bin ? { bin } : {}) }).catch(() => undefined);
  if (!conn) return { state: 'missing', fix: COPILOT_MISSING, models: [] };
  try {
    const s = await conn.rpc.request<SessionResponse>('session/new', { cwd, mcpServers: [] }, 30_000);
    if (s.sessionId && !deps.connect) void dropCopilotSession(s.sessionId).catch(() => false);
    return { state: 'ready', models: modelRows(s.configOptions) };
  } catch (err) {
    const words = err instanceof Error ? err.message : String(err);
    if (COPILOT_NOT_ALLOWED.test(words)) return { state: 'signed_out', fix: COPILOT_NO_ACCESS, models: [] };
    if (COPILOT_SIGNED_OUT.test(words)) return { state: 'signed_out', fix: COPILOT_SIGN_IN, models: [] };
    // Anything else (no network, a timeout): it's there and signed in as far as Beluga can tell; a run says what's wrong.
    return { state: 'ready', models: [AUTO_MODEL] };
  } finally {
    await conn.proc.kill();
  }
}
