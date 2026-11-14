import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findProjects } from '../src/workspaces/discovery.js';
import { parseWorktreeList } from '../src/workspaces/git.js';
import { WorkspaceManager, slug } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function makeRepo(parent: string, name: string): string {
  const origin = path.join(parent, `${name}.git`);
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  const dir = path.join(parent, 'code', name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 'T');
  writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-m', 'init');
  sh(dir, 'remote', 'add', 'origin', origin);
  sh(dir, 'push', '-u', 'origin', 'main');
  sh(dir, 'remote', 'set-head', 'origin', 'main');
  return dir;
}

let base: string;
let repo: string;
let mgr: WorkspaceManager;
const repos = () => mgr.list.filter((p) => p.root);

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-ws-')));
  repo = makeRepo(base, 'app');
  const store = new WorkspaceStore(path.join(base, 'home'));
  store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  mgr = new WorkspaceManager(store);
  await mgr.refresh();
});

const commitIn = (dir: string, file: string, content: string, msg: string) => {
  writeFileSync(path.join(dir, file), content);
  sh(dir, 'add', '.');
  sh(dir, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', msg);
};

describe('projects', () => {
  it('discovers git projects in parent folders and adds individual ones', async () => {
    expect(repos().map((p) => p.name)).toEqual(['app']);
    const project = repos()[0]!;
    expect(project.base).toBe('origin/main');
    expect(project.workspaces.map((w) => [w.kind, w.name, w.branch])).toEqual([['main', 'main', 'main']]);
    const other = makeRepo(path.join(base, 'elsewhere'), 'lib');
    mgr.addProject(other);
    await mgr.refresh();
    expect(repos().map((p) => p.name)).toEqual(['app', 'lib']);
    expect(() => mgr.addProject(base)).toThrow(/not a git project/);
    mgr.hideProject(repos()[1]!.id);
    await mgr.refresh();
    expect(repos().map((p) => p.name)).toEqual(['app']);
    expect(findProjects([path.join(base, 'nope')])).toEqual([]);
    expect(mgr.addFolder(path.join(base, 'code'))).toBe(1);
    expect(() => mgr.addFolder(path.join(base, 'missing'))).toThrow(/doesn't exist/);
  });

  it('shows worktrees made by other tools', async () => {
    sh(repo, 'worktree', 'add', '-b', 'other-tool', path.join(base, 'ext'));
    await mgr.refresh();
    const ext = repos()[0]!.workspaces.find((w) => w.branch === 'other-tool')!;
    expect(ext).toMatchObject({ kind: 'worktree', external: true, name: 'ext' });
  });
});

describe('worktree lifecycle', () => {
  it('creates a worktree from origin, tracks status, reviews and merges it', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'Fix Auth!');
    expect(ws).toMatchObject({ name: 'fix-auth', branch: 'beluga/fix-auth', base: 'origin/main', kind: 'worktree', external: false });
    expect(existsSync(path.join(ws.path, 'README.md'))).toBe(true);
    expect(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.beluga/');

    writeFileSync(path.join(ws.path, 'new.txt'), 'x');
    await mgr.refresh();
    expect(mgr.find(ws.id)?.status).toMatchObject({ changed: 1, ahead: 0 });
    await expect(mgr.merge(ws.id)).rejects.toThrow(/uncommitted/);
    expect(await mgr.commitAll(ws.id, 'add new')).toBe(true);
    expect(await mgr.commitAll(ws.id, 'nothing')).toBe(false);
    commitIn(ws.path, 'README.md', '# hi\nmore\n', 'edit readme');
    await mgr.refresh();
    expect(mgr.find(ws.id)?.status).toMatchObject({ changed: 0, ahead: 2 });

    const review = await mgr.review(ws.id);
    expect(review.commits.map((c) => c.subject)).toEqual(['edit readme', 'add new']);
    expect(review.files.map((f) => [f.path, f.state, f.added])).toEqual([
      ['README.md', 'modified', 1],
      ['new.txt', 'added', 1],
    ]);
    expect(await mgr.fileDiff(ws.id, 'README.md')).toContain('+more');

    expect(await mgr.merge(ws.id)).toEqual({ ok: true });
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toContain('more');
  });

  it('refuses to merge into a dirty main folder and aborts conflicts cleanly', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'conflict');
    commitIn(ws.path, 'README.md', 'theirs\n', 'theirs');
    writeFileSync(path.join(repo, 'README.md'), 'dirty\n');
    await mgr.refresh();
    expect(await mgr.merge(ws.id)).toEqual({ ok: false, reason: 'dirty', files: ['README.md'] });
    commitIn(repo, 'README.md', 'ours\n', 'ours');
    expect(await mgr.merge(ws.id)).toEqual({ ok: false, reason: 'conflict', files: ['README.md'] });
    expect(sh(repo, 'status', '--porcelain')).toBe(''); // merge was aborted
  });

  it('forks with history, archives, restores and deletes', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'idea');
    mgr.rememberSession(ws.id, 'session-1');
    mgr.saveHistory(ws.id, [{ text: 'hello' }]);
    commitIn(ws.path, 'idea.txt', 'v1', 'idea v1');
    await mgr.refresh();

    const fork = await mgr.fork(ws.id, 'idea 2');
    expect(fork).toMatchObject({ name: 'idea-2', forkedFrom: ws.id, forkFromSession: 'session-1', branch: 'beluga/idea-2' });
    expect(existsSync(path.join(fork.path, 'idea.txt'))).toBe(true); // starts from the parent's state
    expect(mgr.loadHistory(fork.id)).toEqual([{ text: 'hello' }]);
    mgr.rememberSession(fork.id, 'session-2');
    expect(mgr.find(fork.id)).toMatchObject({ sessionId: 'session-2', forkFromSession: undefined });

    // Uncommitted work is kept by the archive (it used to be lost to "archive anyway").
    writeFileSync(path.join(ws.path, 'wip.txt'), 'x');
    await mgr.refresh();
    const kept = await mgr.archive(ws.id);
    expect(mgr.find(ws.id)).toMatchObject({ archived: true, archive: { keptBytes: kept!.keptBytes } });
    expect(existsSync(ws.path)).toBe(false);
    expect(await mgr.restore(ws.id)).toMatchObject({ snapshot: kept!.snapshot });
    expect(existsSync(path.join(ws.path, 'idea.txt'))).toBe(true);
    expect(readFileSync(path.join(ws.path, 'wip.txt'), 'utf8')).toBe('x');
    expect(mgr.find(ws.id)?.archive).toBeUndefined();

    await mgr.remove(fork.id);
    expect(mgr.find(fork.id)).toBeUndefined();
    expect(sh(repo, 'branch', '--list', 'beluga/idea-2')).toBe('');
    await expect(mgr.archive(repos()[0]!.workspaces[0]!.id)).rejects.toThrow(/main folder/);
    const again = await mgr.createWorktree(repos()[0]!.id, 'idea'); // name taken by a live worktree → idea-2
    expect(again.name).toBe('idea');
    expect(path.basename(again.path)).toBe('idea-2');
    expect(again.id).not.toBe(ws.id);
  });

  it('forks the whole worktree: uncommitted changes and Scratch too, the source untouched', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'whole');
    commitIn(ws.path, 'kept.txt', 'v1', 'kept v1');
    writeFileSync(path.join(ws.path, 'kept.txt'), 'v2 unsaved'); // changed, not staged
    writeFileSync(path.join(ws.path, 'staged.txt'), 'staged');
    sh(ws.path, 'add', 'staged.txt');
    writeFileSync(path.join(ws.path, 'new.txt'), 'brand new'); // untracked
    sh(ws.path, 'rm', '-q', 'README.md'); // deleted
    mkdirSync(path.join(ws.path, '.beluga', 'scratch', 'shots'), { recursive: true });
    writeFileSync(path.join(ws.path, '.beluga', 'scratch', 'shots', 'home.png'), 'png');
    writeFileSync(path.join(ws.path, '.beluga', 'scratch', 'notes.md'), 'notes');
    const before = sh(ws.path, 'status', '--porcelain');

    const fork = await mgr.fork(ws.id, 'whole 2', { id: 'chosen-id' });
    expect(fork.id).toBe('chosen-id');
    expect(readFileSync(path.join(fork.path, 'kept.txt'), 'utf8')).toBe('v2 unsaved');
    expect(readFileSync(path.join(fork.path, 'staged.txt'), 'utf8')).toBe('staged');
    expect(readFileSync(path.join(fork.path, 'new.txt'), 'utf8')).toBe('brand new');
    expect(existsSync(path.join(fork.path, 'README.md'))).toBe(false);
    // Still uncommitted there: the fork's branch is where the source's is.
    expect(sh(fork.path, 'rev-parse', 'HEAD')).toBe(sh(ws.path, 'rev-parse', 'HEAD'));
    expect(sh(fork.path, 'status', '--porcelain')).not.toBe('');
    expect(readFileSync(path.join(fork.path, '.beluga', 'scratch', 'shots', 'home.png'), 'utf8')).toBe('png');
    expect(readFileSync(path.join(fork.path, '.beluga', 'scratch', 'notes.md'), 'utf8')).toBe('notes');
    // Scratch stays out of git in the fork too.
    expect(sh(fork.path, 'status', '--porcelain')).not.toContain('.beluga');
    // The source is exactly as it was, and no ref of the copy is left behind.
    expect(sh(ws.path, 'status', '--porcelain')).toBe(before);
    expect(sh(repo, 'for-each-ref', 'refs/beluga/fork')).toBe('');
  });

  it('forks a clean worktree with nothing to carry', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'tidy');
    commitIn(ws.path, 'a.txt', 'a', 'a');
    const fork = await mgr.fork(ws.id, 'tidy 2');
    expect(readFileSync(path.join(fork.path, 'a.txt'), 'utf8')).toBe('a');
    expect(sh(fork.path, 'status', '--porcelain')).toBe('');
    expect(existsSync(path.join(fork.path, '.beluga', 'scratch'))).toBe(false);
  });

  it('deleting an archived worktree for good deletes its archive too', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'gone');
    writeFileSync(path.join(ws.path, 'wip.txt'), 'x');
    await mgr.archive(ws.id);
    expect(existsSync(path.join(base, 'home', 'archives', ws.id))).toBe(true);
    await mgr.remove(ws.id);
    expect(existsSync(path.join(base, 'home', 'archives', ws.id))).toBe(false);
    expect(sh(repo, 'for-each-ref', 'refs/beluga/')).toBe('');
  });

  it('deleting a worktree for good forgets its Claude Code sessions, never another folder filed alike', async () => {
    const claude = path.join(base, 'claude');
    process.env.CLAUDE_CONFIG_DIR = claude;
    try {
      const ws = await mgr.createWorktree(repos()[0]!.id, 'chatty');
      const filed = path.join(claude, 'projects', ws.path.replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(path.join(filed, 's1', 'subagents'), { recursive: true });
      writeFileSync(path.join(filed, 's1.jsonl'), `${JSON.stringify({ type: 'user', cwd: ws.path })}\n`);
      // Filed under the same name but ran elsewhere ("a/b-c" and "a-b/c" are filed alike): stays.
      writeFileSync(path.join(filed, 's2.jsonl'), `${JSON.stringify({ type: 'user', cwd: '/elsewhere' })}\n`);
      mkdirSync(path.join(claude, 'file-history', 's1'), { recursive: true });
      mkdirSync(path.join(claude, 'todos'), { recursive: true });
      writeFileSync(path.join(claude, 'todos', 's1-agent-s1.json'), '[]');
      writeFileSync(path.join(claude, 'todos', 's2-agent-s2.json'), '[]');
      await mgr.remove(ws.id);
      expect(existsSync(path.join(filed, 's1.jsonl'))).toBe(false);
      expect(existsSync(path.join(filed, 's1'))).toBe(false);
      expect(existsSync(path.join(filed, 's2.jsonl'))).toBe(true);
      expect(existsSync(path.join(claude, 'file-history', 's1'))).toBe(false);
      expect(existsSync(path.join(claude, 'todos', 's1-agent-s1.json'))).toBe(false);
      expect(existsSync(path.join(claude, 'todos', 's2-agent-s2.json'))).toBe(true);
      // Only its own: the folder goes with it.
      const solo = await mgr.createWorktree(repos()[0]!.id, 'solo');
      const soloFiled = path.join(claude, 'projects', solo.path.replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(soloFiled, { recursive: true });
      writeFileSync(path.join(soloFiled, 's3.jsonl'), `${JSON.stringify({ type: 'user', cwd: solo.path })}\n`);
      await mgr.archive(solo.id);
      // Archived keeps it (restore brings the conversation back).
      expect(existsSync(path.join(soloFiled, 's3.jsonl'))).toBe(true);
      await mgr.remove(solo.id);
      expect(existsSync(soloFiled)).toBe(false);
      // Codex's rollouts that ran there go too; another folder's stay.
      const codex = process.env.CODEX_HOME!;
      const day = path.join(codex, 'sessions', '2026', '10', '31');
      mkdirSync(day, { recursive: true });
      const rollout = (id: string, cwd: string) => {
        const f = path.join(day, `rollout-2026-10-31T20-00-00-${id}.jsonl`);
        writeFileSync(f, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n`);
        return f;
      };
      const cx = await mgr.createWorktree(repos()[0]!.id, 'codexy');
      const there = rollout('t1', cx.path);
      const elsewhere = rollout('t2', '/elsewhere');
      await mgr.remove(cx.id);
      expect([existsSync(there), existsSync(elsewhere)]).toEqual([false, true]);
      // A Codex chat forgets its own thread.
      const chat = await mgr.createChat(repos()[0]!.id, 'Codex chat');
      mgr.rememberSession(chat.id, 't2', 'codex');
      await mgr.remove(chat.id);
      expect(existsSync(elsewhere)).toBe(false);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('forgets the Claude Code sessions worktrees deleted before BLG-532 left behind, never an archived one’s', async () => {
    const claude = path.join(base, 'claude');
    process.env.CLAUDE_CONFIG_DIR = claude;
    const fileSession = (cwd: string, id: string): string => {
      const filed = path.join(claude, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(path.join(filed, id), { recursive: true });
      writeFileSync(path.join(filed, `${id}.jsonl`), `${JSON.stringify({ type: 'user', cwd })}\n`);
      return filed;
    };
    try {
      const live = await mgr.createWorktree(repos()[0]!.id, 'live');
      const archived = await mgr.createWorktree(repos()[0]!.id, 'shelved');
      const liveFiled = fileSession(live.path, 'a');
      const archivedFiled = fileSession(archived.path, 'b');
      await mgr.archive(archived.id);
      // Deleted by an older Beluga: no folder, no workspace, its sessions still filed (one ran in a sub-folder).
      const gone = path.join(path.dirname(live.path), 'old-task');
      const goneFiled = fileSession(gone, 'c');
      const goneSub = fileSession(path.join(gone, 'packages', 'mac'), 'd');
      // Outside Beluga's worktrees: not ours to judge.
      const outside = fileSession(path.join(base, 'elsewhere', 'gone'), 'e');
      expect(await mgr.sweepLeftoverSessions()).toBe(2);
      expect([goneFiled, goneSub].map(existsSync)).toEqual([false, false]);
      expect([liveFiled, archivedFiled, outside].map(existsSync)).toEqual([true, true, true]);
      expect(await mgr.sweepLeftoverSessions()).toBe(0);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it("deleting a chat in the main folder forgets only its own Claude Code session", async () => {
    const claude = path.join(base, 'claude');
    process.env.CLAUDE_CONFIG_DIR = claude;
    try {
      const filed = path.join(claude, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(path.join(filed, 'mine'), { recursive: true });
      for (const s of ['mine', 'shared', 'other']) writeFileSync(path.join(filed, `${s}.jsonl`), '{}\n');
      const chat = await mgr.createChat(repos()[0]!.id, 'Quick');
      mgr.rememberSession(chat.id, 'mine');
      const twin = await mgr.createChat(repos()[0]!.id, 'Twin');
      mgr.rememberSession(twin.id, 'shared');
      const fork = await mgr.createChat(repos()[0]!.id, 'Fork');
      mgr.rememberSession(fork.id, 'shared');
      await mgr.remove(chat.id);
      // Another chat still resumes "shared": it stays.
      await mgr.remove(twin.id);
      expect(['mine', 'mine.jsonl', 'shared.jsonl', 'other.jsonl'].map((f) => existsSync(path.join(filed, f)))).toEqual([false, false, true, true]);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('lists a new worktree or chat at once, and a refresh that began before it keeps it (BLG-531)', async () => {
    const before = mgr.refresh();
    const ws = await mgr.createWorktree(repos()[0]!.id, 'quick');
    const chat = await mgr.createChat(repos()[0]!.id, 'Ask');
    const ids = () => repos()[0]!.workspaces.map((w) => w.id);
    expect(ids()).toEqual(expect.arrayContaining([ws.id, chat.id]));
    expect(chat.askOnly).toBe(true);
    expect(ws.status).toBeDefined();
    await before;
    expect(ids()).toEqual(expect.arrayContaining([ws.id, chat.id]));
    await mgr.refresh();
    expect(repos()[0]!.workspaces.find((w) => w.id === ws.id)).toMatchObject({ kind: 'worktree', external: false });
  });

  it('creates chats in the main folder without a worktree', async () => {
    const chat = await mgr.createChat(repos()[0]!.id, 'Quick question');
    expect(chat).toMatchObject({ kind: 'chat', name: 'Quick question', path: repo });
    mgr.rename(chat.id, 'Renamed');
    await mgr.refresh();
    expect(mgr.find(chat.id)?.name).toBe('Renamed');
    await mgr.archive(chat.id);
    expect(mgr.find(chat.id)?.archived).toBe(true);
    await mgr.remove(chat.id);
    expect(mgr.find(chat.id)).toBeUndefined();
  });

  it('creates stand-alone Claude chats with their own folder', async () => {
    expect(mgr.list[0]).toMatchObject({ id: 'chats', name: 'Chats', workspaces: [] });
    const chat = await mgr.createChat('chats', 'Ideas');
    expect(chat).toMatchObject({ kind: 'chat', name: 'Ideas', projectId: 'chats', projectRoot: '' });
    expect(existsSync(chat.path)).toBe(true);
    expect(mgr.list[0]!.workspaces.map((w) => w.name)).toEqual(['Ideas']);
    await mgr.remove(chat.id);
    expect(existsSync(chat.path)).toBe(false);
  });

  it('gives a stand-alone chat its own folder when the client has no launch folder', async () => {
    // The Mac app connects without one, so it asks for the chat in ''.
    const chat = await mgr.createChat('chats', 'Hello', '');
    expect(chat.path).not.toBe('');
    expect(existsSync(chat.path)).toBe(true);
  });

  it('persists across restarts', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'keep');
    mgr.rememberSession(ws.id, 's-9');
    const again = new WorkspaceManager(new WorkspaceStore(path.join(base, 'home')));
    await again.refresh();
    expect(again.find(ws.id)).toMatchObject({ name: 'keep', sessionId: 's-9', external: false });
  });
});

describe('env files and safe merges', () => {
  it('copies env files into new worktrees and offers to bring key changes back', async () => {
    writeFileSync(path.join(repo, '.env'), 'API=1\nKEEP=yes\n');
    mkdirSync(path.join(repo, '.aws'));
    writeFileSync(path.join(repo, '.aws', 'config'), '[default]\n');
    writeFileSync(path.join(repo, '.env.example'), 'API=\n');
    const ws = await mgr.createWorktree(repos()[0]!.id, 'envs');
    expect(readFileSync(path.join(ws.path, '.env'), 'utf8')).toBe('API=1\nKEEP=yes\n');
    expect(existsSync(path.join(ws.path, '.aws', 'config'))).toBe(true);
    expect(Object.keys(ws.envSnapshot ?? {})).toEqual(['.aws/config', '.env']);
    expect(mgr.envChanges(ws.id)).toEqual([]); // untouched

    writeFileSync(path.join(ws.path, '.env'), 'API=2\nKEEP=yes\nNEW=x\n');
    expect(mgr.envChanges(ws.id)).toEqual([{ file: '.env', added: ['NEW'], changed: ['API'], removed: [], binary: false }]);
    expect(mgr.applyEnvBack(ws.id)).toBe(1);
    expect(readFileSync(path.join(repo, '.env'), 'utf8')).toBe('API=2\nKEEP=yes\nNEW=x\n');
    writeFileSync(path.join(ws.path, '.aws', 'config'), '[changed]\n');
    expect(mgr.envChanges(ws.id).map((c) => [c.file, c.binary])).toEqual([['.aws/config', true]]);
  });

  it("keeps a worktree's env change there when asked, and untouched copies follow the main folder (BLG-369)", async () => {
    writeFileSync(path.join(repo, '.env'), 'API=1\n');
    const a = await mgr.createWorktree(repos()[0]!.id, 'env-a');
    const b = await mgr.createWorktree(repos()[0]!.id, 'env-b');
    // Copied back from a: in step again, so a isn't asked, and b (never touched) follows.
    writeFileSync(path.join(a.path, '.env'), 'API=2\nNEW=x\n');
    expect(mgr.applyEnvBack(a.id)).toBe(1);
    expect(mgr.envChanges(a.id)).toEqual([]);
    expect(mgr.followMainEnv(b.id)).toEqual(['.env']);
    expect(readFileSync(path.join(b.path, '.env'), 'utf8')).toBe('API=2\nNEW=x\n');
    expect(mgr.envChanges(b.id)).toEqual([]);

    // Kept in b: not asked again (archiving still lists it), and the main folder no longer overwrites it.
    writeFileSync(path.join(b.path, '.env'), 'API=b\nNEW=x\n');
    expect(mgr.keepEnvHere(b.id)).toBe(1);
    expect(mgr.envChanges(b.id)).toEqual([]);
    expect(mgr.envChanges(b.id, true)).toEqual([{ file: '.env', added: [], changed: ['API'], removed: [], binary: false }]);
    writeFileSync(path.join(repo, '.env'), 'API=3\nNEW=x\n');
    expect(mgr.followMainEnv(b.id)).toEqual([]);
    expect(readFileSync(path.join(b.path, '.env'), 'utf8')).toBe('API=b\nNEW=x\n');
    // Changed again: asked again.
    writeFileSync(path.join(b.path, '.env'), 'API=b2\nNEW=x\n');
    expect(mgr.envChanges(b.id).map((c) => c.changed)).toEqual([['API']]);
    // A new env file in the main folder comes in; one deleted in the worktree isn't made again.
    writeFileSync(path.join(repo, '.env.local'), 'L=1\n');
    expect(mgr.followMainEnv(a.id)).toEqual(['.env', '.env.local']);
    rmSync(path.join(a.path, '.env.local'));
    expect(mgr.followMainEnv(a.id)).toEqual([]);
  });

  it('brings only brand-new keys back on its own, and gives the values for Save in Beluga (BLG-369)', async () => {
    writeFileSync(path.join(repo, '.env'), 'API=1\nKEEP=yes\n');
    const ws = await mgr.createWorktree(repos()[0]!.id, 'env-new');
    writeFileSync(path.join(ws.path, '.env'), 'API=staging\nKEEP=yes\nSTRIPE_KEY="sk test"\n');
    expect(mgr.envValues(ws.id)).toEqual({ API: 'staging', STRIPE_KEY: 'sk test' });
    expect(mgr.applyNewEnvKeys(ws.id)).toEqual([{ file: '.env', keys: ['STRIPE_KEY'] }]);
    // The new key is in the main folder; the changed value isn't, and is still asked about.
    expect(readFileSync(path.join(repo, '.env'), 'utf8')).toBe('API=1\nKEEP=yes\nSTRIPE_KEY="sk test"\n');
    expect(mgr.envChanges(ws.id)).toEqual([{ file: '.env', added: [], changed: ['API'], removed: [], binary: false }]);
    expect(mgr.applyNewEnvKeys(ws.id)).toEqual([]);
    // Only new keys: the copy follows the main folder again afterwards.
    writeFileSync(path.join(repo, '.env'), 'API=1\n');
    const other = await mgr.createWorktree(repos()[0]!.id, 'env-new-2');
    writeFileSync(path.join(other.path, '.env'), 'API=1\nFLAG=on\n');
    mgr.applyNewEnvKeys(other.id);
    writeFileSync(path.join(repo, '.env'), 'API=2\nFLAG=on\n');
    expect(mgr.followMainEnv(other.id)).toEqual(['.env']);
  });

  it('copies deep, direnv, Wrangler and .worktreeinclude files too, never tracked ones or examples', async () => {
    const deep = path.join(repo, 'apps', 'web', 'config', 'local');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, '.env'), 'DEEP=1\n');
    writeFileSync(path.join(repo, '.envrc'), 'export A=1\n');
    writeFileSync(path.join(repo, '.dev.vars'), 'B=2\n');
    writeFileSync(path.join(repo, 'secrets.json'), '{}\n');
    writeFileSync(path.join(repo, 'notes.txt'), 'not mine to copy\n');
    writeFileSync(path.join(repo, '.worktreeinclude'), 'secrets.json\n');
    mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(repo, 'node_modules', 'pkg', '.env'), 'X=1\n');
    const ws = await mgr.createWorktree(repos()[0]!.id, 'deep');
    expect(readFileSync(path.join(ws.path, 'apps', 'web', 'config', 'local', '.env'), 'utf8')).toBe('DEEP=1\n');
    expect(existsSync(path.join(ws.path, '.envrc'))).toBe(true);
    expect(existsSync(path.join(ws.path, '.dev.vars'))).toBe(true);
    expect(existsSync(path.join(ws.path, 'secrets.json'))).toBe(true);
    expect(existsSync(path.join(ws.path, 'notes.txt'))).toBe(false);
    expect(existsSync(path.join(ws.path, 'node_modules', 'pkg', '.env'))).toBe(false);
  });

  it('only merges into the main folder when it is on the base branch', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'side');
    commitIn(ws.path, 'x.txt', 'x', 'x');
    sh(repo, 'checkout', '-b', 'other');
    await mgr.refresh();
    expect(await mgr.merge(ws.id)).toEqual({ ok: false, reason: 'wrong_branch', files: [], current: 'other', expected: 'main' });
    sh(repo, 'checkout', 'main');
    expect(await mgr.merge(ws.id)).toEqual({ ok: true });
  });

  it('never force-removes worktrees made by other tools', async () => {
    sh(repo, 'worktree', 'add', '-b', 'tool', path.join(base, 'tool'));
    writeFileSync(path.join(base, 'tool', 'wip.txt'), 'unsaved');
    await mgr.refresh();
    const ext = repos()[0]!.workspaces.find((w) => w.external)!;
    await expect(mgr.remove(ext.id)).rejects.toThrow();
    expect(existsSync(path.join(base, 'tool', 'wip.txt'))).toBe(true);
  });

  it('deletes a worktree whose folder was removed by hand, branch and all', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'gone');
    rmSync(ws.path, { recursive: true, force: true });
    await mgr.remove(ws.id);
    await mgr.refresh();
    expect(repos()[0]!.workspaces.some((w) => w.name === 'gone')).toBe(false);
    expect(sh(repo, 'branch', '--list', 'beluga/gone').trim()).toBe('');
  });

  it('deletes a worktree git already let go of, whatever was left in its folder', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'husk');
    // A delete that stopped halfway: git's link is gone, files are still there.
    rmSync(path.join(repo, '.git', 'worktrees', path.basename(ws.path)), { recursive: true, force: true });
    await mgr.remove(ws.id);
    await mgr.refresh();
    expect(existsSync(ws.path)).toBe(false);
    expect(repos()[0]!.workspaces.some((w) => w.name === 'husk')).toBe(false);
    expect(sh(repo, 'branch', '--list', 'beluga/husk').trim()).toBe('');
  });

  it("reports why a merge failed when it isn't a conflict", async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'nobranch');
    commitIn(ws.path, 'x.txt', 'x', 'x');
    await mgr.refresh();
    const { mergeInto } = await import('../src/workspaces/git.js');
    await expect(mergeInto(repo, 'no-such-branch', 'main')).rejects.toThrow(/no-such-branch/);
  });
});

describe('choosing the base branch', () => {
  const pushFeature = (): string => {
    sh(repo, 'checkout', '-b', 'feature');
    commitIn(repo, 'feature.txt', 'f', 'feature work');
    sh(repo, 'push', '-u', 'origin', 'feature');
    sh(repo, 'checkout', 'main');
    return sh(repo, 'rev-parse', 'origin/feature').trim();
  };

  it('creates a worktree on the chosen branch and compares against it', async () => {
    const tip = pushFeature();
    const ws = await mgr.createWorktree(repos()[0]!.id, 'on feature', 'origin/feature');
    expect(ws).toMatchObject({ branch: 'beluga/on-feature', base: 'origin/feature' });
    expect(sh(ws.path, 'rev-parse', 'HEAD').trim()).toBe(tip);
    expect(existsSync(path.join(ws.path, 'feature.txt'))).toBe(true);
    commitIn(ws.path, 'more.txt', 'm', 'more');
    await mgr.refresh();
    // Ahead of what it branched from, not of main (which is behind feature).
    expect(mgr.find(ws.id)?.status).toMatchObject({ ahead: 1, behind: 0 });
    // Restarting keeps the base it was made from.
    const again = new WorkspaceManager(new WorkspaceStore(path.join(base, 'home')));
    await again.refresh();
    expect(again.find(ws.id)?.base).toBe('origin/feature');
  });

  it('refuses a branch that does not exist or looks like an option', async () => {
    const id = repos()[0]!.id;
    await expect(mgr.createWorktree(id, 'x', 'no-such-branch')).rejects.toThrow("There's no branch called no-such-branch");
    await expect(mgr.createWorktree(id, 'y', '--upload-pack=touch /tmp/pwned')).rejects.toThrow(/There's no branch called --upload-pack/);
    expect(repos()[0]!.workspaces.filter((w) => w.kind === 'worktree')).toHaveLength(0);
  });

  it('lists the branches, the default base first', async () => {
    pushFeature();
    const { base: def, branches } = await mgr.branches(repos()[0]!.id);
    expect(def).toBe('origin/main');
    expect(branches[0]).toBe('origin/main');
    expect(branches).toEqual(expect.arrayContaining(['main', 'feature', 'origin/feature']));
    expect(branches).not.toContain('origin/HEAD');
    expect(new Set(branches).size).toBe(branches.length);
    await expect(mgr.branches('nope')).rejects.toThrow('Project not found');
  });
});

describe('helpers', () => {
  // Not on Windows: POSIX paths in the fixtures (git paths become C:\… there).
  it.skipIf(process.platform === 'win32')('slugs names and parses worktree lists', () => {
    expect(slug('  Fix: Auth / Login!! ')).toBe('fix-auth-login');
    expect(slug('!!!')).toBe('workspace');
    expect(parseWorktreeList('worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n')).toEqual([
      { path: '/a', head: '1', branch: 'main', detached: false, bare: false },
      { path: '/b', head: '2', branch: undefined, detached: true, bare: false },
    ]);
  });
});

describe('case-insensitive disks', () => {
  it('scans a folder once even when listed with different letter case', () => {
    const roots = [path.join(base, 'code'), path.join(base, 'CODE'), path.join(base, 'code')];
    expect(findProjects(roots)).toEqual([repo]);
  });
});
