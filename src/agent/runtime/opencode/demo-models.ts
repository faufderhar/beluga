/**
 * The demo's OpenCode with several providers set up (BLG-945): DeepSeek and Moonshot AI (Kimi) on
 * their own keys, and OpenRouter's catalogue, so the picker's search, provider headings and paging
 * have a long list to work on, as a real OpenCode with OpenRouter gives. Ids as models.dev has them.
 */

interface DemoModel {
  readonly value: string;
  readonly name: string;
  readonly efforts: string[];
  readonly context: number;
}

const own: readonly DemoModel[] = [
  { value: 'deepseek/deepseek-chat', name: 'DeepSeek/DeepSeek Chat', efforts: [], context: 128_000 },
  { value: 'deepseek/deepseek-reasoner', name: 'DeepSeek/DeepSeek Reasoner', efforts: [], context: 128_000 },
  { value: 'moonshotai/kimi-k2-thinking', name: 'Moonshot AI/Kimi K2 Thinking', efforts: [], context: 262_144 },
  { value: 'moonshotai/kimi-k2-0905-preview', name: 'Moonshot AI/Kimi K2 0905', efforts: [], context: 262_144 },
  { value: 'moonshotai/kimi-k2-turbo-preview', name: 'Moonshot AI/Kimi K2 Turbo', efforts: [], context: 262_144 },
];

/** OpenRouter's catalogue: each maker's models, as `maker/model` and the name OpenRouter gives it. */
const ROUTED: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  anthropic: [['claude-sonnet-4.5', 'Claude Sonnet 4.5'], ['claude-opus-4.1', 'Claude Opus 4.1'], ['claude-haiku-4.5', 'Claude Haiku 4.5']],
  openai: [['gpt-5', 'GPT-5'], ['gpt-5-mini', 'GPT-5 Mini'], ['gpt-5-nano', 'GPT-5 Nano'], ['gpt-oss-120b', 'gpt-oss-120b'], ['gpt-oss-20b', 'gpt-oss-20b'], ['o4-mini', 'o4 Mini']],
  google: [['gemini-2.5-pro', 'Gemini 2.5 Pro'], ['gemini-2.5-flash', 'Gemini 2.5 Flash'], ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite'], ['gemma-3-27b-it', 'Gemma 3 27B']],
  deepseek: [['deepseek-chat-v3.1', 'DeepSeek V3.1'], ['deepseek-v3.2-exp', 'DeepSeek V3.2 Exp'], ['deepseek-r1', 'DeepSeek R1'], ['deepseek-r1:free', 'DeepSeek R1 (free)'], ['deepseek-r1-0528', 'DeepSeek R1 0528']],
  moonshotai: [['kimi-k2', 'Kimi K2'], ['kimi-k2-0905', 'Kimi K2 0905'], ['kimi-k2:free', 'Kimi K2 (free)'], ['kimi-dev-72b', 'Kimi Dev 72B']],
  qwen: [['qwen3-coder', 'Qwen3 Coder 480B'], ['qwen3-coder:free', 'Qwen3 Coder (free)'], ['qwen3-max', 'Qwen3 Max'], ['qwen3-235b-a22b', 'Qwen3 235B A22B'], ['qwen3-30b-a3b', 'Qwen3 30B A3B'], ['qwen3-next-80b-a3b-instruct', 'Qwen3 Next 80B']],
  'meta-llama': [['llama-4-maverick', 'Llama 4 Maverick'], ['llama-4-scout', 'Llama 4 Scout'], ['llama-3.3-70b-instruct', 'Llama 3.3 70B']],
  mistralai: [['mistral-medium-3.1', 'Mistral Medium 3.1'], ['devstral-medium', 'Devstral Medium'], ['devstral-small', 'Devstral Small'], ['codestral-2508', 'Codestral'], ['mistral-small-3.2-24b-instruct', 'Mistral Small 3.2']],
  'x-ai': [['grok-4', 'Grok 4'], ['grok-4-fast', 'Grok 4 Fast'], ['grok-code-fast-1', 'Grok Code Fast 1'], ['grok-3-mini', 'Grok 3 Mini']],
  'z-ai': [['glm-4.6', 'GLM 4.6'], ['glm-4.5', 'GLM 4.5'], ['glm-4.5-air', 'GLM 4.5 Air'], ['glm-4.5-air:free', 'GLM 4.5 Air (free)']],
  minimax: [['minimax-m2', 'MiniMax M2'], ['minimax-m1', 'MiniMax M1']],
  nvidia: [['nemotron-nano-9b-v2', 'Nemotron Nano 9B V2'], ['llama-3.3-nemotron-super-49b-v1.5', 'Nemotron Super 49B']],
  'nousresearch': [['hermes-4-405b', 'Hermes 4 405B'], ['hermes-4-70b', 'Hermes 4 70B']],
  inception: [['mercury-coder', 'Mercury Coder']],
  baidu: [['ernie-4.5-300b-a47b', 'ERNIE 4.5 300B']],
  tencent: [['hunyuan-a13b-instruct', 'Hunyuan A13B']],
  'arcee-ai': [['coder-large', 'Coder Large']],
  ai21: [['jamba-large-1.7', 'Jamba Large 1.7']],
  cohere: [['command-a', 'Command A']],
};

const routed: readonly DemoModel[] = Object.entries(ROUTED).flatMap(([maker, list]) => list.map(([id, name]): DemoModel => ({ value: `openrouter/${maker}/${id}`, name: `OpenRouter/${name}`, efforts: [], context: 131_072 })));

/** The demo's providers' models, after OpenCode's own. */
export const DEMO_PROVIDER_MODELS: readonly DemoModel[] = [...own, ...routed];

const tokens = (n: number): string => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}K`);

/** A demo model's description, as `opencode models --verbose` makes one: its provider and how much it holds. */
export const demoDescription = (m: { readonly value: string; readonly context?: number }): string => [m.value.split('/')[0] ?? '', m.context ? `${tokens(m.context)} context` : ''].filter(Boolean).join(' · ');
