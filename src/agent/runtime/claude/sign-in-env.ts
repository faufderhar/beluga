/**
 * How Claude Code signs in stays the same for a chat's whole life (BLG-1027). Claude Code started
 * with one of these in its environment signs in with it instead of your claude.ai login, and then
 * leaves out Claude in Chrome, every claude.ai connector and your account. A run gets your project's
 * .env, its variables and keys pasted into the chat (core/env-vars.ts), so a project's Anthropic key
 * (one for its own code) used to switch every later turn of the chat to that key.
 *
 * Such a variable is for the project's code: Claude Code keeps the sign-in it has here, and its Bash
 * commands still see the variable. It travels under another name (BELUGA_SHELL_<NAME>), and
 * Beluga's CLAUDE_ENV_FILE (zsh-compat.ts), which runs before each command, gives it back its own
 * name. Nothing secret is written to disk.
 */

/** The variables Claude Code signs in with, besides its own login on this Mac. */
export const SIGN_IN_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
export type SignInVar = (typeof SIGN_IN_VARS)[number];

/** The name a held variable travels under until the shell gives it back its own. */
export const shellName = (name: SignInVar): string => `BELUGA_SHELL_${name}`;

/** POSIX sh (zsh and bash alike): each held variable back under its own name, for the command only. */
export const SHELL_RESTORE = SIGN_IN_VARS.map((name) => `if [ -n "\${${shellName(name)}+x}" ]; then export ${name}="$${shellName(name)}"; unset ${shellName(name)}; fi\n`).join('');

/**
 * The sign-in variables a run's own variables (`runVars`) would change: set there, to something
 * else than Claude Code has from the daemon (`daemon`, how you signed it in).
 */
export function signInChanges(runVars: Readonly<Record<string, string>> | undefined, daemon: NodeJS.ProcessEnv = process.env): SignInVar[] {
  return SIGN_IN_VARS.filter((name) => runVars?.[name] !== undefined && runVars[name] !== daemon[name]);
}

/**
 * The launch environment with those variables held for the shell: Claude Code gets the daemon's
 * value (or none), its commands get the run's. `launchEnv` undefined: the run inherits the daemon's
 * environment as it is, and nothing changes.
 */
export function holdSignIn(launchEnv: Readonly<Record<string, string>> | undefined, runVars: Readonly<Record<string, string>> | undefined, daemon: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> | undefined {
  const held = signInChanges(runVars, daemon);
  if (!launchEnv || !held.length) return launchEnv;
  const kept = Object.fromEntries(Object.entries(launchEnv).filter(([name]) => !(held as readonly string[]).includes(name)));
  const ours = Object.fromEntries(held.flatMap((name) => (daemon[name] !== undefined ? [[name, daemon[name] as string]] : [])));
  const forShell = Object.fromEntries(held.map((name) => [shellName(name), runVars![name]!]));
  return { ...kept, ...ours, ...forShell };
}

/** The variable Claude Code signs in with in this environment, if any (else its own login here). */
export function signedInWith(env: Readonly<Record<string, string | undefined>>): SignInVar | undefined {
  return SIGN_IN_VARS.find((name) => Boolean(env[name]));
}
