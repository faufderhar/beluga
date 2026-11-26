/**
 * Local and bring-your-own models (BLG-449): named Anthropic-compatible endpoints (Ollama first,
 * then LiteLLM, a company proxy…) that Claude Code runs against instead of Anthropic. The endpoint
 * is config, not its own agent: a run on one is Claude Code with ANTHROPIC_BASE_URL pointed there.
 * In the picker they're the 'local' runtime's models, one per endpoint and model, valued
 * "<endpoint id>/<model>". Browser-safe: the daemon, the Mac app and the phone import it.
 */
import type { RuntimeModel } from './agent-runtimes.js';
import { THIS_COMPUTER } from './assistant.js';

/** The runtime id local endpoints run under (see agent-runtimes.ts KNOWN_RUNTIMES). */
export const LOCAL_RUNTIME = 'local';

/** Ollama's Anthropic-compatible endpoint on this Mac: the blessed local stack (BLG-451). */
export const OLLAMA_URL = 'http://localhost:11434';
export const OLLAMA_ID = 'ollama';

/**
 * How an endpoint is spoken to. 'anthropic' (the default): Claude Code calls its /v1/messages
 * itself. 'openai': it only has /v1/chat/completions (a gateway, vLLM, a provider's OpenAI API),
 * so Beluga runs a translator on this computer between them (agent/runtime/openai-bridge.ts).
 */
export type EndpointFormat = 'anthropic' | 'openai';
export const ENDPOINT_FORMATS: readonly EndpointFormat[] = ['anthropic', 'openai'];

/**
 * An OpenAI-format address for `path` ("chat/completions", "models"): an address that already ends
 * in a version (…/v1, BigModel's …/api/paas/v4) takes it as it is, a bare one gets /v1.
 */
export function openaiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v\d+[a-z]*$/i.test(base) ? `${base}/${path}` : `${base}/v1/${path}`;
}

/** An endpoint id: short, no slash (it starts a model value). */
export const ENDPOINT_ID = /^[a-z0-9][a-z0-9-]{0,19}$/;

/** An endpoint as Settings shows it: never its key, only whether it has one. */
export interface EndpointView {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  /** Unset: 'anthropic'. */
  readonly format?: EndpointFormat;
  readonly hasKey: boolean;
  /** The models you listed (none: the ones it says it has). */
  readonly models: readonly string[];
  /** The models it says it has, when it answered. */
  readonly found?: readonly string[];
  /** It answered the last time Beluga looked. Unset: not looked yet. */
  readonly reachable?: boolean;
  /** Ollama on this Mac, found without being added. */
  readonly builtIn?: boolean;
}

/** What a picker needs of an endpoint (no URL, no key). */
export type EndpointChoice = Pick<EndpointView, 'id' | 'label' | 'models' | 'found' | 'reachable' | 'builtIn'>;

/** "<endpoint id>/<model>" for the picker and a workspace's model. */
export const localModelValue = (id: string, model: string): string => `${id}/${model}`;

/** The endpoint and its model a value names (the model may have slashes of its own: hf.co/…). */
export function parseLocalModel(value: string | undefined): { readonly id: string; readonly model: string } | undefined {
  if (!value) return undefined;
  const at = value.indexOf('/');
  if (at <= 0 || at === value.length - 1) return undefined;
  const id = value.slice(0, at);
  return ENDPOINT_ID.test(id) ? { id, model: value.slice(at + 1) } : undefined;
}

/** An endpoint id from its label ("Work proxy" → "work-proxy"), not one of `taken`. */
export function endpointIdFor(label: string, taken: readonly string[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'endpoint';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

const isOllama = (e: Pick<EndpointChoice, 'id' | 'label'>): boolean => e.id === OLLAMA_ID || /ollama/i.test(e.label);

/** What an endpoint's models are: the ones you listed, else the ones it says it has. */
export const modelsOfEndpoint = (e: Pick<EndpointChoice, 'models' | 'found'>): readonly string[] => (e.models.length ? e.models : (e.found ?? []));

/** Why an endpoint can't be picked now, in plain words (no URL: the picker is seen in chat). */
export function endpointWhy(e: EndpointChoice): string | undefined {
  if (e.reachable === false) return isOllama(e) ? "Ollama isn't answering. Start it (OLLAMA_CONTEXT_LENGTH=32768 ollama serve)." : `${e.label} isn't answering.`;
  if (!modelsOfEndpoint(e).length) return isOllama(e) ? 'No models yet. Pull one in Ollama (ollama pull qwen3-coder).' : `List ${e.label}'s models in Settings › Local models.`;
  return undefined;
}

/**
 * The 'local' runtime's picker rows: Ollama first, each endpoint's models as "<endpoint> · <model>",
 * an endpoint that isn't answering greyed with why. Answers depend on the model: the rows say so.
 */
export function localModels(endpoints: readonly EndpointChoice[]): RuntimeModel[] {
  const ordered = [...endpoints].sort((a, b) => Number(isOllama(b)) - Number(isOllama(a)));
  return ordered.flatMap((e): RuntimeModel[] => {
    const why = endpointWhy(e);
    const models = modelsOfEndpoint(e);
    if (!models.length) return [{ value: localModelValue(e.id, '-'), label: e.label, description: why ?? '', why: why ?? 'No models' }];
    return models.map((m) => ({
      value: localModelValue(e.id, m),
      label: `${e.label} · ${m}`,
      description: why ?? 'Runs on your endpoint; answers depend on the model',
      efforts: [],
      ...(why ? { why } : {}),
    }));
  });
}

/** Why the Local group can't be used at all (nothing set up), or undefined when some endpoint is there. */
export function localWhy(endpoints: readonly EndpointChoice[]): string | undefined {
  if (!endpoints.length) return `Start Ollama on ${THIS_COMPUTER}, or add an endpoint in Settings › Local models`;
  return undefined;
}

/** Tokens per second, one decimal under 10 ("4.2"), whole above ("42"); undefined when too short to say. */
export function tokensPerSecond(tokens: number, ms: number): number | undefined {
  if (!(tokens > 0) || !(ms >= 250)) return undefined;
  const tps = tokens / (ms / 1000);
  return tps < 10 ? Math.round(tps * 10) / 10 : Math.round(tps);
}

/** "free · 42 tok/s": what a local model shows where Claude shows plan limits. */
export const speedWords = (tps: number | undefined): string => (tps ? `free · ${tps} tok/s` : 'free');
