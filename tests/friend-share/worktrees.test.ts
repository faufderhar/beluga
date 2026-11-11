import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { remoteScratch } from '../../src/core/friend-share/scratch.js';
import { chatReactions } from '../../src/core/chat-reactions.js';
import { conversations, convView, workView } from '../../src/companion/views.js';
import { peopleHere, waitingNote } from '../../src/core/friend-share-people.js';
import { createDemoWorkspaces } from '../../src/demo.js';
import { type Crowd, SLOW, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Mac, mac } from './helpers.js';

/**
 * BLG-206: a worktree shared over the network is live for everyone in it. Everyone talks to its
 * Claude, everyone sees every message and turn, and what's said while the owner is offline waits.
 */

let net: Crowd | undefined;
const macs: Mac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

const agentDone = (m: Mac, channel: string, text: string) => m.store.getState().log.find((l) => l.type === 'agent' && l.channel === channel && l.status === 'done' && l.text.includes(text));
const chatSeen = (m: Mac, channel: string, text: string) => m.store.getState().log.some((l) => l.type === 'chat' && l.channel === channel && l.text === text);
const ctx = { refs: { output: () => undefined }, mac: { name: 'Mac', version: '1' } };

async function sharedWorktree(): Promise<{ ata: Mac; kay: Mac; mia: Mac; channel: string; wsId: string }> {
  net = await crowd();
  const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
  const kay = await mac(net, 'kay');
  const mia = await mac(net, 'mia');
  macs.push(ata, kay, mia);
  // Kay and mia are each ata's friend, not each other's.
  await befriend(ata.person, kay.person);
  await befriend(ata.person, mia.person);
  const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
  const ws = project.workspaces.find((w) => !w.archived && !w.external && w.kind === 'worktree')!;
  ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'contribute' });
  ata.session.sharing.shareWithFriend({ peerId: mia.id, projectId: project.id, role: 'contribute' });
  await settle(() => kay.store.getState().shared.some((w) => w.id === ws.id) && mia.store.getState().shared.some((w) => w.id === ws.id));
  await settle(() => (kay.store.getState().roster[ws.id] ?? []).length === 2);
  return { ata, kay, mia, channel: `ws:${ws.id}`, wsId: ws.id };
}

describe('a worktree shared over the network', () => {
  it('everyone in it sees every message and every turn of its Claude', async () => {
    const { ata, kay, mia, channel } = await sharedWorktree();
    expect(kay.session.submit('please look at the tests', { channel })).toBe(true);
    await settle(() => agentDone(kay, channel, 'please look at the tests'));
    expect(ata.runs.length).toBe(1);
    expect(chatSeen(ata, channel, 'please look at the tests')).toBe(true);
    // Mia isn't kay's friend: ata's Mac passes kay's message on, and its Claude's answer reaches her too.
    await settle(() => chatSeen(mia, channel, 'please look at the tests') && agentDone(mia, channel, 'please look at the tests'));
    const relayed = mia.store.getState().log.find((l) => l.type === 'chat' && l.channel === channel && l.text === 'please look at the tests');
    expect(relayed?.type === 'chat' && relayed.from).toBe(kay.id);

    ata.session.sendChat('on it with you', false, channel);
    await settle(() => chatSeen(kay, channel, 'on it with you') && chatSeen(mia, channel, 'on it with you'));

    // The header's people: ata (its owner) first, then mia (not kay's friend: how she is isn't known here).
    const here = peopleHere(kay.store.getState(), channel.slice(3));
    expect(here.map((p) => [p.name, p.owner, p.state])).toEqual([
      ['ata', true, 'online'],
      ['mia', false, 'unknown'],
    ]);
    // On ata's side: the friends she shared it with.
    expect(peopleHere(ata.store.getState(), channel.slice(3)).map((p) => p.name).sort()).toEqual(['kay', 'mia']);

    // The phone: the shared worktree is in its work view like your own, with the owner's name.
    const conv = conversations(kay.store.getState()).find((c) => c.channel === channel);
    expect(conv).toMatchObject({ project: 'ata · bob-api', mine: true });
    expect(workView(kay.store.getState(), ctx).projects.some((p) => p.name === 'ata · bob-api')).toBe(true);
  }, 60_000 * SLOW);

  it("a guest's @claude is their own agent: it reads the worktree over the link and everyone sees its answer", async () => {
    const { ata, kay, mia, channel } = await sharedWorktree();
    expect(kay.session.submit('@claude what changed here?', { channel })).toBe(true);
    // Kay's own agent answers, on kay's Mac; ata's stays out of it.
    await settle(() => agentDone(kay, channel, 'what changed here?'));
    expect(kay.runs.map((r) => r.prompt)).toEqual(['what changed here?']);
    expect(ata.runs).toHaveLength(0);
    // Ata sees it in her worktree, and passes it on to mia (not kay's friend), as kay's agent's.
    await settle(() => agentDone(ata, channel, 'what changed here?') && agentDone(mia, channel, 'what changed here?'));
    expect(agentDone(mia, channel, 'what changed here?')).toMatchObject({ owner: kay.id });
    // Kay's agent reads the worktree over the link, ata named as in the conversation.
    const share = kay.store.getState().shared.find((w) => `ws:${w.id}` === channel)!.share;
    const files = await kay.session.bridge.listPeerFiles('ata', share, '');
    expect(files.length).toBeGreaterThan(0);
    // "@claude:ata" is still hers.
    kay.session.submit('@claude:ata add a test', { channel });
    await settle(() => ata.runs.some((r) => r.prompt === 'add a test'));
  }, 60_000 * SLOW);

  it('reactions reach everyone in it, through its owner’s Mac for people who aren’t friends (BLG-702)', async () => {
    const { ata, kay, mia, channel } = await sharedWorktree();
    ata.session.sendChat('pushed the fix', false, channel);
    await settle(() => chatSeen(kay, channel, 'pushed the fix') && chatSeen(mia, channel, 'pushed the fix'));
    const item = (m: Mac) => m.store.getState().log.find((l) => l.type === 'chat' && l.channel === channel && l.text === 'pushed the fix');
    // One id in every copy.
    expect(new Set([ata, kay, mia].map((m) => item(m)?.id)).size).toBe(1);
    const chips = (m: Mac) => {
      const it = item(m);
      return it?.type === 'chat' ? chatReactions(it) : [];
    };
    kay.session.reactChat(channel, item(kay)!.id, '🎉');
    await settle(() => chips(ata).length === 1 && chips(mia).length === 1);
    expect(chips(mia)).toEqual([{ emoji: '🎉', by: [kay.id] }]);
    mia.session.reactChat(channel, item(mia)!.id, '🎉');
    await settle(() => chips(kay)[0]?.by.length === 2);
    expect(chips(kay)).toEqual([{ emoji: '🎉', by: [kay.id, mia.id] }]);
  }, 60_000 * SLOW);

  it("waits while the owner's Mac is offline, says so, and goes when it's back", async () => {
    const { ata, kay, channel, wsId } = await sharedWorktree();
    await ata.stop();
    await settle(() => kay.store.getState().network.friends.find((f) => f.peerId === ata.id)?.online === false);
    expect(waitingNote(kay.store.getState(), wsId)).toBe("You can't chat with this while ata's Mac is offline");
    expect(convView(kay.store.getState(), ctx, `conv:${channel}`).waiting).toBe("You can't chat with this while ata's Mac is offline");

    expect(kay.session.submit('while you were away', { channel })).toBe(true);
    const waiting = await settle(() => Object.entries(kay.store.getState().delivery).find(([, s]) => s === 'waiting'));
    // Kay's own message shows at once, marked as waiting (the request it carries).
    expect(kay.store.getState().log.some((l) => l.type === 'chat' && l.channel === channel && l.request === waiting[0])).toBe(true);

    // Back: delivered, ata's Claude answers, kay sees it; nothing ran twice.
    await ata.start();
    await settle(() => kay.store.getState().delivery[waiting[0]] === 'delivered');
    await settle(() => agentDone(kay, channel, 'while you were away'));
    expect(chatSeen(ata, channel, 'while you were away')).toBe(true);
    expect(waitingNote(kay.store.getState(), wsId)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 500));
    expect(ata.runs.filter((r) => r.prompt.includes('while you were away'))).toHaveLength(1);
  }, 60_000 * SLOW);

  it('someone not in the worktree, or only following it, never reaches its Claude', async () => {
    const { ata, kay, channel, wsId } = await sharedWorktree();
    // Ata takes kay's role down to following: her Mac refuses, and ata's would too.
    const project = ata.store.getState().projects.find((p) => p.workspaces.some((w) => w.id === wsId))!;
    ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'view' });
    await settle(() => kay.store.getState().shared.find((w) => w.id === wsId)?.role === 'view');
    expect(kay.session.submit('sneak a request in', { channel })).toBe(false);
    // Even sent by hand, ata's Mac declines it.
    kay.session.send({ kind: 'agent_request', requestId: 'r-by-hand-1', prompt: 'by hand', viaAgent: false, channel, urgent: false, plan: false }, { to: ata.id });
    await settle(() => kay.store.getState().log.find((l) => l.type === 'agent' && l.requestId === 'r-by-hand-1' && l.status === 'denied'));
    expect(ata.runs).toHaveLength(0);
  }, 60_000 * SLOW);

  it('its scratch folder shows on the friend’s Mac too, newest first, read over the link (BLG-259)', async () => {
    const { ata, kay, wsId } = await sharedWorktree();
    const ws = ata.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId)!;
    const dir = path.join(ws.path, '.beluga', 'scratch', 'shots');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'old.txt'), 'old');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(path.join(ws.path, '.beluga', 'scratch', 'notes.md'), '# notes');
    const list = await remoteScratch(ata.id, wsId, (at, o) => kay.session.listFiles(at, o));
    expect(list.files.map((f) => f.path)).toEqual(['.beluga/scratch/notes.md', '.beluga/scratch/shots/old.txt']);
    expect(list.files.every((f) => f.mtime > 0)).toBe(true);
    expect(await kay.session.readFile({ owner: ata.id, share: `ws-${wsId}`, path: '.beluga/scratch/notes.md' })).toMatchObject({ content: '# notes' });
  }, 60_000 * SLOW);

  it('its whole conversation reaches the friend a page at a time as they scroll back, oldest on top (BLG-259)', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay');
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const ws = project.workspaces.find((w) => !w.archived && !w.external && w.kind === 'worktree')!;
    const channel = `ws:${ws.id}`;
    const t0 = Date.now() - 1_000_000;
    ata.session.workspaces!.manager.saveHistory(
      ws.id,
      Array.from({ length: 150 }, (_, i) => ({ id: `old-${i}`, type: 'chat', channel, from: ata.id, text: `line ${i}`, ts: t0 + i * 1000, byAgent: false })),
    );
    ata.session.sharing.shareWithFriend({ peerId: kay.id, workspaceId: ws.id, role: 'view' });
    // Each line reads "<who>: <text>"; what was said is what's checked.
    const lines = (): string[] => kay.store.getState().log.filter((l) => l.channel === channel && l.type === 'system').map((l) => (l as { text: string }).text.replace(/^[^:]*: /, ''));
    await settle(() => lines().length === 60);
    expect(lines()[0]).toBe('line 90');
    expect(kay.store.getState().shared.find((w) => w.id === ws.id)?.earlier).toBe(true);

    expect(kay.shares.earlier(ata.id, ws.id)).toBe(true);
    await settle(() => lines().length === 120);
    expect(lines()[0]).toBe('line 30');
    expect(lines()[119]).toBe('line 149');
    kay.shares.earlier(ata.id, ws.id);
    await settle(() => lines().length === 150);
    expect(lines()[0]).toBe('line 0');
    await settle(() => !kay.store.getState().shared.find((w) => w.id === ws.id)?.earlier);
    expect(kay.shares.earlier(ata.id, ws.id)).toBe(false);
  }, 60_000 * SLOW);

  it('a long answer in its conversation (a graph) reaches the friend whole, not cut at 4,000 characters (BLG-622)', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay');
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    await settle(() => ata.person.mesh.belugaOf(kay.id)?.can.includes('share.history.long'));
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const ws = project.workspaces.find((w) => !w.archived && !w.external && w.kind === 'worktree')!;
    const channel = `ws:${ws.id}`;
    const nodes = Array.from({ length: 120 }, (_, i) => ({ id: `n${i}`, type: 'function', label: `Step ${i}`, sublabel: 'one stage of the pipeline, with a longer note' }));
    const answer = `Here it is:\n\`\`\`beluga-graph\n${JSON.stringify({ title: 'How it runs', nodes })}\n\`\`\``;
    expect(answer.length).toBeGreaterThan(10_000);
    ata.session.workspaces!.manager.saveHistory(ws.id, [{ id: 'g-1', type: 'chat', channel, from: ata.id, text: answer, ts: Date.now() - 1000, byAgent: false }]);
    ata.session.sharing.shareWithFriend({ peerId: kay.id, workspaceId: ws.id, role: 'view' });
    // The line reads "<who>: <text>"; what was said is what's checked.
    const seen = (): string | undefined => kay.store.getState().log.flatMap((l) => (l.channel === channel && l.type === 'system' ? [l.text.replace(/^[^:]*: /, '')] : []))[0];
    await settle(() => seen());
    expect(seen()?.length).toBe(answer.length);
    expect(seen()).toBe(answer);
  }, 60_000 * SLOW);
});
