import {
  type FoundDatabase,
  type PgProblem,
  classifyPgError,
  hidePassword,
  hostOf,
  isSupabaseDirect,
  parsePgUrl,
  poolerCandidates,
  poolerUrl,
  scrubbed,
  withPassword,
} from './database-url.js';
import { THIS_COMPUTER } from '../../shared/assistant.js';

/**
 * Reaching a Postgres database (BLG-302): the connection string, then its fallbacks; for Supabase,
 * when its direct address can't be reached (IPv6 only), its session pooler, found by asking each
 * region's until one knows the project; when the password is refused, the project's other password
 * variables (SUPABASE_DB_PASSWORD…). What answered is remembered, so the next run dials it first. When
 * nothing works it says why in words (no IPv6, the wrong pooler, the wrong password) and what to put
 * where, the password hidden. psql is passed in: the tests fake it.
 */

/** Run one query with psql against a connection string → its output; throws with psql's error. */
export type Psql = (url: string, sql: string, timeoutMs: number) => Promise<string>;

/** What answered before: by connection string, the one that worked; by Supabase project, its pooler host. */
export interface PgMemory {
  readonly reached: Map<string, string>;
  readonly poolers: Map<string, string>;
}
export const pgMemory: PgMemory = { reached: new Map(), poolers: new Map() };

/** psql isn't there at all: said once, as it is. */
export const PSQL_MISSING = `psql isn’t on ${THIS_COMPUTER}: install it with “brew install libpq” (or Postgres.app)`;
/** Poolers asked at once while looking for the project's. */
const AT_ONCE = 8;
const PROBE = 'SELECT 1';
const PROBE_MS = 10_000;

/** One address tried, and how it went (the message without the connection string or its password). */
export interface Tried {
  readonly url: string;
  readonly problem: PgProblem;
  readonly message: string;
}

/** Run `sql` on the first address that answers, as above. → psql's output. Errors never carry a password. */
export async function connectPostgres(found: FoundDatabase, sql: string, timeout: number, psql: Psql, memory: PgMemory = pgMemory): Promise<string> {
  const tried: Tried[] = [];
  const secrets = new Set<string>([found.url, ...(found.more ?? [])]);
  const clean = (text: string): string => {
    let out = text;
    for (const url of secrets) out = scrubbed(out, url);
    for (const p of found.passwords ?? []) for (const form of new Set([p.value, safeDecode(p.value)])) if (form.length >= 4) out = out.split(form).join('•••');
    return out;
  };
  const attempt = async (url: string, query = sql, ms = timeout): Promise<{ readonly out: string } | Tried> => {
    secrets.add(url);
    try {
      return { out: await psql(url, query, ms) };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (text === PSQL_MISSING) throw new Error(PSQL_MISSING);
      const t: Tried = { url, problem: classifyPgError(text, url), message: clean(text) };
      tried.push(t);
      return t;
    }
  };
  const done = (url: string, out: string): string => {
    memory.reached.set(found.url, url);
    if (found.supabase && !isSupabaseDirect(url) && /\.pooler\.supabase\.com$/i.test(hostOf(url))) memory.poolers.set(found.supabase.ref, hostOf(url));
    return out;
  };
  /** The database answered, and not about connecting (bad SQL): said as it is. */
  const answered = (t: Tried): Error => new Error(`${t.message} (connecting with ${found.from})`);

  /** The server's right but its password was refused: the project's other passwords, in turn. */
  const otherPasswords = async (url: string): Promise<string | undefined> => {
    const have = parsePgUrl(url)?.password;
    for (const p of found.passwords ?? []) {
      if (p.value === have) continue;
      const next = withPassword(url, p.value);
      const r = await attempt(next);
      if ('out' in r) return done(next, r.out);
      if (r.problem === 'other') throw answered(r);
    }
    return undefined;
  };

  const known = memory.reached.get(found.url);
  const order = [...new Set([...(known ? [known] : []), found.url, ...(found.more ?? [])])];
  let refused: string | undefined;
  for (const url of order) {
    const r = await attempt(url);
    if ('out' in r) return done(url, r.out);
    if (r.problem === 'other') throw answered(r);
    if (r.problem === 'wrong-password') {
      const out = await otherPasswords(url);
      if (out !== undefined) return out;
      refused = url;
      break;
    }
  }

  // Supabase's address didn't answer and no pooler said yes: ask each region's until one knows it.
  let pooler: string | undefined;
  if (!refused && found.supabase) {
    const { ref } = found.supabase;
    const base = order.find((u) => parsePgUrl(u)?.password !== undefined) ?? found.url;
    const triedHosts = new Set(tried.map((t) => hostOf(t.url)));
    const remembered = memory.poolers.get(ref);
    const hosts = [...new Set([...(remembered ? [remembered] : []), ...poolerCandidates(found.supabase)])].filter((h) => !triedHosts.has(h));
    for (let i = 0; i < hosts.length && !pooler; i += AT_ONCE) {
      const batch = hosts.slice(i, i + AT_ONCE).map((h) => poolerUrl(base, ref, h));
      const results = await Promise.all(batch.map((u) => attempt(u, PROBE, Math.min(timeout, PROBE_MS))));
      const at = results.findIndex((r) => 'out' in r || r.problem === 'wrong-password' || r.problem === 'other');
      // None answered at all: this Mac is offline, not on the wrong pooler.
      if (at < 0 && results.every((r) => !('out' in r) && r.problem === 'unreachable')) break;
      if (at < 0) continue;
      const url = batch[at]!;
      const r = results[at]!;
      memory.poolers.set(ref, hostOf(url));
      pooler = url;
      if ('out' in r) {
        const real = await attempt(url);
        if ('out' in real) return done(url, real.out);
        if (real.problem === 'other') throw answered(real);
        if (real.problem !== 'wrong-password') break;
      } else if (r.problem === 'other') throw answered(r);
      const out = await otherPasswords(url);
      if (out !== undefined) return out;
      refused = url;
    }
  }
  throw new Error(pgFailure(found, tried, refused ?? pooler));
}

/** Plural "addresses" for a count. */
const addresses = (n: number): string => `${n} ${n === 1 ? 'address' : 'addresses'}`;

/**
 * Why nothing answered, in plain words, and what to do: the password refused (and which were tried),
 * Supabase's direct address with no IPv6 here, no pooler knowing the project; with the pooler's
 * connection string to put in place, its password hidden. `pooler`: the pooler that knows the project.
 */
export function pgFailure(found: FoundDatabase, tried: readonly Tried[], pooler?: string): string {
  const target = found.from.startsWith('`$') ? found.from : '`$DATABASE_URL`';
  const ref = found.supabase?.ref;
  const refusedBy = tried.filter((t) => t.problem === 'wrong-password');
  const via = ` (connecting with ${found.from}${tried.length > 1 ? `, tried ${addresses(new Set(tried.map((t) => t.url)).size)}` : ''})`;
  if (refusedBy.length) {
    const which = [`${found.from}’s`, ...(found.passwords ?? []).map((p) => p.from)].slice(0, 1 + Math.max(0, refusedBy.length - 1));
    const server = pooler ?? refusedBy[0]!.url;
    const supa = ref && /\.pooler\.supabase\.com$/i.test(hostOf(server));
    return (
      `The database refused the password (${which.join(', then ')}).` +
      (supa
        ? ` Supabase’s session pooler for this project is ${hostOf(server)}: set the right password (Supabase › Project Settings › Database resets it) and put this in ${target}: ${hidePassword(server)}`
        : ` Check the password in ${found.from}.`) +
      via
    );
  }
  const direct = tried.find((t) => t.problem === 'no-ipv6');
  if (ref && (direct || tried.some((t) => t.problem === 'wrong-pooler'))) {
    const poolers = tried.filter((t) => /\.pooler\.supabase\.com$/i.test(hostOf(t.url)));
    const dead = poolers.filter((t) => t.problem === 'unreachable');
    const example = hidePassword(poolerUrl(found.url, ref, `aws-0-${found.supabase?.region ?? '<region>'}.pooler.supabase.com`));
    if (poolers.length && dead.length === poolers.length) return `Neither Supabase’s direct address nor its session poolers answered: is ${THIS_COMPUTER} online?${via}`;
    const why = direct ? `Supabase’s direct address (db.${ref}.supabase.co) answers only over IPv6, and this network has none. ` : '';
    const poolerWords = poolers.length ? `None of Supabase’s session poolers (${poolers.length} tried) knows project ${ref}: the wrong region, or aws-0 for aws-1.` : 'No session pooler was tried.';
    return `${why}${poolerWords} Put the Session pooler connection string from Supabase › Connect in ${target}, like ${example}${via}`;
  }
  const last = tried.at(-1);
  return `${last?.message ?? 'The database didn’t answer'}${via}${found.hint && last && (last.problem === 'unreachable' || last.problem === 'no-ipv6') ? ` ${found.hint}` : ''}`;
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
