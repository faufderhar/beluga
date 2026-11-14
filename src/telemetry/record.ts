import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { belugaHome } from '../core/home.js';
import { TELEMETRY_LEVELS, type TelemetryRecord } from '../core/telemetry-store.js';

/** ~/.beluga/telemetry.json: your level, how you answered the ask, and this install's random id. */
export const telemetryPath = (): string => path.join(belugaHome(), 'telemetry.json');

const Asked = z.object({ round: z.number().int().min(0), answer: z.enum(['share', 'later', 'never']), at: z.number(), merges: z.number().int().min(0), times: z.number().int().min(1) });
export const TelemetryFile = z.object({
  installId: z.string().uuid(),
  level: z.enum(TELEMETRY_LEVELS).optional(),
  chosenAt: z.number().optional(),
  via: z.enum(['onboarding', 'ask', 'settings']).optional(),
  ask: Asked.optional(),
  excluded: z.array(z.string().min(1).max(4096)).max(1000).optional(),
});

/** The record, or a fresh one (a new random id, nothing chosen) when there's none or it doesn't read. */
export function loadTelemetryRecord(file: string = telemetryPath()): { record: TelemetryRecord; fresh: boolean } {
  try {
    const parsed = TelemetryFile.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (parsed.success) return { record: parsed.data, fresh: false };
  } catch {
    // None yet, or unreadable: start over.
  }
  return { record: { installId: randomUUID() }, fresh: true };
}

export function saveTelemetryRecord(record: TelemetryRecord, file: string = telemetryPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
