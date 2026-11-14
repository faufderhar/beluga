import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildShellAppend, loginShellSetup } from '../src/agent/prompt.js';
import { runInstructions } from '../src/agent/run-instructions.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { ZSH_COMPAT, ZSH_COMPAT_FILE, claudeCodeShell, claudeShellSetup, zshCompatEnv } from '../src/agent/runtime/claude/zsh-compat.js';
import { keptBashInput } from '../src/workspaces/test-procs.js';

const home = (): string => mkdtempSync(path.join(os.tmpdir(), 'zsh-compat-'));

const ZSH = ['/bin/zsh', '/usr/bin/zsh'].find((file) => existsSync(file));

/** Agents write bash, and Claude Code runs it in zsh on most Macs: zsh stopped whole commands on bash habits. */
describe('zsh compat for Claude runs', () => {
  it('points CLAUDE_ENV_FILE at a file it writes in Beluga’s home', () => {
    const dir = home();
    const env = zshCompatEnv({}, dir, 'darwin');
    expect(env.CLAUDE_ENV_FILE).toBe(path.join(dir, ZSH_COMPAT_FILE));
    expect(readFileSync(env.CLAUDE_ENV_FILE!, 'utf8')).toBe(ZSH_COMPAT);
  });

  it('rewrites a file that drifted', () => {
    const dir = home();
    writeFileSync(path.join(dir, ZSH_COMPAT_FILE), 'old');
    zshCompatEnv({}, dir, 'darwin');
    expect(readFileSync(path.join(dir, ZSH_COMPAT_FILE), 'utf8')).toBe(ZSH_COMPAT);
  });

  it('leaves your own CLAUDE_ENV_FILE alone', () => {
    expect(zshCompatEnv({ CLAUDE_ENV_FILE: '/x/env.sh' }, home(), 'darwin')).toEqual({});
  });

  it('turns on only the options that make a failing command go on as bash would', () => {
    expect(ZSH_COMPAT).toContain('setopt NO_NOMATCH NO_BAD_PATTERN NO_EQUALS;');
    // These also change how your own shell functions (nvm, conda, zoxide) read variables and print.
    for (const option of ['SH_WORD_SPLIT', 'KSH_ARRAYS', 'BSD_ECHO']) expect(ZSH_COMPAT).not.toContain(option);
  });

  it.skipIf(!ZSH)('makes zsh take an unmatched glob, a bad pattern and == the way bash does', () => {
    const script = 'a=x; [ "$a" == x ] && echo eq; echo nope*.zzz; echo "a?b=1" ok*[; echo done';
    const out = execFileSync(ZSH!, ['-f', '-c', `${ZSH_COMPAT}${script}`], { encoding: 'utf8', cwd: home() });
    expect(out).toBe('eq\nnope*.zzz\na?b=1 ok*[\ndone\n');
  });

  it.skipIf(!ZSH)('leaves how zsh functions read $path, arrays and echo as zsh has them', () => {
    const fn = 'f() { n=0; for d in $path; do n=$((n+1)); done; arr=(a b c); echo "$n $#arr $arr[1]"; echo "x\\ty"; }; path=(/a /b /c); f';
    const out = execFileSync(ZSH!, ['-f', '-c', `${ZSH_COMPAT}${fn}`], { encoding: 'utf8', cwd: home() });
    expect(out).toBe('3 3 a\nx\ty\n');
  });

  it('does nothing in bash', () => {
    const out = execFileSync('/bin/sh', ['-c', `${ZSH_COMPAT}echo ok`], { encoding: 'utf8' });
    expect(out).toBe('ok\n');
  });
});

/** Claude Code picks its own shell (CLAUDE_CODE_SHELL, $SHELL when bash or zsh, else zsh first); the prompt follows it. */
describe("Claude Code's shell", () => {
  const all = (): boolean => true;
  const only = (...files: string[]) => (file: string): boolean => files.includes(file);

  it('takes CLAUDE_CODE_SHELL, then $SHELL, when either is a bash or zsh it can run', () => {
    expect(claudeCodeShell({ CLAUDE_CODE_SHELL: '/bin/bash', SHELL: '/bin/zsh' }, 'darwin', all)).toBe('bash');
    expect(claudeCodeShell({ SHELL: '/opt/homebrew/bin/zsh' }, 'darwin', all)).toBe('zsh');
    expect(claudeCodeShell({ SHELL: '/bin/bash' }, 'linux', all)).toBe('bash');
    // An override it can't run is passed over.
    expect(claudeCodeShell({ CLAUDE_CODE_SHELL: '/nope/bash', SHELL: '/bin/zsh' }, 'darwin', only('/bin/zsh'))).toBe('zsh');
  });

  it("runs a fish user's commands in zsh, before bash", () => {
    expect(claudeCodeShell({ SHELL: '/opt/homebrew/bin/fish', PATH: '/usr/bin' }, 'darwin', only('/bin/zsh', '/bin/bash'))).toBe('zsh');
    expect(claudeCodeShell({ SHELL: '/usr/bin/fish', PATH: '/usr/bin' }, 'linux', only('/usr/bin/bash'))).toBe('bash');
    expect(claudeCodeShell({ SHELL: '/usr/bin/fish' }, 'linux', () => false)).toBeUndefined();
  });

  it('is none of these on Windows (Git Bash)', () => {
    expect(claudeCodeShell({ SHELL: '/bin/zsh' }, 'win32', all)).toBeUndefined();
  });

  it('words the prompt for the compat file only when Beluga set it', () => {
    const zsh = { SHELL: '/bin/zsh' };
    expect(claudeShellSetup(zsh, { CLAUDE_ENV_FILE: '/b/zsh-compat.sh' }, 'darwin', all)).toBe('zsh-compat');
    expect(claudeShellSetup(zsh, {}, 'darwin', all)).toBe('zsh');
    expect(claudeShellSetup({ SHELL: '/bin/bash' }, { CLAUDE_ENV_FILE: '/b/zsh-compat.sh' }, 'linux', all)).toBe('other');
  });
});

describe('the shell piece of the prompt', () => {
  const said = (setup: Parameters<typeof buildShellAppend>[0]): string => buildShellAppend(setup).replace(/\s+/g, ' ');

  it('tells an agent on plain zsh to write for it', () => {
    const text = said('zsh');
    expect(text).toContain('Your shell commands run in zsh, not bash.');
    expect(text).toContain('stops the whole command');
    expect(text).toContain('[[ $a == b ]]');
    expect(text).toContain('arrays count from 1');
    expect(text).toContain('`printf');
    expect(text).toContain('never name a variable `path`');
  });

  it("tells Claude its zsh takes common bash, and what's still zsh", () => {
    const text = said('zsh-compat');
    expect(text).toContain('set up to take common bash');
    expect(text).not.toContain('not bash');
    expect(text).not.toContain('stops the whole command');
    expect(text).toContain('Still quote globs and URLs');
    expect(text).toContain('[[ $a == b ]]');
    expect(text).toContain('never name a variable `path`');
  });

  it('says nothing for bash or anything else', () => {
    expect(buildShellAppend('other')).toBe('');
  });

  it.each([
    ['/bin/bash', 'linux'],
    ['/usr/bin/fish', 'darwin'],
    ['', 'linux'],
    ['C:\\Program Files\\Git\\bin\\zsh.exe', 'win32'],
  ] as const)('has no login-shell piece for %s on %s', (shell, platform) => {
    expect(loginShellSetup(shell, platform)).toBe('other');
  });

  it('has the plain piece for a zsh login shell', () => {
    expect(loginShellSetup('/usr/bin/zsh', 'linux')).toBe('zsh');
  });

  it("goes into a run's instructions as the runner says", () => {
    const input = { prompt: 'x', requesterName: 'mia' } as unknown as AgentRunInput;
    expect(runInstructions(input, 'kay', undefined, 'zsh-compat')).toContain('set up to take common bash');
    expect(runInstructions(input, 'kay', { runtime: 'codex', label: 'Codex' }, 'zsh')).toContain('not bash');
    expect(runInstructions(input, 'kay', undefined, 'other')).not.toContain('Your shell commands run in zsh');
  });
});

describe('a command kept past the turn', () => {
  it('runs zsh-compat.sh in its own shell first, only in zsh and when the file is there', () => {
    const kept = keptBashInput('Bash', { command: 'BELUGA_KEEP=1 npm run dev', run_in_background: true }, '/w/.beluga/scratch/kept.log', '/b/zsh-compat.sh');
    expect(String(kept?.command)).toContain(`-c '[ -n "$ZSH_VERSION" ] && [ -f '\\''/b/zsh-compat.sh'\\'' ] && . '\\''/b/zsh-compat.sh'\\''; BELUGA_KEEP=1 npm run dev'`);
    const without = keptBashInput('Bash', { command: 'BELUGA_KEEP=1 npm run dev', run_in_background: true }, '/w/.beluga/scratch/kept.log');
    expect(String(without?.command)).not.toContain('ZSH_VERSION');
  });

  it.skipIf(!ZSH)('takes an unmatched glob in the detached zsh', () => {
    const dir = home();
    const file = zshCompatEnv({}, dir, 'darwin').CLAUDE_ENV_FILE!;
    const log = path.join(dir, 'kept.log');
    const kept = keptBashInput('Bash', { command: 'BELUGA_KEEP=1 echo nope*.zzz', run_in_background: true }, log, file);
    // Only the inner command: the outer one starts it detached and returns at once.
    const inner = /-c ('(?:[^']|'\\'')*') >/.exec(String(kept?.command))?.[1] ?? '';
    const out = execFileSync(ZSH!, ['-f', '-c', `${ZSH} -f -c ${inner}`], { encoding: 'utf8', cwd: dir });
    expect(out).toBe('nope*.zzz\n');
  });
});

describe('zsh-compat on Windows', () => {
  it('sets nothing: Claude Code runs commands in Git Bash there', () => {
    expect(zshCompatEnv({}, mkdtempSync(path.join(os.tmpdir(), 'beluga-zsh-win-')), 'win32')).toEqual({});
  });
});
