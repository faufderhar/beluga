import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRunInput } from '../../src/agent/types.js';
import { TALK_READ_ONLY_REASON } from '../../src/agent/dialogue-tools.js';
import type { Dialogue } from '../../src/core/dialogues/model.js';
import { Dialogues } from '../../src/core/dialogues/service.js';
import type { AgentRef } from '../../src/protocol.js';
import { type Crowd, LOSES_A_MESSAGE_ON_WINDOWS, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Node, node } from './helpers.js';

/**
 * Dialogues across owners (BLG-468): kay's Claude ↔ bob's Codex. The chair is kay's; each of bob's
 * turns is a gateway task to bob (his trust vets it), and both threads keep the same turns.
 */

const CLAUDE: AgentRef = { runtime: 'claude', label: 'Claude' };
const CODEX: AgentRef = { runtime: 'codex', label: 'Codex' };

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

interface Side {
  readonly n: Node;
  readonly d: Dialogues;
}

/** One person's Beluga with dialogues on: their own agent answers locally, a friend's goes through the gateway. */
function side(n: Node, friend: Node, agent: AgentRef): Side {
  const d = new Dialogues({
    store: n.store,
    selfId: () => n.id,
    selfName: () => n.name,
    myAgents: () => [agent],
    toast: () => undefined,
    runTurn: async (run) => ({ text: `${n.name}'s ${agent.label}: turn ${run.turn}`, tokens: 5 }),
    friendAgent: (person) => (person === friend.name ? { agent: CODEX, owner: friend.name, peer: friend.id } : 'nobody'),
    gateway: () => n.gw,
  });
  n.gw.useDialogues(d.gatewayPort());
  return { n, d };
}

async function pair(a: string, b: string): Promise<[Side, Side]> {
  const x = await node(net, a);
  const y = await node(net, b);
  await befriend(x.person, y.person);
  x.trust(y.id, 'trusted');
  // Bob's own Claude in the tests answers as "Codex" (his Mac's default agent).
  y.claude.answer = (input: AgentRunInput) => {
    const turn = [...input.prompt.matchAll(/turn (\d+)\)/g)].at(-1)?.[1] ?? '?';
    return `${b}'s Codex: turn ${turn}`;
  };
  return [side(x, y, CLAUDE), side(y, x, CODEX)];
}

const dialogueOf = (s: Side, id: string): Dialogue | undefined => s.n.store.getState().dialogues[id];
const texts = (d: Dialogue | undefined) => (d?.turns ?? []).filter((t) => t.by !== 'person').map((t) => t.text);

describe('a dialogue across owners', () => {
  it('completes with both threads in sync, each remote turn vetted on bob’s side, talk read-only there too', async () => {
    const [kay, bob] = await pair('dlgA1', 'dlgA2');
    bob.n.trust(kay.n.id, 'trusted');
    expect(kay.d.fromComposer('@my:claude @dlgA2:codex talk about retries, 4 turns', 'room')).toBe(true);
    const id = Object.keys(kay.n.store.getState().dialogues)[0]!;
    expect(dialogueOf(kay, id)?.participants[1]).toEqual({ agent: CODEX, owner: 'dlgA2', peer: bob.n.id });
    kay.d.confirm(id);
    await settle(() => dialogueOf(kay, id)?.status === 'paused');

    const chairSide = texts(dialogueOf(kay, id));
    expect(chairSide).toEqual(["dlgA1's Claude: turn 1", "dlgA2's Codex: turn 2", "dlgA1's Claude: turn 3", "dlgA2's Codex: turn 4"]);
    // Bob's thread: the same turns, in order, chaired by kay, with its header card.
    await settle(() => texts(dialogueOf(bob, id)).length === 4);
    expect(texts(dialogueOf(bob, id))).toEqual(chairSide);
    expect(dialogueOf(bob, id)).toMatchObject({ remoteChair: { peer: kay.n.id, name: 'dlgA1' }, topic: 'retries' });
    expect(bob.n.store.getState().log.some((l) => l.type === 'system' && l.dialogue?.id === id)).toBe(true);
    // Each of bob's turns was a task on his Mac, run as a friend's task (his limits), read-only for a talk.
    const runs = bob.n.claude.runs;
    expect(runs).toHaveLength(2);
    expect(runs[0]!.vetTool?.('Write', { file_path: '/tmp/x' })).toBe(TALK_READ_ONLY_REASON);
    expect(runs[0]!.prompt).toContain("dlgA1's Claude: turn 1");
    // Nothing resumed kay's conversation with bob's answers: the chair took them.
    expect(kay.n.resumes).toEqual([]);

    // Kay's Stop: over on both sides.
    kay.d.stop(id);
    await settle(() => dialogueOf(bob, id)?.status === 'stopped');
    expect(dialogueOf(bob, id)?.note).toBe('Stopped by dlgA1');
  }, 60_000);

  it('bob’s Stop (mid-turn) ends it on kay’s side too', async () => {
    const [kay, bob] = await pair('dlgB1', 'dlgB2');
    bob.n.trust(kay.n.id, 'trusted');
    bob.n.claude.hold();
    kay.d.fromComposer('@my:claude @dlgB2:codex talk about caching', 'room');
    const id = Object.keys(kay.n.store.getState().dialogues)[0]!;
    kay.d.confirm(id);
    await settle(() => dialogueOf(bob, id)?.status === 'running' && bob.n.claude.runs.length === 1);
    // Bob's frames reach kay in order but one read at a time, as they often do on Windows: the
    // halted turn's result must not end it on kay's side as a failure before the stop is read.
    const mesh = bob.n.person.mesh;
    const send = mesh.sendGateway.bind(mesh);
    let line = Promise.resolve();
    mesh.sendGateway = (peer, frame) => {
      line = line.then(() => new Promise((r) => setTimeout(() => (send(peer, frame), r()), 30)));
      return true;
    };
    bob.d.stop(id);
    await settle(() => dialogueOf(kay, id)?.status === 'stopped');
    expect(dialogueOf(kay, id)?.note).toBe('Stopped by dlgB2');
    expect(texts(dialogueOf(kay, id))).toEqual(["dlgB1's Claude: turn 1"]);
    bob.n.claude.open();
  }, 60_000);

  it('bob’s trust rules vet each turn: asked each time, and a no ends it with a clear note', async () => {
    const [kay, bob] = await pair('dlgC1', 'dlgC2');
    // Bob asks each time (no trust set): every turn is a request card on his Mac.
    kay.d.fromComposer('@my:claude @dlgC2:codex talk about naming, 4 turns', 'room');
    const id = Object.keys(kay.n.store.getState().dialogues)[0]!;
    kay.d.confirm(id);
    await settle(() => bob.n.approvals.filter((p) => p.kind === 'request').length === 1);
    bob.n.approvals[0]!.answer('yes');
    await settle(() => bob.n.approvals.filter((p) => p.kind === 'request').length === 2);
    bob.n.approvals.filter((p) => p.kind === 'request')[1]!.answer('no');
    await settle(() => dialogueOf(kay, id)?.status === 'failed');
    expect(dialogueOf(kay, id)?.note).toMatch(/Turn 4 couldn't run: dlgC2's Mac declined it/);
    expect(texts(dialogueOf(kay, id))).toHaveLength(3);
  }, 60_000);

  it.skipIf(LOSES_A_MESSAGE_ON_WINDOWS)('blocked means the dialogue ends with a clear note', async () => {
    const [kay, bob] = await pair('dlgD1', 'dlgD2');
    bob.n.trust(kay.n.id, 'blocked');
    kay.d.fromComposer('@my:claude @dlgD2:codex talk about anything', 'room');
    const id = Object.keys(kay.n.store.getState().dialogues)[0]!;
    kay.d.confirm(id);
    await settle(() => dialogueOf(kay, id)?.status === 'failed');
    expect(dialogueOf(kay, id)?.note).toMatch(/Turn 2 couldn't run: dlgD2's Mac declined it: dlgD2 doesn't take requests from you/);
    expect(kay.n.store.getState().log.at(-1)).toMatchObject({ type: 'system', text: expect.stringContaining('Dialogue failed after 1 turn') });
  }, 60_000);
});

describe('the friend-task anti-loop limits', () => {
  it('a declared dialogue within its caps is not killed at the third ask; an undeclared ask loop still is', async () => {
    const [kay, bob] = await pair('dlgE1', 'dlgE2');
    bob.n.trust(kay.n.id, 'trusted');
    kay.d.fromComposer('@my:claude @dlgE2:codex talk about limits, 10 turns', 'ws:abc');
    const id = Object.keys(kay.n.store.getState().dialogues)[0]!;
    kay.d.confirm(id);
    await settle(() => dialogueOf(kay, id)?.status === 'paused');
    // Five of bob's turns from one conversation in a minute: more than the 3 an undeclared loop gets.
    expect(texts(dialogueOf(kay, id))).toHaveLength(10);
    expect(kay.n.gw.book.all().filter((t) => t.direction === 'sent' && t.dialogue?.id === id)).toHaveLength(5);

    // The same conversation's Claude asking bob on its own: its own 3, then stopped (dialogue asks don't count, nor excuse it).
    for (let i = 0; i < 3; i++) kay.n.gw.ask({ person: bob.n.id, ask: `again ${i}`, by: 'agent', conversation: 'ws:abc' });
    expect(() => kay.n.gw.ask({ person: bob.n.id, ask: 'again 3', by: 'agent', conversation: 'ws:abc' })).toThrow(/You already sent dlgE2 3 requests from this conversation/);
  }, 60_000);

  it('a dialogue is no way around them: its own cap holds at the gateway', async () => {
    const [kay, bob] = await pair('dlgF1', 'dlgF2');
    bob.n.trust(kay.n.id, 'trusted');
    const envelope = { id: 'dlg_capcheck01', turn: 1, cap: 2, chair: 'dlgF1', topic: 't', mode: 'talk' as const, participants: [{ agent: CLAUDE }, { agent: CODEX, owner: 'dlgF2' }], said: [] };
    kay.n.gw.ask({ person: bob.n.id, ask: 'one', by: 'agent', conversation: 'room', dialogue: envelope });
    kay.n.gw.ask({ person: bob.n.id, ask: 'two', by: 'agent', conversation: 'room', dialogue: { ...envelope, turn: 2 } });
    expect(() => kay.n.gw.ask({ person: bob.n.id, ask: 'three', by: 'agent', conversation: 'room', dialogue: { ...envelope, turn: 3 } })).toThrow(/already had its 2 turns/);
    expect(() => kay.n.gw.ask({ person: bob.n.id, ask: 'past it', by: 'agent', conversation: 'room', dialogue: { ...envelope, id: 'dlg_capcheck02', turn: 3 } })).toThrow(/already had its 2 turns/);
  }, 60_000);

  it('a turn sent again (the chair resumed after a restart) stops the first copy and counts once', async () => {
    const [kay, bob] = await pair('dlgG1', 'dlgG2');
    bob.n.trust(kay.n.id, 'trusted');
    const envelope = { id: 'dlg_resend0001', turn: 1, cap: 2, chair: 'dlgG1', topic: 't', mode: 'talk' as const, participants: [{ agent: CLAUDE }, { agent: CODEX, owner: 'dlgG2' }], said: [] };
    kay.n.gw.ask({ person: bob.n.id, ask: 'one', by: 'agent', conversation: 'room', dialogue: envelope });
    const first = kay.n.gw.ask({ person: bob.n.id, ask: 'two', by: 'agent', conversation: 'room', dialogue: { ...envelope, turn: 2 } });
    const again = kay.n.gw.ask({ person: bob.n.id, ask: 'two again', by: 'agent', conversation: 'room', dialogue: { ...envelope, turn: 2 } });
    expect(again.id).not.toBe(first.id);
    expect(kay.n.gw.get(first.id)?.state).toBe('cancelled');
  }, 60_000);
});
