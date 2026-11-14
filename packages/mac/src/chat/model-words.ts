import { type AgentMark, modelMark } from '@beluga/shared/agent-marks.js';

/** The maker a runtime's models usually come from: its own models carry no second mark. */
const HOUSE: Readonly<Record<string, AgentMark>> = { claude: 'anthropic', codex: 'openai', opencode: 'opencode', copilot: 'copilot', grok: 'grok' };

/** A model's maker mark when it isn't its runtime's own (a local runtime serving a GPT model, DeepSeek under OpenCode); else none. */
export function foreignMark(model: string, runtime: string): AgentMark | undefined {
  if (!model) return undefined;
  const mark = modelMark(model, runtime);
  return mark === (HOUSE[runtime] ?? 'localModel') ? undefined : mark;
}

/** A friendlier word for a model, from its name (Opus is the most capable, Haiku the fastest). */
export function modelFlavor(value: string, label: string, runtime: string): string {
  const v = `${value} ${label}`.toLowerCase();
  if (v.includes('opus')) return 'Most capable';
  if (v.includes('sonnet')) return 'Fast and capable';
  if (v.includes('haiku')) return 'Fastest';
  return value ? '' : `${runtime} chooses`;
}
