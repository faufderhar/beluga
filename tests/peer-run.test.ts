import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CAPABILITIES, type Rule, decideAccess, ruleFor } from '../src/core/gateway/access.js';
import { afterEach, describe, expect, it } from 'vitest';
import { decideTool } from '../src/agent/policy.js';
import { peerRunTarget } from '../src/agent/mock.js';
import type { RoomBridge } from '../src/agent/types.js';
import { describePeers } from '../src/core/agent-bridge.js';
import { describeShellResult, keepTail, runShell, tilde } from '../src/core/peer-run.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState, type DomainState, type Policy, type ShellItem } from '../src/core/store.js';
import { canRunOn, shellGate } from '../src/core/trust.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { ShellRequestBody, ShellResultBody } from '../src/protocol.js';
import { personMenu } from '../src/ui/menus.js';
import { shellLines, shortFolder } from '../src/ui/format.js';
import { waitFor, appOf } from './helpers.js';

describe('run_on_peer gating', () => {
  it('runs with full trust, asks for trusted and ask, declines blocked', () => {
    expect(shellGate('full')).toBe('run');
    expect(shellGate('trusted')).toBe('ask');
    expect(shellGate('ask')).toBe('ask');
    expect(shellGate('blocked')).toBe('decline');
    expect(canRunOn('ask')).toBe(true);
    expect(canRunOn('blocked')).toBe(false);
    expect(canRunOn(undefined)).toBe(false);
  });

  it('refuses commands that touch secrets before they leave this computer', () => {
    const ctx = { cwd: '/p', roots: ['/p'], autoEdit: false };
    expect(decideTool('mcp__beluga__run_on_peer', { command: 'cat .env' }, ctx)).toBe('deny');
    expect(decideTool('mcp__beluga__run_on_peer', { command: 'npm test' }, ctx)).toBe('ask');
  });

  it('keeps the tail of long output and describes results for Claude', () => {
    expect(keepTail('abcdef', 3)).toEqual({ text: 'def', truncated: true });
    expect(keepTail('ab', 3)).toEqual({ text: 'ab', truncated: false });
    expect(tilde('/home/bob/api', '/home/bob')).toBe('~/api');
    expect(describeShellResult('bob', { kind: 'shell_result', reqId: 'r', ok: false, error: 'bob declined', output: '', truncated: false, timedOut: false })).toBe('bob did not run it: bob declined');
    const ok = describeShellResult('bob', { kind: 'shell_result', reqId: 'r', ok: true, exitCode: 1, output: 'boom', truncated: true, timedOut: false, cwd: '~/api', ms: 1200 });
    expect(ok).toContain("Exit code 1 after 1s on bob's computer, in ~/api.");
    expect(ok).toContain('boom');
  });

  it('validates requests on the wire (timeouts default to 2 minutes, at most 10)', () => {
    expect(ShellRequestBody.parse({ kind: 'shell_request', reqId: 'r', command: 'ls' })).toMatchObject({ timeoutSec: 120, viaAgent: false, why: '' });
    expect(ShellRequestBody.safeParse({ kind: 'shell_request', reqId: 'r', command: 'ls', timeoutSec: 601 }).success).toBe(false);
    expect(ShellRequestBody.safeParse({ kind: 'shell_request', reqId: 'r', command: '' }).success).toBe(false);
    expect(ShellResultBody.parse({ kind: 'shell_result', reqId: 'r', ok: true })).toMatchObject({ output: '', truncated: false });
  });

  it('finds who the demo Claude should run on', () => {
    expect(peerRunTarget("run the tests on bob's computer", 'kay')).toEqual({ peer: 'bob', command: 'npm test' });
    expect(peerRunTarget('check my machine with `git log -1`', 'kay')).toEqual({ peer: 'kay', command: 'git log -1' });
    expect(peerRunTarget('fix the bug', 'kay')).toBeUndefined();
  });
});

describe('runShell', () => {
  const dir = realpathSync(os.tmpdir());
  // Not on Windows: sh syntax: Windows runs these in cmd.
  it.skipIf(process.platform === 'win32')('returns output and the exit code, with no input', async () => {
    const res = await runShell('echo hi; echo err >&2; cat; exit 3', dir, 5000);
    expect(res.exitCode).toBe(3);
    expect(res.output).toContain('hi');
    expect(res.output).toContain('err');
    expect(res.timedOut).toBe(false);
  });

  it('stops commands that run too long', async () => {
    const res = await runShell('sleep 5', dir, 300);
    expect(res.timedOut).toBe(true);
    expect(res.ms).toBeLessThan(3000);
  });

  // Not on Windows: sh syntax: Windows runs these in cmd.
  it.skipIf(process.platform === 'win32')('caps output, keeping the end', async () => {
    const res = await runShell("yes x | head -c 200000; echo END", dir, 5000);
    expect(res.truncated).toBe(true);
    expect(res.output.length).toBeLessThanOrEqual(64 * 1024 + 10);
    expect(res.output.trim().endsWith('END')).toBe(true);
  });
});

describe('shell card', () => {
  it('shows the command, where it ran and the end of the output', () => {
    const item: ShellItem = { id: 's', type: 'shell', channel: 'room', ts: 0, endTs: 2000, owner: 'b', ownerName: 'bob', by: 'you', command: 'npm test', cwd: '~/api', status: 'done', exitCode: 0, output: 'one\ntwo' };
    const text = shellLines(item, 80).map((l) => l.map((s) => s.text).join(''));
    expect(text[0]).toContain('$ npm test');
    expect(text[0]).toContain("on bob's computer · ~/api · you");
    expect(text[0]).toContain('exit 0');
    expect(text.slice(1).join('\n')).toContain('two');
  });

  it('shortens long folders to their last two parts', () => {
    expect(shortFolder('~/api')).toBe('~/api');
    expect(shortFolder('/private/var/folders/sj/abc/T/klaud-demo-x/api')).toBe('…/klaud-demo-x/api');
  });
});

// ------------------------------------------------------------------ over the wire

const keys = deriveKeys(generateSecret());
let hub: Hub;
const sessions: Session[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  await hub?.close();
});

interface Peer {
  session: Session;
  state: () => DomainState;
  root: string;
  bridge: RoomBridge;
  ran: string[];
}

function peer(name: string, policy: Policy = 'ask'): Peer {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `klaud-run-${name}-`)));
  const shares = new ShareService([{ name: 'proj', root, writable: false }]);
  const store = new Store(initialState('test', policy));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name, shares: shares.infos, agent: true }, reconnect: false });
  const ran: string[] = [];
  let bridge!: RoomBridge;
  const session = new Session({
    client,
    store,
    shares,
    agentCwd: root,
    requestTimeoutMs: 2000,
    agentTimeoutMs: 2000,
    createAgent: (b) => {
      bridge = b;
      return { run: async (input) => `echo: ${input.prompt}` };
    },
    runShell: async (command, cwd, timeoutMs) => {
      ran.push(`${command} @ ${cwd}`);
      return runShell(command, cwd, timeoutMs);
    },
  });
  session.start();
  sessions.push(session);
  return { session, state: store.getState, root, ran, get bridge() { return bridge; } };
}

async function room(...peers: Peer[]): Promise<void> {
  await waitFor(() => peers.every((p) => p.state().peers.length === peers.length && p.state().self));
}

const shellItems = (s: DomainState) => s.log.filter((l): l is ShellItem => l.type === 'shell');

describe('running a command on a friend', () => {
  it("asks the friend (showing the exact command and folder), then shows the output in the asker's chat", async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    const done = kay.session.runOnPeer('bob', 'echo hello from bob');
    await waitFor(() => bob.state().approvals.length === 1);
    const approval = bob.state().approvals[0]!;
    expect(approval.title).toContain('kay');
    expect(approval.detail).toContain('$ echo hello from bob');
    expect(approval.detail).toContain('no input');
    expect(shellItems(kay.state())[0]).toMatchObject({ status: 'waiting', command: 'echo hello from bob' });
    bob.session.answerApproval('yes');
    expect(await done).toContain('hello from bob');
    expect(bob.ran[0]).toBe(`echo hello from bob @ ${bob.root}`);
    expect(shellItems(kay.state())[0]).toMatchObject({ status: 'done', exitCode: 0 });
    expect(shellItems(kay.state())[0]?.output).toContain('hello from bob');
    // A quiet notice on bob's side, in the chat and the inbox.
    expect(bob.state().log.some((l) => l.type === 'system' && l.text.includes('kay ran `echo hello from bob`'))).toBe(true);
    expect(bob.state().inbox[0]?.title).toContain('kay ran');
  });

  it('a command from an agent\'s run says so on the friend\'s card', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    const done = kay.session.runOnPeer('bob', 'echo labelled', { viaAgent: true, via: { id: 'g1', name: 'GrokBot', creationSource: 'mcp' } });
    await waitFor(() => bob.state().approvals.length === 1);
    expect(bob.state().approvals[0]!.title).toContain("kay");
    expect(bob.state().approvals[0]!.title).toContain('(via GrokBot)');
    bob.session.answerApproval('no');
    await done.catch(() => undefined);
  });

  // Not on Windows: sh syntax (sleep): Windows runs these in cmd.
  it.skipIf(process.platform === 'win32')('shows "running" once they approve, before the output arrives', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    const done = kay.session.runOnPeer('bob', 'sleep 0.6; echo late');
    await waitFor(() => bob.state().approvals.length === 1);
    expect(shellItems(kay.state())[0]?.status).toBe('waiting');
    bob.session.answerApproval('yes');
    await waitFor(() => shellItems(kay.state())[0]?.status === 'running');
    const running = shellItems(kay.state())[0]!;
    expect(running.startTs).toBeGreaterThanOrEqual(running.ts);
    expect(shellLines(running, 100).map((l) => l.map((x) => x.text).join(''))[0]).toContain('running');
    expect(await done).toContain('late');
    expect(shellItems(kay.state())[0]).toMatchObject({ status: 'done', exitCode: 0 });
  });

  it('declines when they say no, and remembers Always for this person', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    const first = kay.session.runOnPeer('bob', 'echo one');
    await waitFor(() => bob.state().approvals.length === 1);
    bob.session.answerApproval('no');
    expect(await first).toBe('bob did not run it: bob declined');
    expect(shellItems(kay.state())[0]).toMatchObject({ status: 'declined' });
    const second = kay.session.runOnPeer('bob', 'echo two');
    await waitFor(() => bob.state().approvals.length === 1);
    bob.session.answerApproval('always');
    expect(await second).toContain('two');
    expect(await kay.session.runOnPeer('bob', 'echo three')).toContain('three');
    expect(bob.state().approvals).toHaveLength(0);
  });

  it('with the app’s rules attached, Always writes a rule for that command there (not every command), and a decline rule holds', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    let rules: Rule[] = [];
    bob.session.peerRun.useAccess({
      decide: (facts, trust) => decideAccess({ trust, caps: DEFAULT_CAPABILITIES, rules, facts, now: Date.now() }),
      remember: (facts, name, d) => void (rules = [...rules, ruleFor(facts, name, d, Date.now(), `r_test${rules.length}xyz`)]),
    });
    const first = kay.session.runOnPeer('bob', 'echo one');
    await waitFor(() => bob.state().approvals.length === 1);
    expect(bob.state().approvals[0]!.detail).toContain('Always = run this command from kay in this folder');
    bob.session.answerApproval('always');
    expect(await first).toContain('one');
    expect(rules).toEqual([expect.objectContaining({ kind: 'command', command: 'echo one', folder: bob.root, decision: 'allow' })]);
    expect(await kay.session.runOnPeer('bob', 'echo one')).toContain('one');
    expect(bob.state().approvals).toHaveLength(0);
    const other = kay.session.runOnPeer('bob', 'echo two');
    await waitFor(() => bob.state().approvals.length === 1);
    bob.session.answerApproval('no');
    expect(await other).toContain('declined');
    rules = [...rules, { ...rules[0]!, id: 'r_declineall', command: undefined, decision: 'decline' }];
    expect(await kay.session.runOnPeer('bob', 'echo one')).toBe('bob did not run it: bob has a rule that declines requests like this one');
  });

  it('runs right away with full trust, in their home folder by default', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    bob.session.people.setTrust(kay.session.selfId, 'full', true);
    expect(await kay.session.runOnPeer('bob', 'echo fast', { viaAgent: true })).toContain('fast');
    expect(bob.ran[0]).toBe(`echo fast @ ${realpathSync(os.homedir())}`);
    expect(bob.state().log.some((l) => l.type === 'system' && l.text.includes("kay's agent ran `echo fast`"))).toBe(true);
  });

  it('declines blocked people and commands that touch secrets, without asking', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    expect(await kay.session.runOnPeer('bob', 'cat ~/.ssh/id_rsa')).toContain('never runs commands that touch secrets');
    bob.session.people.setTrust(kay.session.selfId, 'blocked', true);
    expect(await kay.session.runOnPeer('bob', 'echo hi')).toContain('declined');
    expect(bob.state().approvals).toHaveLength(0);
    expect(bob.ran).toHaveLength(0);
    await expect(kay.session.runOnPeer('nobody', 'ls')).rejects.toThrow(/No friend named/);
  });

  it('tells friends how much you trust them, for the person menu and list_peers', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    await waitFor(() => kay.state().granted[bob.session.selfId]?.level === 'ask');
    bob.session.people.setTrust(kay.session.selfId, 'full', true);
    await waitFor(() => kay.state().granted[bob.session.selfId]?.level === 'full');
    const bobIndex = kay.state().peers.findIndex((p) => p.name === 'bob');
    const menu = personMenu(appOf(kay.state()), bobIndex)!;
    expect(menu.intro).toContain('bob lets your agent: anything, without asking');
    expect(menu.options.some((o) => o.id === 'person-run' && o.label === "Run a command on bob's computer…")).toBe(true);
    const bobSeen = describePeers(kay.session).find((p) => p.name === 'bob');
    expect(bobSeen).toMatchObject({ shares: ['proj'], lets_you: { trust: 'full' } });
    bob.session.people.setTrust(kay.session.selfId, 'blocked', true);
    await waitFor(() => kay.state().granted[bob.session.selfId]?.level === 'blocked');
    expect(personMenu(appOf(kay.state()), bobIndex)!.options.some((o) => o.id === 'person-run')).toBe(false);
  });

  it('/run @bob <command> runs it exactly as typed', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    bob.session.people.setTrust(kay.session.selfId, 'full', true);
    kay.session.submit('/run @bob echo "a  b"');
    await waitFor(() => shellItems(kay.state())[0]?.status === 'done');
    expect(shellItems(kay.state())[0]?.output).toContain('a  b');
  });

  it("ask_agent can name a project; a project that doesn't exist is declined", async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    await expect(kay.bridge.askAgent('bob', 'look', 'nope')).rejects.toThrow(/no project called nope/);
  });
});
