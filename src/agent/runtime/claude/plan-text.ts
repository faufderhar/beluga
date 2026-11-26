import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPlanPath } from '../../policy.js';

/** The longest plan that goes to the card. */
const PLAN_MAX = 60_000;

/** What the card says when Claude asked to go ahead without a plan to show: never a chat line passed off as one (#607). */
export const NO_PLAN_TEXT = "Claude asked to go ahead, but its plan didn't come through. Type below to ask it to write the plan out in its message.";

/** Claude Code's plan folder, as the Claude Code a run starts sees it: ~/.claude/plans, or in $CLAUDE_CONFIG_DIR. */
export const claudePlansDir = (env: Readonly<Record<string, string | undefined>> = process.env): string => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plans');

/**
 * The plan for the card: ExitPlanMode's `plan` (Claude Code fills it from its plan file), else the
 * plan file this run wrote (planFileOf), read only from Claude Code's plan folder. Never a path the
 * tool's input names: that could show someone a plan, or a file, that isn't theirs. None: undefined.
 */
export function planText(toolInput: Readonly<Record<string, unknown>>, plans: string, written?: string): string | undefined {
  if (typeof toolInput.plan === 'string' && toolInput.plan.trim()) return toolInput.plan.slice(0, PLAN_MAX);
  const text = written && isPlanPath(written, plans) ? readPlan(written) : undefined;
  return text?.slice(0, PLAN_MAX);
}

const readPlan = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined; // gone or unreadable: the card says the plan didn't come through
  }
};
