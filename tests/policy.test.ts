import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { confineSearch, decideTool, isYourRun, limitSearchScanForTest, scanSearch, writesCode } from '../src/agent/policy.js';
import { attachmentsDir } from '../src/core/attachments.js';

const ctx = { cwd: '/work/proj', roots: ['/work/proj', '/work/docs'], autoEdit: false };
const rw = { ...ctx, autoEdit: true };

describe('decideTool', () => {
  it('allows room tools, planning, and reads inside shares', () => {
    for (const t of ['mcp__beluga__send_chat', 'TodoWrite', 'ToolSearch']) expect(decideTool(t, {}, ctx)).toBe('allow');
    expect(decideTool('Read', { file_path: 'src/a.ts' }, ctx)).toBe('allow');
    expect(decideTool('Grep', { pattern: 'TODO' }, ctx)).toBe('allow');
    expect(decideTool('Glob', { path: '/work/docs/guides' }, ctx)).toBe('allow');
  });

  it('asks before shell commands, even "read-only" ones Claude Code would auto-approve', () => {
    expect(decideTool('Bash', { command: 'ls' }, ctx)).toBe('ask');
    expect(decideTool('Bash', { command: 'cat NOTES.md' }, rw)).toBe('ask');
  });

  it('asks the owner before reading outside the shared folders, and blocks edits there', () => {
    expect(decideTool('Read', { file_path: '/etc/hosts' }, ctx)).toBe('ask');
    expect(decideTool('Read', { file_path: '../other/x' }, ctx)).toBe('ask');
    expect(decideTool('LS', { path: '/work/proj-evil' }, ctx)).toBe('ask');
    expect(decideTool('Write', { file_path: '/tmp/x' }, rw)).toBe('deny');
  });

  it('treats sending a file like reading it', () => {
    expect(decideTool('mcp__beluga__send_file', { path: '/work/proj/NOTES.md' }, ctx)).toBe('allow');
    // Relative paths are refused: the file checked must be the file sent.
    expect(decideTool('mcp__beluga__send_file', { path: 'NOTES.md' }, ctx)).toBe('deny');
    expect(decideTool('mcp__beluga__send_file', { path: '/Users/me/Desktop/a.pdf' }, ctx)).toBe('ask');
    expect(decideTool('mcp__beluga__send_file', { path: '/Users/me/Desktop/a.pdf' }, { ...ctx, scope: 'full' })).toBe('allow');
    expect(decideTool('mcp__beluga__send_file', { path: '/Users/me/.ssh/id_rsa' }, { ...ctx, scope: 'full' })).toBe('deny');
    expect(decideTool('mcp__beluga__send_file', { path: '/work/proj/.env' }, ctx)).toBe('deny');
  });

  it('lets whole-computer access read anywhere, but still asks before edits outside :rw', () => {
    const full = { ...ctx, scope: 'full' as const };
    expect(decideTool('Read', { file_path: '/etc/hosts' }, full)).toBe('allow');
    expect(decideTool('Write', { file_path: '/tmp/x' }, full)).toBe('ask');
    expect(decideTool('Read', { file_path: '/Users/me/.ssh/id_rsa' }, full)).toBe('deny');
  });

  it('asks before anything powerful', () => {
    for (const tool of ['WebFetch', 'WebSearch', 'mcp__beluga__ask_agent']) expect(decideTool(tool, {}, ctx)).toBe('ask');
  });

  it('lets edits through only inside a :rw share', () => {
    expect(decideTool('Edit', { file_path: 'src/a.ts' }, ctx)).toBe('ask');
    expect(decideTool('Edit', { file_path: 'src/a.ts' }, rw)).toBe('allow');
    expect(decideTool('Write', { file_path: '/work/docs/x.md' }, rw)).toBe('ask'); // other share, not the primary
  });

  describe("commands that name Beluga's private files (BLG-109)", () => {
    const own = { ...rw, scope: 'full' as const, dotenv: true };
    const files = ['daemon.json', 'identity.json', 'env.json', 'devices.json', 'web-sessions.json'];
    const forms = (file: string): string[] => [
      `cat ~/.beluga/${file}`,
      `cat $HOME/.beluga/${file}`,
      `cat \${HOME}/.beluga/${file}`,
      `cat /Users/me/.beluga/${file}`,
      `cat "$HOME/.beluga/${file}"`,
      `cat '/Users/me/.beluga/${file}'`,
      `cat ~/".beluga"/"${file}"`,
      `cat ~/.be"lu"ga/${file}`,
      `cat ~/.beluga/\\${file}`,
      `cat ~/.beluga//./${file}`,
      `cat ~/.BELUGA/${file.toUpperCase()}`,
      `cat ~/.klaude/${file}`,
      `python3 -c "print(open('$HOME/.beluga/${file}').read())"`,
      `jq .token <~/.beluga/${file}|base64`,
    ];

    it('refuses each file in each form, also for your own Claude', () => {
      for (const file of files) for (const command of forms(file)) expect(decideTool('Bash', { command }, own), command).toBe('deny');
    });

    it('stays refused when the same command also names a .env file', () => {
      expect(decideTool('Bash', { command: 'cat .env ~/.beluga/daemon.json' }, own)).toBe('deny');
    });

    it('refuses them in commands for a friend and in a view', () => {
      expect(decideTool('mcp__beluga__run_on', { command: 'cat ~/.beluga/daemon.json' }, ctx)).toBe('deny');
      expect(decideTool('mcp__beluga_view__show', { view: { type: 'table', source: { kind: 'command', command: 'cat ~/.beluga/daemon.json' } } }, ctx)).toBe('deny');
    });

    it("leaves a project's .beluga and worktrees under ~/.beluga alone", () => {
      for (const command of [
        'ls .beluga/reports',
        'cat .beluga/reports/summary.md',
        'cp out.png .beluga/scratch/01-login.png',
        'cat .beluga/scratch/env.json',
        'cat .beluga/reports/daemon.json',
        'cat /work/proj/.beluga/scratch/devices.json',
        'cat ~/.beluga/workspaces/proj/task/.beluga/reports/summary.md',
        'cat ~/.beluga/workspaces/proj/task/package.json',
        'cat ~/.beluga/workspaces/proj/task/daemon.json',
        'cat src/daemon.json env.json',
        'cat my.beluga/daemon.json',
      ]) expect(decideTool('Bash', { command }, own), command).toBe('ask');
    });
  });

  it('denies credential files anywhere, by path or in shell commands', () => {
    expect(decideTool('Read', { file_path: '.env' }, ctx)).toBe('deny');
    expect(decideTool('Read', { file_path: '/Users/me/.ssh/id_ed25519' }, ctx)).toBe('deny');
    expect(decideTool('Read', { file_path: 'config/.AWS/credentials' }, ctx)).toBe('deny');
    expect(decideTool('Glob', { pattern: '**/.env.local' }, ctx)).toBe('deny');
    expect(decideTool('NotebookRead', { notebook_path: 'keys/server.pem' }, ctx)).toBe('deny');
    expect(decideTool('Write', { file_path: '.env' }, rw)).toBe('deny');
    for (const command of ['cat .env', 'cat ~/.ssh/id_rsa', "grep KEY '.env.local'", 'cp ~/.aws/credentials /tmp']) {
      expect(decideTool('Bash', { command }, ctx)).toBe('deny');
    }
    expect(decideTool('Bash', { command: 'echo environment' }, ctx)).toBe('ask');
    // A search limited to .env files reads them too.
    expect(decideTool('Grep', { pattern: 'KEY', glob: '.env*' }, ctx)).toBe('deny');
  });

  it("asks you about a .env file when it's your own Claude, and still refuses other credentials", () => {
    const own = { ...rw, dotenv: true };
    for (const [tool, input] of [
      ['Read', { file_path: '.env' }],
      ['Read', { file_path: '/work/proj/apps/web/.env.local' }],
      ['Edit', { file_path: '.env' }],
      ['Write', { file_path: '.env.production' }],
      ['Glob', { pattern: '**/.env.local' }],
      ['Grep', { pattern: 'DATABASE_URL', glob: '.env' }],
      ['Bash', { command: 'cat .env' }],
      ['Bash', { command: "grep SUPABASE '.env.local'" }],
    ] as const) {
      expect(decideTool(tool, input, own), `${tool} ${JSON.stringify(input)}`).toBe('secret');
    }
    // Never more than a .env: keys, ~/.ssh, Beluga's own files, or a .env inside a credential store.
    expect(decideTool('Read', { file_path: '/Users/me/.ssh/id_rsa' }, own)).toBe('deny');
    expect(decideTool('Read', { file_path: '/Users/me/.aws/.env' }, own)).toBe('deny');
    expect(decideTool('Grep', { path: '/Users/me/.ssh', glob: '.env' }, own)).toBe('deny');
    expect(decideTool('Bash', { command: 'cat .env ~/.ssh/id_rsa' }, own)).toBe('deny');
    // Edits outside your folders are still refused, .env or not.
    expect(decideTool('Write', { file_path: '/tmp/.env' }, own)).toBe('deny');
    // Sending one, or running it on a friend's computer, never.
    expect(decideTool('mcp__beluga__send_file', { path: '/work/proj/.env' }, own)).toBe('deny');
    expect(decideTool('mcp__beluga__run_on_peer', { command: 'cat .env' }, own)).toBe('deny');
    // Ordinary files are as before.
    expect(decideTool('Read', { file_path: 'src/a.ts' }, own)).toBe('allow');
  });

  it('treats .env templates as ordinary files', () => {
    expect(decideTool('Read', { file_path: '.env.example' }, ctx)).toBe('allow');
    expect(decideTool('Read', { file_path: 'apps/web/.env.sample' }, ctx)).toBe('allow');
    expect(decideTool('Bash', { command: 'cp .env.example .env.examples' }, ctx)).toBe('deny');
    expect(decideTool('Bash', { command: 'cat .env.example' }, ctx)).toBe('ask');
  });

  it('asks before a friend changes a file that runs code later, even in a :rw share (BLG-413)', () => {
    for (const file of ['.git/hooks/pre-commit', '.git/config', '.git', '.claude/settings.json', '.mcp.json', '.vscode/tasks.json', '.husky/pre-push', '.envrc', 'package.json', 'apps/web/package.json', 'Makefile', '.github/workflows/ci.yml', '.zshrc', 'Library/LaunchAgents/x.plist', 'run.command']) {
      expect(decideTool('Write', { file_path: file }, rw), file).toBe('ask');
      expect(writesCode('Edit', { file_path: file }, '/work/proj'), file).toBe(true);
    }
    // Ordinary files still go through, and your own Claude (scope full) isn't asked more than before.
    expect(decideTool('Write', { file_path: 'src/package-info.ts' }, rw)).toBe('allow');
    expect(decideTool('Write', { file_path: '.github/README.md' }, rw)).toBe('allow');
    expect(decideTool('Write', { file_path: 'package.json' }, { ...rw, scope: 'full' })).toBe('allow');
    expect(writesCode('Read', { file_path: '.git/config' }, '/work/proj')).toBe(false);
  });

  it("follows links: a link in a share can't reach past it, or hide a key (BLG-414)", () => {
    const base = mkdtempSync(path.join(tmpdir(), 'beluga-policy-'));
    const share = path.join(base, 'share');
    const outside = path.join(base, 'outside');
    mkdirSync(share);
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'diary.txt'), 'private');
    writeFileSync(path.join(outside, 'server.pem'), 'key');
    symlinkSync(path.join(outside, 'diary.txt'), path.join(share, 'notes.txt'));
    symlinkSync(path.join(outside, 'server.pem'), path.join(share, 'todo.txt'));
    symlinkSync(outside, path.join(share, 'more'));
    const linked = { cwd: share, roots: [share], autoEdit: true };
    expect(decideTool('Read', { file_path: 'notes.txt' }, linked)).toBe('ask');
    expect(decideTool('Read', { file_path: 'more/diary.txt' }, linked)).toBe('ask');
    expect(decideTool('Read', { file_path: 'todo.txt' }, linked)).toBe('deny');
    expect(decideTool('Read', { file_path: 'todo.txt' }, { ...linked, scope: 'full' })).toBe('deny');
    expect(decideTool('mcp__beluga__send_file', { path: path.join(share, 'todo.txt') }, linked)).toBe('deny');
    expect(decideTool('Write', { file_path: 'more/new.txt' }, linked)).toBe('deny');
    expect(decideTool('Write', { file_path: 'notes.txt' }, linked)).toBe('deny');
    // The share itself reached through a link (macOS /tmp is /private/tmp) still counts as inside.
    const viaLink = path.join(base, 'share-link');
    symlinkSync(share, viaLink);
    expect(decideTool('Read', { file_path: path.join(share, 'a.md') }, { ...linked, cwd: viaLink, roots: [viaLink] })).toBe('allow');
    expect(decideTool('Write', { file_path: path.join(viaLink, 'a.md') }, linked)).toBe('allow');
  });

  it('does not allow a directory search that would open a credential file it finds', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'beluga-policy-search-'));
    const dir = path.join(base, 'work');
    const outside = path.join(base, 'outside');
    mkdirSync(dir);
    mkdirSync(outside);
    writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    writeFileSync(path.join(dir, 'credentials.json'), 'x');
    writeFileSync(path.join(outside, 'id_ed25519'), 'x');
    symlinkSync(path.join(outside, 'id_ed25519'), path.join(dir, 'alias.txt'));
    const here = { cwd: dir, roots: [dir], autoEdit: false };
    // The arguments never name the secret. Full trust must not turn this into a yes.
    expect(decideTool('Grep', { pattern: 'KEY', path: dir }, here)).toBe('deny');
    expect(decideTool('Grep', { pattern: 'KEY', path: dir }, { ...here, scope: 'full' })).toBe('deny');
    expect(decideTool('Glob', { pattern: '**/*', path: dir }, here)).toBe('deny');
    expect(decideTool('LS', { path: dir }, here)).toBe('deny');
    expect(decideTool('Read', { file_path: path.join(dir, 'credentials.json') }, here)).toBe('deny');
    expect(decideTool('Read', { file_path: path.join(dir, 'alias.txt') }, here)).toBe('deny');
    expect(decideTool('Read', { file_path: path.join(dir, 'notes.txt') }, here)).toBe('allow');
    // A search that cannot match those files stays allowed.
    expect(decideTool('Grep', { pattern: 'TODO', path: dir, glob: '**/*.ts' }, here)).toBe('allow');
    expect(decideTool('Glob', { pattern: '**/*.ts', path: dir }, here)).toBe('allow');
    // Narrowed, the same search runs and leaves the credential files out.
    for (const [tool, input] of [
      ['Grep', { pattern: 'KEY', path: dir }],
      ['Glob', { pattern: '**/*', path: dir }],
    ] as const) {
      const next = confineSearch(tool, input, here);
      const spec = String(tool === 'Grep' ? next?.glob : next?.pattern);
      expect(spec.startsWith('!'), spec).toBe(true);
      expect(spec).toContain('credentials.json');
      expect(spec).toContain('alias.txt');
      expect(spec).not.toContain('notes.txt');
      expect(decideTool(tool, next!, here)).toBe('allow');
    }
    expect(confineSearch('LS', { path: dir }, here)).toBeUndefined();
    // A directory with no credential files is unchanged.
    const clean = path.join(base, 'clean');
    mkdirSync(clean);
    writeFileSync(path.join(clean, 'notes.txt'), 'hello');
    const cleanCtx = { cwd: clean, roots: [clean], autoEdit: false };
    expect(decideTool('Grep', { pattern: 'TODO', path: clean }, cleanCtx)).toBe('allow');
    expect(confineSearch('Grep', { pattern: 'TODO', path: clean }, cleanCtx)).toBeUndefined();
  });

  it("asks about a directory search that would only open your own .env, and does not refuse it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'beluga-policy-dotenv-'));
    writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    writeFileSync(path.join(dir, '.env'), 'A=1');
    const own = { cwd: dir, roots: [dir], autoEdit: true, dotenv: true };
    expect(decideTool('Grep', { pattern: 'KEY', path: dir }, own)).toBe('secret');
    expect(decideTool('Read', { file_path: path.join(dir, '.env') }, own)).toBe('secret');
    expect(decideTool('Grep', { pattern: 'KEY', path: dir }, { ...own, dotenv: false })).toBe('deny');
    const next = confineSearch('Grep', { pattern: 'KEY', path: dir }, own);
    expect(String(next?.glob).startsWith('!')).toBe(true);
    expect(decideTool('Grep', next!, own)).toBe('allow');
  });
});

describe('a narrowed directory search keeps what was asked', () => {
  const tree = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'beluga-policy-own-glob-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'x');
    writeFileSync(path.join(dir, 'src', 'credentials.json'), 'x');
    return { dir, ctx: { cwd: dir, roots: [dir], autoEdit: false } };
  };

  it("isn't narrowed when it has a glob or pattern of its own (the exclusion would replace it): it's turned down", () => {
    const { dir, ctx } = tree();
    expect(confineSearch('Grep', { pattern: 'KEY', path: dir, glob: 'src/**' }, ctx)).toBeUndefined();
    expect(decideTool('Grep', { pattern: 'KEY', path: dir, glob: 'src/**' }, ctx)).toBe('deny');
    expect(confineSearch('Glob', { pattern: 'src/*', path: dir }, ctx)).toBeUndefined();
    expect(decideTool('Glob', { pattern: 'src/*', path: dir }, ctx)).toBe('deny');
    // The whole tree, asked for as such, is narrowed as before.
    expect(String(confineSearch('Glob', { pattern: '**', path: dir }, ctx)?.pattern).startsWith('!')).toBe(true);
  });
});

describe('a directory search, judged on what it finds', () => {
  it("won't put a credential file with a space in its name into the exclusion glob: the search is turned down", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'beluga-policy-space-'));
    writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    writeFileSync(path.join(dir, 'my secret.pem'), 'x');
    const here = { cwd: dir, roots: [dir], autoEdit: false };
    expect(confineSearch('Grep', { pattern: 'KEY', path: dir }, here)).toBeUndefined();
    expect(confineSearch('Glob', { pattern: '**/*', path: dir }, here)).toBeUndefined();
    expect(decideTool('Grep', { pattern: 'KEY', path: dir }, here)).toBe('deny');
    expect(decideTool('Glob', { pattern: '**/*', path: dir }, { ...here, scope: 'full' })).toBe('deny');
  });

  it('walks a folder once for a few seconds, then again', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'beluga-policy-cache-'));
    const key = path.join(dir, 'credentials.json');
    writeFileSync(key, 'x');
    const t = 1_000_000;
    expect(scanSearch(dir, t)?.hits.map((h) => h.rel)).toEqual(['credentials.json']);
    rmSync(key);
    // The same call judged again (the hook, then canUseTool): what was walked is kept.
    expect(scanSearch(dir, t + 500)?.hits.map((h) => h.rel)).toEqual(['credentials.json']);
    // A later call walks it again.
    expect(scanSearch(dir, t + 60_000)?.hits).toEqual([]);
  });

  it('asks about a search cut off before the end whose own glob could still pick a key, even with full trust', () => {
    const undo = limitSearchScanForTest(2);
    try {
      const dir = mkdtempSync(path.join(tmpdir(), 'beluga-policy-cutoff-'));
      for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(path.join(dir, name), 'x');
      mkdirSync(path.join(dir, 'src'));
      writeFileSync(path.join(dir, 'src', 'credentials.json'), 'x');
      const ctx = { cwd: dir, roots: [dir], autoEdit: false };
      expect(scanSearch(dir)?.truncated).toBe(true);
      expect(decideTool('Grep', { pattern: 'KEY', path: dir, glob: 'src/**' }, ctx)).toBe('ask');
      expect(decideTool('Grep', { pattern: 'KEY', path: dir, glob: 'src/**' }, { ...ctx, scope: 'full' })).toBe('ask');
      expect(decideTool('Glob', { pattern: 'src/*', path: dir }, ctx)).toBe('ask');
      expect(decideTool('Grep', { pattern: 'KEY', path: dir, glob: '!*.md' }, ctx)).toBe('ask');
      // A glob that can't pick a credential file runs as before.
      expect(decideTool('Grep', { pattern: 'KEY', path: dir, glob: '**/*.ts' }, ctx)).toBe('allow');
      expect(decideTool('Glob', { pattern: 'src/**/*.{ts,tsx}', path: dir }, ctx)).toBe('allow');
      // No glob of its own: narrowed to leave every named secret out, then allowed.
      const next = confineSearch('Grep', { pattern: 'KEY', path: dir }, ctx);
      expect(String(next?.glob).startsWith('!')).toBe(true);
      expect(decideTool('Grep', next!, ctx)).toBe('allow');
    } finally {
      undo();
    }
  });
});

describe('an image you attached (an answer to a question links it)', () => {
  const dir = attachmentsDir();
  mkdirSync(path.join(dir, 'received'), { recursive: true });
  mkdirSync(path.join(dir, 'room'), { recursive: true });
  for (const f of ['shot.png', 'notes.txt', path.join('received', 'f-shot.png'), path.join('room', 'shot.png')]) writeFileSync(path.join(dir, f), 'x');
  const outside = mkdtempSync(path.join(tmpdir(), 'policy-img-'));
  writeFileSync(path.join(outside, 'private.png'), 'x');
  const own = { cwd: '/work/proj', roots: ['/work/proj'], autoEdit: false, scope: 'full' as const, dotenv: true, yourRun: true };
  const friend = { cwd: '/work/proj', roots: ['/work/proj'], autoEdit: false, scope: 'full' as const };

  it('your own run reads it, without a new question even at folder reach', () => {
    expect(decideTool('Read', { file_path: path.join(dir, 'shot.png') }, own)).toBe('allow');
    expect(decideTool('Read', { file_path: path.join(dir, 'shot.png') }, { ...own, scope: 'folder' })).toBe('allow');
  });

  it("a friend's, a guest's or an external agent's run doesn't: the folder stays Beluga's own", () => {
    expect(decideTool('Read', { file_path: path.join(dir, 'shot.png') }, friend)).toBe('deny');
    expect(decideTool('Read', { file_path: path.join(dir, 'shot.png') }, { ...friend, guest: true })).toBe('deny');
    // An external agent at full trust has dotenv, never yourRun.
    expect(decideTool('Read', { file_path: path.join(dir, 'shot.png') }, { ...friend, dotenv: true })).toBe('deny');
    expect(isYourRun({ canUseSecret: () => true })).toBe(true);
    expect(isYourRun({ canUseSecret: () => true, asOwner: true })).toBe(false);
    expect(isYourRun({ canUseSecret: () => true, guest: true })).toBe(false);
    expect(isYourRun({})).toBe(false);
  });

  it('only an image right in the folder: not received/, room/, another file, or a way out', () => {
    expect(decideTool('Read', { file_path: path.join(dir, 'received', 'f-shot.png') }, own)).toBe('deny');
    expect(decideTool('Read', { file_path: path.join(dir, 'room', 'shot.png') }, own)).toBe('deny');
    expect(decideTool('Read', { file_path: path.join(dir, 'notes.txt') }, own)).toBe('deny');
    expect(decideTool('Read', { file_path: `${dir}/received/../../identity.png` }, own)).toBe('deny');
    expect(decideTool('Read', { file_path: `${dir}/../attachments-x.png` }, own)).toBe('deny');
    expect(decideTool('NotebookRead', { notebook_path: path.join(dir, 'shot.png') }, own)).toBe('deny');
  });

  // Symlinks need privileges on Windows.
  it.skipIf(process.platform === 'win32')('a link named like an image is judged where it really points', () => {
    const out = path.join(dir, 'linked-out.png');
    rmSync(out, { force: true });
    symlinkSync(path.join(outside, 'private.png'), out);
    expect(decideTool('Read', { file_path: out }, own)).toBe('deny');
    const down = path.join(dir, 'linked-down.png');
    rmSync(down, { force: true });
    symlinkSync(path.join(dir, 'received', 'f-shot.png'), down);
    expect(decideTool('Read', { file_path: down }, own)).toBe('deny');
  });

  it('no search, listing, writing or sending there', () => {
    expect(decideTool('Grep', { pattern: 'x', path: dir }, own)).toBe('deny');
    expect(decideTool('Glob', { pattern: '*.png', path: dir }, own)).toBe('deny');
    expect(decideTool('LS', { path: dir }, own)).toBe('deny');
    expect(decideTool('Write', { file_path: path.join(dir, 'shot.png') }, own)).toBe('deny');
    expect(decideTool('Write', { file_path: path.join(dir, 'room', 'new.png') }, own)).toBe('deny');
    expect(decideTool('mcp__beluga__send_file', { path: path.join(dir, 'shot.png') }, own)).toBe('deny');
  });
});
