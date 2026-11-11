import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { confineSearch, decideTool, writesCode } from '../src/agent/policy.js';

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
