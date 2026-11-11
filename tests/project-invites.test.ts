import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBackend } from '../src/agent/types.js';
import { toolInside } from '../src/core/agent-host.js';
import { completions, lsLines, parseCommand, resolvePath } from '../src/core/guest-shell.js';
import { searchShare } from '../src/core/guest-search.js';
import { DAY_MS, contactsFor, guestSummary, linkUsable, roleFor, trustFor, withSecret } from '../src/core/project-invites.js';
import { Session, type RoomControl } from '../src/core/session.js';
import { guestMayDo } from '../src/core/shared-diff.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { createDemoWorkspaces } from '../src/demo.js';
import { deriveKeys, generateIdentity, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import type { WorkspaceManager } from '../src/workspaces/manager.js';
import { waitFor, attach } from './helpers.js';

describe('project links (pure parts)', () => {
  it('single-use and expiring links stop working', () => {
    expect(linkUsable({ singleUse: true, used: 0 }, 0)).toBe(true);
    expect(linkUsable({ singleUse: true, used: 1 }, 0)).toBe(false);
    expect(linkUsable({ singleUse: false, used: 5, expiresAt: DAY_MS }, DAY_MS - 1)).toBe(true);
    expect(linkUsable({ singleUse: false, used: 0, expiresAt: DAY_MS }, DAY_MS)).toBe(false);
  });

  it('swaps only the secret of the room link', () => {
    expect(withSecret('klaud://abc?relay=https://x.trycloudflare.com#roomsecret123456', 'projsecret1234567')).toBe('klaud://abc?relay=https://x.trycloudflare.com#projsecret1234567');
  });

  it('maps what a guest can do to roles and trust', () => {
    expect(roleFor('watch')).toBe('view');
    expect(roleFor('prompt')).toBe('contribute');
    expect(trustFor('watch')).toBe('blocked');
    expect(trustFor('prompt')).toBe('ask');
    expect(guestSummary({ peerId: 'm', name: 'mia', projects: ['p1'], room: false, can: 'prompt' }, () => 'bob-api')).toBe('bob-api · can prompt');
    expect(guestSummary({ peerId: 'm', name: 'mia', projects: [], room: true, can: 'watch' }, () => '')).toBe('everything · can watch');
  });

  it('contacts are the people a guest shares a workspace with', () => {
    expect(contactsFor('mia', { w1: { mia: 'view', bob: 'contribute' }, w2: { zed: 'view' } }).sort()).toEqual(['bob']);
  });

  it('guests only reach their workspaces and private folders', () => {
    const shares = { isPrivate: (name: string) => name.startsWith('ws-') };
    expect(guestMayDo({ kind: 'chat', text: 'hi', byAgent: false, channel: 'room' }, shares)).toBe(false);
    expect(guestMayDo({ kind: 'chat', text: 'hi', byAgent: false, channel: 'ws:abc' }, shares)).toBe(true);
    expect(guestMayDo({ kind: 'fs_list', reqId: 'r', share: 'landing', path: '' }, shares)).toBe(false);
    expect(guestMayDo({ kind: 'fs_list', reqId: 'r', share: 'ws-abc', path: '' }, shares)).toBe(true);
    expect(guestMayDo({ kind: 'file_request', reqId: 'r', path: '/etc/passwd', why: '' }, shares)).toBe(false);
    expect(guestMayDo({ kind: 'ws_request', reqId: 'r', project: 'x', task: 'y', plan: false }, shares)).toBe(false);
  });

  it('edit-level tools stay inside the project folder', () => {
    expect(toolInside('Edit', { file_path: 'src/a.ts' }, '/p')).toBe(true);
    expect(toolInside('Write', { file_path: '/etc/hosts' }, '/p')).toBe(false);
    expect(toolInside('Read', { file_path: '/p/../q/x' }, '/p')).toBe(false);
    // Commands can reach anywhere whatever their arguments look like: they always ask.
    expect(toolInside('Bash', { command: 'npm test' }, '/p')).toBe(false);
    expect(toolInside('Bash', { command: 'cat src/../../../../Users/kay/.zsh_history' }, '/p')).toBe(false);
    // So do tools without a file: the web, room tools, sub-agents.
    for (const tool of ['WebFetch', 'Task', 'mcp__beluga__run_on_peer', 'mcp__beluga__ask_agent', 'mcp__beluga__get_peer_file']) expect(toolInside(tool, {}, '/p'), tool).toBe(false);
    expect(toolInside('Grep', { pattern: 'x', path: 'src' }, '/p')).toBe(true);
    expect(toolInside('Bash', { command: 'cat ~/.zshrc' }, '/p')).toBe(false);
    expect(toolInside('Bash', { command: 'ls ../other' }, '/p')).toBe(false);
    expect(toolInside('Bash', { command: 'rm -rf /etc' }, '/p')).toBe(false);
    expect(toolInside('Bash', { command: 'rm -rf $HOME' }, '/p')).toBe(false);
    expect(toolInside('Bash', { command: 'curl https://example.com' }, '/p')).toBe(false);
  });
});

describe('the virtual shell (pure parts)', () => {
  it('parses words and quotes', () => {
    expect(parseCommand('cat "my file.md"')).toEqual({ name: 'cat', args: ['my file.md'] });
    expect(parseCommand('  LS  src ')).toEqual({ name: 'ls', args: ['src'] });
  });

  it('resolves paths and never goes above the top', () => {
    expect(resolvePath('src/lib', '..')).toBe('src');
    expect(resolvePath('src', '../../..')).toBe('');
    expect(resolvePath('src', '/design')).toBe('design');
    expect(resolvePath('src', '~/a/./b')).toBe('a/b');
    expect(resolvePath('src', undefined)).toBe('src');
  });

  it('lists folders first, each one clickable', () => {
    const lines = lsLines('src', [{ name: 'b.ts', dir: false, size: 3 }, { name: 'lib', dir: true, size: 0 }]);
    expect(lines.map((l) => l.text)).toEqual(['lib/', 'b.ts']);
    expect(lines[0]).toMatchObject({ open: 'src/lib', dir: true });
  });

  it('completes commands and names', () => {
    expect(completions('tr', '', () => undefined).map((c) => c.value)).toEqual(['tree ']);
    const listing = (dir: string) => (dir === 'src' ? [{ name: 'server.ts', dir: false, size: 1 }, { name: 'shared', dir: true, size: 0 }] : undefined);
    expect(completions('cat src/se', '', listing).map((c) => c.value)).toEqual(['cat src/server.ts']);
    expect(completions('cd s', 'src', () => listing('src')).map((c) => c.value)).toEqual(['cd shared/']);
  });

  it('searches inside the share only, skipping secrets', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-search-')));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'auth.ts'), 'export const TODO = 1; // TODO auth\n');
    writeFileSync(path.join(root, '.env'), 'TODO=secret\n');
    const share = { name: 'ws-x', root, writable: false, private: true };
    const grep = await searchShare(share, '', 'grep', 'todo');
    expect(grep.hits.map((h) => h.path)).toEqual(['src/auth.ts']);
    expect((await searchShare(share, '', 'find', 'auth')).hits.map((h) => h.path)).toEqual(['src/auth.ts']);
    await expect(searchShare(share, '../', 'find', 'x')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- end to end

const roomSecret = generateSecret();
const roomKeys = deriveKeys(roomSecret);
const HOST = generateIdentity();
let hub: Hub;
const sessions: Session[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  await hub?.close();
});

function person(name: string, opts: { host?: boolean; workspaces?: WorkspaceManager; secret?: string } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `klaud-${name}-`)));
  const shares = new ShareService([{ name: 'proj', root, writable: false }]);
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys: opts.secret ? deriveKeys(opts.secret) : roomKeys, profile: { name, shares: shares.infos, agent: true }, reconnect: false, ...(opts.host ? { identity: HOST } : {}) });
  const room: RoomControl | undefined = opts.host
    ? {
        removePerson: (id) => hub.kick(id),
        newInvite: () => undefined,
        setOpen: (open) => hub.setOpen(open),
        clearHistory: () => hub.clearHistory(),
        guests: { setGate: (g) => hub.setGuestGate(g), setAccess: (p, a) => hub.setGuestAccess(p, a), turnAway: (p) => void hub.dismiss(p, 'not this time') },
      }
    : undefined;
  const session = new Session({
    client,
    store,
    shares,
    agentCwd: root,
    requestTimeoutMs: 3000,
    copy: async () => undefined,
    zoom: async () => ({ ok: true, message: '' }),
    ...(opts.workspaces ? { workspaces: opts.workspaces } : {}),
    ...(room ? { room } : {}),
    createAgent: (): AgentBackend => ({ run: async (input) => `echo: ${input.prompt}` }),
  });
  session.start();
  sessions.push(session);
  const screen = attach(session);
  return { session, state: store.getState, store, screen };
}

describe('inviting someone into one project by link', () => {
  it('knocks, lets them into the project only, and keeps the rest of the room away', async () => {
    hub = await startHub({ keys: roomKeys, hostId: HOST.peerId, roomName: "kay's room" });
    const workspaces = await createDemoWorkspaces();
    const kay = person('kay', { host: true, workspaces });
    await kay.session.workspaces?.refresh();
    const bob = person('bob');
    await waitFor(() => kay.state().peers.length === 2 && bob.state().peers.length === 2);
    kay.store.dispatch({ type: 'invite', invite: `https://calm.trycloudflare.com#${roomSecret}` });
    const project = kay.state().projects.find((p) => p.name === 'bob-api');
    expect(project).toBeDefined();
    const link = await kay.session.invites.create({ scope: project!.id, can: 'prompt', knock: true, singleUse: true, expiresInMs: DAY_MS });
    const secret = kay.session.invites.urlOf(link!.id)!.split('#')[1]!;

    const mia = person('mia', { secret });
    // At the door: mia sees only the host (no shares), and kay gets a knock card.
    await waitFor(() => kay.state().knocks.length === 1 && mia.state().self);
    expect(mia.state().peers.map((p) => p.name).sort()).toEqual(['kay', 'mia']);
    expect(mia.state().peers.find((p) => p.name === 'kay')?.shares).toEqual([]);
    expect(kay.state().trustPrompts).not.toContain(mia.session.selfId);

    // The room chat never reaches her, and hers never reaches the room.
    bob.session.sendChat('secret room plans', false);
    mia.session.sendChat('hello room', false);
    await waitFor(() => kay.state().log.some((l) => l.type === 'chat' && l.text === 'secret room plans'));

    kay.session.invites.letIn(mia.session.selfId);
    const count = project!.workspaces.filter((w) => !w.archived).length;
    await waitFor(() => mia.state().shared.length === count);
    expect(mia.screen.store.getState().view.kind).toBe('shared');
    expect(mia.state().log.some((l) => l.type === 'chat' && l.text === 'secret room plans')).toBe(false);
    expect(kay.state().log.some((l) => l.type === 'chat' && l.text === 'hello room')).toBe(false);
    expect(kay.state().guests[mia.session.selfId]).toMatchObject({ can: 'prompt', room: false });

    // Files stream on demand; folders shared with the room stay out of reach.
    const ws = mia.state().shared[0]!;
    const entries = await mia.session.listFiles({ owner: ws.owner, share: ws.share, path: '' });
    expect(entries.some((e) => e.name === 'README.md')).toBe(true);
    await expect(mia.session.listFiles({ owner: ws.owner, share: 'proj', path: '' })).rejects.toThrow();

    // The shell: ls, cd, grep (bounded, on kay's side).
    await mia.session.shell.run(ws.id, 'cd src');
    await mia.session.shell.run(ws.id, 'grep express');
    const out = mia.state().shells[ws.id]!.entries.at(-1)!.out;
    expect(mia.state().shells[ws.id]!.cwd).toBe('src');
    expect(out.some((l) => l.text.startsWith('src/server.ts:1:'))).toBe(true);

    // The diff, read-only.
    const auth = mia.state().shared.find((w) => w.name === 'add-auth')!;
    await mia.session.diff.load(auth.id);
    await waitFor(() => mia.state().review?.diff);
    expect(mia.state().review?.data?.files.map((f) => f.path)).toContain('src/auth.ts');

    // The link was single-use: a second person is turned away at the door.
    const zed = person('zed', { secret });
    await waitFor(() => zed.state().log.some((l) => l.type === 'system' && /expired|used|turned off/.test(l.text)));
  }, process.platform === 'win32' ? 120_000 : 20_000); // the demo's repositories are made with real git: 22-40 s on Windows' runners, and past 60 s on a busy one

  it('decline turns them away; invite to everything makes them a member', async () => {
    hub = await startHub({ keys: roomKeys, hostId: HOST.peerId });
    const kay = person('kay', { host: true });
    await waitFor(() => kay.state().self);
    kay.store.dispatch({ type: 'invite', invite: `https://calm.trycloudflare.com#${roomSecret}` });
    const link = await kay.session.invites.create({ scope: 'room', can: 'watch', knock: true, singleUse: false, expiresInMs: 0 });
    const secret = kay.session.invites.urlOf(link!.id)!.split('#')[1]!;
    const ann = person('ann', { secret });
    await waitFor(() => kay.state().knocks.length === 1);
    kay.session.invites.decline(ann.session.selfId);
    await waitFor(() => ann.state().log.some((l) => l.type === 'system' && l.text.includes('not this time')));

    const bea = person('bea', { secret });
    await waitFor(() => kay.state().knocks.some((k) => k.peerId === bea.session.selfId));
    kay.session.invites.letIn(bea.session.selfId);
    await waitFor(() => bea.state().peers.find((p) => p.peerId === bea.session.selfId && !p.guest));
    expect(bea.state().peers.find((p) => p.name === 'kay')?.shares.map((s) => s.name)).toEqual(['proj']);
    kay.session.sendChat('welcome bea', false);
    await waitFor(() => bea.state().log.some((l) => l.type === 'chat' && l.text === 'welcome bea'));
  }, 15_000);
});
