import type { AuditEntry, AuditRecord } from '../domain/audit.js';

/** Each decision made for an external agent. Records hold a hash of the arguments, never their values. */
export interface AuditLog {
  append(entry: AuditEntry): void;
  /** The latest records, newest first. */
  recent(limit: number): AuditRecord[];
}
