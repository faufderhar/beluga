import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { belugaEnv } from '../../core/beluga-env.js';
import { belugaHome } from '../../core/home.js';

/** Whether the external agents' listener opens, in ~/.beluga/external.json (0600). No file: off. */

export const EXTERNAL_HOST = '127.0.0.1';
export const EXTERNAL_PORT = 7778;

const Config = z.object({ enabled: z.boolean(), paused: z.boolean().optional(), tailscale: z.boolean().optional(), public: z.boolean().optional(), signingKey: z.string().min(32).max(200).optional() });
export type ExternalConfig = z.infer<typeof Config>;

export const externalConfigPath = (): string => path.join(belugaHome(), 'external.json');

export function readExternalConfig(file = externalConfigPath()): ExternalConfig {
  try {
    const parsed = Config.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

/** Changes what's given and keeps the rest. */
export function writeExternalConfig(patch: Partial<ExternalConfig>, file = externalConfigPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...readExternalConfig(file), ...patch }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** The key that signs stateless client registrations, made once. */
export function externalSigningKey(file = externalConfigPath()): string {
  const held = readExternalConfig(file).signingKey;
  if (held) return held;
  const key = randomBytes(32).toString('base64url');
  writeExternalConfig({ signingKey: key }, file);
  return key;
}

/** The port unless asked otherwise: BELUGA_EXTERNAL_PORT (end-to-end tests run many, on 0), else 7778. */
export function externalPort(): number {
  const raw = belugaEnv('EXTERNAL_PORT');
  const n = Number(raw);
  return raw && /^\d+$/.test(raw) && n <= 65535 ? n : EXTERNAL_PORT;
}

/** Where it listens: 127.0.0.1 unless BELUGA_EXTERNAL_HOST says otherwise, and the listener refuses anything but loopback. */
export const externalHost = (): string => belugaEnv('EXTERNAL_HOST') ?? EXTERNAL_HOST;

export const externalUrl = (port: number): string => `http://${EXTERNAL_HOST}:${port}/mcp`;
