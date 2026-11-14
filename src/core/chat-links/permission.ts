import { claudeLaunch } from '../../agent/runtime/claude/launch-args.js';
import type { ArgsRuntime } from '../../shared/agent-args.js';

/** One chat's run, as permissionRank reads it. */
export interface RankInput {
  readonly planMode: boolean;
  /** Where it runs (AgentPlace): a look-only chat has `askOnly`. */
  readonly place?: { readonly askOnly?: unknown; readonly autoEdit?: boolean } | undefined;
  /** The runtime that answers in the chat ('claude', 'codex', …). */
  readonly runtime: string;
  /** Your launch flags per runtime (Settings › Agents › Launch flags). */
  readonly flags: Readonly<Partial<Record<ArgsRuntime, readonly string[]>>>;
}

const CLAUDE_RANK: Readonly<Record<string, number>> = { plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };

/**
 * How far a chat's run can act on its own (BLG-304), for send_to_chat's mode_wider check: a message
 * may not ask a chat to go further than its sender can.
 *
 * 0: it only looks (plan mode, a look-only chat). 1: it asks before it edits. 2: it edits on its own.
 * 3: it never asks (your launch flags for its runtime skip the asks, or set a Codex approval mode
 * or sandbox that never asks).
 */
export function permissionRank(run: RankInput): number {
  if (run.planMode || !run.place || run.place.askOnly) return 0;
  const base = run.place.autoEdit ? 2 : 1;
  if (run.runtime === 'claude') {
    const mode = claudeLaunch(run.flags.claude ?? [], { plan: false, autoEdit: base === 2 }).permissionMode;
    return CLAUDE_RANK[mode] ?? base;
  }
  if (run.runtime === 'codex' && codexNeverAsks(run.flags.codex ?? [])) return 3;
  return base;
}

/** Codex flags that turn off its asks or its sandbox: a bypass, approval "never", or full access. */
function codexNeverAsks(flags: readonly string[]): boolean {
  for (let i = 0; i < flags.length; i++) {
    const [flag, inline] = splitFlag(flags[i]!);
    const value = unquote(inline ?? flags[i + 1] ?? '');
    if (flag === '--dangerously-bypass-approvals-and-sandbox' || flag === '--yolo') return true;
    if ((flag === '-a' || flag === '--ask-for-approval') && value === 'never') return true;
    if ((flag === '-s' || flag === '--sandbox') && value === 'danger-full-access') return true;
    if (flag === '-c' || flag === '--config') {
      const [key, setting] = splitAt(value, '=');
      if (key.trim() === 'approval_policy' && unquote(setting) === 'never') return true;
      if (key.trim() === 'sandbox_mode' && unquote(setting) === 'danger-full-access') return true;
    }
  }
  return false;
}

/** `--flag=value` → ['--flag', 'value']; `--flag` → ['--flag', undefined]. */
function splitFlag(arg: string): [string, string | undefined] {
  const at = arg.indexOf('=');
  return at > 0 && arg.startsWith('--') ? [arg.slice(0, at), arg.slice(at + 1)] : [arg, undefined];
}

function splitAt(text: string, sep: string): [string, string] {
  const at = text.indexOf(sep);
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
}

function unquote(text: string): string {
  return text.trim().replace(/^["']|["']$/g, '');
}
