import { runtimeStatuses } from '../agent/runtime/registry.js';
import type { Session } from '../core/session.js';
import type { LogItem } from '../core/store.js';
import { externalRequester } from '../core/trust.js';
import { asksEachStep, grantLookup } from './adapters/runs.js';
import { stopAgentWork } from './adapters/stop.js';
import { sessionControl } from './adapters/session-control.js';
import { sessionFiles } from './adapters/session-files.js';
import { sessionMethods } from './adapters/session-methods.js';
import { withDiscovery } from './adapters/tools/discover.js';
import { fileTools } from './adapters/tools/files.js';
import { peopleTools } from './adapters/tools/people.js';
import { ALL_METHOD_ROWS, methodTools } from './adapters/tools/method-rows.js';
import { sessionReads } from './adapters/session-reads.js';
import { controlTools } from './adapters/tools/control.js';
import { readTools } from './adapters/tools/read.js';
import { stateTools } from './adapters/tools/state.js';
import { peerTools } from './adapters/tools/peers.js';
import { workspaceTools } from './adapters/tools/workspace.js';
import { sessionState } from './adapters/session-state.js';
import { sessionPeers } from './adapters/session-peers.js';
import { sessionWorkspace } from './adapters/session-workspace.js';
import { REMOTE_FULL_WARNING } from '../shared/remote-full.js';
import { LIMITS } from './domain/limits.js';
import { DISCOVERY_TOOLS } from './domain/tools.js';
import { attachExternal, detachExternal } from './registry.js';
import { ExternalService } from './service.js';

/** The external agents' server, in the daemon only. Listens only if you left it on. Returns its stop. */
export function launchExternal(deps: { readonly session: Session; readonly log?: (line: string) => void }): () => Promise<void> {
  const reads = sessionReads({
    state: () => deps.session.store.getState(),
    loadHistory: (id) => deps.session.workspaces?.manager.loadHistory<LogItem>(id) ?? [],
    stepsFor: (channel, itemId) => deps.session.host.stepsFor(channel, itemId),
    runtimes: async () => (await runtimeStatuses()).map((r) => ({ id: r.id, ready: r.state === 'ready', asksEachStep: asksEachStep(r.id), models: r.models.map((m) => ({ value: m.value, label: m.label })) })),
  });
  const chats = sessionControl(deps.session, { runCap: (id) => LIMITS[service.grants.list().find((g) => g.id === id)?.route ?? 'remote'].runs });
  const methods = sessionMethods(deps.session);
  const chatControl = controlTools(reads, chats);
  const others = [...stateTools(sessionState(deps.session), chats), ...workspaceTools(reads, sessionWorkspace(deps.session), chats), ...peerTools(sessionPeers(deps.session)), ...methodTools(ALL_METHOD_ROWS, reads, methods, chats.startedBy), ...fileTools(reads, sessionFiles(deps.session), methods), ...peopleTools(methods)];
  const service = new ExternalService({
    ...(deps.log ? { log: deps.log } : {}),
    tools: withDiscovery([...readTools(reads, { alsoTools: [...chatControl.map((t) => t.name), ...DISCOVERY_TOOLS], moreTools: others.length }), ...chatControl], others),
    // A card with no chat waits in the agent's own place, not in the group chat.
    // The agent is the card's peer: its cap on waiting cards applies and a stop finds them. The answer is only for this call, and writes no trust.
    ask: (title, detail, once, card, signal) => deps.session.host.ask('tool', title, detail, card ? externalRequester(card.agentId) : undefined, card?.chatId ? `ws:${card.chatId}` : card ? externalRequester(card.agentId) : 'room', { once, call: true, ...(card ? { asker: card.agent } : {}), ...(signal ? { signal } : {}) }),
    stopWork: (grantId) => stopAgentWork(deps.session, grantId),
    notify: (grant) => deps.session.toast(`${grant.name} connected to Beluga as an external agent (${grant.level})`, 'info'),
    notifyRemoteFull: (grant) => {
      const body = `${grant.name} at ${grant.redirectHost} has Full trust from outside this computer. ${REMOTE_FULL_WARNING} Revoke it in Settings › External agents if you didn't mean this.`;
      deps.session.toast(body, 'error');
      deps.session.notifier.notify({ kind: 'problems', title: `${grant.name} has Full trust from outside this computer`, body });
    },
    notifyLockout: () => {
      const body = 'Too many wrong pairing codes came through a remote address, so new remote sign-ins stop for up to 10 minutes. Connected agents keep working. Wait, or close the route in Settings › External agents.';
      deps.session.toast(body, 'error');
      deps.session.notifier.notify({ kind: 'problems', title: 'Remote sign-ins are stopped', body });
    },
    notifySuspended: (grant) => {
      deps.session.toast(`${grant.name} was suspended after repeated refusals. Resume or revoke it in Settings › External agents.`, 'error');
      deps.session.notifier.notify({ kind: 'problems', title: `${grant.name} was suspended`, body: 'It was refused again and again, so Beluga stopped it. Resume or revoke it in Settings › External agents.' });
    },
  });
  deps.session.host.setExternalAgents(grantLookup(service.grants, Date.now));
  attachExternal(deps.session, service);
  const starting = service.start();
  return async () => {
    await starting;
    detachExternal(deps.session);
    await service.stop();
  };
}
