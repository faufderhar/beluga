import { STOPPED_OUTPUT } from '../agent/step-recorder.js';
import type { StepRecord } from '../shared/steps.js';
import type { Refusal } from './claude-otel.js';

/**
 * Why a tool call failed, as one of a few classes for a span's `error.type`. Worked out on this
 * computer from the step's result; only the class leaves, never the words it was read from.
 */

export type ToolErrorType = 'timeout' | 'denied' | 'aborted' | 'nonzero_exit' | 'validation' | 'tool_error';

/** Tools whose failure is a command's exit code. */
const COMMANDS = new Set(['Bash']);
/** How much of a result is read: what a failure is shows in its first lines. */
const HEAD = 600;

const EXIT = /^Exit(?:ed with)? code (?!0\b)-?\d+/;
const ABORTED = /^\[Request interrupted/;
const DENIED = /doesn't want to (?:proceed|take this action)|tool use was rejected|haven't granted it|has been denied|permission (?:was )?denied by|user skipped this question|^Declined\.?$|blocked by (?:a |the )?hook/i;
const TIMEOUT = /\btimed out\b|\btimeout (?:exceeded|reached|expired|after|of)\b|\bETIMEDOUT\b|deadline exceeded/i;
const VALIDATION = /InputValidationError|Invalid tool parameters|Invalid arguments|Invalid params|-32602|invalid_type|required parameter/i;

/**
 * A failed step's class. `refusal` is what Claude Code itself said about the call (its permission
 * decision: src/telemetry/claude-otel.ts), which wins over what the result looks like.
 */
export function toolErrorType(record: StepRecord, refusal?: Refusal): ToolErrorType {
  if (refusal) return refusal;
  const said = (record.output ?? '').slice(0, HEAD).trim();
  if (said === STOPPED_OUTPUT || ABORTED.test(said)) return 'aborted';
  // A command that ran and failed: its output is its own (it may well speak of timeouts and denials).
  if (record.tool && COMMANDS.has(record.tool) && EXIT.test(said)) return 'nonzero_exit';
  if (DENIED.test(said)) return 'denied';
  if (TIMEOUT.test(said)) return 'timeout';
  if (VALIDATION.test(said)) return 'validation';
  return 'tool_error';
}
