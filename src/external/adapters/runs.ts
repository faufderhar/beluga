import { type ExternalLookup, externalRequester, isExternalRequester, type TrustLevel } from '../../core/trust.js';
import { runtimeFor } from '../../agent/runtime/registry.js';
import { canHold, ToolRefusal } from '../domain/decide.js';
import { isExpired } from '../domain/grant.js';
import type { GrantStore } from '../ports/grant-store.js';

/**
 * Who stands behind an `ext:` requester, read from the grant book each time. Nothing is held, so a
 * revoke or a suspension counts at the run's next step. A level its route can't hold is refused.
 */
export function grantLookup(grants: Pick<GrantStore, 'list'>, now: () => number): ExternalLookup {
  return (requester) => {
    if (!isExternalRequester(requester)) return undefined;
    const grant = grants.list().find((g) => externalRequester(g.id) === requester);
    if (!grant || isExpired(grant, now())) return undefined;
    return { name: grant.name, level: canHold(grant.route, grant.level, grant.allowRemoteFull) && grant.suspendedAt === undefined ? grant.level : 'blocked' };
  };
}

/** Whether a runtime stops at Beluga's gate before each step. An unknown one doesn't. */
export const asksEachStep = (runtime: string): boolean => runtimeFor(runtime)?.capabilities.canGateEveryTool === true;

/** At level ask each step shows a card, so its run needs a runtime that asks before each step. Read at each launch and send. */
export const runtimeAllowed = (level: TrustLevel, runtime: string): boolean => level !== 'ask' || asksEachStep(runtime);

export function needAllowedRuntime(level: TrustLevel, runtime: string): void {
  if (!runtimeAllowed(level, runtime)) throw new ToolRefusal('level_denied', `At level ask each step needs a card, and ${runtime} cannot ask before each step. Use a Claude agent or raise this agent's level.`);
}
