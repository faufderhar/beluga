import { REDACTED, redactSecrets, SECRET_KEY } from '../../shared/steps.js';
import type { Denial, OperationClass, Outcome } from './decide.js';

export const DECIDED_BY = ['rule', 'person'] as const;
export type DecidedBy = (typeof DECIDED_BY)[number];

export type AuditResult = 'ok' | 'error' | Denial;

/** One decision, as the caller reports it. `args` is hashed and then dropped. */
export interface AuditEntry {
  readonly agent: string;
  /** Its grant: names can repeat. */
  readonly agentId?: string;
  readonly tool: string;
  readonly class: OperationClass;
  /** What it acted on, by id ("chat:abc"). */
  readonly target: string;
  readonly decision: Outcome;
  readonly decidedBy: DecidedBy;
  readonly result: AuditResult;
  readonly durationMs: number;
  readonly args: unknown;
  /** Words from the tool and its class, not from its arguments: scrubbing below is only a backstop. */
  readonly summary: string;
}

export type AuditRecord = Omit<AuditEntry, 'args'> & { readonly ts: number; readonly argsHash: string };

/** What came of a decision, as a person reads it: it ran, a person was asked and let it, or it was refused. */
export type ActivityKind = 'allowed' | 'asked' | 'refused';

export function activityKind(record: Pick<AuditRecord, 'decision' | 'result'>): ActivityKind {
  if (record.decision === 'deny' || (record.result !== 'ok' && record.result !== 'error')) return 'refused';
  return record.decision === 'allow' ? 'allowed' : 'asked';
}

export const SUMMARY_MAX = 300;
export const TARGET_MAX = 200;
const NAME_MAX = 120;
/** Shorter values are too common to take out of a sentence ("a", "yes"). */
const SCRUB_MIN = 4;

/** The line to keep for an entry: no argument value in it, and small. */
export function auditRecord(entry: AuditEntry, ts: number, argsHash: string): AuditRecord {
  const { args, ...rest } = entry;
  const values = argumentValues(args);
  const secretOrProse = values.filter((v) => v.secret || /\s/.test(v.text));
  return {
    ...rest,
    ts,
    argsHash,
    agent: entry.agent.slice(0, NAME_MAX),
    tool: entry.tool.slice(0, NAME_MAX),
    // A target is an id, so an id among the arguments stays; a secret or a sentence does not.
    target: redactSecrets(scrub(entry.target, secretOrProse)).slice(0, TARGET_MAX),
    summary: redactSecrets(scrub(entry.summary, values)).slice(0, SUMMARY_MAX),
  };
}

interface ArgumentValue {
  readonly text: string;
  readonly secret: boolean;
}

/** Each string and number in the arguments, however deep. */
function argumentValues(value: unknown, secret = false): ArgumentValue[] {
  if (typeof value === 'string' || typeof value === 'number') return [{ text: String(value), secret }];
  if (Array.isArray(value)) return value.flatMap((v) => argumentValues(v, secret));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => argumentValues(v, secret || SECRET_KEY.test(k)));
  return [];
}

/** Longest first, so a value inside a longer one doesn't leave the rest of the longer one behind. */
function scrub(text: string, values: readonly ArgumentValue[]): string {
  const longestFirst = values.filter((v) => v.secret || v.text.length >= SCRUB_MIN).sort((a, b) => b.text.length - a.text.length);
  return longestFirst.reduce((out, v) => (v.text ? out.split(v.text).join(REDACTED) : out), text);
}
