import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput, RoomBridge } from '../src/agent/types.js';
import { Session } from '../src/core/session.js';
import { STEERED_IN } from '../src/shared/claude-notices.js';
import { ShareService } from '../src/core/shares.js';
import { Store, fileKey, initialState, type DomainState, type Policy } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { attach, waitFor } from './helpers.js';
import type { InProcessClient } from '../src/ipc/in-process.js';
import { friendRooms, providerCards } from '../src/ui/usage-cards.js';

const keys = deriveKeys(generateSecret());
let hub: Hub;
const sessions: Session[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  await hub?.close();
});

type Script = (input: AgentRunInput, bridge: RoomBridge) => Promise<string>;

interface Peer {
  session: Session;
  state: () => DomainState;
  /** A screen attached to it (view, tabs, toasts). */
  screen: InProcessClient;
  runs: AgentRunInput[];
  bridge: RoomBridge;
  root: string;
  quit: { called: boolean };
  toasts: string[];
  copied: string[];
}

function peer(name: string, opts: { policy?: Policy; script?: Script; agent?: boolean; files?: Record<string, string>; approvalTimeoutMs?: number } = {}): Peer {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `klaud-${name}-`)));
  for (const [file, content] of Object.entries(opts.files ?? {})) writeFileSync(path.join(root, file), content);
  const shares = new ShareService([{ name: 'proj', root, writable: true }]);
  const store = new Store(initialState('test', opts.policy ?? 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name, shares: shares.infos, agent: opts.agent !== false }, reconnect: false });
  const runs: AgentRunInput[] = [];
  let bridge!: RoomBridge;
  const quit = { called: false };
  const toasts: string[] = [];
  const copied: string[] = [];
  const session = new Session({
    zoom: async (dir) => ({ ok: true, message: `zoom ${dir}` }),
    copy: async (text) => {
      if (text.includes('FAIL')) throw new Error('no clipboard');
      copied.push(text);
    },
    client,
    store,
    shares,
    agentCwd: root,
    requestTimeoutMs: 2000,
    approvalTimeoutMs: opts.approvalTimeoutMs,
    agentTimeoutMs: 2000,
    downloadDir: path.join(root, 'downloads'),
    createAgent:
      opts.agent === false
        ? undefined
        : (b): AgentBackend => {
            bridge = b;
            return {
              run: async (input) => {
                runs.push(input);
                return opts.script ? opts.script(input, b) : `echo: ${input.prompt}`;
              },
            };
          },
  });
  const screen = attach(session);
  let lastToast: unknown;
  screen.store.subscribe(() => {
    const t = screen.store.getState().toast;
    if (t && t !== lastToast) toasts.push(t.text);
    lastToast = t;
  });
  screen.onIntent((intent) => {
    if (intent.type === 'quit') quit.called = true;
  });
  session.start();
  sessions.push(session);
  return { session, state: store.getState, screen, runs, get bridge() { return bridge; }, root, quit, toasts, copied };
}

const agentItems = (s: DomainState) => s.log.filter((l) => l.type === 'agent');
const systemText = (s: DomainState) => s.log.filter((l) => l.type === 'system').map((l) => (l.type === 'system' ? l.text : ''));

async function room(...peers: Peer[]): Promise<void> {
  await waitFor(() => peers.every((p) => p.state().peers.length === peers.length && p.state().self));
}

describe('Session', () => {
  it('chats and runs your own agent with @claude', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    kay.session.submit('hi bob');
    await waitFor(() => bob.state().log.some((l) => l.type === 'chat' && l.text === 'hi bob'));

    kay.session.submit('@claude summarize');
    await waitFor(() => agentItems(bob.state()).some((a) => a.type === 'agent' && a.status === 'done'));
    expect(agentItems(bob.state())[0]).toMatchObject({ ownerName: 'kay', requesterName: 'kay', text: 'echo: summarize' });
    expect(kay.runs[0]?.context).toContain('kay: hi bob');
  });

  it("asks the owner before running a friend's request, and honours 'always'", async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);

    kay.session.submit('@claude:bob check the api');
    await waitFor(() => bob.state().approvals.length === 1);
    // Kay hears of it over the hub, a moment after Bob is asked.
    await waitFor(() => agentItems(kay.state())[0]?.status === 'awaiting_approval');
    expect(bob.session.answerApproval('always')).toBe(true);
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'done'));
    expect(bob.runs[0]?.requesterName).toBe('kay');
    expect(bob.state().levels[kay.session.selfId]).toBe('trusted');

    kay.session.submit('@claude:bob again');
    await waitFor(() => bob.runs.length === 2);
    expect(bob.state().approvals).toHaveLength(0);
  });

  // The ask names Codex since BLG-520; bob's card lists no Codex here, so his default answers (tests/room-agent-tags.test.ts).
  it('@bob:codex reaches bob, and his Mac decides which agent runs (BLG-476, BLG-520)', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    kay.session.submit('@bob:codex check the api');
    await waitFor(() => bob.state().approvals.length === 1);
    expect(bob.session.answerApproval('yes')).toBe(true);
    await waitFor(() => bob.runs.length === 1);
    expect(bob.runs[0]?.prompt).toContain('check the api');
    expect(bob.runs[0]?.requesterName).toBe('kay');
  });

  it('reports declined and denied requests', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    const cat = peer('cat', { policy: 'deny' });
    const dan = peer('dan', { agent: false });
    await room(kay, bob, cat, dan);

    kay.session.submit('@claude:bob do it');
    await waitFor(() => bob.state().approvals.length === 1);
    bob.session.answerApproval('no');
    kay.session.submit('@claude:cat do it');
    kay.session.submit('@claude:dan do it');
    kay.session.submit('@claude:zed do it');
    await waitFor(() => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.status === 'denied').length === 3);
    expect(kay.toasts).toContain('Nobody named "zed" is here');
    expect(bob.runs).toHaveLength(0);
    expect(bob.session.answerApproval('yes')).toBe(false);
  });

  it('runs every agent with @claudes when policy is auto', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', { policy: 'auto' });
    const bob = peer('bob', { policy: 'auto' });
    await room(kay, bob);
    bob.session.submit('@claudes status?');
    await waitFor(() => kay.runs.length === 1 && bob.runs.length === 1);
    await waitFor(() => agentItems(bob.state()).filter((a) => a.type === 'agent' && a.status === 'done').length === 2);
  });

  it('publishes your default agent on your card at once, without reconnecting (BLG-444)', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    const opus = { runtime: 'claude' as const, model: 'opus', label: 'Claude' };
    kay.session.setPrefs({ defaultAgent: opus });
    await waitFor(() => bob.state().peers.find((p) => p.name === 'kay')?.defaultAgent?.model === 'opus');
    expect(bob.state().peers.find((p) => p.name === 'kay')?.agents?.[0]).toEqual(opus);
    expect(kay.session.agentRef).toEqual(opus);
    kay.session.setPrefs({ projectAgents: { api: { runtime: 'claude', model: 'sonnet', label: 'Claude' } } });
    expect(kay.session.agentFor('api').model).toBe('sonnet');
    expect(kay.session.agentFor('web')).toEqual(opus);
    kay.session.setPrefs({ defaultAgent: null });
    await waitFor(() => bob.state().peers.find((p) => p.name === 'kay')?.defaultAgent?.model === undefined);
  });

  it('make-default on a usage card sets your default and the peer card friends see (BLG-458)', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    const codex = { runtime: 'codex', model: 'gpt-5', label: 'Codex' };
    kay.session.updateUsage({ windows: [{ label: 'Weekly', pct: 24 }] }, codex);
    // What the Codex card's chip sends.
    kay.session.setPrefs({ defaultAgent: codex });
    await waitFor(() => bob.state().peers.find((p) => p.name === 'kay')?.defaultAgent?.runtime === 'codex');
    await waitFor(() => (kay.state().peers.find((p) => p.name === 'kay')?.usages?.length ?? 0) > 0);
    expect(providerCards(kay.state().peers.find((p) => p.name === 'kay'), kay.state().prefs.defaultAgent).find((c) => c.isDefault)?.key).toBe('codex');
    const room0 = friendRooms(bob.state().peers, bob.session.selfId).find((r) => r.name === 'kay');
    expect(room0).toMatchObject({ agent: { runtime: 'codex' }, isDefault: true, left: 76 });
    // And Claude's chip: back to no default.
    kay.session.setPrefs({ defaultAgent: null });
    await waitFor(() => bob.state().peers.find((p) => p.name === 'kay')?.defaultAgent?.runtime === 'claude');
  });

  it('runs the person\'s agent with @bob and @agents, and says who a mistyped name may be', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', { policy: 'auto' });
    const bob = peer('bob', { policy: 'auto' });
    await room(kay, bob);
    kay.session.submit('@bob status?');
    await waitFor(() => bob.runs.length === 1);
    expect(kay.runs).toHaveLength(0);
    kay.session.submit('@agents status?');
    await waitFor(() => kay.runs.length === 1 && bob.runs.length === 2);
    kay.session.submit('@bbo status?');
    expect(kay.toasts).toContain('Nobody named "bbo" is here. Did you mean @bob?');
  });

  it('streams agent text/tool events and approves tool use', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: async (input) => {
        input.onEvent('tool', 'Bash ls');
        const ok = await input.canUseTool('Bash', { command: 'ls' });
        input.onEvent('text', ok ? 'allowed' : 'blocked');
        const again = await input.canUseTool('Bash', { command: 'pwd' });
        return again ? 'finished' : 'nope';
      },
    });
    await room(kay);
    kay.session.store.dispatch({ type: 'prefs', prefs: { selfApproval: 'ask' } });
    kay.session.submit('@claude list files');
    await waitFor(() => kay.state().approvals[0]?.kind === 'tool');
    expect(kay.state().approvals[0]?.detail).toBe('ls');
    kay.session.answerApproval('always');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'done'));
    expect(agentItems(kay.state())[0]).toMatchObject({ text: 'finished', steps: ['Bash ls'] });
  });

  it('deleting a sentinel or a dashboard asks you first, even when your Claude never asks: once, no Always', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: async (input) => {
        const ls = await input.canUseTool('Bash', { command: 'ls' });
        const gone = await input.canUseTool('mcp__beluga_sentinel__sentinel_remove', { id: 'sn_x' });
        return `${ls ? 'ran' : 'asked'} ${gone ? 'deleted' : 'kept'}`;
      },
    });
    await room(kay);
    // The default: your Claude doesn't ask (Bash just runs), but a delete still does.
    expect(kay.state().prefs.selfApproval).toBe('never');
    kay.session.submit('@claude delete the nightly sentinel');
    await waitFor(() => kay.state().approvals[0]?.kind === 'tool');
    expect(kay.state().approvals[0]).toMatchObject({ once: true, title: expect.stringMatching(/sentinel_remove/) });
    kay.session.answerApproval('no');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'done'));
    expect(agentItems(kay.state())[0]).toMatchObject({ text: 'ran kept' });
  });

  it('surfaces agent failures and stop requests', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: (input) =>
        input.prompt === 'crash'
          ? Promise.reject(new Error('kaboom'))
          : new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    await room(kay);
    kay.session.submit('@claude crash');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'error' && a.text === 'kaboom'));
    kay.session.submit('@claude hang');
    await waitFor(() => kay.runs.length === 2);
    kay.session.submit(':stop');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'Stopped by owner'));
    kay.session.submit(':stop');
    expect(kay.toasts).toContain('Your agent is not running anything');
  });

  it("browses and reads a friend's shared folder, live-reloading on change", async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob', { files: { 'README.md': 'v1', '.env': 'SECRET' } });
    await room(kay, bob);

    const bobRow = kay.state().browser.rows.findIndex((r) => r.label === 'bob · proj');
    await kay.session.browserEnter(bobRow);
    expect(kay.state().browser.rows.map((r) => r.label)).toEqual(['..', 'README.md']);
    await kay.session.browserEnter(1);
    expect(kay.state().viewer).toMatchObject({ content: 'v1', path: 'README.md' });
    await waitFor(() => bob.state().focus[kay.session.selfId]?.path === 'README.md');

    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(path.join(bob.root, 'README.md'), 'v2');
    await waitFor(() => kay.state().viewer?.content === 'v2', 5000);

    kay.session.submit(`:open bob:proj/.env`);
    await waitFor(() => kay.state().viewer?.error === 'That file is private');
    kay.session.submit(':open bob:proj/missing.md');
    await waitFor(() => kay.state().viewer?.error?.includes('ENOENT'));
    kay.session.submit(':open nope');
    expect(kay.toasts.some((t) => t.includes("Can't open"))).toBe(true);

    await kay.session.loadDir({ owner: bob.session.selfId, share: 'proj', path: '' });
    expect(kay.state().dirCache[`${bob.session.selfId}:proj/`]?.map((e) => e.name)).toEqual(['README.md']);
    await kay.session.loadDir({ owner: bob.session.selfId, share: 'proj', path: 'nope' }); // errors are ignored

    await kay.session.browserEnter(0); // '..' goes back to root
    expect(kay.state().browser.at).toBeUndefined();
    await kay.session.browseTo({ owner: bob.session.selfId, share: 'nope', path: '' });
    expect(kay.state().browser.error).toMatch(/not shared with you/);
  });

  it('reads the images a friend’s document shows, by the same rules as opening a file', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>';
    const bob = peer('bob', { files: { 'flow.svg': svg, 'notes.md': '# Notes' } });
    mkdirSync(path.join(bob.root, 'node_modules'));
    writeFileSync(path.join(bob.root, 'node_modules', 'logo.png'), 'x');
    await room(kay, bob);
    const at = (p: string) => ({ owner: bob.session.selfId, share: 'proj', path: p });
    const image = await kay.session.files.readImageFile(at('flow.svg'));
    expect(image.mediaType).toBe('image/svg+xml');
    expect(image.bytes.toString('utf8')).toBe(svg);
    // Only images; nothing the share keeps private; nothing outside it; nothing that isn't there.
    await expect(kay.session.files.readImageFile(at('notes.md'))).rejects.toThrow('Not an image');
    await expect(kay.session.files.readImageFile(at('node_modules/logo.png'))).rejects.toThrow('That file is private');
    await expect(kay.session.files.readImageFile(at('../outside.png'))).rejects.toThrow(/traversal/);
    await expect(kay.session.files.readImageFile(at('missing.png'))).rejects.toThrow(/ENOENT/);
    await expect(kay.session.files.readImageFile({ owner: bob.session.selfId, share: 'nope', path: 'flow.svg' })).rejects.toThrow(/not shared with you/);
  });

  it('a picture whose file was deleted raises no toast: the screen shows a placeholder instead', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', { files: { 'shot.png': 'x' } });
    await room(kay);
    const at = { owner: kay.session.selfId, share: 'proj', path: 'gone.gif' };
    await expect(kay.screen.api.files.version(at)).rejects.toThrow(/ENOENT/);
    await expect(kay.screen.api.files.readImageFile(at)).rejects.toThrow(/ENOENT/);
    await new Promise((r) => setTimeout(r, 0));
    expect(kay.toasts.filter((t) => t.includes('Something went wrong'))).toEqual([]);
    // Any other failed call still says so.
    await expect(kay.screen.api.session.localLocation(42 as unknown as string, false)).rejects.toThrow();
    await waitFor(() => kay.toasts.some((t) => t.startsWith('Something went wrong')));
  });

  it('a picture a preview shows is watched: written again, its new time comes for the preview to read it again (BLG-670)', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob', { files: { 'fire.gif': 'GIF89a-light' } });
    await room(kay, bob);
    const at = { owner: bob.session.selfId, share: 'proj', path: 'fire.gif' };
    expect((await kay.session.files.readImageFile(at)).bytes.toString('latin1')).toBe('GIF89a-light');
    expect(kay.state().written[fileKey(at)]).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(path.join(bob.root, 'fire.gif'), 'GIF89a-dark');
    await waitFor(() => kay.state().written[fileKey(at)] !== undefined, 5000);
    expect((await kay.session.files.readImageFile(at)).bytes.toString('latin1')).toBe('GIF89a-dark');
  });

  it('tells which version of a picture is there (size and time, yours or a friend’s) without reading it (BLG-749)', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', { files: { 'shot.png': 'PNG-old' } });
    const bob = peer('bob', { files: { 'flow.png': 'PNG-bob' } });
    await room(kay, bob);
    const mine = { owner: kay.session.selfId, share: 'proj', path: 'shot.png' };
    const first = await kay.session.files.fileVersion(mine);
    expect(first.size).toBe(7);
    // Re-taken under the same name: the version moves, so a picture kept by it is read again.
    writeFileSync(path.join(kay.root, 'shot.png'), 'PNG-newer');
    utimesSync(path.join(kay.root, 'shot.png'), new Date(), new Date(first.mtime + 5000));
    const second = await kay.session.files.fileVersion(mine);
    expect(second.size).toBe(9);
    expect(second.mtime).toBeGreaterThan(first.mtime);
    // A friend's, from a listing of its folder; the same rules as reading it.
    expect((await kay.session.files.fileVersion({ owner: bob.session.selfId, share: 'proj', path: 'flow.png' })).size).toBe(7);
    await expect(kay.session.files.fileVersion({ owner: bob.session.selfId, share: 'proj', path: 'missing.png' })).rejects.toThrow(/ENOENT/);
    await expect(kay.session.files.fileVersion({ ...mine, path: '../outside.png' })).rejects.toThrow(/traversal/);
    await expect(kay.session.files.fileVersion({ owner: bob.session.selfId, share: 'nope', path: 'flow.png' })).rejects.toThrow(/not shared with you/);
  });

  it('reads a PDF for the Mac reader, and a file’s text without opening the viewer', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const pdf = '%PDF-1.4\n%\u00e2\u00e3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n';
    const bob = peer('bob', { files: { 'spec.pdf': pdf, 'README.md': '# Hello' } });
    await room(kay, bob);
    const at = (p: string) => ({ owner: bob.session.selfId, share: 'proj', path: p });
    const doc = await kay.session.files.readImageFile(at('spec.pdf'));
    expect(doc.mediaType).toBe('application/pdf');
    expect(doc.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = await kay.session.files.readFile(at('README.md'));
    expect(text).toEqual({ content: '# Hello', truncated: false });
    // Reading it doesn't open it.
    expect(kay.session.store.getState().viewer).toBeUndefined();
  });

  it('follows a friend and their agent like Google Docs', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob', {
      files: { 'a.md': 'A', 'b.md': 'B' },
      policy: 'auto',
      script: async (_input, bridge) => {
        const where = await bridge.writeReport('Audit Results', 'all good');
        return where;
      },
    });
    await room(kay, bob);
    await bob.session.openLocation({ owner: bob.session.selfId, share: 'proj', path: 'a.md' });
    kay.session.submit(':follow bob');
    await waitFor(() => kay.state().viewer?.content === 'A');
    expect(kay.state().viewer?.by).toBe('bob');

    await bob.session.openLocation({ owner: bob.session.selfId, share: 'proj', path: 'b.md' });
    await waitFor(() => kay.state().viewer?.content === 'B');

    kay.session.submit('@claude:bob audit');
    await waitFor(() => kay.state().viewer?.path.startsWith('.beluga/reports/') && kay.state().viewer?.content.includes('all good'));
    expect(kay.state().viewer?.by).toBe("bob's agent");
    const reports = readdirSync(path.join(bob.root, '.beluga', 'reports'));
    expect(readFileSync(path.join(bob.root, '.beluga', 'reports', reports[0]!), 'utf8')).toBe('# Audit Results\n\nall good');
    expect(systemText(kay.state()).some((t) => t.includes("bob's agent wrote a report. Open it with /open bob:proj/.beluga/reports/"))).toBe(true);

    kay.session.submit(':unfollow');
    expect(kay.state().follow).toBeUndefined();
    kay.session.submit('/follow zed');
    expect(kay.toasts).toContain('Nobody named "zed" is here');
  });

  it('lets agents talk to each other and browse peers through the bridge', async () => {
    hub = await startHub({ keys });
    const bob = peer('bob', { policy: 'auto', files: { 'notes.txt': 'bob notes' } });
    const nop = peer('nop', { agent: false });
    const kay = peer('kay', {
      script: async (_input, bridge) => {
        const peers = bridge.listPeers().map((p) => p.name).sort();
        const files = await bridge.listPeerFiles('bob', 'proj', '');
        const notes = await bridge.readPeerFile('bob', 'proj', 'notes.txt');
        const answer = await bridge.askAgent('bob', 'what do you think?');
        bridge.sendChat('agent says hi');
        await expect(bridge.askAgent('nop', 'x')).rejects.toThrow(/no agent/);
        await expect(bridge.readPeerFile('zed', 'proj', 'x')).rejects.toThrow(/No peer/);
        return JSON.stringify({ me: bridge.selfName(), peers, files: files.map((f) => f.name), notes, answer });
      },
    });
    await room(kay, bob, nop);
    kay.session.submit('@claude coordinate');
    const done = await waitFor(() => agentItems(kay.state()).find((a) => a.type === 'agent' && a.owner === kay.session.selfId && a.status === 'done'));
    expect(JSON.parse(done.type === 'agent' ? done.text : '')).toEqual({
      me: 'kay',
      peers: ['bob', 'kay', 'nop'],
      files: ['notes.txt'],
      notes: 'bob notes',
      answer: 'echo: what do you think?',
    });
    expect(bob.runs[0]).toMatchObject({ viaAgent: true, requesterName: 'kay' });
    await waitFor(() => bob.state().log.some((l) => l.type === 'chat' && l.byAgent && l.name === "kay's Claude"));
  });

  it('runs slash commands (and legacy colon commands)', async () => {
    hub = await startHub({ keys, roomName: "kay's room" });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    expect(kay.state().room).toBe("kay's room");
    for (const cmd of ['/people', '/policy', '/policy auto', ':trust bob', '/untrust bob', '/trust', '/y', '/wat', '/open', '/close']) {
      kay.session.submit(cmd);
    }
    expect(systemText(kay.state()).some((t) => t.startsWith('kay (you) · claude on · shares proj'))).toBe(true);
    for (const t of [
      'Policy is "ask". Use /policy ask, auto or deny',
      "Friends' requests for your Claude: auto",
      "bob's requests are auto-approved",
      "bob's requests need approval again",
      'Usage: /trust <name>',
      'Nothing to approve',
      'Unknown command /wat. Type /help (or // to send a message starting with /)',
      'Usage: /open <name>:<folder>/<file>',
    ]) {
      expect(kay.toasts).toContain(t);
    }
    expect(kay.state().policy).toBe('auto');
    kay.session.submit('/help');
    expect(kay.screen.store.getState().overlay).toBe('help');
    kay.session.submit('//not a command');
    await waitFor(() => bob.state().log.some((l) => l.type === 'chat' && l.text === '/not a command'));
    kay.session.submit('/clear'); // asks how to clear (just me / everyone)
    expect(kay.screen.store.getState().overlay).toBe('clear');
    kay.session.clearChat('room');
    expect(kay.state().log).toHaveLength(0);
    kay.session.submit('/quit');
    expect(kay.quit.called).toBe(true);
  });

  it('copies the invite and the last Claude answer', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    await room(kay);
    // /invite adds a friend now (BLG-203); the room's link is still copied from Settings and the room's menus.
    kay.session.submit('/invite');
    expect(kay.screen.store.getState().overlay).toBe('add_friend');
    kay.session.submit('/invite @nobody');
    await waitFor(() => kay.toasts.some((t) => /nobody isn’t your friend yet/.test(t)));
    void kay.session.copyInvite();
    await waitFor(() => kay.toasts.includes('No invite link available'));
    kay.session.store.dispatch({ type: 'hosting', hosting: { phase: 'tunnel' } });
    void kay.session.copyInvite();
    await waitFor(() => kay.toasts.includes('The invite link is still being created…'));
    kay.session.store.dispatch({ type: 'invite', invite: 'https://x.trycloudflare.com#abcdefghijklmnopqrstuvwx' });
    void kay.session.copyInvite();
    await waitFor(() => kay.copied.length === 1);
    expect(kay.copied[0]).toBe('https://x.trycloudflare.com#abcdefghijklmnopqrstuvwx');
    expect(kay.toasts).toContain('Invite copied. Paste it to a friend');

    kay.session.submit('/copy');
    await waitFor(() => kay.toasts.includes('No agent answer to copy yet'));
    kay.session.submit('@claude hello');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'done'));
    kay.session.submit('/copy');
    await waitFor(() => kay.copied.includes('echo: hello'));

    kay.session.store.dispatch({ type: 'invite', invite: 'FAIL' });
    await kay.session.copyInvite(); // clipboard unavailable -> shown in chat instead
    expect(kay.toasts.at(-1)).toBe('Could not reach the clipboard. Copy it from the chat instead');
  });
});

describe('Session hardening', () => {
  it(':stop cancels queued runs and pending tool approvals', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: async (input) => {
        await input.canUseTool('Bash', { command: 'sleep 100' });
        return 'should not matter';
      },
    });
    await room(kay);
    kay.session.store.dispatch({ type: 'prefs', prefs: { selfApproval: 'ask' } });
    kay.session.submit('@claude first');
    kay.session.submit('@claude second');
    await waitFor(() => kay.state().approvals.length === 1);
    kay.session.stopAgent();
    await waitFor(() => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.status === 'error').length === 2);
    expect(kay.state().approvals).toHaveLength(0);
    expect(kay.runs).toHaveLength(1);
    expect(agentItems(kay.state()).map((a) => (a.type === 'agent' ? a.text : ''))).toContain('Cancelled by owner');
  });

  it('stops your Claude in one conversation; your queued messages come back, others keep going', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      policy: 'auto',
      script: async (input) => {
        if (input.prompt !== 'first') return `done: ${input.prompt}`;
        await input.canUseTool('Bash', { command: 'sleep 100' });
        return 'should not matter';
      },
    });
    const bob = peer('bob');
    await room(kay, bob);
    kay.session.store.dispatch({ type: 'prefs', prefs: { selfApproval: 'ask' } });
    kay.session.submit('@claude first');
    await waitFor(() => kay.state().approvals.length === 1);
    kay.session.submit('@claude second');
    bob.session.submit('@claude:kay from bob');
    kay.session.submit('@claude third');
    const queued = () => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.status === 'queued');
    await waitFor(() => queued().length === 3);

    // Nothing of yours in another conversation: nothing there (or here) stops.
    expect(kay.session.host.stopRun('ws:elsewhere')).toEqual({ stopped: false, returned: [] });
    await waitFor(() => kay.toasts.includes("Your agent isn't working here"));
    expect(kay.state().approvals).toHaveLength(1);

    expect(kay.session.host.stopRun('room')).toEqual({ stopped: true, returned: ['second', 'third'] });
    await waitFor(() => kay.toasts.includes('Stopped your agent here · 2 queued messages back in the box'));
    expect(kay.state().approvals).toHaveLength(0);
    const text = (prompt: string) => agentItems(kay.state()).find((a) => a.type === 'agent' && a.prompt === prompt);
    // The run that was going (it never queued, so its log line has no prompt) is the first one.
    await waitFor(() => agentItems(kay.state())[0]?.type === 'agent' && agentItems(kay.state())[0]?.text === 'Stopped by you');
    for (const prompt of ['second', 'third']) expect(text(prompt)).toMatchObject({ status: 'error', text: 'Taken out of the queue when you stopped your agent' });
    // Bob's request kept its place and runs next.
    await waitFor(() => agentItems(bob.state()).some((a) => a.type === 'agent' && a.status === 'done' && a.text === 'done: from bob'));
    expect(kay.runs.map((r) => r.prompt)).toEqual(['first', 'from bob']);
  });

  it('scopes "always" tool approval to one requester', async () => {
    hub = await startHub({ keys });
    const bob = peer('bob', {
      policy: 'auto',
      script: async (input) => ((await input.canUseTool('Bash', { command: 'ls' })) ? 'ran' : 'blocked'),
    });
    const kay = peer('kay');
    const cat = peer('cat');
    await room(bob, kay, cat);
    kay.session.submit('@claude:bob go');
    await waitFor(() => bob.state().approvals.length === 1);
    bob.session.answerApproval('always');
    await waitFor(() => bob.runs.length === 1 && bob.state().approvals.length === 0);
    kay.session.submit('@claude:bob again');
    await waitFor(() => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.status === 'done').length === 2);
    expect(bob.state().approvals).toHaveLength(0);
    cat.session.submit('@claude:bob me too');
    await waitFor(() => bob.state().approvals.length === 1); // cat still needs approval
    bob.session.answerApproval('no');
  });

  it('builds agent context from its own chat log, not the requester', async () => {
    hub = await startHub({ keys });
    const bob = peer('bob', { policy: 'auto' });
    const kay = peer('kay');
    await room(bob, kay);
    kay.session.submit('the plan is X');
    await waitFor(() => bob.state().log.some((l) => l.type === 'chat'));
    kay.session.submit('@claude:bob thoughts?');
    await waitFor(() => bob.runs.length === 1);
    expect(bob.runs[0]?.context).toEqual(['kay: the plan is X', 'kay: @claude:bob thoughts?']);
  });

  it('downloads a file from a friend in encrypted chunks and tells the owner', async () => {
    hub = await startHub({ keys });
    const big = Buffer.alloc(600 * 1024, 7); // spans 3 chunks
    const kay = peer('kay');
    const bob = peer('bob', { files: { 'notes.md': 'hi from bob' } });
    writeFileSync(path.join(bob.root, 'blob.bin'), big);
    await room(kay, bob);
    const saved = await kay.session.download({ owner: bob.session.selfId, share: 'proj', path: 'blob.bin' });
    expect(saved).toBe(path.join(kay.root, 'downloads', 'bob', 'blob.bin'));
    expect(readFileSync(saved!).equals(big)).toBe(true);
    await waitFor(() => systemText(bob.state()).some((t) => t === 'kay is downloading proj/blob.bin'));
    expect(kay.toasts).toContain('Downloaded blob.bin');

    kay.session.submit('/get bob:proj/notes.md');
    await waitFor(() => kay.toasts.includes('Downloaded notes.md'));
    expect(await kay.session.download({ owner: bob.session.selfId, share: 'proj', path: '.env' })).toBeUndefined();
    expect(kay.toasts.at(-1)).toMatch(/Download failed/);
    expect(await kay.session.download({ owner: bob.session.selfId, share: 'proj', path: '' })).toBeUndefined();
    kay.session.submit('/get nope');
    kay.session.submit('/get');
    expect(kay.toasts).toContain('Usage: /get <name>:<folder>/<file>');

    // Saved exactly where you picked (a Save dialog), replacing what's there; never a relative path.
    const picked = path.join(kay.root, 'Desktop copy.md');
    writeFileSync(picked, 'old');
    expect(await kay.session.download({ owner: bob.session.selfId, share: 'proj', path: 'notes.md' }, { to: picked })).toBe(picked);
    expect(readFileSync(picked, 'utf8')).toBe('hi from bob');
    expect(await kay.session.download({ owner: bob.session.selfId, share: 'proj', path: 'notes.md' }, { to: 'relative.md' })).toBeUndefined();
    expect(kay.toasts.at(-1)).toBe('Pick where to save it');
  });

  it('lets you keep your Claude private', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    bob.session.setClaudeSharing('deny');
    await waitFor(() => kay.state().peers.find((p) => p.name === 'bob')?.agent === false);
    expect(bob.state().policy).toBe('deny');
    bob.session.submit('/policy ask');
    await waitFor(() => kay.state().peers.find((p) => p.name === 'bob')?.agent === true);
  });

  it("runs friends' requests with their access level and shares plan usage", async () => {
    hub = await startHub({ keys });
    const bob = peer('bob', {
      policy: 'auto',
      script: async (_input, bridge) => {
        bridge.reportUsage({ fiveHour: { pct: 42 } });
        bridge.reportUsage({ windows: [{ label: 'Weekly', pct: 7 }] }, { runtime: 'codex', label: 'Codex' });
        return 'ok';
      },
    });
    const kay = peer('kay');
    await room(bob, kay);
    kay.session.submit('@claude:bob hi');
    await waitFor(() => bob.runs.length === 1);
    expect(bob.runs[0]?.scope).toBe('folder');
    await waitFor(() => kay.state().peers.find((p) => p.name === 'bob')?.usage?.fiveHour?.pct === 42);
    // Each provider's usage lands on its own entry; the old field stays Claude's.
    await waitFor(() => (kay.state().peers.find((p) => p.name === 'bob')?.usages?.length ?? 0) === 2);
    const shared = kay.state().peers.find((p) => p.name === 'bob')?.usages ?? [];
    expect(shared.find((u) => u.agent.runtime === 'claude')?.fiveHour?.pct).toBe(42);
    expect(shared.find((u) => u.agent.runtime === 'codex')?.windows?.[0]?.pct).toBe(7);
    expect(shared.find((u) => u.agent.runtime === 'codex')?.fiveHour).toBeUndefined();

    bob.session.setAccess(kay.session.selfId, 'full');
    kay.session.submit('@claude:bob again');
    await waitFor(() => bob.runs.length === 2);
    expect(bob.runs[1]?.scope).toBe('full');
    bob.session.submit('@claude mine');
    await waitFor(() => bob.runs.length === 3);
    expect(bob.runs[2]?.scope).toBe('full'); // your own requests always have full reach
  });

  it('shows the access level in approval prompts', async () => {
    hub = await startHub({ keys });
    const bob = peer('bob');
    const kay = peer('kay');
    await room(bob, kay);
    kay.session.submit('@claude:bob look around');
    await waitFor(() => bob.state().approvals.length === 1);
    expect(bob.state().approvals[0]?.title).toBe('kay wants your agent to run this (shared folders; anything else asks you)');
    bob.session.answerApproval('no');
  });

  it('renames and remembers settings changes', async () => {
    hub = await startHub({ keys });
    const saved: object[] = [];
    const kay = peer('kay');
    (kay.session as unknown as { opts: { saveSettings: (p: object) => void } }).opts.saveSettings = (p) => void saved.push(p);
    const bob = peer('bob');
    await room(kay, bob);
    kay.session.submit('/name kayra');
    await waitFor(() => bob.state().peers.some((p) => p.name === 'kayra'));
    kay.session.submit('/name !!!');
    expect(kay.toasts).toContain('Usage: /name <new name> (letters, numbers, . - _)');
    kay.session.submit('/theme mono');
    expect(kay.state().prefs.theme).toBe('mono');
    kay.session.submit('/theme neon');
    expect(kay.toasts).toContain('Themes: calm, light, contrast, mono');
    kay.session.setClaudeSharing('auto');
    expect(saved).toEqual([{ name: 'kayra' }, { theme: 'mono' }, { policy: 'auto' }]);
    kay.session.submit('/settings');
    expect(kay.screen.store.getState().overlay).toBe('settings');
  });

  it('changes text size via /zoom', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    await room(kay);
    kay.session.submit('/zoom in');
    kay.session.submit('/zoom smaller');
    kay.session.submit('/zoom reset');
    await waitFor(() => kay.toasts.includes('zoom reset'));
    expect(kay.toasts).toEqual(expect.arrayContaining(['zoom in', 'zoom out', 'zoom reset']));
  });

  it('queues requests while busy, and urgent ones from you interrupt', async () => {
    hub = await startHub({ keys });
    let release!: () => void;
    const kay = peer('kay', {
      script: (input) =>
        input.prompt === 'slow'
          ? new Promise((resolve, reject) => {
              release = () => resolve('slow done');
              input.signal.addEventListener('abort', () => reject(new Error('aborted')));
            })
          : Promise.resolve(`did ${input.prompt}`),
    });
    await room(kay);
    kay.session.submit('@claude slow');
    await waitFor(() => kay.runs.length === 1);
    kay.session.submit('@claude next');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'queued'));
    kay.session.submit('@claude now', { urgent: true });
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'Interrupted by a newer message'));
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'did now'));
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'did next'));
    expect(kay.runs.map((r) => r.prompt)).toEqual(['slow', 'now', 'next']);
    void release;
  });

  it('runs a queued message now, or cancels it before it starts', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: (input) =>
        input.prompt === 'slow'
          ? new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted'))))
          : Promise.resolve(`did ${input.prompt}`),
    });
    await room(kay);
    kay.session.submit('@claude slow');
    await waitFor(() => kay.runs.length === 1);
    kay.session.submit('@claude later');
    kay.session.submit('@claude drop');
    const queued = () => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.status === 'queued') as Array<{ requestId: string }>;
    await waitFor(() => queued().length === 2);
    const [later, drop] = queued();
    expect(kay.session.host.cancelQueued(drop!.requestId)).toBe(true);
    expect(kay.session.host.promote(later!.requestId)).toBe(true);
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'did later'));
    expect(kay.runs.map((r) => r.prompt)).toEqual(['slow', 'later']);
    expect(agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'Cancelled before it started')).toBe(true);
    expect(kay.session.host.promote('nope')).toBe(false);
  });

  it('a message past the limit of conversations at once says it waits for a free Claude, and stays yours to drop or start', async () => {
    hub = await startHub({ keys });
    const hang = (input: AgentRunInput) => new Promise<string>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const kay = peer('kay', { script: (input) => (input.prompt === 'slow' ? hang(input) : Promise.resolve(`did ${input.prompt}`)) });
    await room(kay);
    (kay.session.host as unknown as { deps: { workspaces: unknown } }).deps.workspaces = { place: () => ({ cwd: kay.root, additionalDirectories: [], autoEdit: false, onSession: () => undefined }), refresh: async () => undefined };
    (kay.session as unknown as { opts: { store: Store } }).opts.store.dispatch({ type: 'prefs', prefs: { parallelRuns: 1 } });
    kay.session.submit('slow', { channel: 'ws:a' });
    await waitFor(() => kay.runs.length === 1);
    kay.session.submit('drop', { channel: 'ws:b' });
    const waiting = () => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.channel === 'ws:b' && a.status === 'queued') as Array<{ requestId: string; prompt?: string; slotWait?: unknown }>;
    await waitFor(() => waiting().length === 1);
    // Nothing runs in ws:b: its card says what it waits for, not "the current task".
    expect(waiting()[0]!.slotWait).toEqual({ running: 1, limit: 1 });
    // Still in line while it waits: it can be dropped.
    expect(kay.session.host.cancelQueued(waiting()[0]!.requestId)).toBe(true);
    kay.session.submit('now', { channel: 'ws:b' });
    await waitFor(() => waiting().length === 1 && waiting()[0]!.prompt === 'now');
    // Start now: past the limit, at once.
    expect(kay.session.host.promote(waiting()[0]!.requestId)).toBe(true);
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'did now'));
    expect(kay.runs.map((r) => r.prompt)).toEqual(['slow', 'now']);
    expect(agentItems(kay.state()).find((a) => a.type === 'agent' && a.text === 'did now')).not.toHaveProperty('slotWait');
  });

  it('a run that only waits on its background agents gives its slot back', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: (input) =>
        input.prompt === 'answer then wait'
          ? new Promise<string>((_resolve, reject) => {
              // Answered; its background agents still work (the runner offers follow-ups then).
              input.onFollowUps?.(() => false);
              input.signal.addEventListener('abort', () => reject(new Error('aborted')));
            })
          : Promise.resolve(`did ${input.prompt}`),
    });
    await room(kay);
    (kay.session.host as unknown as { deps: { workspaces: unknown } }).deps.workspaces = { place: () => ({ cwd: kay.root, additionalDirectories: [], autoEdit: false, onSession: () => undefined }), refresh: async () => undefined };
    (kay.session as unknown as { opts: { store: Store } }).opts.store.dispatch({ type: 'prefs', prefs: { parallelRuns: 1 } });
    kay.session.submit('answer then wait', { channel: 'ws:a' });
    await waitFor(() => kay.runs.length === 1);
    kay.session.submit('other', { channel: 'ws:b' });
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'did other'));
  });

  it('says what waits in the queue, and moves your waiting messages around', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: (input) =>
        input.prompt === 'slow'
          ? new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted'))))
          : Promise.resolve(`did ${input.prompt}`),
    });
    await room(kay);
    kay.session.submit('@claude slow');
    await waitFor(() => kay.runs.length === 1);
    for (const p of ['one', 'two', 'three']) kay.session.submit(`@claude ${p}`);
    const queued = () => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.status === 'queued') as Array<{ requestId: string; prompt?: string; requester?: string }>;
    await waitFor(() => queued().length === 3);
    expect(queued().map((q) => q.prompt)).toEqual(['one', 'two', 'three']);
    expect(queued()[0]!.requester).toBe(kay.session.selfId);
    const [one, , three] = queued();
    expect(kay.session.host.reorderQueued(three!.requestId, 0)).toBe(true);
    expect(queued().map((q) => q.prompt)).toEqual(['three', 'one', 'two']);
    expect(kay.session.host.reorderQueued(one!.requestId, 99)).toBe(true);
    expect(queued().map((q) => q.prompt)).toEqual(['three', 'two', 'one']);
    expect(kay.session.host.reorderQueued('nope', 0)).toBe(false);
    // The queue runs in the new order once the slow task stops.
    kay.session.host.promote(three!.requestId);
    await waitFor(() => kay.runs.length === 4);
    expect(kay.runs.map((r) => r.prompt)).toEqual(['slow', 'three', 'two', 'one']);
  });

  it("shows a friend the images you send to the room, and only them", async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    const zoe = peer('zoe');
    await room(kay, bob, zoe);
    const { publishForRoom, readAttachment, registerAttachment, roomAttachmentsDir, saveImageBytes, ATTACHMENT_SHARE } = await import('../src/core/attachments.js');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const a = registerAttachment(await saveImageBytes(png, 'png'), png.byteLength);
    const file = publishForRoom(a);
    kay.session.serveFolder(ATTACHMENT_SHARE, roomAttachmentsDir(), [bob.session.selfId]);
    const fetchVia = (p: Peer) => (at: { owner: string; share: string; path: string }, max: number) =>
      import('../src/core/downloads.js').then((d) => d.fetchBytes(at, p.session.files.request.bind(p.session.files), max));
    expect(await readAttachment(kay.session.selfId, file, kay.session.selfId, fetchVia(kay))).toEqual(png);
    expect(await readAttachment(kay.session.selfId, file, bob.session.selfId, fetchVia(bob))).toEqual(png);
    await expect(readAttachment(kay.session.selfId, file, zoe.session.selfId, fetchVia(zoe))).rejects.toThrow();
    await expect(readAttachment(kay.session.selfId, '../secret.png', bob.session.selfId, fetchVia(bob))).rejects.toThrow("isn't an image link");
  });

  it("sends your messages into a run that waits on background agents instead of queueing; others still queue", async () => {
    hub = await startHub({ keys });
    let finishAgents!: () => void;
    const kay = peer('kay', {
      policy: 'auto',
      script: (input) =>
        input.prompt === 'start jobs'
          ? new Promise((resolve) => {
              // Answered, but background agents keep the run open and it takes follow-ups.
              input.onFollowUps?.((f) => {
                setTimeout(() => f.onDone(`got ${f.prompt}`), 10);
                return true;
              });
              finishAgents = () => {
                input.onFollowUps?.(undefined);
                resolve('jobs done');
              };
            })
          : Promise.resolve(`did ${input.prompt}`),
    });
    const bob = peer('bob');
    await room(kay, bob);
    kay.session.submit('@claude start jobs');
    await waitFor(() => kay.runs.length === 1);
    kay.session.submit('@claude how is it going', { urgent: true });
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'got how is it going'));
    bob.session.submit('@claude:kay hi');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'queued'));
    expect(agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'Interrupted by a newer message')).toBe(false);
    finishAgents();
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'did hi'));
    expect(kay.runs.map((r) => r.prompt)).toEqual(['start jobs', 'hi']);
  });

  it('steers your running Claude with urgent messages instead of stopping it', async () => {
    hub = await startHub({ keys });
    let finish!: () => void;
    const steered: string[] = [];
    const kay = peer('kay', {
      script: (input) =>
        input.prompt === 'slow'
          ? new Promise((resolve, reject) => {
              input.signal.addEventListener('abort', () => reject(new Error('aborted')));
              // Claude takes the first message in mid-turn; the second gets a turn of its own.
              input.onSteer?.((f) => {
                steered.push(f.prompt);
                setTimeout(() => (steered.length === 1 ? f.onFolded?.() : (f.onStart?.(), f.onDone(`did ${f.prompt}`))), 10);
                return true;
              });
              finish = () => {
                input.onSteer?.(undefined);
                resolve('slow done');
              };
            })
          : Promise.resolve(`did ${input.prompt}`),
    });
    await room(kay);
    kay.session.submit('@claude slow');
    await waitFor(() => kay.runs.length === 1);
    kay.session.submit('@claude use pnpm', { urgent: true });
    await waitFor(() => steered.length === 1);
    kay.session.submit('@claude later');
    const queued = () => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.status === 'queued') as Array<{ requestId: string }>;
    await waitFor(() => queued().length === 1);
    expect(kay.session.host.promote(queued()[0]!.requestId)).toBe(true);
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'did later'));
    finish();
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'slow done'));
    expect(steered).toEqual(['use pnpm', 'later']);
    expect(kay.runs.map((r) => r.prompt)).toEqual(['slow']);
    // Taken in mid-turn: no turn of its own (its card only says Claude read it), and nothing was interrupted.
    expect(agentItems(kay.state()).filter((a) => a.type === 'agent').map((a) => a.text)).toEqual(['slow done', STEERED_IN, 'did later']);
  });

  it('shares folders at runtime and opens invites on demand', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    let invites = 0;
    (kay.session as unknown as { opts: { startInvite: () => void } }).opts.startInvite = () => void invites++;
    await room(kay, bob);
    kay.session.submit(`/share ${kay.root} rw`);
    await waitFor(() => bob.state().peers.find((p) => p.name === 'kay')?.shares.some((s) => s.writable && s.name === path.basename(kay.root)));
    kay.session.submit('/share /definitely/missing');
    expect(kay.toasts.at(-1)).toContain("doesn't exist");
    kay.session.submit(`/unshare ${path.basename(kay.root)}`);
    await waitFor(() => !bob.state().peers.find((p) => p.name === 'kay')?.shares.some((s) => s.name === path.basename(kay.root)));
    kay.session.submit('/share');
    kay.session.submit('/unshare');
    expect(kay.toasts).toEqual(expect.arrayContaining(['Usage: /share <folder> [rw]', 'Usage: /unshare <name>']));
    await kay.session.copyInvite();
    expect(invites).toBe(1);
    expect(kay.toasts.at(-1)).toContain('Opening a secure link');
  });

  it('keeps workspace chats private: injected events and private paths never cross over', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    const bobClient = (bob.session as unknown as { opts: { client: { send: (b: object, o?: object) => boolean } } }).opts.client;
    bobClient.send({ kind: 'agent_event', requestId: 'fake', requester: kay.session.selfId, event: 'done', text: 'injected', channel: 'ws:abc' }, { to: kay.session.selfId });
    bobClient.send({ kind: 'chat', text: 'sneaky', channel: 'ws:abc' }, { to: kay.session.selfId });
    await new Promise((r) => setTimeout(r, 200));
    expect(kay.state().log.some((l) => (l.type === 'agent' || l.type === 'chat') && l.channel === 'ws:abc')).toBe(false);
  });

  it('runs urgent messages in the order you sent them and /stop clears the queue', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: (input) =>
        input.prompt === 'slow'
          ? new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted'))))
          : // takes a moment, so the next urgent message has arrived before the queue moves on
            new Promise((resolve) => setTimeout(() => resolve(`did ${input.prompt}`), 150)),
    });
    await room(kay);
    kay.session.submit('@claude slow');
    await waitFor(() => kay.runs.length === 1);
    kay.session.submit('@claude queued');
    kay.session.submit('@claude first', { urgent: true });
    kay.session.submit('@claude second', { urgent: true });
    await waitFor(() => kay.runs.length === 4);
    expect(kay.runs.map((r) => r.prompt)).toEqual(['slow', 'first', 'second', 'queued']);
  });

  it("your own Claude doesn't ask; fully trusted friends skip every prompt; unanswered approvals expire", async () => {
    hub = await startHub({ keys });
    const bashScript: Script = async (input) => ((await input.canUseTool('Bash', { command: 'rm -rf build' })) ? 'ran' : 'blocked');
    const bob = peer('bob', { script: bashScript, approvalTimeoutMs: 300 });
    const kay = peer('kay');
    await room(bob, kay);
    bob.session.submit('@claude clean up');
    await waitFor(() => agentItems(bob.state()).some((a) => a.type === 'agent' && a.text === 'ran'));
    expect(bob.state().approvals).toHaveLength(0); // no prompt for your own request

    kay.session.submit('@claude:bob clean up');
    await waitFor(() => bob.state().approvals.length === 1); // request approval
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'denied'), 3000); // expired → declined
    expect(bob.toasts.some((t) => t.includes('expired'))).toBe(true);

    bob.session.store.dispatch({ type: 'full_trust', peerId: kay.session.selfId, trusted: true });
    kay.session.submit('@claude:bob clean up again');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'ran'));
    expect(bob.state().approvals).toHaveLength(0);
  });

  it('your own conversations reach your Claude with the room gone, and a busy Claude queues what you send', async () => {
    hub = await startHub({ keys });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const kay = peer('kay', { script: async (input) => (input.prompt === 'slow' ? (await held, 'slow done') : `did ${input.prompt}`) });
    await room(kay);
    // The room's connection drops (sleep, a network change): sends over it go nowhere.
    await hub.close();
    await waitFor(() => kay.state().status !== 'connected');
    const plan = 'ws:plan-home';
    // A workspace for it to run in (the test has no workspace manager).
    (kay.session.host as unknown as { deps: { workspaces: unknown } }).deps.workspaces = { place: () => ({ cwd: kay.root, additionalDirectories: [], autoEdit: false, onSession: () => undefined }), refresh: async () => undefined };
    kay.session.submit('slow', { channel: plan });
    await waitFor(() => kay.runs.length === 1);
    kay.session.submit('next', { channel: plan });
    const inPlan = () => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.channel === plan);
    await waitFor(() => inPlan().some((a) => a.type === 'agent' && a.prompt === 'next' && a.status === 'queued'));
    release();
    await waitFor(() => inPlan().filter((a) => a.type === 'agent' && a.status === 'done').length === 2);
    expect(kay.runs.map((r) => r.prompt)).toEqual(['slow', 'next']);
    expect(kay.state().log.filter((l) => l.type === 'chat' && l.channel === plan).map((l) => (l.type === 'chat' ? l.text : ''))).toEqual(['slow', 'next']);
  });

  it('a plan chat message reaches your Claude over a half-open room connection (KLD-66)', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', { script: async (input) => `did ${input.prompt}` });
    await room(kay);
    // Half-open: the connection still says it's up and takes sends, but nothing comes out the other end.
    const client = (kay.session as unknown as { opts: { client: { send: (b: object, o?: object) => boolean } } }).opts.client;
    const relayed: object[] = [];
    client.send = (body) => (relayed.push(body), true);
    expect(kay.state().status).toBe('connected');
    const plan = 'ws:plan-home';
    (kay.session.host as unknown as { deps: { workspaces: unknown } }).deps.workspaces = { place: () => ({ cwd: kay.root, additionalDirectories: [], autoEdit: false, onSession: () => undefined }), refresh: async () => undefined };
    // What the plan chat sends: the session says it went, and Claude answers it.
    expect(kay.session.submit('tighten the plan', { channel: plan })).toBe(true);
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.channel === plan && a.status === 'done'));
    expect(kay.runs.map((r) => r.prompt)).toEqual(['tighten the plan']);
    expect(agentItems(kay.state()).find((a) => a.type === 'agent' && a.channel === plan)).toMatchObject({ text: 'did tighten the plan' });
    // None of it went through the room.
    expect(relayed.filter((b) => 'requestId' in b)).toEqual([]);
  });

  it('a plan chat Retry of a message that went is said and asked once (KLD-69)', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', { script: async (input) => `did ${input.prompt}` });
    await room(kay);
    const plan = 'ws:plan-home';
    (kay.session.host as unknown as { deps: { workspaces: unknown } }).deps.workspaces = { place: () => ({ cwd: kay.root, additionalDirectories: [], autoEdit: false, onSession: () => undefined }), refresh: async () => undefined };
    // The first send went (said in the chat, Claude asked), but its answer never reached the screen; Retry sends it again with the same id.
    expect(kay.session.submit('tighten the plan', { channel: plan, id: 'send-1' })).toBe(true);
    expect(kay.session.submit('tighten the plan', { channel: plan, id: 'send-1' })).toBe(true);
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.channel === plan && a.status === 'done'));
    const said = () => kay.state().log.filter((l) => l.type === 'chat' && l.channel === plan).map((l) => (l.type === 'chat' ? l.text : ''));
    expect(said()).toEqual(['tighten the plan']);
    expect(kay.runs.map((r) => r.prompt)).toEqual(['tighten the plan']);
    // A new message with the same words is a new send.
    expect(kay.session.submit('tighten the plan', { channel: plan, id: 'send-2' })).toBe(true);
    expect(said()).toEqual(['tighten the plan', 'tighten the plan']);
  });
});
