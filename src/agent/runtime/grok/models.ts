import type { RuntimeStatus } from '../types.js';
import type { GrokConnect, GrokInit, GrokModel } from './connection.js';
import { spawnGrok } from './connection.js';

export type GrokModelChoice = RuntimeStatus['models'][number];

const tokens = (n: number | undefined): string => (!n ? '' : n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}K`);

/** A model as the picker shows it: its id, its name, what it holds, the efforts it takes. */
export function modelChoice(m: GrokModel): GrokModelChoice {
  const efforts = (m._meta?.reasoningEfforts ?? []).map((e) => e.value);
  const held = tokens(m._meta?.totalContextTokens);
  return { value: m.modelId, label: m.name || m.modelId, description: [m.description ?? '', held ? `${held} context` : ''].filter(Boolean).join(' · '), ...(efforts.length ? { efforts } : {}) };
}

/** What Grok says about itself on this computer. */
export interface GrokProbe {
  readonly models: GrokModelChoice[];
  readonly signedIn: boolean;
}

/** Signed in, and the models it offers, from its `initialize` answer. An XAI_API_KEY in the environment signs it in too. */
export function probeOf(init: GrokInit, env: Readonly<Record<string, string | undefined>> = process.env): GrokProbe {
  return { models: (init._meta?.modelState?.availableModels ?? []).map(modelChoice), signedIn: Boolean(init._meta?.defaultAuthMethodId) || Boolean(env.XAI_API_KEY) };
}

const CACHE_MS = 60_000;
let cached: { readonly bin: string; readonly at: number; readonly probe: Promise<GrokProbe | undefined> } | undefined;

/** Ask Grok what it offers (a handshake, no session, nothing sent to a model); kept a minute. Undefined when it wouldn't start. */
export function probeGrok(bin: string, deps: { readonly connect?: GrokConnect; readonly now?: number; readonly cwd?: string } = {}): Promise<GrokProbe | undefined> {
  const now = deps.now ?? Date.now();
  if (cached && cached.bin === bin && now - cached.at < CACHE_MS) return cached.probe;
  const probe = (async () => {
    const conn = await (deps.connect ?? spawnGrok)({ cwd: deps.cwd ?? process.cwd(), bin, ungated: true });
    try {
      return probeOf(conn.init);
    } finally {
      await conn.proc.kill();
    }
  })().catch(() => undefined);
  cached = { bin, at: now, probe };
  return probe;
}

/** Forget what was asked (tests). */
export const forgetProbe = (): void => {
  cached = undefined;
};
