import { describe, expect, it } from 'vitest';
import { buildSystemAppend } from '../src/agent/prompt.js';
import { speaker, systemPrompt } from '../src/core/chat/claude-prompt.js';
import { agentBadge, agentLabel, agentName, modelName } from '../src/shared/agent-label.js';
import type { AgentRef } from '../src/protocol.js';

const codex: AgentRef = { runtime: 'codex', model: 'gpt-5', label: 'Codex' };
const opus: AgentRef = { runtime: 'claude', model: 'opus', label: 'Claude' };

describe('agentLabel (BLG-435)', () => {
  it('says your own agent, and someone else’s by their name', () => {
    expect(agentLabel(codex, 'kayra', true)).toBe('your Codex');
    expect(agentLabel(codex, 'Kayra', false)).toBe("Kayra's Codex");
    expect(agentLabel(codex, 'kayra', true, { capital: true })).toBe('Your Codex');
    expect(agentLabel(codex, undefined, false)).toBe('Codex');
  });

  it('adds the model when asked, and only when it’s known', () => {
    expect(agentLabel(opus, 'Bob', false, { model: true })).toBe("Bob's Claude (Opus)");
    expect(agentLabel(codex, 'bob', true, { model: true })).toBe('your Codex (GPT-5)');
    expect(agentLabel({ runtime: 'local', label: 'Local' }, 'bob', false, { model: true })).toBe("bob's Local");
  });

  it('an older Mac’s agent (no ref) is Claude', () => {
    expect(agentLabel(undefined, 'bob', false)).toBe("bob's Claude");
    expect(agentName(undefined)).toBe('Claude');
  });

  it('says model ids the way people do', () => {
    expect(modelName('opus')).toBe('Opus');
    expect(modelName('gpt-5')).toBe('GPT-5');
    expect(modelName('claude-sonnet-4-5')).toBe('Sonnet 4.5');
    expect(modelName('claude-opus-4-1-20250805')).toBe('Opus 4.1');
    expect(modelName('qwen3')).toBe('Qwen3');
    // BLG-945: DeepSeek and Kimi, from their own provider or through a router.
    expect(modelName('deepseek/deepseek-chat')).toBe('DeepSeek chat');
    expect(modelName('openrouter/deepseek/deepseek-r1:free')).toBe('DeepSeek R1:free');
    expect(modelName('moonshotai/kimi-k2-0905-preview')).toBe('Kimi K2 preview 0905');
  });
});

describe('agentBadge (BLG-436)', () => {
  it('shows the model, and the runtime only when the name doesn’t say it', () => {
    expect(agentBadge(codex)).toBe('GPT-5');
    expect(agentBadge(opus)).toBe('Opus');
    expect(agentBadge({ runtime: 'codex', model: 'gpt-5', label: 'Helper' })).toBe('Codex · GPT-5');
    expect(agentBadge({ runtime: 'local', label: 'Qwen box' })).toBe('Local model');
  });

  it('adds nothing when there’s nothing to add (an older Mac’s message, or plain Claude)', () => {
    expect(agentBadge(undefined)).toBeUndefined();
    expect(agentBadge({ runtime: 'claude', label: 'Claude' })).toBeUndefined();
  });
});

describe('prompts name the actual agent (BLG-435)', () => {
  it('the system prompt says whose agent it is, Claude by default', () => {
    expect(buildSystemAppend('kay')).toContain("You are kay's Claude, running inside Beluga");
    expect(buildSystemAppend('kay', codex)).toContain("You are kay's Codex, running inside Beluga");
    expect(buildSystemAppend('kay', codex)).not.toMatch(/their Claude|friend's Claude/);
  });

  it('a friend chat’s answerer and its transcript name the agent', () => {
    const scene = { owner: 'mia', where: 'the group “launch”', people: ['mia', 'bob'], asker: 'bob', askedAll: true, agent: codex };
    expect(systemPrompt(scene)).toContain("You are mia's Codex, answering in a Beluga chat");
    expect(systemPrompt(scene)).not.toContain('Claude');
    expect(speaker({ name: 'bob', mine: false, claude: { for: 'm1', agent: opus } }, 'mia')).toBe("bob's Claude");
    expect(speaker({ name: 'bob', mine: true, claude: { for: 'm1', agent: codex } }, 'mia')).toBe("mia's Codex");
  });
});
