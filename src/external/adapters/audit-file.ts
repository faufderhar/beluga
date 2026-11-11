import { createHash } from 'node:crypto';
import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { belugaHome } from '../../core/home.js';
import { auditRecord, DECIDED_BY, SUMMARY_MAX, TARGET_MAX, type AuditEntry, type AuditRecord } from '../domain/audit.js';
import { DENIALS, OPERATION_CLASSES, OUTCOMES } from '../domain/decide.js';
import type { AuditLog } from '../ports/audit-log.js';

/**
 * What external agents did, in ~/.beluga/external-audit.jsonl (0600): one JSON line per decision,
 * only ever appended. At its size cap the file becomes .1 (the previous .1 goes) and a new one starts.
 */

const MAX_BYTES = 10 * 1024 * 1024;

export const auditFilePath = (): string => path.join(belugaHome(), 'external-audit.jsonl');

const Stored = z.object({
  ts: z.number(),
  agent: z.string(),
  agentId: z.string().optional(),
  tool: z.string(),
  class: z.enum(OPERATION_CLASSES),
  target: z.string().max(TARGET_MAX),
  decision: z.enum(OUTCOMES),
  decidedBy: z.enum(DECIDED_BY),
  result: z.enum(['ok', 'error', ...DENIALS]),
  durationMs: z.number(),
  argsHash: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().max(SUMMARY_MAX),
});

export interface AuditFileOptions {
  readonly file?: string;
  readonly now?: () => number;
  readonly maxBytes?: number;
}

export class AuditFile implements AuditLog {
  private readonly file: string;
  private readonly now: () => number;
  private readonly maxBytes: number;

  constructor(opts: AuditFileOptions = {}) {
    this.file = opts.file ?? auditFilePath();
    this.now = opts.now ?? Date.now;
    this.maxBytes = opts.maxBytes ?? MAX_BYTES;
  }

  append(entry: AuditEntry): void {
    const line = `${JSON.stringify(auditRecord(entry, this.now(), hashArgs(entry.args)))}\n`;
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (sizeOf(this.file) + Buffer.byteLength(line) > this.maxBytes) this.rotate();
    const fd = openSync(this.file, 'a', 0o600);
    try {
      // `mode` only applies to a new file: an older one that was opened up closes again here.
      fchmodSync(fd, 0o600);
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  }

  recent(limit: number): AuditRecord[] {
    return [...linesOf(this.rotated()), ...linesOf(this.file)].flatMap(parseLine).slice(-limit).reverse();
  }

  private rotate(): void {
    if (sizeOf(this.file) > 0) renameSync(this.file, this.rotated());
  }

  private rotated(): string {
    return `${this.file}.1`;
  }
}

const sizeOf = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

const linesOf = (file: string): string[] => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

const parseLine = (line: string): AuditRecord[] => {
  try {
    const parsed = Stored.safeParse(JSON.parse(line));
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
  }
};

const hashArgs = (args: unknown): string => createHash('sha256').update(JSON.stringify(sorted(args)) ?? 'null').digest('hex');

/** The same value with its keys in one order, so a hash doesn't depend on how it was written. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sorted(v)]));
}
