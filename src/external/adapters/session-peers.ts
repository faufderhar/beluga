import { createRoomBridge } from '../../core/agent-bridge.js';
import { gatewayOf } from '../../core/gateway/registry.js';
import type { Session } from '../../core/session.js';
import { externalRequester } from '../../core/trust.js';
import type { PeersPort } from '../ports/peers.js';

/** The peers port over a daemon's session. An agent's home is its requester id: that channel names it on what it sends. */
export function sessionPeers(session: Session): PeersPort {
  const projects = () => session.store.getState().projects;
  return {
    bridge: (agent, projectId) => createRoomBridge(session, () => projects().find((p) => p.id === projectId)?.root ?? '', externalRequester(agent.id)),
    taskSender: (id) => gatewayOf(session)?.sentBy(id),
    taskHoldsSecret: (id) => gatewayOf(session)?.holdsSecret(id) ?? false,
    projectId: (name) => projects().find((p) => p.name.toLowerCase() === name.trim().toLowerCase())?.id,
    projectIds: () => projects().filter((p) => p.root).map((p) => p.id),
    projectDirs: (id) => {
      const project = projects().find((p) => p.id === id);
      return project ? [project.root, ...project.workspaces.map((w) => w.path)].filter(Boolean) : [];
    },
    setup: (worktree) => {
      const found = projects().flatMap((p) => p.workspaces).find((w) => w.id === worktree);
      const tools = found ? session.workbench?.setupForRun(found.id) : undefined;
      return found && tools ? { projectId: found.projectId, tools } : undefined;
    },
  };
}
