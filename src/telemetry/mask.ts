/**
 * Masking text before it leaves this computer (level "on" only): the exact values of your saved
 * variables and every project's .env files, then keys by their known shapes, `key=value` secrets,
 * passwords inside URLs, emails, and your home folder. Over-masking is fine; under-masking isn't.
 *
 * Cheap on purpose: text is cut to MAX_TEXT before anything runs, the secret values are one
 * compiled matcher rebuilt only when they change, and every pattern is linear (bounded classes, no
 * nested quantifiers), so a pass over 32 KB takes well under a millisecond. Pure, browser-free and
 * synchronous: the caller decides when to run it (src/telemetry/exporter.ts, off the hot path).
 */

export const REDACTED = '[redacted]';
/** Text longer than this is cut (its start kept, with a marker) before masking. */
export const MAX_TEXT = 32_000;
/** A value shorter than this isn't treated as a secret (ports, flags, "true"). */
const MIN_SECRET = 6;
/** Values matched exactly: more than this and the longest are kept. */
const MAX_SECRETS = 2_000;
const MAX_SECRET_LENGTH = 4_096;

/** Keys by the shapes their makers give them. */
const KEY_SHAPES = [
  String.raw`-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,12000}?-----END [A-Z ]{0,40}PRIVATE KEY-----`,
  String.raw`\bsk-ant-[A-Za-z0-9_-]{20,400}`,
  String.raw`\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,400}`,
  String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,255}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{40,255}`,
  String.raw`\bglpat-[A-Za-z0-9_-]{20,255}`,
  String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,255}`,
  String.raw`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,255}`,
  String.raw`\bwhsec_[A-Za-z0-9+/=]{20,255}`,
  String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
  String.raw`\bAIza[0-9A-Za-z_-]{35}`,
  String.raw`\bnpm_[A-Za-z0-9]{36}`,
  String.raw`\bhf_[A-Za-z0-9]{30,255}`,
  String.raw`\brtl_[A-Za-z0-9_-]{16,255}`,
  String.raw`\bsntrys_[A-Za-z0-9+/=_-]{20,400}`,
  String.raw`\bey[JK][A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,2000}`,
  String.raw`\b[Bb]earer\s{1,4}[A-Za-z0-9._~+/=-]{20,2000}`,
];
const SHAPES = new RegExp(KEY_SHAPES.join('|'), 'g');
/** `API_KEY=…`, `"password": "…"`, `token: …`: the name stays, the value goes. */
const KEY_VALUE = /\b([A-Za-z0-9_.-]{0,40}(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|pass|pwd|credential|private[_-]?key|auth)[A-Za-z0-9_.-]{0,20}["']?\s{0,4}[:=]\s{0,4})(?:"[^"\n]{1,2000}"|'[^'\n]{1,2000}'|[^\s"',;]{4,2000})/gi;
/** The password in `scheme://user:password@host`. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,128}:)([^\s@/]{1,256})(@)/gi;
/** Anyone's home folder (macOS, Linux, Windows): the name in it is a person's. */
const HOMES = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\"'`]{1,64}/g;
const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a variable's value is worth masking: long enough, and not a plain word. */
export function secretWorthy(value: string): boolean {
  const v = value.trim();
  if (v.length < MIN_SECRET || v.length > MAX_SECRET_LENGTH) return false;
  // "production", "localhost", "development": words, not secrets.
  if (/^[A-Za-z]+$/.test(v) && v.length < 20) return false;
  // Flags and small numbers ("12345678" is kept: it could be a PIN).
  return !/^(true|false|yes|no|null|undefined)$/i.test(v);
}

export class Masker {
  private secrets?: RegExp;
  private signature = '';

  constructor(private readonly home?: string) {}

  /** The exact values to mask (your variables, the projects' .env values). Rebuilt only when they changed. */
  setSecrets(values: Iterable<string>): void {
    const kept = [...new Set([...values].map((v) => v.trim()).filter(secretWorthy))].sort((a, b) => b.length - a.length).slice(0, MAX_SECRETS);
    const signature = `${kept.length}:${kept.join('\u0000').length}:${hash(kept)}`;
    if (signature === this.signature) return;
    this.signature = signature;
    // Longest first, so a value that contains another is masked whole.
    this.secrets = kept.length ? new RegExp(kept.map(escape).join('|'), 'g') : undefined;
  }

  /** The text, masked (and cut to MAX_TEXT first). */
  mask(text: string): string {
    let out = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)} [cut]` : text;
    if (this.secrets) out = out.replace(this.secrets, REDACTED);
    out = out.replace(SHAPES, REDACTED);
    // A quoted value is taken whole (spaces and all), and keeps its quotes.
    out = out.replace(KEY_VALUE, (m: string, name: string) => {
      const value = m.slice(name.length);
      const q = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${name}${q}${REDACTED}${q}`;
    });
    out = out.replace(URL_PASSWORD, (_m, before: string, _pw: string, at: string) => `${before}${REDACTED}${at}`);
    out = out.replace(EMAIL, '[email]');
    if (this.home && this.home.length > 1) out = out.split(this.home).join('~');
    out = out.replace(HOMES, '~');
    return out;
  }
}

/** A short fingerprint of the values (FNV-1a), so an unchanged set isn't compiled again. */
function hash(values: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const v of values) {
    for (let i = 0; i < v.length; i++) {
      h ^= v.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0xff;
  }
  return (h >>> 0).toString(36);
}
