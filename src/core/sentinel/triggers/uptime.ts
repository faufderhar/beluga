import { type UptimeTrigger, hostOf } from '../model.js';
import { MINUTE, type FetchLike, type TriggerContext, type TriggerDeps, type TriggerEvent, firstWords, startPolling } from './types.js';
import { THIS_COMPUTER } from '../../../shared/assistant.js';

/**
 * Uptime (docs/sentinel.md §1): the URL fetched every 1, 5 or 15 minutes (10 seconds to answer)
 * with the status it should answer (200 by default). It fires on the change only: down once two
 * checks in a row failed (one is a blip), and back on the first good check after that. Up or down
 * is the cursor, so a restart doesn't say "back" about a site that never went.
 */

export interface UptimeCursor {
  readonly state: 'up' | 'down';
  /** Failed checks in a row. */
  readonly fails: number;
  /** When the current state began (down: the first failed check). */
  readonly since: number;
  /** The first failure of this run of failures (it becomes `since` when they count as down). */
  readonly failingSince?: number;
}

export interface UptimeCheck {
  readonly ok: boolean;
  /** The status (0: no answer). */
  readonly status: number;
  readonly ms: number;
  /** No answer: why ("timed out after 10 s"). */
  readonly error?: string;
  /** The Mac itself is offline (no DNS, no network): says nothing about the site, either way. */
  readonly offline?: boolean;
}

/** Errors that mean this Mac can't reach anything (not that the site is down). */
const OFFLINE = /\b(ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENETDOWN)\b/;

/** An error's codes and messages, its causes' too (fetch says "fetch failed" with the reason in `cause`). */
function codesOf(err: unknown): string {
  const out: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    if (typeof e !== 'object') {
      out.push(String(e));
      break;
    }
    const o = e as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof o.code === 'string') out.push(o.code);
    if (typeof o.message === 'string') out.push(o.message);
    if (Array.isArray(o.errors)) for (const x of o.errors) if (x && typeof x === 'object' && typeof (x as { code?: unknown }).code === 'string') out.push((x as { code: string }).code);
    e = o.cause;
  }
  return out.join(' ');
}

const TIMEOUT_MS = 10_000;
/** Failed checks in a row that count as down. */
export const DOWN_AFTER = 2;

export async function checkUrl(fetchFn: FetchLike, t: UptimeTrigger, now: () => number = Date.now): Promise<UptimeCheck> {
  const start = now();
  const expect = t.expect ?? 200;
  try {
    const res = await fetchFn(t.url, { method: 'GET', redirect: expect >= 300 && expect < 400 ? 'manual' : 'follow', headers: { 'User-Agent': 'Beluga Sentinel (uptime)' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    // The body isn't needed; stop downloading it and let the connection go.
    void res.body?.cancel().catch(() => undefined);
    return { ok: res.status === expect, status: res.status, ms: now() - start };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const codes = codesOf(err);
    const offline = !timedOut && OFFLINE.test(codes);
    return { ok: false, status: 0, ms: now() - start, error: timedOut ? `no answer in ${TIMEOUT_MS / 1000} s` : offline ? `${THIS_COMPUTER} is offline (${OFFLINE.exec(codes)![1]})` : firstWords(err), ...(offline ? { offline: true } : {}) };
  }
}

/** A check against what was: the next cursor, and the event when it changed (down after two failures, back on the first success). */
export function uptimeStep(t: UptimeTrigger, cursor: UptimeCursor | undefined, check: UptimeCheck, at: number): { readonly cursor: UptimeCursor; readonly event?: TriggerEvent } {
  const was: UptimeCursor = cursor ?? { state: 'up', fails: 0, since: at };
  // Offline here: neither a failure nor a success (down stays down, up stays up, the count waits).
  if (check.offline) return { cursor: was };
  const host = hostOf(t.url);
  if (check.ok) {
    if (was.state === 'down') {
      return {
        cursor: { state: 'up', fails: 0, since: at },
        event: { summary: `${host} is back (${check.status}, ${check.ms} ms)`, payload: { state: 'up', url: t.url, status: check.status, ms: check.ms, since: was.since, downFor: at - was.since } },
      };
    }
    return { cursor: { state: 'up', fails: 0, since: was.since } };
  }
  const fails = was.fails + 1;
  const failingSince = was.failingSince ?? at;
  if (was.state === 'up' && fails >= DOWN_AFTER) {
    const why = check.status ? String(check.status) : (check.error ?? 'no answer');
    return {
      cursor: { state: 'down', fails, since: failingSince },
      event: { summary: `${host} stopped answering (${why})`, payload: { state: 'down', url: t.url, status: check.status, ms: check.ms, since: failingSince, expected: t.expect ?? 200, ...(check.error ? { error: check.error } : {}) } },
    };
  }
  return { cursor: { ...was, fails, ...(was.state === 'up' ? { failingSince } : {}) } };
}

export const uptimeEvery = (t: UptimeTrigger): number => (t.minutes === 1 || t.minutes === 15 ? t.minutes : 5) * MINUTE;

export function startUptime(t: UptimeTrigger, ctx: TriggerContext<UptimeCursor>, deps: TriggerDeps): () => void {
  const now = deps.now ?? Date.now;
  return startPolling(
    ctx,
    async () => {
      if (!deps.fetch) return 'Checking a site needs the Beluga app';
      const check = await checkUrl(deps.fetch, t, now);
      const { cursor, event } = uptimeStep(t, ctx.cursor(), check, now());
      ctx.save(cursor);
      if (event) ctx.fire(event);
      return undefined;
    },
    { everyMs: uptimeEvery(t) },
  );
}
