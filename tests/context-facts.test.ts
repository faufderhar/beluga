import { describe, expect, it } from 'vitest';
import { contextFacts, type ContextFactsState } from '../src/ui/context-facts.js';

const prefs = { autoCompact: true, autoCompactAt: 75, model: 'claude-opus-4-6', defaultAgent: { runtime: 'grok', label: 'Grok Build', model: 'grok-4.7' } };

function state(over: Partial<ContextFactsState> = {}): ContextFactsState {
  return {
    context: {},
    projects: [{ name: 'beluga', workspaces: [{ id: 'w1', agent: { runtime: 'grok', model: 'grok-4.7' } }] }],
    prefs,
    models: [{ value: 'claude-opus-4-6', label: 'Opus 4.6' }],
    runtimes: [{ id: 'grok', label: 'Grok Build', models: [{ value: 'grok-4.7', label: 'Grok 4.7' }] }, { id: 'claude', label: 'Claude' }],
    ...over,
  };
}

describe('context facts', () => {
  it('names a Grok chat from its own model and reported window, not Settings’ Opus', () => {
    const facts = contextFacts(state({ context: { 'ws:w1': { window: 256_000, model: 'grok-4.7' } } }), 'ws:w1');
    expect(facts.runtime).toBe('grok');
    expect(facts.modelId).toBe('grok-4.7');
    expect(facts.modelLabel).toBe('Grok 4.7');
    expect(facts.window).toBe(256_000);
    expect(facts.modelLabel).not.toContain('Opus');
    expect(facts.autoCompact).toBe('Beluga at 75%');
    expect(facts.autoCompactMark).toBe(true);
    expect(facts.autoCompactTitle).toMatch(/Grok Build may also compact/);
  });

  it('does not invent a window or Claude’s model when Grok has reported neither', () => {
    const facts = contextFacts(state({ projects: [{ name: 'beluga', workspaces: [{ id: 'w1', agent: { runtime: 'grok' } }] }] }), 'ws:w1');
    expect(facts.modelId).toBeUndefined();
    expect(facts.modelLabel).toBe('Grok Build');
    expect(facts.window).toBeUndefined();
  });

  it('says when Beluga will not compact a Grok chat, and that Grok still might', () => {
    const facts = contextFacts(state({ prefs: { ...prefs, autoCompact: false } }), 'ws:w1');
    expect(facts.autoCompact).toBe('Off in Beluga');
    expect(facts.autoCompactMark).toBe(false);
    expect(facts.autoCompactTitle).toMatch(/may still compact/);
  });

  it('leaves Codex to compact itself', () => {
    const facts = contextFacts(
      state({
        prefs: { ...prefs, defaultAgent: { runtime: 'codex', label: 'Codex' } },
        projects: [{ name: 'beluga', workspaces: [{ id: 'w1', agent: { runtime: 'codex' } }] }],
      }),
      'ws:w1',
    );
    expect(facts.autoCompact).toBe('Codex compacts this chat itself');
    expect(facts.autoCompactMark).toBe(false);
    expect(facts.window).toBeUndefined();
  });

  it('keeps Claude’s window and Settings model, and Beluga’s own threshold', () => {
    const facts = contextFacts(
      state({
        prefs: { autoCompact: true, autoCompactAt: 75, model: 'claude-opus-4-6' },
        projects: [{ name: 'beluga', workspaces: [{ id: 'w1' }] }],
        context: { 'ws:w1': { window: 200_000 } },
      }),
      'ws:w1',
    );
    expect(facts.runtime).toBe('claude');
    expect(facts.modelId).toBe('claude-opus-4-6');
    expect(facts.modelLabel).toBe('Opus 4.6');
    expect(facts.window).toBe(200_000);
    expect(facts.autoCompact).toBe('At 75%');
    expect(facts.autoCompactMark).toBe(true);
  });

  it('uses Claude’s known window when nothing has reported one', () => {
    const facts = contextFacts(state({ prefs: { autoCompact: false, autoCompactAt: 85, model: 'opus' }, projects: [{ name: 'beluga', workspaces: [{ id: 'w1' }] }] }), 'ws:w1');
    expect(facts.window).toBe(1_000_000);
    expect(facts.autoCompact).toBe('Off');
  });
});
