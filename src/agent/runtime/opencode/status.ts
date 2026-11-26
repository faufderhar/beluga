import type { RuntimeStatus } from '../types.js';
import { findOpenCode } from './connection.js';
import { listOpenCodeModels } from './models.js';

export const OPENCODE_MISSING = 'Install OpenCode: brew install sst/tap/opencode, or npm i -g opencode-ai';
export const OPENCODE_SIGN_IN = 'Run opencode auth login in Terminal to add a model provider';
export const OPENCODE_NO_MODELS = 'OpenCode is installed but didn’t list its models. Run opencode models in Terminal to see why';

/**
 * OpenCode on this Mac (BLG-686): not installed, installed with no model it can use, or ready with
 * its models. OpenCode comes with free models of its own, so installed nearly always means ready;
 * a provider you sign in to (`opencode auth login`) adds its models. Found but not listing them
 * (it failed, or took too long on its first run) is installed, never "Not installed" (#568).
 * Never signs in.
 */
export async function openCodeStatus(deps: { readonly bin?: string; readonly models?: (bin: string) => Promise<ReadonlyArray<RuntimeStatus['models'][number]> | undefined> } = {}): Promise<RuntimeStatus> {
  const bin = deps.bin ?? findOpenCode();
  if (!bin) return { state: 'missing', fix: OPENCODE_MISSING, models: [] };
  const models = await (deps.models ?? listOpenCodeModels)(bin).catch(() => undefined);
  if (models === undefined) return { state: 'signed_out', fix: OPENCODE_NO_MODELS, models: [] };
  if (!models.length) return { state: 'signed_out', fix: OPENCODE_SIGN_IN, models: [] };
  return { state: 'ready', models: [...models] };
}
