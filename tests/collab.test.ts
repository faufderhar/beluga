import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { Session, type RoomControl, type SessionOptions as SessionOpts } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState, type DomainState } from '../src/core/store.js';
import { createDemoWorkspaces } from '../src/demo.js';
import { deriveKeys, generateIdentity, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import type { WorkspaceManager } from '../src/workspaces/manager.js';
import { waitFor } from './helpers.js';

const secret = generateSecret();
const keys = deriveKeys(secret);
const HOST = generateIdentity();
let hub: Hub;
const sessions: Session[] = [];
/**
 * The demo projects take ~100 git commands to build (about a second alone, several under a busy
 * parallel run), so the tests share one set, built once. Each test has its own fresh room and
 * peers, and the workspaces it talks in don't depend on what another test said there.
 */
let demo: WorkspaceManager;
// Two real repos with history and worktrees: well past 30 s on a busy Windows runner.
beforeAll(async () => {
  demo = await createDemoWorkspaces();
}, 120_000);

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  await hub?.close();
});

type Script = (input: AgentRunInput) => Promise<string>;

function peer(name: string, opts: { script?: Script; workspaces?: WorkspaceManager; host?: boolean; approvalTimeoutMs?: number; findConversation?: SessionOpts['findConversation'] } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `klaud-${name}-`)));
  const shares = new ShareService([{ name: 'proj', root, writable: false }]);
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name, shares: shares.infos, agent: true }, reconnect: false, ...(opts.host ? { identity: HOST } : {}) });
  const runs: AgentRunInput[] = [];
  const room: RoomControl | undefined = opts.host
    ? {
        removePerson: (id) => {
          hub.kick(id);
          const fresh = generateSecret();
          hub.replaceInvite(fresh, deriveKeys(fresh));
        },
        newInvite: () => undefined,
        setOpen: (open) => hub.setOpen(open),
        clearHistory: () => hub.clearHistory(),
      }
    : undefined;
  const session = new Session({
    client,
    store,
    shares,
    agentCwd: root,
    requestTimeoutMs: 2000,
    agentTimeoutMs: 4000,
    approvalTimeoutMs: opts.approvalTimeoutMs,
    zoom: async () => ({ ok: true, message: '' }),
    copy: async () => undefined,
    ...(opts.workspaces ? { workspaces: opts.workspaces } : {}),
    ...(opts.findConversation ? { findConversation: opts.findConversation } : {}),
    ...(room ? { room } : {}),
    createAgent: (): AgentBackend => ({
      run: async (input) => {
        runs.push(input);
        return opts.script ? opts.script(input) : `echo: ${input.prompt}`;
      },
    }),
  });
  session.start();
  sessions.push(session);
  return { session, state: store.getState, runs };
}

type P = ReturnType<typeof peer>;
const agentDone = (s: DomainState, text?: string) => s.log.some((l) => l.type === 'agent' && l.status === 'done' && (!text || l.text.includes(text)));
async function room(...peers: P[]): Promise<void> {
  await waitFor(() => peers.every((p) => p.state().peers.length === peers.length && p.state().self));
}

describe("Claude's questions and plans", () => {
  it('asks you (on your screen) and continues with your answer', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: async (input) => {
        const a = await input.askUser!({ kind: 'question', questions: [{ question: 'Which db?', header: 'DB', multiSelect: false, options: [{ label: 'Redis', description: '' }, { label: 'Postgres', description: '' }] }] });
        return a.kind === 'answers' ? `using ${a.answers['Which db?']}` : 'skipped';
      },
    });
    await room(kay);
    kay.session.submit('@claude set up sessions');
    const q = await waitFor(() => kay.state().questions[0]);
    expect(q.owner).toBe(kay.session.selfId);
    kay.session.questions.answer(q.qid, { kind: 'answers', answers: { 'Which db?': 'Postgres' } });
    await waitFor(() => agentDone(kay.state(), 'using Postgres'));
    expect(kay.state().questions).toHaveLength(0);
  });

  it("routes a friend's Claude's question to you, the one who asked, and only accepts your answer", async () => {
    hub = await startHub({ keys });
    const bob = peer('bob', {
      script: async (input) => {
        const a = await input.askUser!({ kind: 'plan', plan: '1. do it' });
        return a.kind === 'plan' && a.approve ? 'approved and done' : `not approved: ${a.kind === 'plan' ? a.feedback : a.kind}`;
      },
    });
    const kay = peer('kay');
    await room(bob, kay);
    bob.session.store.dispatch({ type: 'trust', peerId: kay.session.selfId, trusted: true });
    kay.session.submit('@claude:bob plan the auth work');
    const q = await waitFor(() => kay.state().questions[0]);
    expect(q.question.kind).toBe('plan');
    expect(bob.state().questions).toHaveLength(0); // it's kay's to answer, not bob's
    kay.session.questions.answer(q.qid, { kind: 'plan', approve: true, feedback: '' });
    await waitFor(() => agentDone(kay.state(), 'approved and done'));
  });

  it('carries on without an answer after the timeout, so nobody is stuck', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', { approvalTimeoutMs: 80, script: async (input) => ((await input.askUser!({ kind: 'plan', plan: 'x' })).kind) });
    await room(kay);
    kay.session.submit('@claude go');
    await waitFor(() => agentDone(kay.state(), 'skip'));
  });

  it('sends plan mode with the request when it is on for that conversation', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    await room(kay);
    kay.session.setPlanMode('room', true);
    kay.session.submit('@claude add auth');
    await waitFor(() => kay.runs.length);
    expect(kay.runs[0]?.plan).toBe(true);
  });
});

describe('sharing a workspace', () => {
  it('invites a friend to contribute: they see the chat, can ask your Claude there, and can be removed', async () => {
    hub = await startHub({ keys });
    const mgr = demo;
    const kay = peer('kay', { workspaces: mgr });
    const bob = peer('bob');
    await room(kay, bob);
    await kay.session.workspaces!.refresh();
    const ws = mgr.list.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth')!;
    const channel = `ws:${ws.id}`;
    kay.session.askOwnClaude('first thing', channel);
    await waitFor(() => agentDone(kay.state()));

    expect(kay.session.sharing.invite(ws.id, bob.session.selfId, 'contribute')).toBe(true);
    const shared = await waitFor(() => bob.state().shared[0]);
    expect(shared).toMatchObject({ name: 'add-auth', role: 'contribute', owner: kay.session.selfId });
    // recent history came along (as lines, saying who wrote each one, for screens that draw it as their message)
    await waitFor(() => bob.state().log.some((l) => l.channel === channel && l.type === 'system' && l.text.includes('first thing')));
    expect(bob.state().log.some((l) => l.type === 'system' && l.said?.from === kay.session.selfId && l.said.text === 'first thing' && !l.said.byAgent)).toBe(true);
    expect(bob.state().log.some((l) => l.type === 'system' && l.said?.byAgent && l.said.name === "kay's Claude")).toBe(true);

    // bob asks kay's Claude in that workspace: runs on kay's computer, in the worktree, no request approval
    bob.session.askOwnClaude('add a test', channel);
    await waitFor(() => kay.runs.some((r) => r.prompt === 'add a test'));
    expect(kay.runs.find((r) => r.prompt === 'add a test')?.place?.cwd).toBe(ws.path);
    expect(kay.state().approvals).toHaveLength(0);
    await waitFor(() => agentDone(bob.state(), 'echo: add a test'));
    // both see each other's messages in the workspace
    await waitFor(() => kay.state().log.some((l) => l.channel === channel && l.type === 'chat' && l.text === 'add a test'));

    // bob can browse the workspace folder
    const files = await bob.session.listFiles({ owner: kay.session.selfId, share: shared.share, path: '' });
    expect(files.some((f) => f.name === 'src')).toBe(true);

    // removed: it disappears for bob and the folder closes
    kay.session.sharing.remove(ws.id, bob.session.selfId);
    await waitFor(() => bob.state().shared.length === 0);
    await expect(bob.session.listFiles({ owner: kay.session.selfId, share: shared.share, path: '' })).rejects.toThrow();
  });

  it("a guest's @claude is their own agent, answering in the worktree for everyone; the owner's answers the rest", async () => {
    hub = await startHub({ keys });
    const mgr = demo;
    const kay = peer('kay', { workspaces: mgr });
    const bob = peer('bob');
    await room(kay, bob);
    await kay.session.workspaces!.refresh();
    const ws = mgr.list.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth')!;
    const channel = `ws:${ws.id}`;
    kay.session.sharing.invite(ws.id, bob.session.selfId, 'contribute');
    const shared = await waitFor(() => bob.state().shared[0]);

    // "@claude" from bob: bob's agent, on bob's Mac, told how to read kay's worktree; kay's stays out.
    bob.session.submit('@claude what does src do?', { channel });
    await waitFor(() => bob.runs.some((r) => r.prompt === 'what does src do?'));
    const run = bob.runs.find((r) => r.prompt === 'what does src do?')!;
    expect(run.place?.cwd).not.toBe(ws.path);
    expect(run.sharedBrief).toContain(`share "${shared.share}"`);
    // Its answer is in the worktree's conversation on kay's Mac too, as bob's agent's.
    await waitFor(() => kay.state().log.some((l) => l.type === 'agent' && l.channel === channel && l.owner === bob.session.selfId && l.status === 'done' && l.text.includes('echo: what does src do?')));
    await waitFor(() => kay.state().log.some((l) => l.type === 'chat' && l.channel === channel && l.text === '@claude what does src do?'));
    expect(kay.runs).toHaveLength(0);

    // A plain line, and "@claude:kay", go to kay's agent.
    bob.session.submit('add a test', { channel });
    bob.session.submit('@claude:kay and a readme', { channel });
    await waitFor(() => kay.runs.some((r) => r.prompt === 'add a test') && kay.runs.some((r) => r.prompt === 'and a readme'));
    expect(bob.runs).toHaveLength(1);

    // Bob's agent reads kay's worktree with the room's file tools.
    const files = await bob.session.bridge.listPeerFiles('kay', shared.share, '');
    expect(files.some((f) => f.name === 'src')).toBe(true);
  });

  it("nobody else's agent writes into a worktree, nor a guest's agent for someone else's ask", async () => {
    hub = await startHub({ keys });
    const mgr = demo;
    const kay = peer('kay', { workspaces: mgr });
    const bob = peer('bob');
    const cat = peer('cat');
    await room(kay, bob, cat);
    await kay.session.workspaces!.refresh();
    const ws = mgr.list.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth')!;
    const channel = `ws:${ws.id}`;
    kay.session.sharing.invite(ws.id, bob.session.selfId, 'contribute');
    await waitFor(() => bob.state().shared[0]);
    const forged = (from: P, requester: string) => from.session.send({ kind: 'agent_event', requestId: `f-${requester}`, requester, event: 'done', text: 'forged', channel }, { to: kay.session.selfId });
    forged(cat, cat.session.selfId); // not invited
    forged(bob, kay.session.selfId); // invited, but not their own ask
    await new Promise((r) => setTimeout(r, 200));
    expect(kay.state().log.some((l) => l.type === 'agent' && l.text === 'forged')).toBe(false);
  });

  it('viewers follow along but cannot ask Claude or post', async () => {
    hub = await startHub({ keys });
    const mgr = demo;
    const kay = peer('kay', { workspaces: mgr });
    const bob = peer('bob');
    await room(kay, bob);
    await kay.session.workspaces!.refresh();
    const ws = mgr.list.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth')!;
    kay.session.sharing.invite(ws.id, bob.session.selfId, 'view');
    await waitFor(() => bob.state().shared[0]);
    bob.session.askOwnClaude('sneaky', `ws:${ws.id}`);
    // a forged request is refused on kay's side too
    bob.session.requestAgent(kay.session.selfId, 'forged', false, `ws:${ws.id}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(kay.runs).toHaveLength(0);
  });

  it("nobody can talk to Claude in a workspace that wasn't shared with them", async () => {
    hub = await startHub({ keys });
    const mgr = demo;
    const kay = peer('kay', { workspaces: mgr });
    const bob = peer('bob');
    await room(kay, bob);
    await kay.session.workspaces!.refresh();
    const ws = mgr.list.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth')!;
    bob.session.requestAgent(kay.session.selfId, 'hi', false, `ws:${ws.id}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(kay.runs).toHaveLength(0);
  });

  // A name you give is up to 200 characters; the invite carries at most 80 (what older peers accept).
  it.each([80, 81, 200])('invites with a name of %i characters: the friend gets it, cut to 80', async (n) => {
    hub = await startHub({ keys });
    const mgr = demo;
    const kay = peer('kay', { workspaces: mgr });
    const bob = peer('bob');
    await room(kay, bob);
    await kay.session.workspaces!.refresh();
    // A worktree no other test looks for by name.
    const ws = mgr.list.flatMap((p) => p.workspaces).find((w) => w.name === 'checkout-events')!;
    const original = ws.name;
    const long = 'x'.repeat(n);
    mgr.rename(ws.id, long);
    try {
      await kay.session.workspaces!.refresh();
      expect(kay.session.sharing.invite(ws.id, bob.session.selfId, 'view')).toBe(true);
      const shared = await waitFor(() => bob.state().shared[0]);
      expect(shared.name).toBe(long.slice(0, 80));
      expect(mgr.list.flatMap((p) => p.workspaces).find((w) => w.id === ws.id)?.name).toBe(long);
    } finally {
      mgr.rename(ws.id, original);
    }
  });
});

describe('sharing a folder with one person', () => {
  it('only that person sees and can open it, and it goes away when you stop', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    const eve = peer('eve');
    await room(kay, bob, eve);
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-notes-')));
    (await import('node:fs')).writeFileSync(path.join(dir, 'plan.md'), '# plan');
    kay.session.shareFolder(dir, false, [bob.session.selfId]);
    const offer = await waitFor(() => bob.state().offers[0]);
    expect(eve.state().offers).toHaveLength(0);
    expect(bob.state().browser.rows.some((r) => r.label.includes('(shared with you)'))).toBe(true);
    const files = await bob.session.listFiles({ owner: kay.session.selfId, share: offer.name, path: '' });
    expect(files.map((f) => f.name)).toEqual(['plan.md']);
    await expect(eve.session.listFiles({ owner: kay.session.selfId, share: offer.name, path: '' })).rejects.toThrow();
    kay.session.unshareFolder(offer.name);
    await waitFor(() => bob.state().offers.length === 0);
  });
});

describe('the host manages the room', () => {
  it('removes a person; they are told and can not come back with the old link', async () => {
    hub = await startHub({ keys, hostId: HOST.peerId });
    const kay = peer('kay', { host: true });
    const bob = peer('bob');
    await room(kay, bob);
    expect(kay.session.isHost).toBe(true);
    expect(bob.session.isHost).toBe(false);
    kay.session.removePerson(bob.session.selfId);
    await waitFor(() => kay.state().peers.length === 1);
    await waitFor(() => bob.state().log.some((l) => l.type === 'system' && l.text.includes('removed')));
  });

  it('clears the group chat for everyone; others can only clear their own screen', async () => {
    hub = await startHub({ keys, hostId: HOST.peerId });
    const kay = peer('kay', { host: true });
    const bob = peer('bob');
    await room(kay, bob);
    kay.session.submit('hello');
    await waitFor(() => bob.state().log.some((l) => l.type === 'chat'));
    bob.session.clearChat('room', { everyone: true }); // not the host: only bob's screen
    await new Promise((r) => setTimeout(r, 100));
    expect(kay.state().log.some((l) => l.type === 'chat')).toBe(true);
    kay.session.clearChat('room', { everyone: true });
    await waitFor(() => !bob.state().log.some((l) => l.type === 'chat') && !kay.state().log.some((l) => l.type === 'chat'));
  });

  it('closes the room to newcomers', async () => {
    hub = await startHub({ keys, hostId: HOST.peerId });
    const kay = peer('kay', { host: true });
    await room(kay);
    kay.session.setRoomOpen(false);
    expect(kay.state().roomOpen).toBe(false);
    const late = peer('late');
    await waitFor(() => late.state().log.some((l) => l.type === 'system' && /isn't taking new people/.test(l.text)));
  });
});

describe('Claude Code agent worktrees', () => {
  it('removes the finished ones and keeps those with uncommitted work', async () => {
    const mgr = demo; // the only test that removes worktrees; no other test looks at agent worktrees
    const api = mgr.list.find((p) => p.name === 'bob-api')!;
    const agents = api.workspaces.filter((w) => /[\\/]\.claude[\\/]worktrees[\\/]/.test(w.path));
    expect(agents).toHaveLength(2);
    (await import('node:fs')).writeFileSync(path.join(agents[0]!.path, 'wip.txt'), 'not committed');
    await mgr.refresh();
    const res = await mgr.cleanAgentWorktrees(api.id);
    expect(res).toEqual({ removed: 1, kept: 1 });
    const left = mgr.list.find((p) => p.id === api.id)!.workspaces.filter((w) => /[\\/]\.claude[\\/]worktrees[\\/]/.test(w.path));
    expect(left.map((w) => w.id)).toEqual([agents[0]!.id]);
  });
});

describe('review hardening', () => {
  it("ignores a question about your request from anyone but the Claude you asked", async () => {
    hub = await startHub({ keys });
    const bob = peer('bob', { script: async (input) => ((await input.askUser!({ kind: 'plan', plan: 'real' })).kind) });
    const kay = peer('kay');
    const eve = peer('eve');
    await room(bob, kay, eve);
    bob.session.store.dispatch({ type: 'trust', peerId: kay.session.selfId, trusted: true });
    kay.session.submit('@claude:bob do it');
    const real = await waitFor(() => kay.state().questions[0]);
    const requestId = real.requestId;
    // eve forges a card for the same request
    (eve.session as unknown as { send: (b: unknown, o: unknown) => boolean }).send(
      { kind: 'agent_question', requestId, qid: 'forged', channel: 'room', question: { kind: 'plan', plan: '\u001b]0;pwned\u0007evil' } },
      { to: kay.session.selfId },
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(kay.state().questions.map((q) => q.qid)).toEqual([real.qid]);
  });

  it("respects 'nobody uses my Claude' even for workspace contributors", async () => {
    hub = await startHub({ keys });
    const mgr = demo;
    const kay = peer('kay', { workspaces: mgr });
    const bob = peer('bob');
    await room(kay, bob);
    await kay.session.workspaces!.refresh();
    const ws = mgr.list.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth')!;
    kay.session.sharing.invite(ws.id, bob.session.selfId, 'contribute');
    await waitFor(() => bob.state().shared[0]);
    kay.session.setClaudeSharing('deny');
    bob.session.askOwnClaude('please', `ws:${ws.id}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(kay.runs).toHaveLength(0);
  });
});

describe('on your own', () => {
  it('plain messages in the chat go to your Claude, and @workspace reaches the Claude working there', async () => {
    hub = await startHub({ keys });
    const mgr = demo;
    const kay = peer('kay', { workspaces: mgr });
    await room(kay);
    await kay.session.workspaces!.refresh();
    kay.session.submit('what is this project?');
    await waitFor(() => kay.runs.some((r) => r.prompt === 'what is this project?' && !r.place));
    const ws = mgr.list.flatMap((p) => p.workspaces).find((w) => w.name === 'add-auth')!;
    kay.session.submit('@add-auth add a test');
    await waitFor(() => kay.runs.some((r) => r.prompt === 'add a test'));
    expect(kay.runs.find((r) => r.prompt === 'add a test')?.place?.cwd).toBe(ws.path);
    expect(kay.state().log.some((l) => l.type === 'system' && l.text.includes('Sent to the agent in add-auth'))).toBe(true);
  });

  it("opening a workspace Beluga hasn't used shows its Claude Code conversation and continues it", async () => {
    hub = await startHub({ keys });
    const mgr = demo;
    const seen: string[] = [];
    const kay = peer('kay', {
      workspaces: mgr,
      findConversation: async (dir) => {
        seen.push(dir);
        return { sessionId: 'sess-1', title: 'Fix login', lastModified: Date.now(), items: [{ id: 'c1', type: 'chat', channel: '', from: 'me', name: 'kay', text: 'earlier message', ts: 1, byAgent: false }] };
      },
    });
    await room(kay);
    await kay.session.workspaces!.refresh();
    const ws = mgr.list.flatMap((p) => p.workspaces).find((w) => w.name === 'webhook-retries')!;
    kay.session.workspaces!.open(ws.id);
    await waitFor(() => kay.state().log.some((l) => l.channel === `ws:${ws.id}` && l.type === 'chat' && l.text === 'earlier message'));
    expect(seen).toEqual([ws.path]);
    expect(kay.state().log.some((l) => l.type === 'system' && l.text.includes('Continuing "Fix login"'))).toBe(true);
    expect(mgr.find(ws.id)?.sessionId).toBe('sess-1');
  });
});

describe('workspaces work in parallel', () => {
  it("runs different workspaces' Claudes at the same time, and one conversation in order", async () => {
    hub = await startHub({ keys });
    const mgr = demo;
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const kay = peer('kay', {
      workspaces: mgr,
      script: async (input) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Each run holds until another one runs beside it (or 3 s go by: they don't), not for a set
        // time a busy machine can take just to start the next one.
        await waitFor(() => peak >= 2, 3_000).catch(() => undefined);
        order.push(input.prompt);
        inFlight--;
        return 'ok';
      },
    });
    await room(kay);
    await kay.session.workspaces!.refresh();
    const all = mgr.list.flatMap((p) => p.workspaces);
    const a = all.find((w) => w.name === 'add-auth')!;
    const b = all.find((w) => w.name === 'new-hero')!;
    kay.session.askOwnClaude('a1', `ws:${a.id}`);
    kay.session.askOwnClaude('a2', `ws:${a.id}`);
    kay.session.askOwnClaude('b1', `ws:${b.id}`);
    await waitFor(() => order.length === 3, 10_000);
    expect(peak).toBe(2); // add-auth and new-hero side by side
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2')); // same workspace stays in order
  });
});
