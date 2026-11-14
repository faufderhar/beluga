// Shells for the built-in terminal, as data: their friendly names and how to start them. Browser-safe.

/** A shell installed on this computer. */
export interface ShellChoice {
  readonly path: string;
  /** "zsh", "bash", "fish", "Nushell"… */
  readonly name: string;
  /** Your login shell ($SHELL): what Beluga uses when you haven't picked one. */
  readonly isDefault: boolean;
}

const NAMES: Readonly<Record<string, string>> = {
  zsh: 'zsh',
  bash: 'bash',
  sh: 'sh',
  dash: 'dash',
  ksh: 'ksh',
  mksh: 'mksh',
  tcsh: 'tcsh',
  csh: 'csh',
  fish: 'fish',
  nu: 'Nushell',
  elvish: 'Elvish',
  xonsh: 'xonsh',
  pwsh: 'PowerShell',
  'pwsh-preview': 'PowerShell Preview',
  oil: 'Oils',
  osh: 'Oils (osh)',
  ysh: 'Oils (ysh)',
  powershell: 'Windows PowerShell',
  cmd: 'Command Prompt',
};

/** A Windows program's file ("bash.exe", "code.cmd"): its name is the part before. */
const WINDOWS_PROGRAM = /\.(exe|cmd|bat|com)$/i;

/** The program's name without its folder, nor ".exe" on Windows ("bash" for C:\…\bash.exe). */
const base = (file: string): string => (file.split(/[\\/]/).pop() ?? file).replace(WINDOWS_PROGRAM, '');

/** "fish" for /opt/homebrew/bin/fish, "PowerShell" for …\pwsh.exe; unknown shells keep their file name. */
export const shellName = (file: string): string => NAMES[base(file)] ?? NAMES[base(file).toLowerCase()] ?? base(file);

const POSIX = ['zsh', 'bash', 'sh', 'dash', 'ksh', 'mksh', 'osh'];

/** Shells that understand POSIX sh syntax (`a && b`, `$(…)`), so scripts written for sh run in them. */
export const isPosixShell = (file: string): boolean => POSIX.includes(base(file).toLowerCase());

/**
 * Whether the shell takes `-l` (start as a login shell). Every shell on a Mac and Linux keeps it, as
 * before; a Windows program only when it's one that knows it (Git Bash, fish, nu), never
 * PowerShell or cmd.
 */
export const takesLoginFlag = (file: string | undefined): boolean => {
  if (!file || !WINDOWS_PROGRAM.test(file)) return true;
  const name = base(file).toLowerCase();
  return POSIX.includes(name) || name === 'fish' || name === 'nu';
};

/**
 * Arguments for an interactive shell: `-l` when it's a login shell (and the shell takes it), then
 * your own. No `shell` is a shell from a Mac or Linux.
 */
export const shellArgs = (opts: { readonly login: boolean; readonly extra: readonly string[]; readonly shell?: string }): string[] => [...(opts.login && takesLoginFlag(opts.shell) ? ['-l'] : []), ...opts.extra];

/**
 * Arguments that make `shell` run one command line and end: `-l -c …` for sh-like shells (and
 * any shell on a Mac or Linux, as before), `-Command …` for PowerShell, `/d /s /c …` for cmd.
 */
export function commandArgs(shell: string | undefined, command: string): string[] {
  const line = heldOpen(shell, command);
  if (!shell || !WINDOWS_PROGRAM.test(shell)) return ['-l', '-c', line];
  const name = base(shell).toLowerCase();
  if (name === 'pwsh' || name === 'powershell') return ['-NoLogo', '-Command', command];
  if (name === 'cmd') return ['/d', '/s', '/c', command];
  return takesLoginFlag(shell) ? ['-l', '-c', line] : ['-c', line];
}

/**
 * An sh-like shell's command line, with the shell kept as the terminal's last process. Given one
 * command, bash and zsh exec it in their place; a program that closes its own output just before it
 * ends (`touch`, most of coreutils) then closes the terminal while it is still alive, the terminal
 * hangs up, and Linux kills it with SIGHUP: a setup that worked reads as failed (2% of `touch .ready`
 * on CI's runners). An `exit` after it keeps the shell there to end last, with the command's code.
 * On its own line, so a comment at the end of the command can't swallow it.
 */
function heldOpen(shell: string | undefined, command: string): string {
  return !shell || isPosixShell(shell) ? `${command}\nexit $?` : command;
}

/**
 * Split typed arguments the way a shell would: spaces separate them, quotes keep spaces in one.
 * `--rcfile "my rc"` → ['--rcfile', 'my rc'].
 */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let any = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (current || any) out.push(current);
      current = '';
      any = false;
    } else current += ch;
  }
  if (current || any) out.push(current);
  return out;
}

/** Arguments back into text for editing (quoted where they hold spaces). */
export const joinArgs = (args: readonly string[]): string => args.map((a) => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, "'")}"` : a)).join(' ');
