// Keys no provider list knows (BLG-977): a short lowercase prefix and a long random body, like
// `rtl_k6RdVk9lLghguXqcpxATMBfV00FPbQPV`. Never sure, so the card asks softly ("Looks like a key")
// and remembers a "Not a key". Public ids that share the shape (Anthropic's `msg_…`, Stripe's
// `pi_…`, `pk_live_…`) are never asked about. Browser-safe: no Node APIs.

/**
 * Prefixes of ids that are made to be shown (messages, requests, payments, customers, publishable
 * keys): their first word, lower case. A log or a Stripe dashboard paste is full of them.
 */
const PUBLIC_IDS = new Set([
  // Anthropic
  'msg', 'msgbatch', 'toolu', 'srvtoolu', 'req', 'file', 'compact',
  // OpenAI
  'chatcmpl', 'resp', 'run', 'thread', 'asst', 'call', 'batch', 'ft', 'vs', 'step', 'org', 'proj',
  // Stripe objects and publishable keys
  'pk', 'pi', 'ch', 'cus', 'sub', 'si', 'price', 'prod', 'evt', 'in', 'ii', 'il', 'pm', 'src', 'card', 'ba', 'acct', 'txn', 'tr', 'po', 're', 'seti', 'cs', 'plink', 'promo', 'coupon', 'tok', 'py', 'ipi', 'cn', 'dp', 'du', 'bt', 'fee', 'link',
  // Ids anywhere: users, teams, sessions, deployments, builds, traces
  'user', 'usr', 'team', 'sess', 'session', 'prj', 'dpl', 'inv', 'acc', 'tx', 'id', 'uid', 'uuid', 'ws', 'wt', 'conv', 'chat', 'job', 'task', 'img', 'sha', 'commit', 'build', 'trace', 'span', 'cache', 'idem', 'order', 'item', 'node', 'pub', 'public', 'anon', 'test', 'mock', 'demo',
]);

/** A token with a prefix: `rtl_…`, `abc-…`, `acme_live_…`, with a body of letters and digits only. */
const SHAPE = /(?<![A-Za-z0-9_\-./])([a-z][a-z0-9]{1,7}(?:_(?:live|test|prod|dev|sk|pk|v\d{1,2}))?[_-])([A-Za-z0-9]{24,128})(?![A-Za-z0-9_\-])/g;

/** Bits per character: a key's body is high, words and repeats are low. */
function bits(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let out = 0;
  for (const n of counts.values()) out -= (n / s.length) * Math.log2(n / s.length);
  return out;
}

/** Random enough to be a key: long hex, or upper, lower and digits all mixed, never a run or a word. */
function randomBody(body: string): boolean {
  if (/(.)\1{4,}/.test(body) || /x{4,}|X{4,}/.test(body)) return false;
  if (/^[a-f0-9]+$/.test(body)) return body.length >= 32 && bits(body) >= 3.2;
  if (!/[a-z]/.test(body) || !/[A-Z]/.test(body) || !/\d/.test(body)) return false;
  // A camelCase identifier with a number (UserProfileSettings2) is made of words; a key's pieces are short.
  const pieces = body.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
  if (pieces.length && body.length / pieces.length >= 4) return false;
  return bits(body) >= 3.6;
}

/** The first word of a prefix (`acme_live_` → `acme`). */
const firstWord = (prefix: string): string => prefix.split(/[_-]/)[0] ?? prefix;

/** A token that looks like an API key nobody listed: its prefix and where it is. */
export interface KeyShape {
  readonly value: string;
  readonly prefix: string;
  readonly at: number;
}

/** Every token in the text shaped like a key, except public ids and prefixes you said aren't keys. */
export function keyShapes(text: string, notKeys: readonly string[] = []): KeyShape[] {
  const out: KeyShape[] = [];
  const skip = new Set(notKeys.map((p) => p.toLowerCase()));
  for (const m of text.matchAll(SHAPE)) {
    const prefix = m[1]!;
    const body = m[2]!;
    if (PUBLIC_IDS.has(firstWord(prefix)) || skip.has(prefix.toLowerCase())) continue;
    if (!randomBody(body)) continue;
    out.push({ value: m[0], prefix, at: m.index ?? 0 });
  }
  return out;
}

/** Whether a single token looks like a key (the group chat's guard). */
export const looksLikeKey = (text: string): boolean => keyShapes(text).length > 0;

/**
 * A variable name for a key from its prefix (`rtl_…` → `RTL_API_KEY`), or `SECRET` with none,
 * never one already taken (`RTL_API_KEY_2`).
 */
export function suggestName(value: string, taken: readonly string[] = []): string {
  const prefix = /^([A-Za-z][A-Za-z0-9]{1,9})[_\-.]/.exec(value)?.[1];
  const base = prefix && !PUBLIC_IDS.has(prefix.toLowerCase()) ? `${prefix.toUpperCase()}_API_KEY` : 'SECRET';
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
  return base;
}
