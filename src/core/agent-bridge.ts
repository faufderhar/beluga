import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PeerSummary, RoomBridge } from '../agent/types.js';
import type { GatewayBridge } from '../agent/gateway-tools.js';
import type { TaskView } from './gateway/model.js';
import { gatewayOf, needGateway } from './gateway/registry.js';
import { GRANT_INFO, externalRequester } from './trust.js';
import type { MessageVia, PeerInfo } from '../protocol.js';
import type { Session } from './session.js';
import { peerName } from './store.js';
import { PROJECT_DIR } from '../shared/scratch-dir.js';

/** Where your Claude writes reports, and how they're announced to the room. */
export async function writeReport(session: Session, cwd: string, title: string, markdown: string): Promise<string> {
  const dir = path.join(cwd, PROJECT_DIR, 'reports');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'report';
  const file = path.join(dir, `${stamp}-${slug}.md`);
  await fs.writeFile(file, markdown.startsWith('#') ? markdown : `# ${title}\n\n${markdown}`, 'utf8');
  const hit = session.locateShared(file);
  if (hit) {
    session.send({ kind: 'report', share: hit.share, path: hit.path, title }, { keep: true });
    session.send({ kind: 'focus', owner: session.selfId, share: hit.share, path: hit.path, actor: 'agent' });
  }
  return hit ? `${hit.share}/${hit.path}` : file;
}

/**
 * What your Claude may do to the room, exposed to it as MCP tools (see agent/tools.ts).
 * `channel`: the conversation a run works in. Several run at once, so each run's tools are bound
 * to its own (inChannel): its updates and questions never land in another conversation.
 */
export function createRoomBridge(session: Session, cwd: () => string, channel?: string): RoomBridge {
  const conversation = (): string => channel ?? session.host.currentChannel;
  const requirePeer = (name: string): PeerInfo => {
    const peer = session.findPeer(name);
    if (!peer) throw new Error(`No peer named "${name}". Call list_peers first.`);
    return peer;
  };
  /** Whose folder: someone in the room, or a friend whose worktree with that share is shared with you (over the network too). */
  const folderOwner = (name: string, share: string): string => {
    const peer = session.findPeer(name);
    if (peer) return peer.peerId;
    const state = session.store.getState();
    const lower = name.toLowerCase().replace(/^@/, '');
    const ws = state.shared.find((w) => w.share === share && peerName(state, w.owner).toLowerCase() === lower);
    if (!ws) throw new Error(`No peer named "${name}". Call list_peers first.`);
    return ws.owner;
  };
  /** A file's frames have no label of their own: the words they show say who asked. */
  const viaWords = (words?: string): string | undefined => {
    const via = session.host.viaIn(conversation());
    return via ? `via ${via.name}${words ? `: ${words}` : ''}` : words;
  };
  return {
    selfName: () => session.store.getState().self?.name ?? 'me',
    sendChat: (text) => session.sendChat(text, true, conversation(), undefined, false, false, session.host.viaIn(conversation())),
    listPeers: () => session.store.getState().peers,
    askAgent: (name, prompt, project) => {
      const peer = requirePeer(name);
      if (!peer.agent) return Promise.reject(new Error(`${peer.name} has no agent online`));
      // Their Claude may send files back for you: accept them without asking.
      session.remote.expectFrom(peer.peerId);
      const via = session.host.viaIn(conversation());
      return session.askPeerAgent(peer.peerId, peer.name, prompt, { ...(project ? { project } : {}), mirror: conversation(), ...(via ? { via } : {}) });
    },
    runOnPeer: (name, command, opts = {}) => {
      const via = session.host.viaIn(conversation());
      return session.runOnPeer(name, command, { ...opts, viaAgent: true, channel: conversation(), ...(via ? { via } : {}) });
    },
    describePeers: () => describePeers(session),
    listPeerFiles: (name, share, p) => session.files.listFiles({ owner: folderOwner(name, share), share, path: p }),
    readPeerFile: async (name, share, p) => (await session.files.readFile({ owner: folderOwner(name, share), share, path: p })).content,
    // In a workspace's conversation, its own folder: the room's may be "/" when the app starts the daemon.
    writeReport: (title, markdown) => writeReport(session, (channel && session.workspaces?.inChannel(channel)?.path) || cwd(), title, markdown),
    reportUsage: (usage, agent) => session.updateUsage(usage, agent),
    getPeerFile: (name, file, saveTo, why) => session.remote.getFile(requirePeer(name).peerId, file, saveTo, viaWords(why)),
    sendFile: (name, file, note) => session.remote.sendFile(requirePeer(name).peerId, file, viaWords(note)),
    gateway: gatewayBridge(session, channel),
    inChannel: (c) => createRoomBridge(session, cwd, c),
  };
}

/** Tasks between Claudes for your Claude's tools (agent/gateway-tools.ts), through the session's gateway. */
export function gatewayBridge(session: Session, channel?: string): GatewayBridge {
  const conversation = (): string => channel ?? session.host.currentChannel;
  const gw = () => needGateway(session);
  /** The external agent this run is for, if it is for one: what it asks of others says so. */
  const viaHere = (): { via?: MessageVia; viaFull?: boolean } => {
    const via = session.host.viaIn(conversation());
    return via ? { via, viaFull: session.host.externalLevel(externalRequester(via.id)) === 'full' } : {};
  };
  const told = (t: TaskView): string => {
    const target = t.kind === 'ask' ? `${t.peerName}'s agent` : `${t.peerName}'s Mac`;
    const next = `Call wait_for with task "${t.id}" to wait for the answer, or end your turn saying you asked: the answer comes back into this conversation when it arrives.`;
    if (t.state === 'confirm') return `Task ${t.id}: your user is asked first ("Ask ${target}?"), because they haven't marked ${t.peerName} as trusted. ${next} (wait_for waits through their answer too.)`;
    const offline = t.steps.some((s) => s.includes('offline')) ? ` ${t.peerName} is offline right now; it goes out when they're back.` : '';
    return `Task ${t.id} sent to ${target}.${offline} ${next}`;
  };
  return {
    available: () => Boolean(gatewayOf(session)),
    whoCan: (need) => gw().whoCan(need),
    askPerson: (input) => told(gw().ask({ ...input, by: 'agent', conversation: conversation(), ...viaHere() })),
    runOn: (input) =>
      told(
        gw().ask({
          person: input.person,
          kind: 'run',
          ask: input.why ?? input.command,
          ...(input.why ? { summary: input.why } : {}),
          command: input.command,
          needs: ['shell'],
          by: 'agent',
          conversation: conversation(),
          ...viaHere(),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.project ? { project: input.project } : {}),
          ...(input.timeoutSec ? { timeoutSec: input.timeoutSec } : {}),
        }),
      ),
    getFile: (input) =>
      told(
        gw().ask({
          person: input.person,
          kind: 'file',
          ask: input.why ?? `Send me ${input.path}`,
          ...(input.why ? { summary: input.why } : {}),
          path: input.path,
          by: 'agent',
          conversation: conversation(),
          ...viaHere(),
        }),
      ),
    answerQuestion: (task, answers) => {
      const t = gw().answer(task, answers, 'agent');
      if (t.answerDraft) return `Your user hadn't seen task ${t.id}, so they see your answer before it goes to ${t.peerName}'s agent (they can send it, change it, or let them decide). End your turn or call wait_for: the result comes back here.`;
      return `Answer sent to ${t.peerName}'s agent for task ${t.id}. Call wait_for to wait for the result (or end your turn: it comes back here).`;
    },
    waitFor: async (task, timeoutSec) => {
      await gw().wait(task, timeoutSec * 1000);
      return gw().describe(task);
    },
    check: (task) => gw().describe(task),
    cancel: (task) => {
      const t = gw().cancel(task);
      return `Task ${t.id} is ${t.state === 'cancelled' ? 'cancelled' : `already ${t.state}`}.`;
    },
  };
}

/** Everyone in the room as your Claude sees them: what they offer and what they let you do. */
export function describePeers(session: Session): PeerSummary[] {
  const state = session.store.getState();
  return state.peers.map((p) => {
    const you = p.peerId === session.selfId;
    const grant = state.granted[p.peerId];
    return {
      name: p.name,
      you,
      agent: p.agent,
      shares: p.shares.map((s) => s.name),
      projects: p.projects ?? [],
      workspaces: state.shared.filter((w) => w.owner === p.peerId).map((w) => ({ name: w.name, project: w.project, role: w.role === 'contribute' ? 'can ask their agent there' : 'follow only' })),
      ...(!you && grant ? { lets_you: { trust: grant.level, means: GRANT_INFO[grant.level].detail } } : {}),
    };
  });
}
