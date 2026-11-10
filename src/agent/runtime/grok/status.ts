import type { RuntimeStatus } from '../types.js';
import { findGrok } from './connection.js';
import { type GrokProbe, probeGrok } from './models.js';

export const GROK_MISSING = 'Install Grok Build: curl -fsSL https://x.ai/cli/install.sh | bash';
export const GROK_SIGN_IN = 'Run grok login in Terminal to sign in';

/** Grok Build on this computer: not installed, installed but signed out, or ready with its models. Never signs in. */
export async function grokStatus(deps: { readonly bin?: string; readonly probe?: (bin: string) => Promise<GrokProbe | undefined> } = {}): Promise<RuntimeStatus> {
  const bin = deps.bin ?? findGrok();
  if (!bin) return { state: 'missing', fix: GROK_MISSING, models: [] };
  const probe = await (deps.probe ?? probeGrok)(bin).catch(() => undefined);
  if (!probe) return { state: 'missing', fix: GROK_MISSING, models: [] };
  if (!probe.signedIn) return { state: 'signed_out', fix: GROK_SIGN_IN, models: [] };
  return { state: 'ready', models: probe.models };
}
