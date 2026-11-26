/**
 * Text that looks like it holds a secret (a database password, an API key), so a message to the
 * group chat can stop and say so before everyone in the room has it. Browser-safe.
 */
import { looksLikeKey } from './key-shape.js';

const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  // A connection string with its password in it (Supabase › Connect's [YOUR-PASSWORD] isn't one).
  [/\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|rediss|amqps?):\/\/[^:\s/@]+:(?!\[YOUR)[^@\s]{3,}@/i, 'a connection string with its password'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
  [/\b(sk|rk)_live_[A-Za-z0-9]{10,}/, 'a Stripe secret key'],
  [/\bsk_[A-Za-z0-9_-]{16,}/, 'a RevenueCat secret key'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{32,}/, 'an API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b[A-Z][A-Z0-9_]*(PASSWORD|PASSWD|SECRET|PRIVATE_KEY|SERVICE_ROLE_KEY|API_KEY|TOKEN)\s*=\s*["']?[^\s"']{6,}/, 'a secret value'],
];

/** What secret the text seems to hold ("a connection string with its password"), if any. */
export function secretIn(text: string): string | undefined {
  // A key no list knows, shaped like one (`rtl_…`, BLG-977).
  return SECRETS.find(([re]) => re.test(text))?.[1] ?? (looksLikeKey(text) ? 'an API key' : undefined);
}
