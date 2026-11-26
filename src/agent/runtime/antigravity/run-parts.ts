import type { RunEnd } from '../../../shared/run-failure.js';
import { acpEnd, acpFailure, acpModel, declinedNote, modeValue } from '../acp/parts.js';
import { AGY_LIMIT } from './status.js';

export { declinedNote, modeValue };

/** A model Antigravity knows (`gemini-3.8-flash`, `claude-opus-4-6-thinking`), or undefined for its own. */
export const agyModel = acpModel;

/** Beluga's efforts as Antigravity's thinking levels (it has low, medium and high). */
export function agyThought(effort: string | null | undefined): string | undefined {
  if (!effort) return undefined;
  if (effort === 'xhigh' || effort === 'max') return 'high';
  if (effort === 'minimal') return 'low';
  return effort;
}

/** Beluga's instructions for a run, as what Antigravity adds to its own system prompt (its `_meta.antigravity.systemPrompt.append`). */
export function systemMeta(text: string): { readonly antigravity: { readonly systemPrompt: { readonly append: string } } } {
  return { antigravity: { systemPrompt: { append: text } } };
}

/** A run's end from what failed: an ACP error (its code kept), or a message. */
export const agyEnd = acpEnd;

/** A failed Antigravity run, told as Antigravity's: a sign-in, your plan's limit (its own words), else as every runtime's is. */
export const agyFailure = (end: RunEnd & { readonly cause?: unknown }): Error => acpFailure(end, 'antigravity', AGY_LIMIT);
