import { describe, expect, it } from 'vitest';
import { type PickerState, agentPicker, pickAction } from '../src/shared/agent-picker.js';
import { CLOSED_WHY } from '../src/shared/open-models.js';
import { runtimeChoices } from '../src/shared/agent-runtimes.js';
import { modelMenu } from '../src/ui/settings-menus.js';
import type { AppState } from '../src/core/store.js';
import { demoPicker } from '../packages/companion/lib/link/demo/agents.js';

/** BLG-446: the agent picker, runtimes as groups with their models, the Mac's, /model's and the phone's. */

const CLAUDE_MODELS = [
  { value: '', label: 'Default', description: "Claude Code's choice" },
  { value: 'opus', label: 'Opus', description: 'most capable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', label: 'Haiku', description: 'fastest' },
];

function state(workspaces: PickerState['projects'][number]['workspaces'] = [], codex = true, model?: string): PickerState {
  return {
    runtimes: runtimeChoices((id) => (id === 'claude' ? {} : id === 'codex' && codex ? { models: [{ value: 'gpt-5-codex', label: 'GPT-5 Codex', description: 'for code' }] } : undefined)),
    models: CLAUDE_MODELS,
    prefs: model ? { model } : {},
    projects: [{ workspaces }],
  };
}

describe('agentPicker', () => {
  it('groups by runtime, your default first, and keeps one this Mac does not run, saying why', () => {
    const p = agentPicker(state([], false), 'ws:a');
    expect(p.groups.map((g) => [g.runtime, g.available, g.isDefault])).toEqual([
      ['claude', true, true],
      ['codex', false, false],
      ['opencode', false, false],
      ['copilot', false, false],
      ['grok', false, false],
      ['local', false, false],
    ]);
    expect(p.groups[1]).toMatchObject({ why: "Codex isn't set up on this Mac yet", models: [] });
    expect(p.groups[2]).toMatchObject({ why: "OpenCode isn't set up on this Mac yet", models: [] });
    expect(p.groups[3]).toMatchObject({ why: "GitHub Copilot CLI isn't set up on this Mac yet", models: [] });
    expect(p.groups[4]).toMatchObject({ why: "Grok Build isn't set up on this Mac yet", models: [] });
    expect(p.groups[5]?.why).toBe('No local model endpoint is set');
    expect(p.groups[0]?.models.map((m) => m.label)).toEqual(['Default', 'Opus', 'Haiku']);
  });

  it("remembers each place's own choice", () => {
    const st = state([
      { id: 'a', model: 'opus' },
      { id: 'b', agent: { runtime: 'codex', label: 'Codex' }, model: 'gpt-5-codex' },
    ]);
    const a = agentPicker(st, 'ws:a');
    expect(a).toMatchObject({ runtime: 'claude', model: 'opus', label: 'Opus' });
    expect(a.groups[0]?.models.find((m) => m.on)?.value).toBe('opus');
    const b = agentPicker(st, 'ws:b');
    expect(b).toMatchObject({ runtime: 'codex', model: 'gpt-5-codex', label: 'Codex · GPT-5 Codex' });
    expect(b.groups.find((g) => g.current)?.runtime).toBe('codex');
    expect(b.groups[0]?.models.some((m) => m.on)).toBe(false);
    // New conversations: your default's model; a new worktree's own pick before it exists.
    expect(agentPicker(state([], true, 'haiku'), 'draft')).toMatchObject({ runtime: 'claude', model: 'haiku', label: 'Haiku' });
    expect(agentPicker(state(), 'draft', 'claude', { runtime: 'codex', label: 'Codex', model: 'gpt-5-codex' })).toMatchObject({ runtime: 'codex', label: 'Codex · GPT-5 Codex' });
  });

  it('a same-runtime pick changes the model; another runtime changes the agent', () => {
    const st = state([{ id: 'a' }, { id: 'b', agent: { runtime: 'codex', label: 'Codex' } }]);
    const a = agentPicker(st, 'ws:a');
    const [claude, codex] = a.groups;
    expect(pickAction(a, claude!, 'opus')).toEqual({ kind: 'model', value: 'opus' });
    expect(pickAction(a, codex!, 'gpt-5-codex')).toEqual({ kind: 'agent', agent: { runtime: 'codex', label: 'Codex', model: 'gpt-5-codex' } });
    const b = agentPicker(st, 'ws:b');
    expect(pickAction(b, b.groups[0]!, '')).toEqual({ kind: 'agent', agent: null });
    expect(pickAction(b, b.groups[0]!, 'opus')).toEqual({ kind: 'agent', agent: { runtime: 'claude', label: 'Claude', model: 'opus' } });
    // New conversations take your default's models only.
    const d = agentPicker(st, 'draft');
    expect(pickAction(d, d.groups[1]!, 'gpt-5-codex')).toBeUndefined();
  });

  it('lists only models turned on, and greys a runtime left with none', () => {
    const claudeOnly = agentPicker({ ...state(), prefs: { openModels: ['claude|', 'claude|opus'] } }, 'ws:a');
    expect(claudeOnly.groups[0]?.models.map((m) => m.value)).toEqual(['', 'opus']);
    const codex = claudeOnly.groups.find((g) => g.runtime === 'codex');
    expect(codex).toMatchObject({ available: false, why: CLOSED_WHY, models: [] });
    // A runtime this Mac doesn't run keeps its own reason.
    const missing = agentPicker({ ...state([], false), prefs: { openModels: ['claude|opus'] } }, 'ws:a');
    expect(missing.groups.find((g) => g.runtime === 'codex')?.why).toBe("Codex isn't set up on this Mac yet");
    // Nothing chosen: every model.
    expect(agentPicker(state(), 'ws:a').groups[0]?.models.map((m) => m.label)).toEqual(['Default', 'Opus', 'Haiku']);
  });
});

describe('/model', () => {
  it('lists runtimes as groups: models of this one switch models, of another switch agent', () => {
    const st = { ...state([{ id: 'a', model: 'opus' }], false), inbox: [] } as unknown as AppState;
    const menu = modelMenu(st, 'ws:a', 'this conversation');
    const ids = menu.options.map((o) => o.id);
    expect(ids).toEqual(['runtime:claude', 'model:', 'model:opus', 'model:haiku', 'runtime:codex', 'runtime:opencode', 'runtime:copilot', 'runtime:grok', 'runtime:local', 'close']);
    expect(menu.options.find((o) => o.id === 'model:opus')?.label).toContain('◉');
    expect(menu.options.find((o) => o.id === 'runtime:codex')?.hint).toBe("Codex isn't set up on this Mac yet");
    const allowed = modelMenu({ ...st, prefs: { openModels: ['claude|opus'] } } as unknown as AppState, 'ws:a', 'this conversation');
    expect(allowed.options.map((o) => o.id)).toContain('model:opus');
    expect(allowed.options.map((o) => o.id)).not.toContain('model:haiku');
    const withCodex = modelMenu({ ...st, ...state([{ id: 'a' }]) } as unknown as AppState, 'ws:a', 'this conversation');
    expect(withCodex.options.map((o) => o.id)).toContain('agent:codex:gpt-5-codex');
  });
});

describe("the phone's demo picker", () => {
  it('shows the groups, and a pick moves the check', () => {
    const p = demoPicker();
    expect(p.groups.map((g) => [g.runtime, g.available])).toEqual([
      ['claude', true],
      ['codex', true],
      ['local', false],
    ]);
    expect(p.label).toBe('Default');
    const codex = demoPicker('codex', 'gpt-5-codex');
    expect(codex.label).toBe('Codex · GPT-5 Codex');
    expect(codex.groups.flatMap((g) => g.models.filter((m) => m.on).map((m) => `${g.runtime}:${m.value}`))).toEqual(['codex:gpt-5-codex']);
  });
});
