import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildForkedAppend } from '../../src/agent/fork-prompt.js';
import { encodeProjectDir } from '../../src/agent/runtime/claude/claude-sessions.js';
import { createDemoWorkspaces } from '../../src/demo.js';
import type { SharedFork } from '../../src/core/friend-share-store.js';
import type { LogItem } from '../../src/core/store.js';
import { type Crowd, LOSES_A_MESSAGE_ON_WINDOWS, SLOW, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Mac, mac } from './helpers.js';

/** BLG-312: a friend forks one of your shared worktrees to their own Mac, changes, Scratch, conversation and Claude's session with it. */

let net: Crowd | undefined;
const macs: Mac[] = [];
const configBefore = process.env.CLAUDE_CONFIG_DIR;

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
  if (configBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configBefore;
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('forking a friend’s worktree to your Mac', () => {
  it('brings its commits, its uncommitted work, Scratch, the conversation and Claude’s session, never a secret; theirs stays as it was', async () => {
    const claude = mkdtempSync(path.join(os.tmpdir(), 'beluga-fork-claude-'));
    process.env.CLAUDE_CONFIG_DIR = claude;
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay', { workspaces: await createDemoWorkspaces() });
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const theirs = project.workspaces.find((w) => w.kind === 'worktree' && !w.archived && !w.external && w.branch)!;

    // Ata's worktree as it is now: a changed file, a new one, a secret, Scratch, a conversation and Claude's session.
    const tracked = git(theirs.path, 'ls-files').split('\n').find((f) => !f.startsWith('.'))!;
    writeFileSync(path.join(theirs.path, tracked), 'changed on ata’s Mac\n');
    mkdirSync(path.join(theirs.path, 'notes'), { recursive: true });
    writeFileSync(path.join(theirs.path, 'notes', 'idea.md'), 'not committed yet\n');
    writeFileSync(path.join(theirs.path, '.env'), 'API_KEY=hunter2-very-secret\n');
    mkdirSync(path.join(theirs.path, '.beluga', 'scratch'), { recursive: true });
    writeFileSync(path.join(theirs.path, '.beluga', 'scratch', '01-notes.md'), 'what I found\n');
    const head = git(theirs.path, 'rev-parse', 'HEAD');
    // The new .env key reaches this worktree's .env.example (BLG-925) on ata's own env check, which
    // otherwise lands 1.5 s after a refresh, mid-fork: done now, so "as it was" means before the fork.
    await ata.session.workspaces!.checkEnv(project.id);
    const statusBefore = git(theirs.path, 'status', '--porcelain');
    ata.session.workspaces!.manager.rememberSession(theirs.id, 'sess-fork-1');
    const sessions = path.join(claude, 'projects', encodeProjectDir(theirs.path));
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, 'sess-fork-1.jsonl'), `${JSON.stringify({ type: 'user', text: 'the key is hunter2-very-secret' })}\n`);
    await ata.session.workspaces!.refresh();
    ata.session.sendChat('let’s try the cache first', false, `ws:${theirs.id}`);

    ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'contribute', fork: 'secrets' });
    await settle(() => kay.store.getState().sharedProjects.find((p) => p.id === project.id && p.copy?.state === 'ready'));

    const seen: SharedFork[] = [];
    const off = kay.store.subscribe(() => {
      const f = kay.store.getState().forks[theirs.id];
      if (f && f !== seen.at(-1)) seen.push(f);
    });
    await kay.shares.fork(ata.id, theirs.id, 'my-take');
    const fork = await settle(() => {
      const f = kay.store.getState().forks[theirs.id];
      if (f?.state === 'failed') throw new Error(f.error);
      return f?.state === 'ready' ? f : undefined;
    });
    off();
    const mine = kay.session.workspaces!.manager.find(fork.wsId!)!;
    expect(mine.branch).toBe('beluga/my-take');
    expect(mine.forkFromSession).toBe('sess-fork-1');

    // The commits, and the uncommitted work left uncommitted.
    expect(git(mine.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(path.join(mine.path, tracked), 'utf8')).toBe('changed on ata’s Mac\n');
    expect(readFileSync(path.join(mine.path, 'notes', 'idea.md'), 'utf8')).toBe('not committed yet\n');
    expect(git(mine.path, 'status', '--porcelain')).toContain(tracked);
    // Scratch, the conversation, and Claude's session where Claude Code looks, its secret taken out.
    expect(readFileSync(path.join(mine.path, '.beluga', 'scratch', '01-notes.md'), 'utf8')).toBe('what I found\n');
    const log = kay.session.workspaces!.manager.loadHistory<LogItem>(mine.id);
    expect(log.some((l) => l.type === 'system' && l.text.includes('let’s try the cache first'))).toBe(true);
    expect(log.some((l) => l.type === 'system' && l.text.startsWith('Forked from ata’s'))).toBe(true);
    const session = readFileSync(path.join(claude, 'projects', encodeProjectDir(path.resolve(mine.path)), 'sess-fork-1.jsonl'), 'utf8');
    expect(session).toContain('[secret]');
    expect(session).not.toContain('hunter2');
    // Never a secret, and no setup from a friend kay doesn't fully trust.
    expect(existsSync(path.join(mine.path, '.env'))).toBe(false);
    expect(log.some((l) => l.type === 'system' && l.text.startsWith('Setup didn’t run'))).toBe(true);

    // Ata's worktree is as it was, and ata is told.
    expect(git(theirs.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(theirs.path, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(theirs.path, 'for-each-ref', 'refs/beluga-fork')).toBe('');
    expect(ata.store.getState().log.some((l) => l.type === 'system' && l.channel === `ws:${theirs.id}` && l.text.startsWith('kay forked this worktree'))).toBe(true);

    // How far it got as it came over: from nothing to all of its bytes, with how many files are in it.
    const copying = seen.filter((f) => f.state === 'copying');
    expect(copying[0]!.received).toBe(0);
    expect(copying[0]!.total).toBeGreaterThan(0);
    // The two uncommitted files and Scratch's (the demo's worktree may have more of its own).
    expect(copying[0]!.files).toBeGreaterThanOrEqual(3);
    expect(copying.at(-1)!.received).toBe(copying[0]!.total);
  }, 60_000 * SLOW);

  it('brings the git-ignored context its owner picked, a secret only when ticked, and tells the forked agent what stayed (BLG-1017)', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay', { workspaces: await createDemoWorkspaces() });
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const theirs = project.workspaces.find((w) => w.kind === 'worktree' && !w.archived && !w.external && w.branch)!;

    // As in FlyingPapers: 22 benchmark docs and a key in git-ignored .context/, the prod key in .env,
    // and a script that reads them (committed, so it's in kay's fork from the start).
    const at = (rel: string, text: string): void => {
      mkdirSync(path.dirname(path.join(theirs.path, rel)), { recursive: true });
      writeFileSync(path.join(theirs.path, rel), text);
    };
    at('.gitignore', '.context/\n.env\n.beluga/\n');
    for (let i = 1; i <= 22; i++) at(`.context/jev-bench/docs/doc-${i}.md`, `doc ${i}\n`);
    at('.context/jev-bench/typesafe.env', 'TYPESAFE_KEY=ts-key-123\n');
    at('.env', 'SUPABASE_SERVICE_ROLE=prod-secret-xyz\n');
    at(
      'run.mjs',
      [
        "import { existsSync, readdirSync, readFileSync } from 'node:fs';",
        "const want = Array.from({ length: 22 }, (_, i) => `.context/jev-bench/docs/doc-${i + 1}.md`);",
        'const missing = want.filter((f) => !existsSync(f)).length;',
        "const key = readFileSync('.context/jev-bench/typesafe.env', 'utf8').trim().split('=')[1];",
        'console.log(`${want.length - missing} of ${want.length} documents found, key ${key ? "set" : "missing"}`);',
      ].join('\n'),
    );
    git(theirs.path, 'add', '.gitignore', 'run.mjs');
    git(theirs.path, '-c', 'user.name=ata', '-c', 'user.email=ata@example.com', 'commit', '-qm', 'bench script');
    await ata.session.workspaces!.refresh();

    // What ata sees before anything goes, then picks: .context/, and its key ticked; .env stays.
    const before = await ata.shares.forkCarry(theirs.id);
    expect(before.candidates.map((c) => c.path).sort()).toEqual(['.context/', '.env']);
    const tried = await ata.shares.forkCarry(theirs.id, { paths: ['.context/'], secrets: [] });
    expect(tried.files.find((f) => f.path === '.context/jev-bench/typesafe.env')).toMatchObject({ secret: true, goes: false });
    expect((await ata.shares.forkCarry(theirs.id)).picks.paths).toEqual([]);
    const saved = await ata.shares.setForkCarry(theirs.id, { paths: ['.context/'], secrets: ['.context/jev-bench/typesafe.env'] });
    expect(saved.count).toBe(23);

    ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'contribute', fork: 'secrets' });
    await settle(() => kay.store.getState().sharedProjects.find((p) => p.id === project.id && p.copy?.state === 'ready'));
    await kay.shares.fork(ata.id, theirs.id, 'bench');
    const fork = await settle(() => {
      const f = kay.store.getState().forks[theirs.id];
      if (f?.state === 'failed') throw new Error(f.error);
      return f?.state === 'ready' ? f : undefined;
    });
    const mine = kay.session.workspaces!.manager.find(fork.wsId!)!;

    // The forked worktree runs the script on its own: every doc and the key came, the .env didn't.
    const out = execFileSync(process.execPath, ['run.mjs'], { cwd: mine.path, encoding: 'utf8' }).trim();
    expect(out).toBe('22 of 22 documents found, key set');
    expect(existsSync(path.join(mine.path, '.env'))).toBe(false);
    expect(git(mine.path, 'status', '--porcelain')).not.toContain('.context');

    // Both Macs say what came and what stayed.
    const said = kay.session.workspaces!.manager.loadHistory<LogItem>(mine.id).flatMap((l) => (l.type === 'system' ? [l.text] : []));
    expect(said.find((t) => t.startsWith('Forked from ata’s'))).toContain('.context/ (23 files)');
    expect(said.find((t) => t.startsWith('Stayed on ata’s computer'))).toContain('.env (a secret)');
    const told = ata.store.getState().log.find((l) => l.type === 'system' && l.channel === `ws:${theirs.id}` && l.text.startsWith('kay forked this worktree'));
    expect(told?.type === 'system' ? told.text : '').toContain('Stayed here: .env (a secret, not ticked)');

    // Kay's agent is told in its instructions, from the fork's own note.
    expect(JSON.parse(readFileSync(path.join(mine.path, '.beluga', 'fork.json'), 'utf8'))).toMatchObject({ owner: 'ata', secrets: ['.context/jev-bench/typesafe.env'], left: [{ path: '.env', why: 'secret' }] });
    kay.session.submit('run the bench', { channel: `ws:${mine.id}` });
    const run = await settle(() => kay.runs.find((r) => r.place?.cwd === mine.path));
    expect(run.place?.forked).toMatchObject({ owner: 'ata', sent: [{ path: '.context/', files: 23 }] });
    expect(buildForkedAppend(run.place!.forked!)).toContain('- .env: a secret');
  }, 60_000 * SLOW);

  it('“Can fork” brings the picked context but never a ticked secret; “Can chat” can’t fork at all (BLG-1019)', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay', { workspaces: await createDemoWorkspaces() });
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const theirs = project.workspaces.find((w) => w.kind === 'worktree' && !w.archived && !w.external && w.branch)!;
    mkdirSync(path.join(theirs.path, '.context'), { recursive: true });
    writeFileSync(path.join(theirs.path, '.gitignore'), '.context/\n.beluga/\n');
    writeFileSync(path.join(theirs.path, '.context', 'notes.md'), 'what we know\n');
    writeFileSync(path.join(theirs.path, '.context', 'typesafe.env'), 'TYPESAFE_KEY=ts-key-123\n');
    await ata.shares.setForkCarry(theirs.id, { paths: ['.context/'], secrets: ['.context/typesafe.env'] });

    ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'contribute', fork: 'code' });
    await settle(() => kay.store.getState().sharedProjects.find((p) => p.id === project.id && p.copy?.state === 'ready' && p.forks === 'code'));
    await kay.shares.fork(ata.id, theirs.id, 'no-secrets');
    const fork = await settle(() => {
      const f = kay.store.getState().forks[theirs.id];
      if (f?.state === 'failed') throw new Error(f.error);
      return f?.state === 'ready' ? f : undefined;
    });
    const mine = kay.session.workspaces!.manager.find(fork.wsId!)!;
    expect(readFileSync(path.join(mine.path, '.context', 'notes.md'), 'utf8')).toBe('what we know\n');
    expect(existsSync(path.join(mine.path, '.context', 'typesafe.env'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(mine.path, '.beluga', 'fork.json'), 'utf8')).left).toContainEqual({ path: '.context/typesafe.env', why: 'secret' });

    // Shared again without saying (an /invite): still "Can fork". Down to "Can chat": kay's Mac is told, and forking is refused.
    ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'contribute' });
    expect(ata.store.getState().projectShares[project.id]?.[kay.id]?.fork).toBe('code');
    ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'contribute', fork: 'none' });
    await settle(() => kay.store.getState().sharedProjects.find((p) => p.id === project.id && p.forks === 'none'));
    await expect(kay.shares.fork(ata.id, theirs.id, 'again')).rejects.toThrow(/ata hasn’t let you fork it/);
  }, 60_000 * SLOW);

  it('forking before the project is on your Mac gets it here first, then forks', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay', { workspaces: await createDemoWorkspaces() });
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const theirs = project.workspaces.find((w) => w.kind === 'worktree' && !w.archived && !w.external && w.branch)!;
    ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'contribute', fork: 'secrets' });
    // While kay's copy of it is still coming over.
    const early = await settle(() => kay.store.getState().sharedProjects.find((p) => p.id === project.id)?.copy);
    const seen: string[] = [];
    const off = kay.store.subscribe(() => {
      const f = kay.store.getState().forks[theirs.id];
      if (f && f.state !== seen.at(-1)) seen.push(f.state);
    });
    await kay.shares.fork(ata.id, theirs.id, 'early');
    const fork = await settle(() => {
      const f = kay.store.getState().forks[theirs.id];
      if (f?.state === 'failed') throw new Error(f.error);
      return f?.state === 'ready' ? f : undefined;
    });
    off();
    const copy = kay.store.getState().sharedProjects.find((p) => p.id === project.id)?.copy;
    expect(copy?.state).toBe('ready');
    const mine = kay.session.workspaces!.manager.find(fork.wsId!)!;
    expect(mine.branch).toBe('beluga/early');
    expect(kay.session.workspaces!.manager.list.find((p) => p.workspaces.some((w) => w.id === mine.id))?.id).toBe(copy?.projectId);
    if (early.state === 'copying') expect(seen.slice(0, 2)).toEqual(['preparing', 'asking']);
  }, 60_000 * SLOW);

  it.skipIf(LOSES_A_MESSAGE_ON_WINDOWS)('a repository you can’t clone, shared a worktree at a time: the fork says why and what to ask for', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay', { workspaces: await createDemoWorkspaces() });
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const ws = project.workspaces.find((w) => w.kind === 'worktree' && !w.archived && !w.external && w.branch)!;
    // A private repository kay can't reach (.invalid never resolves).
    git(project.root!, 'remote', 'set-url', 'origin', 'https://git.nowhere.invalid/ata/bob-api');
    ata.session.sharing.shareWithFriend({ peerId: kay.id, workspaceId: ws.id, role: 'contribute', fork: 'code' });
    await settle(() => kay.store.getState().shared.find((w) => w.id === ws.id));

    // Its address follows the first message (it's looked up): fork once kay has it.
    const deadline = Date.now() + 10_000 * SLOW;
    for (;;) {
      try {
        await kay.shares.fork(ata.id, ws.id);
        break;
      } catch (err) {
        if (!/share the whole project, and it’s copied here/.test(String(err)) || Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(kay.store.getState().forks[ws.id]?.state).toBe('preparing');
    const failed = await settle(() => (kay.store.getState().forks[ws.id]?.state === 'failed' ? kay.store.getState().forks[ws.id] : undefined));
    expect(failed.error).toBe('git.nowhere.invalid/ata/bob-api couldn’t be cloned here (it may be private, or you don’t have access). Ask ata to share the whole project, and it’s copied from their Mac');
    // Nothing of it was sent over: ata only shared the worktree.
    expect(kay.session.workspaces!.manager.list.some((p) => p.name === 'bob-api' && p.root.includes(`${path.sep}copies${path.sep}`))).toBe(false);
  }, 60_000 * SLOW);

  it.skipIf(LOSES_A_MESSAGE_ON_WINDOWS)('someone who only follows along can’t fork', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    // Permission is checked before looking for a local repository: Kay needs no demo copy.
    const kay = await mac(net, 'kay');
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const ws = project.workspaces.find((w) => w.kind === 'worktree' && !w.archived && !w.external)!;
    ata.session.sharing.shareWithFriend({ peerId: kay.id, workspaceId: ws.id, role: 'view' });
    await settle(() => kay.store.getState().sharedProjects[0]);
    await expect(kay.shares.fork(ata.id, ws.id)).rejects.toThrow(/hasn’t let you fork it/);
  }, 30_000 * SLOW);
});
