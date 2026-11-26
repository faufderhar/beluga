import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASK_ONLY_REASON, DENY_REASON, decideTool, denyReason } from '../src/agent/policy.js';
import { buildAskOnlyAppend } from '../src/agent/prompt.js';
import { isReadOnlyCommand } from '../src/agent/read-only.js';
import { carrySession } from '../src/agent/session-carry.js';
import { encodeProjectDir } from '../src/agent/runtime/claude/claude-sessions.js';
import { createMockBackend } from '../src/agent/mock.js';
import type { AgentRunInput, RoomBridge } from '../src/agent/types.js';
import { status } from '../src/workspaces/git.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { agoText, homeModel, homeTasks, mainLineOf } from '../packages/mac/src/views/project/home-model.js';
import type { Issue } from '../src/core/board/model.js';

/** "Never change main": runs in a project's main folder are questions only (see policy.ts). */

const main = { cwd: '/work/app', roots: ['/work/app'], autoEdit: false, askOnly: true, scope: 'full' as const };

describe('isReadOnlyCommand', () => {
  it('lets sed print, and env list names, but nothing that writes or runs', () => {
    for (const c of ["sed -n '12,40p' supabase/migrations/001.sql", "sed -n '/create table/,/;/p' a.sql", 'sed 5q a.sql', "sed -n -e '$p' a", 'env | cut -d= -f1 | sort', 'printenv HOME']) expect(isReadOnlyCommand(c), c).toBe(true);
    for (const c of ["sed -i 's/a/b/' a", "sed 's/a/b/w out' a", "sed -n '1p;w out' a", 'sed -f script a', "sed -n 'e rm -rf x' a", 'env FOO=1 node x.js', 'env rm a']) expect(isReadOnlyCommand(c), c).toBe(false);
  });

  it('lets through commands that only look', () => {
    for (const c of [
      'ls -la',
      'cat README.md | head -20',
      'git status',
      'git log --oneline -20',
      'git diff origin/main --stat',
      'git show HEAD~1:src/a.ts',
      'git branch -a',
      'git branch --list "klaud/*"',
      'git -C ../other status',
      'rg "TODO" src && wc -l src/*.ts',
      'find . -name "*.ts" -not -path "./node_modules/*"',
      'grep -rn requireUser src 2>/dev/null',
      'npm ls react',
      'git remote -v',
      'git config --get remote.origin.url',
      'GIT_PAGER=cat git log -3',
      'cd src && ls',
    ])
      expect(isReadOnlyCommand(c), c).toBe(true);
  });

  it('refuses anything that could change files, git or run other programs', () => {
    for (const c of [
      'git commit -am wip',
      'git push',
      'git merge feature',
      'git reset --hard',
      'git checkout -b x',
      'git branch -D old',
      'git branch new-one',
      'git stash',
      'git tag v1',
      'git config user.name x',
      'git diff --output=patch.diff',
      'rm -rf build',
      'echo hi > notes.txt',
      'cat a >> b',
      'sed -i s/a/b/ file',
      'npm install',
      'npm test',
      'find . -delete',
      'find . -name x -exec rm {} \\;',
      'ls; rm x',
      'ls && touch x',
      'cat $(rm x)',
      'echo `rm x`',
      'sort -o out.txt in.txt',
      'xargs rm',
      'python3 script.py',
      'node -e "require(\'fs\').writeFileSync(\'x\', \'\')"',
      'cat <<EOF > x',
      '',
    ])
      expect(isReadOnlyCommand(c), c).toBe(false);
  });
});

describe('decideTool in a main folder (ask-only)', () => {
  it('denies every edit, even with full trust', () => {
    for (const t of ['Write', 'Edit', 'MultiEdit']) expect(decideTool(t, { file_path: 'src/a.ts' }, main)).toBe('deny');
    expect(decideTool('NotebookEdit', { notebook_path: 'a.ipynb' }, main)).toBe('deny');
    expect(decideTool('Edit', { file_path: 'src/a.ts' }, { ...main, autoEdit: true })).toBe('deny');
  });

  it('denies shell commands that change things, and leaves read-only ones to the usual rules', () => {
    expect(decideTool('Bash', { command: 'git commit -am x' }, main)).toBe('deny');
    expect(decideTool('Bash', { command: 'npm install' }, main)).toBe('deny');
    expect(decideTool('Bash', { command: 'git status' }, main)).toBe('ask');
    expect(decideTool('Bash', { command: 'cat .env' }, main)).toBe('deny');
  });

  it('can still read, and offers continue_in_worktree', () => {
    expect(decideTool('Read', { file_path: 'src/a.ts' }, main)).toBe('allow');
    expect(decideTool('Grep', { pattern: 'TODO' }, main)).toBe('allow');
    expect(decideTool('mcp__beluga__continue_in_worktree', { task: 'x' }, main)).toBe('allow');
  });

  it('keeps fetched files out of the main folder', () => {
    expect(decideTool('mcp__beluga__get_peer_file', { peer: 'bob', path: '~/x', save_to: '/work/app/vendor' }, main)).toBe('deny');
    expect(decideTool('mcp__beluga__get_peer_file', { peer: 'bob', path: '~/x', save_to: '/tmp' }, main)).toBe('ask');
  });

  it('tells Claude why, and what to do instead', () => {
    expect(denyReason('Edit', { file_path: 'a.ts' }, main)).toBe(ASK_ONLY_REASON);
    expect(ASK_ONLY_REASON).toContain('continue_in_worktree');
    expect(denyReason('Read', { file_path: '/Users/me/.ssh/id_rsa' }, main)).toBe(DENY_REASON);
    // A view whose command could change something says so, not "credential files".
    const show = { view: { type: 'table', source: { kind: 'command', command: 'npm run report' } } };
    expect(decideTool('mcp__beluga_view__show', show, main)).toBe('deny');
    expect(denyReason('mcp__beluga_view__show', show, main)).toBe(ASK_ONLY_REASON);
    // Outside a main folder nothing changes.
    expect(decideTool('Edit', { file_path: 'src/a.ts' }, { ...main, askOnly: false, autoEdit: true })).toBe('allow');
  });
});

describe('the system prompt for a main folder', () => {
  it('says it is read-only and to move changes to a worktree right away', () => {
    const text = buildAskOnlyAppend('api', true);
    expect(text).toContain("You're in the main folder of api");
    expect(text).toContain('mcp__beluga__continue_in_worktree right away');
    expect(buildAskOnlyAppend('api', false)).not.toContain('continue_in_worktree');
  });

  it('with the board, says tasks are changed right here, not in a worktree (BLG-626)', () => {
    expect(buildAskOnlyAppend('api', true, true)).toMatch(/task board is not in this folder.*\n.*never needs a worktree/);
    expect(buildAskOnlyAppend('api', true)).not.toContain('mcp__beluga_board__');
  });

  it('board tools stay allowed in a main folder (they change no file there)', () => {
    const main = { cwd: '/repo', roots: ['/repo'], autoEdit: false, scope: 'full' as const, askOnly: true };
    expect(decideTool('mcp__beluga_board__task_create', { title: 'x' }, main)).toBe('allow');
    expect(decideTool('mcp__beluga_board__task_update', { status: 'done' }, main)).toBe('allow');
  });
});

describe('the demo Claude in a main folder', () => {
  const bridge = { writeReport: async () => '' } as unknown as RoomBridge;
  const input = (prompt: string, move?: (task: string) => Promise<string>): AgentRunInput => ({
    prompt,
    requesterName: 'kay',
    viaAgent: false,
    context: [],
    scope: 'full',
    signal: new AbortController().signal,
    onEvent: () => undefined,
    onFileTouched: () => undefined,
    canUseTool: async () => true,
    place: { cwd: '/work/app', additionalDirectories: [], autoEdit: false, onSession: () => undefined, askOnly: { project: 'app' } },
    ...(move ? { continueInWorktree: move } : {}),
  });

  it('moves a change request to a new worktree instead of pretending to edit', async () => {
    const moved: string[] = [];
    const answer = await createMockBackend(bridge, 0).run(input('Add a health check endpoint', async (t) => (moved.push(t), 'ok')));
    expect(moved).toEqual(['Add a health check endpoint']);
    expect(answer).toMatch(/new worktree/);
  });

  it('answers questions there as usual', async () => {
    const moved: string[] = [];
    await createMockBackend(bridge, 0).run(input('How is this organized?', async (t) => (moved.push(t), 'ok')));
    expect(moved).toEqual([]);
  });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

describe('main folders in the workspace list', () => {
  it('marks the main checkout and chats in it as ask-only, never worktrees, and compares main with origin', async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-ask-')));
    const repo = path.join(base, 'code', 'app');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', path.join(base, 'app.git')], { stdio: 'pipe' });
    git(repo, 'init', '-b', 'main');
    writeFileSync(path.join(repo, 'a.txt'), '1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', path.join(base, 'app.git'));
    git(repo, 'push', '-u', 'origin', 'main');
    const store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
    const manager = new WorkspaceManager(store);
    await manager.refresh();
    const project = manager.list.find((p) => p.root)!;
    const chat = await manager.createChat(project.id, 'how does it work?');
    const wt = await manager.createWorktree(project.id, 'feature');
    const standalone = await manager.createStandaloneChat('here', repo);
    const all = manager.list.flatMap((p) => p.workspaces);
    expect(all.find((w) => w.kind === 'main')?.askOnly).toBe(true);
    expect(all.find((w) => w.id === chat.id)?.askOnly).toBe(true);
    expect(all.find((w) => w.id === standalone.id)?.askOnly).toBe(true);
    expect(all.find((w) => w.id === wt.id)?.askOnly).toBeUndefined();
    // Derived, never saved.
    expect(readFileSync(path.join(base, 'home', 'workspaces.json'), 'utf8')).not.toContain('askOnly');

    expect((await status(repo)).upstream).toEqual({ name: 'origin/main', ahead: 0, behind: 0 });
    writeFileSync(path.join(repo, 'a.txt'), '2\n');
    git(repo, 'commit', '-am', 'local');
    expect((await status(repo)).upstream).toEqual({ name: 'origin/main', ahead: 1, behind: 0 });
  });
});

describe('carrySession', () => {
  // Not on Windows: POSIX paths in the fixtures.
  it.skipIf(process.platform === 'win32')('copies a Claude Code conversation next to the folder it continues in', () => {
    const config = mkdtempSync(path.join(os.tmpdir(), 'klaud-cc-'));
    const from = path.join(config, 'projects', encodeProjectDir('/work/app'));
    mkdirSync(from, { recursive: true });
    writeFileSync(path.join(from, 'abc-123.jsonl'), '{"type":"user"}\n');
    expect(carrySession('abc-123', '/work/app', '/work/wt/feature', config)).toBe(true);
    expect(existsSync(path.join(config, 'projects', encodeProjectDir('/work/wt/feature'), 'abc-123.jsonl'))).toBe(true);
    expect(carrySession('missing', '/work/app', '/work/wt/feature', config)).toBe(false);
    expect(carrySession('../evil', '/work/app', '/work/wt/feature', config)).toBe(false);
  });
});

describe('the project home (Mac)', () => {
  const ws = (over: Partial<Workspace>): Workspace => ({ id: 'w', projectRoot: '/p', name: 'w', path: '/wt/w', kind: 'worktree', branch: 'klaud/w', base: 'origin/main', createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over });
  const project: Project = {
    id: 'p1',
    name: 'api',
    root: '/p',
    base: 'origin/main',
    workspaces: [
      ws({ id: 'main', name: 'main', kind: 'main', path: '/p', branch: 'main', askOnly: true, status: { branch: 'main', changed: 0, ahead: 0, behind: 0, upstream: { name: 'origin/main', ahead: 0, behind: 2 } } }),
      ws({ id: 'auth', name: 'add-auth', status: { changed: 0, ahead: 2, behind: 0 }, createdAt: 5 }),
      ws({ id: 'hooks', name: 'webhooks', status: { changed: 1, ahead: 0, behind: 0 }, createdAt: 9 }),
      ws({ id: 'ext', name: 'ext', external: true, path: '/x/.claude/worktrees/a' }),
      ws({ id: 'q', name: 'how does auth work', kind: 'chat', path: '/p', askOnly: true, createdAt: 3 }),
      ws({ id: 'old', name: 'old', archived: true, createdAt: 2 }),
    ],
  };

  it('lists worktrees, questions and archived, with counts', () => {
    const m = homeModel({ log: [], conflicts: {}, prs: {} }, project);
    expect(m.worktrees.map((w) => w.id)).toEqual(['hooks', 'auth']);
    expect(m.asks.map((w) => w.id)).toEqual(['q']);
    expect(m.archived.map((w) => w.id)).toEqual(['old']);
    expect(m.stats).toEqual({ active: 2, ready: 1, archived: 1 });
    expect(m.mainLine).toEqual({ label: '2 behind origin/main', tone: 'info' });
  });

  it("doesn't count a worktree whose PR is merged or closed as ready to merge", () => {
    const pr = { number: 7, url: 'u', title: 'T', draft: false, checks: 'passing' as const };
    expect(homeModel({ log: [], conflicts: {}, prs: { auth: { ...pr, state: 'OPEN' } } }, project).stats.ready).toBe(1);
    expect(homeModel({ log: [], conflicts: {}, prs: { auth: { ...pr, state: 'MERGED' } } }, project).stats.ready).toBe(0);
    expect(homeModel({ log: [], conflicts: {}, prs: { auth: { ...pr, state: 'CLOSED' } } }, project).stats.ready).toBe(0);
  });

  it('says how main compares with origin', () => {
    const at = (status: Workspace['status']) => mainLineOf(ws({ kind: 'main', status }));
    expect(at({ changed: 0, ahead: 0, behind: 0, upstream: { name: 'origin/main', ahead: 0, behind: 0 } })).toEqual({ label: 'Up to date with origin/main', tone: 'ok' });
    expect(at({ changed: 3, ahead: 0, behind: 0, upstream: { name: 'origin/main', ahead: 1, behind: 0 } })).toEqual({ label: '1 commit not pushed to origin/main', tone: 'info', dirty: '3 uncommitted changes in main' });
    expect(at({ changed: 0, ahead: 0, behind: 0 })).toEqual({ label: 'Not tracking a remote branch', tone: 'muted' });
    expect(agoText(1000, 1000 + 5 * 60_000)).toBe('5 min ago');
  });

  it('shows the latest moved open tasks of its board, how many are open, and stays away when it has none', () => {
    const task = (key: string, over: Partial<Issue>): Issue => ({ id: key, key, projectId: 'p1', title: key, status: 'todo', updatedAt: 1, ...over }) as unknown as Issue;
    const board = {
      issues: [
        task('A-1', { updatedAt: 10 }),
        task('A-2', { updatedAt: 30, status: 'in_progress' }),
        task('A-3', { updatedAt: 50, status: 'done' }),
        task('A-4', { updatedAt: 40, archivedAt: 41, status: 'backlog' }),
        task('A-5', { updatedAt: 20, status: 'in_review' }),
        task('B-1', { updatedAt: 99, projectId: 'p2' }),
        // On a board of its own, running in this repo: the repo's board shows it too.
        task('X-1', { updatedAt: 5, board: 'board_team' }),
      ],
    };
    const t = homeTasks(board, 'p1', 3);
    expect(t.shown.map((i) => i.key)).toEqual(['A-2', 'A-5', 'A-1']);
    expect(t.open).toBe(4);
    expect(t.any).toBe(true);
    expect(homeTasks({ issues: [task('A-3', { status: 'done' })] }, 'p1', 3)).toEqual({ shown: [], open: 0, any: true });
    expect(homeTasks(board, 'p9', 3).any).toBe(false);
  });
});

describe('isReadOnlyCommand: what the shell would really run', () => {
  it('splits on separators the way the shell does, escapes included', () => {
    expect(isReadOnlyCommand("ls \\'; rm -rf x; echo \\'")).toBe(false);
    expect(isReadOnlyCommand(String.raw`echo a\;b`)).toBe(true);
  });

  it('refuses environment settings that could run something, or last beyond the command', () => {
    expect(isReadOnlyCommand('PATH=/tmp/evil; git status')).toBe(false);
    expect(isReadOnlyCommand('A=--output=/tmp/x; git diff $A')).toBe(false);
    expect(isReadOnlyCommand('GIT_EXTERNAL_DIFF=/tmp/evil git diff')).toBe(false);
    expect(isReadOnlyCommand('GIT_PAGER=cat git log -3')).toBe(true);
  });
});

describe('a plan’s Claude fixing a conflict in a hidden worktree', () => {
  const fixing = { ...main, roots: ['/work/app', '/k/workspaces/.bases/app/kld-10-base'], fixup: '/k/workspaces/.bases/app/kld-10-base' };

  it('may edit there (and only there); the main folder stays read-only, and git still can’t run', () => {
    expect(decideTool('Edit', { file_path: '/k/workspaces/.bases/app/kld-10-base/src/a.ts' }, fixing)).toBe('allow');
    expect(decideTool('Read', { file_path: '/k/workspaces/.bases/app/kld-10-base/src/a.ts' }, fixing)).toBe('allow');
    expect(decideTool('Edit', { file_path: '/work/app/src/a.ts' }, fixing)).toBe('deny');
    expect(decideTool('Edit', { file_path: '/k/workspaces/.bases/app/kld-11-base/a.ts' }, fixing)).toBe('deny');
    expect(decideTool('Write', { file_path: '/k/workspaces/.bases/app/kld-10-base/.env' }, fixing)).toBe('deny');
    expect(decideTool('Bash', { command: 'git -C /k/workspaces/.bases/app/kld-10-base commit -am x' }, fixing)).toBe('deny');
    expect(decideTool('Edit', { file_path: '/k/workspaces/.bases/app/kld-10-base/src/a.ts' }, main)).toBe('deny');
  });
});

describe('an epic’s worktree working in its sub-tasks’ worktrees in other repos (BLG-561)', () => {
  const epic = { cwd: '/k/workspaces/app/blg-1-pay', roots: ['/k/workspaces/app/blg-1-pay', '/k/workspaces/api/blg-1-pay'], autoEdit: true, scope: 'full' as const, alsoEdit: ['/k/workspaces/api/blg-1-pay'] };

  it('edits there like its own folder, nowhere else; secrets stay refused', () => {
    expect(decideTool('Edit', { file_path: '/k/workspaces/api/blg-1-pay/src/fees.ts' }, epic)).toBe('allow');
    expect(decideTool('Edit', { file_path: '/k/workspaces/app/blg-1-pay/src/fees.ts' }, epic)).toBe('allow');
    expect(decideTool('Edit', { file_path: '/k/workspaces/api/other/src/fees.ts' }, epic)).toBe('ask');
    expect(decideTool('Write', { file_path: '/k/workspaces/api/blg-1-pay/.env' }, epic)).toBe('deny');
    expect(decideTool('Edit', { file_path: '/k/workspaces/api/blg-1-pay/src/fees.ts' }, { ...epic, autoEdit: false })).toBe('ask');
  });
});
