import os from 'node:os';
import type { AttrValue } from './otlp.js';

/**
 * This computer's kind, sent once a day: the system and its version, the chip, how many cores and
 * how much memory (rounded), the language. No name, no address, no time zone, no screen.
 */
export function deviceFacts(extra: Readonly<Record<string, AttrValue>> = {}): Record<string, AttrValue> {
  let language: string | undefined;
  try {
    language = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    language = undefined;
  }
  return {
    os: process.platform,
    os_version: os.release(),
    arch: process.arch,
    cpus: os.cpus().length,
    memory_gb: Math.round(os.totalmem() / 2 ** 30),
    node_version: process.versions.node,
    ...(language ? { language } : {}),
    ...extra,
  };
}
