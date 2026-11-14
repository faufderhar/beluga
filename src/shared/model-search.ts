/**
 * A long list of models, made easy to look through (BLG-945, GitHub #504). OpenCode lists every
 * model of every provider you've set up (OpenRouter alone brings hundreds), so the picker gets a
 * search field, puts each provider's models under its name, and draws a page at a time as you
 * scroll. The phone gets the first of them, the picked one always among them. Browser-safe.
 */

/** What a model row needs to be searched and sorted (a RuntimeModel, a picker row). */
export interface SearchableModel {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** A provider's models under its name; '' when the list has one provider, or none (Claude, Codex). */
export interface ModelSection<M extends SearchableModel> {
  readonly provider: string;
  readonly label: string;
  readonly models: readonly M[];
}

/** Lists longer than this get a search field. */
export const SEARCH_MODELS_OVER = 10;

/** How many rows are drawn at first, and how many more each time you scroll near the end. */
export const MODEL_PAGE = 60;

/** Provider ids (OpenCode's, from models.dev) as people say them; any other is title-cased. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'google-vertex': 'Google Vertex AI',
  deepseek: 'DeepSeek',
  moonshotai: 'Moonshot AI (Kimi)',
  'moonshotai-cn': 'Moonshot AI China (Kimi)',
  'kimi-for-coding': 'Kimi For Coding',
  openrouter: 'OpenRouter',
  opencode: 'OpenCode Zen',
  'github-copilot': 'GitHub Copilot',
  'github-models': 'GitHub Models',
  xai: 'xAI',
  zai: 'Z.ai',
  'zai-coding-plan': 'Z.ai Coding Plan',
  zhipuai: 'Zhipu AI',
  alibaba: 'Alibaba (Qwen)',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  groq: 'Groq',
  'amazon-bedrock': 'Amazon Bedrock',
  azure: 'Azure',
  togetherai: 'Together AI',
  'fireworks-ai': 'Fireworks AI',
  deepinfra: 'DeepInfra',
  huggingface: 'Hugging Face',
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
  vercel: 'Vercel AI Gateway',
};

/** The provider a model comes from: OpenCode's models are `provider/model`; other runtimes' have none (''). */
export function providerOf(value: string, runtime: string): string {
  if (runtime !== 'opencode') return '';
  const at = value.indexOf('/');
  return at > 0 ? value.slice(0, at) : '';
}

/** A provider's name as people know it ("deepseek": DeepSeek). */
export function providerName(id: string): string {
  return (
    PROVIDER_NAMES[id] ??
    id
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const wordsOf = (query: string): string[] => fold(query).split(/\s+/).filter(Boolean);

/** How well a model matches (lower is better), or undefined when a word is missing. */
function rank(m: SearchableModel, provider: string, words: readonly string[]): number | undefined {
  const label = fold(m.label);
  const named = provider ? fold(providerName(provider)) : '';
  const hay = `${label} ${fold(m.value)} ${fold(m.description ?? '')} ${named}`;
  if (!words.every((w) => hay.includes(w))) return undefined;
  const first = words[0]!;
  if (label.startsWith(first) || named.startsWith(first)) return 0;
  if (new RegExp(`(^|[^a-z0-9])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(label)) return 1;
  return 2;
}

/**
 * The models matching what's typed: every word somewhere in the name, id, description or provider
 * (any order, case and accents aside). A name or provider starting with it comes first, then a
 * name with a word starting with it, then the rest; each in the list's own order.
 */
export function searchModels<M extends SearchableModel>(models: readonly M[], query: string, runtime: string): readonly M[] {
  const words = wordsOf(query);
  if (!words.length) return models;
  return models
    .map((m, i) => ({ m, i, r: rank(m, providerOf(m.value, runtime), words) }))
    .filter((x): x is { m: M; i: number; r: number } => x.r !== undefined)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.m);
}

/** The models under their providers, in the order each provider first comes; one untitled section when there's only one. */
export function modelSections<M extends SearchableModel>(models: readonly M[], runtime: string): ModelSection<M>[] {
  if (!models.length) return [];
  const by = new Map<string, M[]>();
  for (const m of models) {
    const p = providerOf(m.value, runtime);
    by.set(p, [...(by.get(p) ?? []), m]);
  }
  if (by.size < 2) return [{ provider: '', label: '', models }];
  return [...by].map(([provider, list]) => ({ provider, label: provider ? providerName(provider) : 'Other', models: list }));
}

/** How many of `total` rows to draw: all of a short list; else a page (or as far as you've scrolled), always reaching the picked one (`on`). */
export function shownCount(total: number, wanted: number, on = -1): number {
  if (total <= MODEL_PAGE) return total;
  return Math.min(total, Math.max(MODEL_PAGE, wanted, on + 1));
}

/** The first `max` models for the phone, the picked one kept (last, when it's further down), and how many more the Mac has. */
export function phoneModels<M extends { readonly on: boolean }>(models: readonly M[], max: number): { models: readonly M[]; more: number } {
  if (models.length <= max) return { models, more: 0 };
  const on = models.findIndex((m) => m.on);
  const first = on >= max ? [...models.slice(0, max - 1), models[on]!] : models.slice(0, max);
  return { models: first, more: models.length - max };
}
