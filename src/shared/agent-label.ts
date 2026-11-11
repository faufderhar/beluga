import type { AgentRef } from '../protocol.js';

/** An older Mac's agent (protocol.ts CLAUDE_AGENT; repeated so the phone imports this file alone, types only). */
const CLAUDE_AGENT: AgentRef = { runtime: 'claude', label: 'Claude' };

/**
 * The words screens and messages say for an agent (BLG-435): "your Claude", "Kayra's Codex",
 * "bob's Claude (Opus)". Nothing user-facing writes "Claude" itself: it says the agent's label,
 * so a Codex or a local model is named as what it is. Missing ref: Claude (an older Mac's).
 * Browser-safe, imports types only: the Mac app and the phone import it.
 */

export interface AgentLabelOptions {
  /** Add the model: "bob's Claude (Opus)". */
  readonly model?: boolean;
  /** Start of a sentence: "Your Claude". */
  readonly capital?: boolean;
}

/** Model ids as people say them: "opus" → "Opus", "gpt-5" → "GPT-5", "claude-sonnet-4-5" → "Sonnet 4.5", OpenCode's "anthropic/claude-sonnet-4-5" the same (its provider isn't said). */
export function modelName(model: string): string {
  const m = model.trim().replace(/^[\w.@-]+\//, '').replace(/^claude-/i, '');
  if (/^gpt/i.test(m)) return m.replace(/^gpt/i, 'GPT');
  // A dated id's date ("-20250929") isn't said.
  const [first = '', ...rest] = m.split('-').filter((p) => !/^\d{8}$/.test(p));
  const version = rest.filter((p) => /^\d+$/.test(p)).join('.');
  const words = rest.filter((p) => !/^\d+$/.test(p));
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words, version].filter(Boolean).join(' ');
}

/** Just the agent: "Claude", or "Codex (GPT-5)" with `model`. */
export function agentName(ref: AgentRef | undefined, opts: Pick<AgentLabelOptions, 'model'> = {}): string {
  const r = ref ?? CLAUDE_AGENT;
  return opts.model && r.model ? `${r.label} (${modelName(r.model)})` : r.label;
}

/**
 * Whose agent it is, as one phrase. `self`: it's yours ("your Codex"); else `owner`'s
 * ("mia's Codex"); no owner: just its name.
 */
export function agentLabel(ref: AgentRef | undefined, owner: string | undefined, self: boolean, opts: AgentLabelOptions = {}): string {
  const name = agentName(ref, opts);
  const phrase = self ? `your ${name}` : owner ? `${owner}'s ${name}` : name;
  return opts.capital ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase;
}

/** What each runtime is called. */
export const RUNTIME_NAMES: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', copilot: 'Copilot', grok: 'Grok Build', local: 'Local model' };

/**
 * A message's small badge: what runs the agent, when its name doesn't already say it, and the
 * model ("Opus", "Codex · GPT-5" for an agent its owner named "Helper"). Nothing to add: undefined.
 */
export function agentBadge(ref: AgentRef | undefined): string | undefined {
  if (!ref) return undefined;
  const runtime = RUNTIME_NAMES[ref.runtime] ?? ref.runtime;
  const parts = [runtime.toLowerCase() === ref.label.toLowerCase() ? '' : runtime, ref.model ? modelName(ref.model) : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}
