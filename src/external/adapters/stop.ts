import { gatewayOf } from '../../core/gateway/registry.js';
import { isFinal } from '../../core/gateway/model.js';
import type { Session } from '../../core/session.js';
import { externalRequester } from '../../core/trust.js';

/**
 * Stop for an agent: its runs, what it queued, what it has waiting on you, and the friend tasks it
 * sent. A task that can't be cancelled now doesn't stop the rest. → whether anything was going.
 */
export function stopAgentWork(session: Session, grantId: string): boolean {
  let stopped = session.host.stopExternal(externalRequester(grantId));
  const gateway = gatewayOf(session);
  if (!gateway) return stopped;
  for (const task of session.store.getState().gateway.tasks) {
    if (task.direction !== 'sent' || task.viaId !== grantId || isFinal(task.state)) continue;
    try {
      gateway.cancel(task.id);
      stopped = true;
    } catch {
      // Gone already.
    }
  }
  return stopped;
}
