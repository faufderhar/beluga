import { AsyncLocalStorage } from 'node:async_hooks';
import type { MessageVia } from '../protocol.js';

/**
 * Which external agent's tool call this code runs for. A tool can reach any path that starts your
 * agent (a plan's task, a message edited, a fix asked for), so the mark goes along by itself: a run
 * started under it is that agent's, at its grant's level, and each message under it says so.
 */

export interface ActingAgent {
  readonly id: string;
  readonly name: string;
}

const acting = new AsyncLocalStorage<ActingAgent>();

export const asActingAgent = <T>(agent: ActingAgent, work: () => T): T => acting.run(agent, work);

/** For what lives on after the call and isn't this agent's: a shared timer, say. */
export const outsideActingAgent = <T>(work: () => T): T => acting.exit(work);

export function actingVia(): MessageVia | undefined {
  const agent = acting.getStore();
  return agent ? { id: agent.id, name: agent.name, creationSource: 'mcp' } : undefined;
}
