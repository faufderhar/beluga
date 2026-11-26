import type { RuntimeStatus } from '../types.js';
import { ACP_AUTH_REQUIRED, ACP_SIGNED_OUT, acpSignedOut, modelRows } from '../acp/parts.js';
import { acpStatus } from '../acp/status.js';
import { type AgyConnect, dropAgyLog } from './connection.js';
import { rulesFreeArgs } from './rules-free.js';
import { dropAgySession } from './sessions.js';
import { AGY_MISSING, AGY_SIGN_IN, ANTIGRAVITY } from './spec.js';

export { AGY_MISSING, AGY_SIGN_IN };

export { ACP_AUTH_REQUIRED, modelRows };
/** Its words for "nobody is signed in", when it says so without ACP's code. */
export const AGY_SIGNED_OUT = ACP_SIGNED_OUT;
/** Signed out, as an ACP error says it: by its code, else its words. */
export const signedOut = acpSignedOut;

/**
 * Its words when your plan's quota has run out: the RESOURCE_EXHAUSTED status, a 429, the weekly or
 * five-hour limit. Not every "exceeded": a deadline or a context window is no limit of your plan's.
 */
export const AGY_LIMIT = /resource.?exhausted|\b429\b|quota|rate.?limit|(weekly|five.?hour|usage) limit/i;

interface StatusDeps {
  readonly bin?: string;
  readonly connect?: AgyConnect;
  /** Drops the session it opened to look (tests: a fake; none with a scripted `connect`). */
  readonly drop?: (sessionId: string) => Promise<unknown>;
}

/**
 * Antigravity on this Mac: not installed, not signed in, or ready with the models your plan has.
 * It opens a session to find out (no message is sent, so nothing of your quota is used), then
 * drops it. Kept a minute. Never signs in.
 */
export function agyStatus(deps: StatusDeps & { readonly now?: number } = {}): Promise<RuntimeStatus> {
  return acpStatus(ANTIGRAVITY, { dropSession: (id) => dropAgySession(id), afterLook: (pid) => dropAgyLog(pid), launch: () => rulesFreeArgs() }, deps);
}
