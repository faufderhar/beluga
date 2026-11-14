import { describe, expect, it } from 'vitest';
import { MODEL_PAGE, SEARCH_MODELS_OVER, modelSections, phoneModels, providerName, providerOf, searchModels, shownCount } from '../src/shared/model-search.js';

const m = (value: string, label: string, description = '') => ({ value, label, description });

/** An OpenCode with many providers set up, as `opencode models --verbose` gives them. */
const MANY = [
  m('anthropic/claude-sonnet-4-5', 'Claude Sonnet 4.5', 'anthropic · 200K context'),
  m('deepseek/deepseek-chat', 'DeepSeek Chat', 'deepseek · 128K context'),
  m('deepseek/deepseek-reasoner', 'DeepSeek Reasoner', 'deepseek · 128K context'),
  m('moonshotai/kimi-k2-0905-preview', 'Kimi K2 0905', 'moonshotai · 256K context'),
  m('openrouter/deepseek/deepseek-r1:free', 'DeepSeek R1 (free)', 'openrouter · 164K context'),
  m('openrouter/moonshotai/kimi-k2', 'MoonshotAI: Kimi K2', 'openrouter · 128K context'),
  m('openai/gpt-5.5', 'GPT-5.5', 'openai · 400K context'),
  m('opencode/big-pickle', 'Big Pickle', 'opencode · 200K context'),
];

describe('the provider a model comes from (BLG-945)', () => {
  it("OpenCode's models are provider/model; other runtimes' have none", () => {
    expect(providerOf('moonshotai/kimi-k2', 'opencode')).toBe('moonshotai');
    expect(providerOf('openrouter/deepseek/deepseek-r1:free', 'opencode')).toBe('openrouter');
    expect(providerOf('gpt-5.5', 'codex')).toBe('');
    expect(providerOf('', 'opencode')).toBe('');
  });

  it('says the providers people know by their names', () => {
    expect(providerName('deepseek')).toBe('DeepSeek');
    expect(providerName('moonshotai')).toBe('Moonshot AI (Kimi)');
    expect(providerName('moonshotai-cn')).toBe('Moonshot AI China (Kimi)');
    expect(providerName('kimi-for-coding')).toBe('Kimi For Coding');
    expect(providerName('opencode')).toBe('OpenCode Zen');
    expect(providerName('some-new-host')).toBe('Some New Host');
  });
});

describe('searching models (BLG-945)', () => {
  it('finds Kimi by its name and by its maker, wherever it is served', () => {
    expect(searchModels(MANY, 'kimi', 'opencode').map((x) => x.value)).toEqual(['moonshotai/kimi-k2-0905-preview', 'openrouter/moonshotai/kimi-k2']);
    expect(searchModels(MANY, 'moonshot', 'opencode').map((x) => x.value)).toEqual(['moonshotai/kimi-k2-0905-preview', 'openrouter/moonshotai/kimi-k2']);
  });

  it('every word has to match, in any order, ignoring case and accents', () => {
    expect(searchModels(MANY, 'free deepseek', 'opencode').map((x) => x.value)).toEqual(['openrouter/deepseek/deepseek-r1:free']);
    expect(searchModels(MANY, 'DÉEPSEEK reasoner', 'opencode').map((x) => x.value)).toEqual(['deepseek/deepseek-reasoner']);
    expect(searchModels(MANY, 'nothing-like-this', 'opencode')).toEqual([]);
  });

  it('a provider’s friendly name finds its models', () => {
    expect(searchModels(MANY, 'zen', 'opencode').map((x) => x.value)).toEqual(['opencode/big-pickle']);
  });

  it('names that start with what you typed come first, then the rest in their order', () => {
    const found = searchModels(MANY, 'deepseek', 'opencode').map((x) => x.label);
    expect(found).toEqual(['DeepSeek Chat', 'DeepSeek Reasoner', 'DeepSeek R1 (free)']);
    const gpt = searchModels([m('a/x', 'Codex GPT'), m('b/y', 'GPT-5')], 'gpt', 'opencode').map((x) => x.label);
    expect(gpt).toEqual(['GPT-5', 'Codex GPT']);
  });

  it('nothing typed: every model, as it was', () => {
    expect(searchModels(MANY, '  ', 'opencode')).toEqual(MANY);
  });
});

describe('sections by provider (BLG-945)', () => {
  it("OpenCode's models under their providers, in the order they first come", () => {
    const sections = modelSections(MANY, 'opencode');
    expect(sections.map((x) => [x.label, x.models.length])).toEqual([
      ['Anthropic', 1],
      ['DeepSeek', 2],
      ['Moonshot AI (Kimi)', 1],
      ['OpenRouter', 2],
      ['OpenAI', 1],
      ['OpenCode Zen', 1],
    ]);
  });

  it('one provider (or a runtime without them) is one untitled section', () => {
    expect(modelSections([m('opus', 'Opus'), m('sonnet', 'Sonnet')], 'claude')).toEqual([{ provider: '', label: '', models: [m('opus', 'Opus'), m('sonnet', 'Sonnet')] }]);
    expect(modelSections(MANY.slice(1, 3), 'opencode')).toEqual([{ provider: '', label: '', models: MANY.slice(1, 3) }]);
    expect(modelSections([], 'opencode')).toEqual([]);
  });
});

describe('showing a long list a page at a time (BLG-945)', () => {
  it('a short list is all shown; a long one a page, then more as you scroll', () => {
    expect(shownCount(12, 0)).toBe(12);
    expect(shownCount(500, 0)).toBe(MODEL_PAGE);
    expect(shownCount(500, MODEL_PAGE * 2)).toBe(MODEL_PAGE * 2);
    expect(shownCount(500, 9999)).toBe(500);
  });

  it('the picked model is always in what’s shown', () => {
    expect(shownCount(500, 0, 230)).toBe(231);
    expect(shownCount(500, 0, -1)).toBe(MODEL_PAGE);
  });

  it('a search field once there are more than a handful', () => {
    expect(SEARCH_MODELS_OVER).toBeGreaterThanOrEqual(8);
  });
});

describe('the phone’s share of a long list (BLG-945)', () => {
  const lots = Array.from({ length: 80 }, (_, i) => ({ ...m(`p/model-${i}`, `Model ${i}`), on: i === 61 }));

  it('the first ones, with the picked one kept, and how many more there are', () => {
    const { models, more } = phoneModels(lots, 30);
    expect(models).toHaveLength(30);
    expect(models.map((x) => x.value)).toContain('p/model-61');
    expect(models.at(-1)?.value).toBe('p/model-61');
    expect(more).toBe(50);
  });

  it('a list that fits is sent whole', () => {
    expect(phoneModels(lots.slice(0, 10), 30)).toEqual({ models: lots.slice(0, 10), more: 0 });
  });
});
