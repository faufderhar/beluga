import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { expandPath, handoffNotePrompt, handoffProblem } from '../src/core/remote-work.js';
import { HANDOFF_FILE } from '../src/core/handoff-note.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { waitFor, attach } from './helpers.js';

const keys = deriveKeys(generateSecret());
let hub: Hub;
let base: string;
const sessions: Session[] = [];
const home = process.env.BELUGA_HOME;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-remote-')));
  process.env.BELUGA_HOME = path.join(base, 'klaud-home');
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  await hub?.close();
  process.env.BELUGA_HOME = home;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

/** A shared origin and one clone of it per person (as if each cloned the project). */
function repos(...names: string[]): Record<string, string> {
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  const seed = path.join(base, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  writeFileSync(path.join(seed, 'README.md'), '# app\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'main');
  const out: Record<string, string> = {};
  for (const name of names) {
    const dir = path.join(base, name, 'code', 'app');
    mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'pipe' });
    git(dir, 'remote', 'set-head', 'origin', 'main');
    // Beluga commits with plain `git commit`; keep this machine's signing setup out of the test.
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'user.email', `${name}@test`);
    git(dir, 'config', 'user.name', name);
    out[name] = dir;
  }
  return out;
}

type Script = (input: AgentRunInput) => Promise<string>;

async function person(name: string, opts: { repo?: string; script?: Script } = {}) {
  const root = realpathSync(mkdtempSync(path.join(base, `${name}-share-`)));
  const shares = new ShareService([]);
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name, shares: shares.infos, agent: true }, reconnect: false });
  const runs: AgentRunInput[] = [];
  let workspaces: WorkspaceManager | undefined;
  if (opts.repo) {
    const wsStore = new WorkspaceStore(path.join(base, name, 'home'));
    wsStore.saveConfig({ roots: [], projects: [opts.repo], hidden: [] });
    workspaces = new WorkspaceManager(wsStore);
    await workspaces.refresh();
  }
  const session = new Session({
    client,
    store,
    shares,
    agentCwd: root,
    requestTimeoutMs: 4000,
    agentTimeoutMs: 4000,
    downloadDir: path.join(base, name, 'Downloads'),
    zoom: async () => ({ ok: true, message: '' }),
    copy: async () => undefined,
    hasGh: async () => false,
    ...(workspaces ? { workspaces } : {}),
    createAgent: (): AgentBackend => ({
      run: async (input) => {
        runs.push(input);
        return opts.script ? opts.script(input) : `echo: ${input.prompt}`;
      },
    }),
  });
  session.start();
  sessions.push(session);
  const screen = attach(session);
  return { session, state: store.getState, screen, runs, workspaces, id: () => session.selfId };
}

type Person = Awaited<ReturnType<typeof person>>;
const together = (...people: Person[]) => waitFor(() => people.every((p) => p.state().peers.length === people.length && p.state().self), 4000);
const approve = async (p: Person, answer: 'yes' | 'no' = 'yes'): Promise<string> => {
  await waitFor(() => p.state().approvals.length > 0, 4000);
  const title = p.state().approvals[0]!.title;
  p.session.answerApproval(answer);
  return title;
};

describe('approvals', () => {
  it('lets one person have only a few requests waiting for you at once', async () => {
    hub = await startHub({ keys });
    const kay = await person('kay');
    const bob = await person('bob');
    await together(kay, bob);
    for (const f of ['a', 'b', 'c', 'd', 'e']) writeFileSync(path.join(base, `${f}.txt`), f);
    // Which three get a slot depends on which request bob's Mac reaches first (each looks its path up
    // before it asks), so: any two of the five are declined at once, the other three wait for bob.
    const answered: string[] = [];
    for (const f of ['a', 'b', 'c', 'd', 'e']) void kay.session.remote.getFile(bob.id(), path.join(base, `${f}.txt`)).catch((e: Error) => void answered.push(e.message));
    await waitFor(() => bob.state().approvals.length === 3 && answered.length === 2, 10_000);
    expect(answered).toEqual(['bob declined', 'bob declined']);
    expect(bob.state().approvals).toHaveLength(3);
    for (let i = 0; i < 3; i++) bob.session.answerApproval('no');
  });
});

describe('files between computers', () => {
  it('gets a file from anywhere on a friend’s computer once they approve', async () => {
    hub = await startHub({ keys });
    const kay = await person('kay');
    const bob = await person('bob');
    await together(kay, bob);
    const file = path.join(base, 'bob-desktop', 'report.txt');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'quarterly numbers');

    const saved = kay.session.remote.getFile(bob.id(), file, path.join(base, 'kay-desktop'), 'for the review');
    expect(await approve(bob)).toMatch(/^kay \(#[\w-]{6}\) wants a file from your computer$/);
    expect(readFileSync(await saved, 'utf8')).toBe('quarterly numbers');
    expect(path.dirname(await saved)).toBe(path.join(base, 'kay-desktop'));
  });

  it('never sends secrets, and declines for people you blocked', async () => {
    hub = await startHub({ keys });
    const kay = await person('kay');
    const bob = await person('bob');
    await together(kay, bob);
    const env = path.join(base, '.env');
    writeFileSync(env, 'TOKEN=1');
    await expect(kay.session.remote.getFile(bob.id(), env)).rejects.toThrow(/secrets/);
    // Whether a file exists is only revealed after bob says yes.
    const missing = kay.session.remote.getFile(bob.id(), path.join(base, 'nope.txt'));
    await approve(bob);
    await expect(missing).rejects.toThrow(/no file/);
    // Beluga's own key and settings never leave, whatever the trust.
    bob.session.people.setTrust(kay.id(), 'full', true);
    await expect(kay.session.remote.getFile(bob.id(), path.join(process.env.BELUGA_HOME!, 'identity.json'))).rejects.toThrow(/secrets/);
    // A link with a harmless name pointing at a secret is caught too.
    symlinkSync(env, path.join(base, 'notes.txt'));
    await expect(kay.session.remote.getFile(bob.id(), path.join(base, 'notes.txt'))).rejects.toThrow(/secrets/);
    bob.session.people.setTrust(kay.id(), 'blocked', true);
    writeFileSync(path.join(base, 'ok.txt'), 'x');
    await expect(kay.session.remote.getFile(bob.id(), path.join(base, 'ok.txt'))).rejects.toThrow(/declined/);
  });

  it('skips the question for people you fully trust', async () => {
    hub = await startHub({ keys });
    const kay = await person('kay');
    const bob = await person('bob');
    await together(kay, bob);
    bob.session.people.setTrust(kay.id(), 'full', true);
    writeFileSync(path.join(base, 'notes.md'), 'hi');
    const saved = await kay.session.remote.getFile(bob.id(), path.join(base, 'notes.md'));
    expect(readFileSync(saved, 'utf8')).toBe('hi');
    expect(saved).toContain(path.join('kay', 'Downloads', 'bob'));
    expect(bob.state().approvals).toHaveLength(0);
  });

  it('sends a file back, saved automatically when you were waiting on that person', async () => {
    hub = await startHub({ keys });
    const kay = await person('kay');
    const bob = await person('bob');
    await together(kay, bob);
    const out = path.join(base, 'result.csv');
    writeFileSync(out, 'a,b\n1,2\n');
    // Without asking for it, kay approves what bob sends.
    await bob.session.remote.sendFile(kay.id(), out, 'here you go');
    expect(await approve(kay)).toMatch(/^bob \(#[\w-]{6}\) sends you a file$/);
    const first = path.join(base, 'kay', 'Downloads', 'bob', 'result.csv');
    await waitFor(() => existsSync(first), 4000);
    // While kay's Claude works with bob's, what bob sends just arrives.
    kay.session.remote.expectFrom(bob.id());
    await bob.session.remote.sendFile(kay.id(), out);
    await waitFor(() => existsSync(path.join(base, 'kay', 'Downloads', 'bob', 'result (1).csv')), 4000);
    expect(kay.state().approvals).toHaveLength(0);
    expect(kay.state().inbox.some((n) => n.title.startsWith('bob sent you'))).toBe(true);
  });

  // Not on Windows: POSIX paths in the fixtures.
  it.skipIf(process.platform === 'win32')('expands ~ and relative paths to the home folder', () => {
    expect(expandPath('~/Desktop/a.pdf', '/Users/x')).toBe('/Users/x/Desktop/a.pdf');
    expect(expandPath('~', '/Users/x')).toBe('/Users/x');
    expect(expandPath('Desktop/a.pdf', '/Users/x')).toBe('/Users/x/Desktop/a.pdf');
    expect(expandPath('/tmp/../etc/hosts', '/Users/x')).toBe('/etc/hosts');
  });
});

describe('work on a friend’s computer', () => {
  it('starts a worktree on their computer for your task, with you in it', async () => {
    hub = await startHub({ keys });
    const dirs = repos('bob');
    const kay = await person('kay');
    const bob = await person('bob', { repo: dirs.bob });
    await together(kay, bob);
    // bob offers his projects (names only) to the room.
    await waitFor(() => kay.state().peers.find((p) => p.name === 'bob')?.projects?.includes('app'), 4000);

    const asked = kay.session.remote.requestWorktree(bob.id(), 'app', 'add a health check endpoint');
    expect(await approve(bob)).toMatch(/^kay \(#[\w-]{6}\) wants to start a worktree in app on your computer$/);
    await asked;
    await waitFor(() => bob.runs.length === 1, 4000);
    expect(bob.runs[0]).toMatchObject({ prompt: 'add a health check endpoint', requesterName: 'kay' });
    const ws = bob.workspaces!.list.flatMap((p) => p.workspaces).find((w) => w.kind === 'worktree');
    expect(ws?.branch).toMatch(/^beluga\/add-.*health-check/);
    // kay is in it (SHARED WITH ME), and her screen opened it.
    await waitFor(() => kay.state().shared.some((w) => w.id === ws?.id), 4000);
    await waitFor(() => kay.screen.store.getState().view.kind === 'shared', 4000);
    await waitFor(() => kay.state().log.some((l) => l.type === 'agent' && l.channel === `ws:${ws?.id}` && l.status === 'done'), 4000);
  });

  it('says why when they turned it off or decline', async () => {
    hub = await startHub({ keys });
    const dirs = repos('bob');
    const kay = await person('kay');
    const bob = await person('bob', { repo: dirs.bob });
    await together(kay, bob);
    const toasts: string[] = [];
    kay.screen.store.subscribe(() => {
      const t = kay.screen.store.getState().toast?.text;
      if (t && toasts.at(-1) !== t) toasts.push(t);
    });
    const declined = kay.session.remote.requestWorktree(bob.id(), 'app', 'x');
    await approve(bob, 'no');
    await declined;
    expect(toasts.at(-1)).toContain("didn't start it: declined");
    bob.session.setFriendWorktrees('off');
    await kay.session.remote.requestWorktree(bob.id(), 'app', 'x');
    expect(toasts.at(-1)).toContain('turned off work from friends');
    bob.session.setFriendWorktrees('ask');
    await kay.session.remote.requestWorktree(bob.id(), 'nope', 'x');
    expect(toasts.at(-1)).toContain('no project called nope');
  });
});

describe('handoff', () => {
  it('hands a worktree to a friend: their branch, the note and the chat; their Claude continues', async () => {
    hub = await startHub({ keys });
    const dirs = repos('kay', 'bob');
    const note = '## Handoff\n- [x] session check\n- [ ] expired sessions test';
    const kay = await person('kay', { repo: dirs.kay, script: async (input) => (input.prompt.includes('handoff note') ? note : 'ok') });
    const bob = await person('bob', { repo: dirs.bob });
    writeFileSync(path.join(dirs.bob!, '.env'), 'STRIPE_KEY=secret\n');
    await together(kay, bob);
    const ws = await kay.workspaces!.createWorktree(kay.workspaces!.list.find((p) => p.root)!.id, 'add-auth');
    writeFileSync(path.join(ws.path, 'auth.ts'), 'export const requireUser = () => true;\n');
    git(ws.path, 'add', '.');
    git(ws.path, 'commit', '-m', 'add requireUser');
    writeFileSync(path.join(ws.path, 'wip.ts'), '// half done\n');
    await kay.session.workspaces!.refresh();

    expect(await kay.session.remote.handoff(ws.id, bob.id())).toBe(true);
    expect(kay.runs[0]?.prompt).toBe(handoffNotePrompt('bob'));
    expect(await approve(bob)).toMatch(/^kay \(#[\w-]{6}\) wants to hand add-auth \(app\) over to you$/);
    await waitFor(() => bob.runs.length === 1, 6000);
    expect(bob.runs[0]?.prompt).toContain('taking over this work from kay');
    expect(bob.runs[0]?.prompt).toContain('expired sessions test');
    const theirs = bob.workspaces!.list.flatMap((p) => p.workspaces).find((w) => w.kind === 'worktree');
    expect(theirs?.handedFrom).toBe('kay');
    // The committed work and the work in progress both came over.
    expect(readFileSync(path.join(theirs!.path, 'auth.ts'), 'utf8')).toContain('requireUser');
    expect(readFileSync(path.join(theirs!.path, 'wip.ts'), 'utf8')).toContain('half done');
    expect(bob.workspaces!.loadHistory<{ text: string }>(theirs!.id).some((l) => l.text.includes('Their note'))).toBe(true);
    // The note comes as a file in their Scratch too (BLG-967), never in the branch.
    expect(readFileSync(path.join(theirs!.path, HANDOFF_FILE), 'utf8')).toMatch(/^# Handoff: add-auth\n\n_From kay for bob, \d{4}-\d\d-\d\d_\n\n## Handoff\n- \[x\] session check/);
    expect(git(theirs!.path, 'ls-files')).not.toContain('HANDOFF.md');
    // bob doesn't fully trust kay: his .env stays out of her branch, setup waits for him, and her
    // note runs with what kay may do on bob's computer (not as bob himself).
    expect(existsSync(path.join(theirs!.path, '.env'))).toBe(false);
    expect(bob.workspaces!.loadHistory<{ text: string }>(theirs!.id).some((l) => l.text.includes("Setup didn't run"))).toBe(true);
    expect(bob.runs[0]?.requesterName).toBe('kay');
    expect(bob.runs[0]?.scope).toBe('folder');
    // kay hears back, and can follow along.
    await waitFor(() => kay.workspaces!.find(ws.id)?.handedTo === 'bob', 4000);
    await waitFor(() => kay.state().shared.some((w) => w.id === theirs?.id), 4000);
  });

  // A name you give is up to 200 characters; the handoff carries at most 80 (what older peers accept).
  it('offers a worktree with a long name: the friend gets it cut to 80, yours stays whole', async () => {
    hub = await startHub({ keys });
    const dirs = repos('kay', 'bob');
    const kay = await person('kay', { repo: dirs.kay, script: async () => 'note' });
    const bob = await person('bob', { repo: dirs.bob });
    await together(kay, bob);
    const ws = await kay.workspaces!.createWorktree(kay.workspaces!.list.find((p) => p.root)!.id, 'feature');
    const long = 'x'.repeat(81);
    kay.workspaces!.rename(ws.id, long);
    await kay.session.workspaces!.refresh();

    expect(await kay.session.remote.handoff(ws.id, bob.id())).toBe(true);
    expect(await approve(bob)).toContain(`hand ${long.slice(0, 80)} (app)`);
    expect(kay.workspaces!.find(ws.id)?.name).toBe(long);
  });

  /** bob with a different repository than kay's. */
  function otherRepo(): string {
    const other = path.join(base, 'bob', 'code', 'other');
    mkdirSync(other, { recursive: true });
    git(other, 'init', '-b', 'main');
    writeFileSync(path.join(other, 'x'), 'x');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'x');
    return other;
  }

  it('checks the friend has the repository before writing a note, committing or asking them (BLG-614)', async () => {
    hub = await startHub({ keys });
    const dirs = repos('kay');
    const kay = await person('kay', { repo: dirs.kay, script: async () => 'note' });
    const bob = await person('bob', { repo: otherRepo() });
    await together(kay, bob);
    const ws = await kay.workspaces!.createWorktree(kay.workspaces!.list.find((p) => p.root)!.id, 'feature');
    writeFileSync(path.join(ws.path, 'wip.ts'), '// half done\n');
    const toasts: string[] = [];
    kay.screen.store.subscribe(() => {
      const t = kay.screen.store.getState().toast?.text;
      if (t && toasts.at(-1) !== t) toasts.push(t);
    });

    expect(await kay.session.remote.canHandOff(ws.id, bob.id())).toEqual({ ok: false, why: expect.stringMatching(/^bob doesn't have app on their Mac\. Ask them to clone .*origin\.git and add it to Beluga/) });
    expect(await kay.session.remote.handoff(ws.id, bob.id())).toBe(false);
    // Nothing happened: no note, no WIP commit, nothing for bob to approve.
    expect(kay.runs).toHaveLength(0);
    expect(git(ws.path, 'status', '--porcelain')).toContain('wip.ts');
    expect(bob.state().approvals).toHaveLength(0);
    expect(toasts.at(-1)).toMatch(/^bob doesn't have app on their Mac/);
    expect(kay.state().log.some((l) => l.type === 'system' && l.text.startsWith("Not handed off: bob doesn't have app"))).toBe(true);
    expect(kay.workspaces!.find(ws.id)?.handedTo).toBeUndefined();
  });

  it('says when the friend turned off work from friends, and when they can take it', async () => {
    hub = await startHub({ keys });
    const dirs = repos('kay', 'bob');
    const kay = await person('kay', { repo: dirs.kay });
    const bob = await person('bob', { repo: dirs.bob });
    await together(kay, bob);
    const ws = await kay.workspaces!.createWorktree(kay.workspaces!.list.find((p) => p.root)!.id, 'feature');
    expect(await kay.session.remote.canHandOff(ws.id, bob.id())).toEqual({ ok: true });
    bob.session.setFriendWorktrees('off');
    expect((await kay.session.remote.canHandOff(ws.id, bob.id())).why).toMatch(/^bob has turned off work from friends/);
  });

  it('tells you plainly when they said no', async () => {
    hub = await startHub({ keys });
    const dirs = repos('kay', 'bob');
    const kay = await person('kay', { repo: dirs.kay, script: async () => 'note' });
    const bob = await person('bob', { repo: dirs.bob });
    await together(kay, bob);
    const ws = await kay.workspaces!.createWorktree(kay.workspaces!.list.find((p) => p.root)!.id, 'feature');
    expect(await kay.session.remote.handoff(ws.id, bob.id())).toBe(true);
    await approve(bob, 'no');
    await waitFor(() => kay.state().log.some((l) => l.type === 'system' && l.text === 'Not handed off: bob said no to taking it over.'), 4000);
    expect(kay.workspaces!.find(ws.id)?.handedTo).toBeUndefined();
  });

  it('an offer from a Beluga that skipped the check never asks you to approve what you cannot take', async () => {
    hub = await startHub({ keys });
    const dirs = repos('kay');
    const kay = await person('kay', { repo: dirs.kay });
    const bob = await person('bob', { repo: otherRepo() });
    await together(kay, bob);
    const toasts: string[] = [];
    bob.screen.store.subscribe(() => {
      const t = bob.screen.store.getState().toast?.text;
      if (t && toasts.at(-1) !== t) toasts.push(t);
    });
    const remote = path.join(base, 'origin.git');
    kay.session.send({ kind: 'ws_handoff', hid: 'old-beluga', ws: { name: 'feature', project: 'app', branch: 'feature', base: 'origin/main' }, remote, note: 'n', history: [] }, { to: bob.id() });
    await waitFor(() => toasts.some((t) => t.startsWith("kay wanted to hand you feature, but you don't have app here")), 4000);
    expect(bob.state().approvals).toHaveLength(0);
  });

  it('turns every reason into words, older Belugas\' too', () => {
    const what = { who: 'bob', project: 'app', remote: 'git@github.com:k/app.git' };
    expect(handoffProblem('no_repo', undefined, what)).toBe("bob doesn't have app on their Mac. Ask them to clone git@github.com:k/app.git and add it to Beluga, then hand it off again");
    expect(handoffProblem('bad_branch', undefined, what)).toMatch(/didn't accept this branch's name/);
    expect(handoffProblem('failed', 'fatal: bad object', what)).toBe("bob's Beluga couldn't set it up: fatal: bad object");
    // An older Beluga sends only words.
    expect(handoffProblem(undefined, "bob don't have that repository cloned", what)).toMatch(/^bob doesn't have app/);
    expect(handoffProblem(undefined, 'they turned off work from friends', what)).toMatch(/turned off work from friends/);
    expect(handoffProblem(undefined, 'declined', what)).toBe('bob said no to taking it over');
    expect(handoffProblem(undefined, 'disk full', what)).toBe("bob's Beluga couldn't set it up: disk full");
  });

  it('shares with a handoff note: written by your agent, in the chat and as HANDOFF.md in Scratch (BLG-967)', async () => {
    hub = await startHub({ keys });
    const dirs = repos('kay', 'bob');
    const note = '## Goal\nLog in with sessions.\n## Next steps\n- [ ] expired sessions test';
    const kay = await person('kay', { repo: dirs.kay, script: async (input) => (input.prompt.includes('handoff note') ? note : 'ok') });
    const bob = await person('bob', { repo: dirs.bob });
    await together(kay, bob);
    const ws = await kay.workspaces!.createWorktree(kay.workspaces!.list.find((p) => p.root)!.id, 'add-auth');
    await kay.session.workspaces!.refresh();

    expect(await kay.session.remote.handoffNote(ws.id, bob.id())).toBe(HANDOFF_FILE);
    // Joining here, not taking over: the prompt says so, and asks for the facts and the sections.
    expect(kay.runs[0]?.prompt).toBe(handoffNotePrompt('bob', 'share'));
    expect(kay.runs[0]?.prompt).toContain('bob is joining this work');
    const saved = readFileSync(path.join(ws.path, HANDOFF_FILE), 'utf8');
    expect(saved).toMatch(/^# Handoff: add-auth\n\n_From kay for bob, /);
    expect(saved).toContain('- [ ] expired sessions test');
    expect(git(ws.path, 'status', '--porcelain')).not.toContain('HANDOFF.md');
    expect(kay.state().log.some((l) => l.type === 'system' && l.text === `Handoff note for bob saved as ${HANDOFF_FILE}.`)).toBe(true);
  });

  it('asks for a note built from the facts, in sections, without secrets', () => {
    const takeover = handoffNotePrompt('bob');
    expect(takeover).toMatch(/^bob is taking over this work on their own computer/);
    for (const part of ['git status', 'Do not change, create, commit or delete any files', '## Goal', '## Where it stands', '## Next steps', '## Decisions', '## Watch out', 'Never include secrets']) expect(takeover).toContain(part);
    expect(handoffNotePrompt('bob', 'share')).not.toContain('taking over');
  });
});
