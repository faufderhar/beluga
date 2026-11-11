import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaHome } from '../home.js';
import { type AgentRef, defaultAgentOf } from '../../protocol.js';
import { gatewayOf } from '../gateway/registry.js';
import type { FriendAgent } from './start.js';
import { runtimeFor } from '../../agent/runtime/registry.js';
import type { AgentBackend, AgentPlace, AgentRunInput } from '../../agent/types.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { attachDialogues, detachDialogues } from './registry.js';
import { Dialogues } from './service.js';

export interface DialoguesHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

/** Runtimes a dialogue can name besides your default agent (when this Beluga has them). */
const KNOWN_RUNTIMES = ['claude', 'codex', 'opencode', 'copilot', 'grok', 'local'];

/** Your agents: the default one, then every other runtime this Beluga can run. */
export function myAgents(own: AgentRef): AgentRef[] {
  const others = KNOWN_RUNTIMES.filter((id) => id !== own.runtime).flatMap((id) => {
    const rt = runtimeFor(id);
    return rt ? [{ runtime: rt.id, label: rt.label }] : [];
  });
  return [own, ...others];
}

/**
 * A dialogue turn's place: the conversation's folder (a worktree's code to read, or to work in),
 * never its own conversation (a dialogue's turns carry their own transcript, not the chat's session).
 * The turn runs on its speaker's agent, not the worktree's (with the worktree's model only when it's
 * the same runtime), and a talk changes nothing: no edits, whatever the worktree allows.
 */
function turnPlace(place: AgentPlace | undefined, agent: AgentRef, talk: boolean): AgentPlace | undefined {
  if (!place) return undefined;
  const { resume: _r, forkSession: _f, agent: worktreeAgent, model, ...rest } = place;
  const sameRuntime = (worktreeAgent?.runtime ?? agent.runtime) === agent.runtime;
  return { ...rest, agent, ...(sameRuntime && model ? { model } : {}), ...(talk ? { autoEdit: false } : {}), onSession: () => undefined };
}

/**
 * A friend's agent by name, from the room and your friends: `@bob:codex` (or the older order,
 * `@claude:bob`). Their Mac runs a friend's task on its own default agent.
 */
function friendAgentIn(store: Store, selfId: () => string): FriendAgent {
  return (person, agentName) => {
    const st = store.getState();
    const all = [...st.peers.filter((p) => p.peerId !== selfId()), ...st.network.friends];
    const look = (who: string) => all.find((x) => x.name.toLowerCase() === who.toLowerCase());
    let friend = look(person);
    let named = agentName;
    if (!friend) {
      friend = look(agentName);
      named = person;
    }
    if (!friend) return `Nobody named “${person}” is your friend or in the room`;
    const listed = (friend as { agents?: readonly AgentRef[] }).agents;
    const agents = listed?.length ? listed : [defaultAgentOf(friend as { agents?: readonly AgentRef[]; defaultAgent?: AgentRef })];
    const n = named.toLowerCase();
    const agent = agents.find((a) => a.label.toLowerCase() === n || a.runtime.toLowerCase() === n);
    if (!agent) return `${friend.name} has no agent named “${named}”`;
    return { agent, owner: friend.name, peer: friend.peerId };
  };
}

/** Dialogues between your agents (core/dialogues): the chair, saved beside plans, and its room thread. */
export function launchDialogues(host: DialoguesHost): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-dialogues-')) : belugaHome();
  const own = (): AgentRef => session.agentRef;
  const dialogues = new Dialogues({
    store,
    dir,
    selfId: () => session.selfId,
    selfName: () => store.getState().self?.name ?? store.getState().network.self?.name ?? 'You',
    myAgents: () => (host.demo ? [own(), { runtime: 'codex', label: 'Codex' }] : myAgents(own())),
    toast: (text, level) => session.toast(text, level ?? 'info'),
    friendAgent: friendAgentIn(store, () => session.selfId),
    gateway: () => gatewayOf(session),
    worktreeOf: (channel) => {
      const ws = session.workspaces?.inChannel(channel);
      return ws && ws.kind === 'worktree' && !ws.archived ? session.workspaces?.place(channel)?.cwd : undefined;
    },
    runTurn: async (run) => {
      const runtime = run.participant.agent.runtime;
      const backend = session.backendFor(runtime);
      if (!backend) throw new Error(`${run.participant.agent.label} can't run on this Mac`);
      const channel = run.dialogue.channel ?? 'room';
      const place = channel === 'room' ? undefined : turnPlace(session.workspaces?.place(channel), run.participant.agent, run.dialogue.mode !== 'work');
      // No place (the room): the speaker's own model rides the run, or a local model wouldn't know its endpoint (BLG-503).
      const model = run.participant.agent.model;
      const on = !place && model ? (Object.assign(Object.create(backend) as AgentBackend, { run: (input: AgentRunInput) => backend.run({ ...input, model }) })) : backend;
      return session.host.runDialogueTurn(channel, on, run.input, { ...(place ? { place } : {}), defaultModel: runtime === own().runtime });
    },
  });
  attachDialogues(session, dialogues);
  // Friends' dialogue turns and stops come in through the gateway (launched before this).
  gatewayOf(session)?.useDialogues(dialogues.gatewayPort());
  return () => {
    gatewayOf(session)?.useDialogues(undefined);
    dialogues.chair.close();
    detachDialogues(session);
  };
}
