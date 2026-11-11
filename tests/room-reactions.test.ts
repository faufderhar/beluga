import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBackend } from '../src/agent/types.js';
import { chatReactions, reactOnLog } from '../src/core/chat-reactions.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { type DomainState, type LogItem, Store, initialState } from '../src/core/store.js';
import { createDemoWorkspaces } from '../src/demo.js';
import { Body } from '../src/protocol.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { type Hub, startHub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import type { WorkspaceManager } from '../src/workspaces/manager.js';
import { waitFor } from './helpers.js';

// Emoji reactions in the room's group chat and in workspace chats (BLG-702): the `chat_react` body.

const keys = deriveKeys(generateSecret());
let hub: Hub;
const sessions: Session[] = [];
let demo: WorkspaceManager;
// Two real repos with history and worktrees: well past 30 s on a busy Windows runner.
beforeAll(async () => {
  demo = await createDemoWorkspaces();
}, 120_000);
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  await hub?.close();
});

function peer(name: string, opts: { workspaces?: WorkspaceManager } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `klaud-react-${name}-`)));
  const shares = new ShareService([]);
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name, shares: shares.infos, agent: true }, reconnect: false });
  const session = new Session({
    client,
    store,
    shares,
    agentCwd: root,
    requestTimeoutMs: 2000,
    agentTimeoutMs: 4000,
    zoom: async () => ({ ok: true, message: '' }),
    copy: async () => undefined,
    ...(opts.workspaces ? { workspaces: opts.workspaces } : {}),
    createAgent: (): AgentBackend => ({ run: async (input) => `echo: ${input.prompt}` }),
  });
  session.start();
  sessions.push(session);
  return { session, state: store.getState, id: () => session.selfId };
}
type P = ReturnType<typeof peer>;
const room = (...peers: P[]): Promise<unknown> => waitFor(() => peers.every((p) => p.state().peers.length === peers.length && p.state().self));
const chatOf = (s: DomainState, channel: string, text: string) => s.log.find((l): l is Extract<LogItem, { type: 'chat' }> => l.type === 'chat' && l.channel === channel && l.text === text);
const chips = (p: P, channel: string, text: string) => {
  const item = chatOf(p.state(), channel, text);
  return item ? chatReactions(item) : undefined;
};

describe('reactions in the group chat', () => {
  it('two people react live, toggle, and someone who comes later sees them from the room’s history', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    kay.session.sendChat('ship it on friday?', false);
    const atBob = await waitFor(() => chatOf(bob.state(), 'room', 'ship it on friday?'));
    // The same id in both copies: a reaction can name it.
    expect(chatOf(kay.state(), 'room', 'ship it on friday?')?.id).toBe(atBob.id);
    expect(atBob.id.startsWith(`${kay.id()}:`)).toBe(true);

    expect(bob.session.reactChat('room', atBob.id, '👍')).toEqual([{ emoji: '👍', by: [bob.id()] }]);
    await waitFor(() => chips(kay, 'room', 'ship it on friday?')?.length === 1);
    kay.session.reactChat('room', atBob.id, '👍');
    kay.session.reactChat('room', atBob.id, '🎉');
    await waitFor(() => chips(bob, 'room', 'ship it on friday?')?.[0]?.by.length === 2 && chips(bob, 'room', 'ship it on friday?')?.length === 2);
    // Clicking yours again takes it back.
    bob.session.reactChat('room', atBob.id, '👍');
    await waitFor(() => chips(kay, 'room', 'ship it on friday?')?.[0]?.by.length === 1);
    expect(chips(kay, 'room', 'ship it on friday?')).toEqual([
      { emoji: '👍', by: [kay.id()] },
      { emoji: '🎉', by: [kay.id()] },
    ]);
    expect(chips(bob, 'room', 'ship it on friday?')).toEqual(chips(kay, 'room', 'ship it on friday?'));

    const cat = peer('cat');
    await room(kay, bob, cat);
    await waitFor(() => chips(cat, 'room', 'ship it on friday?')?.length === 2);
    expect(chips(cat, 'room', 'ship it on friday?')).toEqual(chips(kay, 'room', 'ship it on friday?'));

    expect(() => kay.session.reactChat('room', 'nope:nope', '👍')).toThrow(/No such message/);
    expect(() => kay.session.reactChat('room', atBob.id, 'lol')).toThrow(/emoji/);
    expect(() => kay.session.reactChat('mac:assistant', atBob.id, '👍')).toThrow(/group chat/);
  });
});

describe('reactions in a workspace chat', () => {
  it('everyone in it sees them, a viewer may react, someone outside can’t, and they’re saved with its history', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', { workspaces: demo });
    const bob = peer('bob');
    const eve = peer('eve');
    await room(kay, bob, eve);
    await kay.session.workspaces!.refresh();
    const ws = demo.list.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth')!;
    const channel = `ws:${ws.id}`;
    kay.session.sharing.invite(ws.id, bob.session.selfId, 'view');
    await waitFor(() => bob.state().shared[0]);
    kay.session.sendChat('the auth branch is ready for a look', false, channel);
    const atBob = await waitFor(() => chatOf(bob.state(), channel, 'the auth branch is ready for a look'));
    expect(chatOf(kay.state(), channel, 'the auth branch is ready for a look')?.id).toBe(atBob.id);

    bob.session.reactChat(channel, atBob.id, '👀');
    await waitFor(() => chips(kay, channel, 'the auth branch is ready for a look')?.length === 1);
    kay.session.reactChat(channel, atBob.id, '✅');
    await waitFor(() => chips(bob, channel, 'the auth branch is ready for a look')?.length === 2);

    // eve isn't in it: her reaction (a forged body straight to kay) changes nothing.
    eve.session.send({ kind: 'chat_react', channel, to: atBob.id, e: '💩', on: true, at: Date.now() }, { to: kay.session.selfId });
    await new Promise((r) => setTimeout(r, 200));
    expect(chips(kay, channel, 'the auth branch is ready for a look')?.map((r) => r.emoji)).toEqual(['👀', '✅']);

    // Saved with the conversation (~/.beluga/history/<id>.json).
    await waitFor(() => demo.loadHistory<LogItem>(ws.id).some((l) => l.type === 'chat' && (l.reacts?.length ?? 0) === 2), 5000);
  });
});

describe('the chat_react body and the log', () => {
  const item = (id: string): LogItem => ({ id, type: 'chat', channel: 'room', from: 'kay', name: 'kay', text: 'hi', ts: 1, byAgent: false });
  it('is checked at the boundary', () => {
    const ok = { kind: 'chat_react', channel: 'room', to: 'kay:abc-123-def', e: '👍', on: true, at: 5 };
    expect(Body.safeParse(ok).success).toBe(true);
    expect(Body.safeParse({ ...ok, e: 'thumbs' }).success).toBe(false);
    expect(Body.safeParse({ ...ok, e: '👍'.repeat(20) }).success).toBe(false);
    expect(Body.safeParse({ ...ok, to: 'has spaces' }).success).toBe(false);
    expect(Body.safeParse({ ...ok, channel: 'nowhere' }).success).toBe(false);
    // A chat with its own id; an older Mac's has none and still parses.
    expect(Body.safeParse({ kind: 'chat', text: 'hi', mid: 'abc-123-def' }).success).toBe(true);
    expect(Body.safeParse({ kind: 'chat', text: 'hi' }).success).toBe(true);
    expect(Body.safeParse({ kind: 'chat', text: 'hi', mid: 'bad id!' }).success).toBe(false);
  });

  it('applies only to a chat message that is there, newest change wins', () => {
    const log = [item('a'), item('b')];
    const r = (id: string, on: boolean, at: number) => ({ type: 'chat_react' as const, channel: 'room', id, emoji: '👍', by: 'bob', on, at });
    expect(reactOnLog(log, r('missing', true, 1))).toBe(log);
    const once = reactOnLog(log, r('b', true, 2));
    expect(once[1]).toMatchObject({ reacts: [{ emoji: '👍', by: 'bob', on: true, at: 2 }] });
    expect(once[0]).toBe(log[0]);
    expect(reactOnLog(once, r('b', false, 1))).toBe(once);
    expect(chatReactions(reactOnLog(once, r('b', false, 3))[1] as { reacts?: never })).toEqual([]);
    expect(log[1]).not.toHaveProperty('reacts');
  });
});
