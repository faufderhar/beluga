import { describe, expect, it } from 'vitest';
import { runtimeChoices } from '../src/shared/agent-runtimes.js';
import { modelKey, modelsForChat, openModelCatalog, toggleOpenModel } from '../src/shared/open-models.js';

const known = ['claude|', 'claude|opus', 'claude|haiku'];

describe('models for chat', () => {
  const models = [
    { value: '', label: 'Default' },
    { value: 'opus', label: 'Opus' },
    { value: 'haiku', label: 'Haiku' },
  ];

  it('offers every model until one is turned off', () => {
    expect(modelsForChat(models, 'claude', undefined).map((m) => m.value)).toEqual(['', 'opus', 'haiku']);
    expect(modelsForChat(models, 'claude', []).map((m) => m.value)).toEqual(['', 'opus', 'haiku']);
    expect(modelsForChat(models, 'claude', ['claude|opus']).map((m) => m.value)).toEqual(['opus']);
  });
});

describe('toggleOpenModel', () => {
  it('stores every other model when the first one is turned off, and collapses back to all', () => {
    const off = toggleOpenModel([], 'claude|opus', known);
    expect(off).toEqual(['claude|', 'claude|haiku']);
    expect(toggleOpenModel(off, 'claude|opus', known)).toEqual([]);
  });

  it('refuses to turn off the last model, and keeps a key for one that is not listed', () => {
    expect(toggleOpenModel(['claude|opus'], 'claude|opus', ['claude|opus'])).toBeUndefined();
    expect(toggleOpenModel([], 'claude|opus', ['claude|opus'])).toBeUndefined();
    const next = toggleOpenModel(['claude|', 'claude|opus', 'claude|haiku', 'later|new'], 'claude|opus', known);
    expect(next).toEqual(['claude|', 'claude|haiku', 'later|new']);
  });

  it('keys a model as runtime|value', () => {
    expect(modelKey('claude', 'opus')).toBe('claude|opus');
    expect(modelKey('local', 'org/model:q4')).toBe('local|org/model:q4');
  });
});

describe('openModelCatalog', () => {
  it('lists models of runtimes that run here, and skips one that cannot be picked', () => {
    const runtimes = runtimeChoices((id) => {
      if (id === 'claude') return {};
      if (id === 'codex') return { models: [{ value: 'gpt-5', label: 'GPT-5', description: 'general' }, { value: 'down', label: 'Down', description: '', why: 'Not answering' }] };
      return undefined;
    });
    const catalog = openModelCatalog(runtimes, [{ value: 'opus', label: 'Opus', description: 'most capable' }]);
    expect(catalog.map((m) => m.key)).toEqual(['claude|opus', 'codex|gpt-5']);
  });
});
