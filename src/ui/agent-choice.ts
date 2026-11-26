import type { AgentRef } from '../protocol.js';
import type { RuntimeChoice, RuntimeModel } from '../shared/agent-runtimes.js';
import { type AgentMark, runtimeMark } from '../shared/agent-marks.js';
import { modelName } from '../shared/agent-label.js';

/** protocol.ts's CLAUDE_AGENT, repeated so the phone bundles this file without the daemon's protocol (types only from there). */
// agent-wording: claude (the Claude runtime's own name)
const CLAUDE_AGENT: AgentRef = { runtime: 'claude', label: 'Claude' };

/**
 * The agents you can pick (BLG-444, BLG-497) as pop-up entries: every runtime this Mac knows, each
 * with its models ("Claude", "Claude · Opus", "Codex", "Codex · GPT-5.5", "Local model · qwen3").
 * A runtime that isn't set up here stays listed, greyed, saying what's missing. The value is
 * `runtime:model` ('' model: the runtime's own default).
 */
export interface AgentOption {
  readonly value: string;
  readonly label: string;
  readonly runtime: string;
  readonly model: string;
  /** Its runtime's name, for grouping. */
  readonly group: string;
  readonly mark: AgentMark;
  readonly disabled?: boolean;
  readonly why?: string;
}

const SEP = ':';

/** `claudeModels`: Claude Code's own (the state's `models`); the other runtimes bring theirs. */
export function agentChoices(runtimes: readonly RuntimeChoice[], claudeModels: readonly RuntimeModel[]): AgentOption[] {
  const known = runtimes.length ? runtimes : [{ id: CLAUDE_AGENT.runtime, label: CLAUDE_AGENT.label, available: true }];
  return known.flatMap((r) => {
    const base = { runtime: r.id, group: r.label, mark: runtimeMark(r.id) };
    if (!r.available) return [{ ...base, value: `${r.id}${SEP}`, label: r.label, model: '', disabled: true, ...(r.why ? { why: r.why } : {}) }];
    const models = (r.id === CLAUDE_AGENT.runtime ? claudeModels : (r.models ?? [])).filter((m) => m.value);
    return [
      { ...base, value: `${r.id}${SEP}`, label: r.label, model: '' },
      ...models.map((m) => ({ ...base, value: `${r.id}${SEP}${m.value}`, label: `${r.label} · ${m.label}`, model: m.value, ...(m.why ? { disabled: true, why: m.why } : {}) })),
    ];
  });
}

/** The AgentRef a pop-up value stands for (an older value, a bare model, is Claude's). */
export function agentForChoice(value: string, runtimes: readonly RuntimeChoice[] = []): AgentRef {
  const at = value.indexOf(SEP);
  const runtime = at > 0 ? value.slice(0, at) : CLAUDE_AGENT.runtime;
  const model = at > 0 ? value.slice(at + 1) : value;
  const label = runtimes.find((r) => r.id === runtime)?.label ?? (runtime === CLAUDE_AGENT.runtime ? CLAUDE_AGENT.label : runtime);
  return { runtime, label, ...(model ? { model } : {}) };
}

/** The pop-up value for an agent you chose (undefined: Claude with its default model). */
export function choiceForAgent(ref: AgentRef | undefined): string {
  return `${ref?.runtime ?? CLAUDE_AGENT.runtime}${SEP}${ref?.model ?? ''}`;
}

/**
 * An agent as its pop-up names it ("Claude · Opus 5.5", "Codex"), so a menu that shows who does
 * a part says what the picker said. A model no longer listed: its id in words ("Claude · Opus").
 */
export function agentChoiceLabel(ref: AgentRef | undefined, runtimes: readonly RuntimeChoice[], claudeModels: readonly RuntimeModel[]): string {
  const r = ref ?? CLAUDE_AGENT;
  const value = choiceForAgent(r);
  const known = agentChoices(runtimes, claudeModels).find((o) => o.value === value);
  if (known) return known.label;
  const runtime = runtimes.find((x) => x.id === r.runtime)?.label ?? r.label;
  return r.model ? `${runtime} · ${modelName(r.model)}` : runtime;
}
