import { asActingAgent } from '../acting-agent.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TASK_FEATURES } from '../../net/mesh/features.js';
import type { Mesh } from '../../net/mesh/mesh.js';
import { type Chat, chatOf } from '../chat/launch.js';
import { belugaHome } from '../home.js';
import { watchNetwork } from '../network.js';
import type { Session } from '../session.js';
import { loadSettings, saveSettings } from '../settings.js';
import type { Store } from '../store.js';
import { pretendSystem } from './demo-system.js';
import { Gateway, type MeshNode } from './gateway.js';
import { attachGateway, detachGateway } from './registry.js';
import { boardOf } from '../board/registry.js';
import type { ApproveOpts, Pending } from './serve.js';

/**
 * Start the gateway for the daemon (the Mac app's Beluga): tasks between Claudes over today's
 * room at once, and over the Beluga network whenever it's on. The demo keeps its tasks in a
 * temporary folder; otherwise they live in ~/.beluga/tasks/.
 */

/** The session's chats, while the network is on. */
const chatIn = (session: Session): Chat | undefined => {
  try {
    return chatOf(session);
  } catch {
    return undefined;
  }
};

/** The mesh node as the gateway sees it. */
export function meshNode(mesh: Mesh): MeshNode {
  return {
    get peerId() {
      return mesh.peerId;
    },
    isFriend: (id) => mesh.isFriend(id),
    isLinked: (id) => mesh.isLinked(id),
    sendGateway: (id, payload) => mesh.sendGateway(id, payload),
    nameFor: (id) => mesh.nameFor(id),
    belugaOf: (id) => mesh.belugaOf(id),
    post: (conversation, text, extras) => void mesh.post(conversation, text, extras),
    shares: (conversation, id) => mesh.shares(conversation, id),
    mail: (id, t, payload) => mesh.mail(id, t, payload),
    get mailAfterMs() {
      return mesh.mailAfterMs;
    },
    listen: ({ frame, link, leaving }) => {
      mesh.on('gateway', frame);
      mesh.on('link', link);
      const offLeaving = leaving ? mesh.onLeaving(leaving) : () => undefined;
      // Friends' Macs learn this one takes requests now (and no longer, once it stops listening).
      mesh.offer(TASK_FEATURES, true);
      return () => {
        mesh.off('gateway', frame);
        mesh.off('link', link);
        offLeaving();
        mesh.offer(TASK_FEATURES, false);
      };
    },
  };
}

/** Ask through today's approval cards (linked to the task), with a way to take the question back (it's answered "no"). */
export function approvals(session: Pick<Session, 'host' | 'store'>): (kind: 'request' | 'tool', title: string, detail: string, peer: string, task?: string, opts?: ApproveOpts) => Pending {
  return (kind, title, detail, peer, task, opts = {}) => {
    const before = new Set(session.store.getState().approvals.map((a) => a.id));
    // A request from a chat points at that chat (its card is there); the rest at the room as before.
    const answer = session.host.ask(kind, title, detail, peer, opts.conversation ?? 'room', { ...(task ? { task } : {}), ...(opts.once ? { once: true } : {}) });
    // ask() shows its card right away: find it, so it can be withdrawn.
    const id = session.store.getState().approvals.find((a) => !before.has(a.id))?.id;
    return { answer, withdraw: () => void (id && session.host.answerApproval('no', id)) };
  };
}

export interface GatewayHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

export function launchGateway(host: GatewayHost): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-tasks-')) : path.join(belugaHome(), 'tasks');
  let note = host.demo ? 'a review of the landing page, or anything in my projects' : (loadSettings().askMeFor ?? '');
  let caps: unknown;
  let freely: readonly string[] = host.demo ? [] : (loadSettings().askFreely ?? []);
  const projects = (): Array<{ name: string; root: string }> => (session.workspaces?.manager.list ?? []).filter((p) => p.root && !p.error).map((p) => ({ name: p.name, root: p.root }));
  const gateway = new Gateway({
    store,
    dir,
    scratch: dir,
    selfId: () => session.selfId,
    selfName: () => store.getState().self?.name ?? store.getState().network.self?.name ?? 'me',
    agent: () => session.backend,
    runs: (agent) => session.runsAgent(agent),
    approve: approvals(session),
    rulesFile: path.join(host.demo ? dir : belugaHome(), 'rules.json'),
    loadCaps: () => (host.demo ? caps : loadSettings().capabilities),
    saveCaps: (next) => {
      if (host.demo) caps = next;
      else saveSettings({ capabilities: next });
    },
    serveShell: (from, ask, hooks) => session.peerRun.serveTask(from, ask, hooks),
    runFolder: (from) => session.peerRun.defaultFolder(from),
    // The demo never looks at your real screen.
    ...(host.demo ? { system: pretendSystem() } : {}),
    resume: (channel, prompt, via) => {
      if (via) return asActingAgent(via, () => session.runFor(session.selfId, channel, prompt));
      // Your Claude asked from a friends' chat (BLG-207): it carries on there, and answers in the chat.
      const chat = /^(dm|group):/.test(channel) ? chatIn(session) : undefined;
      if (chat?.claude.acts()) return chat.claude.continueWith(channel, prompt);
      const name = /^\[(?:beluga|klaud)\] (.+?) \(task/.exec(prompt)?.[1] ?? 'A reply came';
      store.dispatch({ type: 'system', text: `${name}. Your agent continues with it.`, channel });
      session.runFor(session.selfId, channel, prompt);
    },
    projectRoot: (name) => projects().find((p) => p.name === name)?.root,
    board: (project, friend) => boardOf(session)?.forFriendIn(project, friend),
    projects: () => (store.getState().prefs.friendWorktrees === 'ask' ? projects().map((p) => p.name) : []),
    // From disk each time: your Always On taking your network, or this Mac standing in, writes it (BLG-848).
    loadNote: () => (host.demo ? note : (loadSettings().askMeFor ?? '')),
    saveNote: (text) => {
      note = text;
      if (!host.demo) saveSettings({ askMeFor: text || undefined });
    },
    loadAskFreely: () => (host.demo ? freely : (loadSettings().askFreely ?? [])),
    saveAskFreely: (peers) => {
      freely = peers;
      if (!host.demo) saveSettings({ askFreely: peers.length ? [...peers] : undefined });
    },
    notify: (e) => session.notifier.notify(e),
    room: () => ({
      present: (id) => {
        const state = store.getState();
        return state.status === 'connected' && state.peers.some((p) => p.peerId === id && !p.guest);
      },
      send: (id, frame) => session.send({ kind: 'gateway', frame }, { to: id }),
    }),
  });
  attachGateway(session, gateway);
  // Commands friends run here through the room (run_on_peer) follow the same rules and capabilities.
  session.peerRun.useAccess({
    decide: (facts, trust) => gateway.rules.decide(facts, trust),
    remember: (facts, name, decision) => void gateway.rules.remember(facts, name, decision),
  });
  const offNetwork = watchNetwork(session, (service) => (service ? gateway.attachMesh(meshNode(service.mesh)) : gateway.detachMesh()));
  let peers = store.getState().peers;
  const offPeers = store.subscribe(() => {
    const now = store.getState().peers;
    if (now === peers) return;
    peers = now;
    gateway.roomChanged();
  });
  return () => {
    offNetwork();
    offPeers();
    session.peerRun.useAccess(undefined);
    detachGateway(session);
    gateway.stop();
    if (host.demo) rmSync(dir, { recursive: true, force: true });
  };
}
