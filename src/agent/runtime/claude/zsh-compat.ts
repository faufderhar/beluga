import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { belugaHome } from '../../../core/home.js';
import type { ShellSetup } from '../../prompt.js';

/**
 * Claude Code runs its Bash tool in zsh on most Macs, and the model writes bash. In zsh that stops
 * a whole command on an unquoted glob or URL that matches nothing (`--include=*.ts`, `curl …?a=1`),
 * a pattern zsh can't parse, and `[ a == b ]`. These options make zsh leave them as typed, the way
 * bash does; in bash the file does nothing.
 *
 * Only options that change what fails into what bash does. They also reach the functions your
 * shell defines (nvm, conda, zoxide), which Claude Code loads ahead of each command, so none
 * changes how working zsh code reads its variables or prints: no SH_WORD_SPLIT or KSH_ARRAYS (a
 * loop over `$path` saw one folder, `$#arr` gave 1), no BSD_ECHO (a function's `echo "\e[1m"`
 * printed the escape as text). The prompt covers those habits instead (prompt.ts).
 */
export const ZSH_COMPAT = 'if [ -n "$ZSH_VERSION" ]; then setopt NO_NOMATCH NO_BAD_PATTERN NO_EQUALS; fi\n';

export const ZSH_COMPAT_FILE = 'zsh-compat.sh';

const current = (file: string): boolean => {
  try {
    return readFileSync(file, 'utf8') === ZSH_COMPAT;
  } catch {
    return false;
  }
};

/**
 * CLAUDE_ENV_FILE for a Claude run: a script Claude Code runs ahead of every Bash command. Left alone
 * when you set one yourself; nothing when the file can't be written.
 */
export function zshCompatEnv(env: Readonly<Record<string, string | undefined>>, home: string = belugaHome(), platform: NodeJS.Platform = process.platform): Record<string, string> {
  // Windows runs Claude Code's commands in Git Bash, never zsh.
  if (env.CLAUDE_ENV_FILE || platform === 'win32') return {};
  const file = path.join(home, ZSH_COMPAT_FILE);
  if (current(file)) return { CLAUDE_ENV_FILE: file };
  try {
    mkdirSync(home, { recursive: true });
    // Whole or not at all: a run starting meanwhile never sources half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, ZSH_COMPAT);
    renameSync(tmp, file);
    return { CLAUDE_ENV_FILE: file };
  } catch {
    return {};
  }
}

const runnable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Where Claude Code looks for a shell besides PATH. */
const SHELL_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];

/**
 * The shell Claude Code runs its Bash tool in, chosen its way: CLAUDE_CODE_SHELL, then $SHELL, when
 * either is a bash or zsh it can run; else zsh before bash, on PATH or in the usual folders. So a
 * fish user's commands run in zsh. Undefined on Windows (Git Bash) or when there's neither.
 */
export function claudeCodeShell(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform, canRun: (file: string) => boolean = runnable): 'zsh' | 'bash' | undefined {
  if (platform === 'win32') return undefined;
  const kind = (file: string): 'zsh' | 'bash' => (path.basename(file).includes('zsh') ? 'zsh' : 'bash');
  const named = [env.CLAUDE_CODE_SHELL, env.SHELL].find((file) => file && (file.includes('bash') || file.includes('zsh')) && canRun(file));
  if (named) return kind(named);
  const dirs = [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...SHELL_DIRS];
  return (['zsh', 'bash'] as const).find((shell) => dirs.some((dir) => canRun(path.join(dir, shell))));
}

/**
 * What a Claude run's prompt says about its shell (prompt.ts buildShellAppend): zsh with the compat
 * file when Beluga set it (`compat`, from zshCompatEnv), plain zsh when you set your own; `other` on bash.
 */
export function claudeShellSetup(env: Readonly<Record<string, string | undefined>>, compat: Readonly<Record<string, string>>, platform: NodeJS.Platform = process.platform, canRun?: (file: string) => boolean): ShellSetup {
  if (claudeCodeShell(env, platform, canRun) !== 'zsh') return 'other';
  return compat.CLAUDE_ENV_FILE ? 'zsh-compat' : 'zsh';
}
