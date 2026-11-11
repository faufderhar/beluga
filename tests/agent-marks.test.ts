import { describe, expect, it } from 'vitest';
import { AGENT_MARKS, agentMark, modelMark, runtimeMark } from '../src/shared/agent-marks.js';
import { runtimeChoices } from '../src/shared/agent-runtimes.js';
import { agentChoices, agentForChoice, choiceForAgent } from '../src/ui/agent-choice.js';

describe('agent marks', () => {
  it('one per runtime, Claude for an older Mac', () => {
    expect(runtimeMark('claude')).toBe('claudeCode');
    expect(runtimeMark('codex')).toBe('codex');
    expect(runtimeMark('local')).toBe('localModel');
    expect(runtimeMark('opencode')).toBe('opencode');
    expect(runtimeMark('grok')).toBe('grok');
    expect(agentMark(undefined)).toBe('claudeCode');
    for (const mark of ['claudeCode', 'codex', 'localModel', 'anthropic', 'openai'] as const) expect(AGENT_MARKS[mark].d).toMatch(/^M/);
  });

  it("a model's maker, by its id", () => {
    expect(modelMark('opus', 'claude')).toBe('anthropic');
    expect(modelMark('gpt-5.5', 'codex')).toBe('openai');
    expect(modelMark('gpt-oss-20b', 'local')).toBe('openai');
    expect(modelMark('claude-sonnet-4-5', 'local')).toBe('anthropic');
    expect(modelMark('qwen3', 'local')).toBe('localModel');
    // OpenCode's models are provider/model: the provider says whose; its own free ones are OpenCode's.
    expect(modelMark('anthropic/claude-sonnet-4-5', 'opencode')).toBe('anthropic');
    expect(modelMark('openai/gpt-5.5', 'opencode')).toBe('openai');
    expect(modelMark('opencode/big-pickle', 'opencode')).toBe('opencode');
  });
});

describe('the agents you can pick', () => {
  const runtimes = runtimeChoices((id) => (id === 'claude' ? {} : id === 'codex' ? { models: [{ value: 'gpt-5.5', label: 'GPT-5.5', description: '' }] } : undefined));
  const claude = [
    { value: '', label: "Claude Code's choice", description: '' },
    { value: 'opus', label: 'Opus', description: '' },
  ];

  it('every runtime with its models; one not set up stays, greyed, saying why', () => {
    const options = agentChoices(runtimes, claude);
    expect(options.map((o) => o.label)).toEqual(['Claude', 'Claude · Opus', 'Codex', 'Codex · GPT-5.5', 'OpenCode', 'Copilot', 'Grok Build', 'Local model']);
    expect(options.find((o) => o.runtime === 'opencode')).toMatchObject({ disabled: true, why: "OpenCode isn't set up on this Mac yet", mark: 'opencode' });
    expect(options.find((o) => o.runtime === 'copilot')).toMatchObject({ disabled: true, why: "GitHub Copilot CLI isn't set up on this Mac yet", mark: 'copilot' });
    expect(options.find((o) => o.runtime === 'local')).toMatchObject({ disabled: true, why: 'No local model endpoint is set', mark: 'localModel' });
    expect(options.find((o) => o.value === 'codex:gpt-5.5')).toMatchObject({ group: 'Codex', mark: 'codex', model: 'gpt-5.5' });
  });

  it('a value and its agent go both ways (an older bare model is Claude’s)', () => {
    expect(agentForChoice('codex:gpt-5.5', runtimes)).toEqual({ runtime: 'codex', label: 'Codex', model: 'gpt-5.5' });
    expect(agentForChoice('claude:', runtimes)).toEqual({ runtime: 'claude', label: 'Claude' });
    expect(agentForChoice('opus')).toEqual({ runtime: 'claude', label: 'Claude', model: 'opus' });
    expect(choiceForAgent({ runtime: 'codex', label: 'Codex', model: 'gpt-5.5' })).toBe('codex:gpt-5.5');
    expect(choiceForAgent(undefined)).toBe('claude:');
  });
});
