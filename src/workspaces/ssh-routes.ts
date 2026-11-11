import { sshRemoteOf } from '../shared/git-trouble.js';

/**
 * https addresses Beluga found it can't use but SSH can, for the rest of the daemon's run: each is
 * an `insteadOf` given to the git commands that talk to a remote (fetch, push, ls-remote, pull), so
 * every one of them, from any worktree, goes over SSH there. Nothing in anyone's git config
 * changes. A repository whose https sign-in failed is routed on its own; when git's https helper
 * itself is broken, the whole host is (no https address there can work).
 */

/** https prefix → its SSH stand-in. */
const routes = new Map<string, string>();

/** git's commands that reach a remote. */
const NETWORK = new Set(['fetch', 'push', 'pull', 'ls-remote']);

/** `url` (an https remote) goes over SSH from now on; `wholeHost`: every address on its host does. */
export function rememberSshRoute(url: string, wholeHost: boolean): void {
  const ssh = sshRemoteOf(url);
  if (!ssh) return;
  if (wholeHost) routes.set(ssh.host.https, ssh.host.ssh);
  else routes.set(url.trim(), ssh.url);
}

/** SSH stopped working for `url`: back to https for it (and for its host). */
export function forgetSshRoute(url: string): void {
  const ssh = sshRemoteOf(url);
  routes.delete(url.trim());
  if (ssh) routes.delete(ssh.host.https);
}

/** `url` is routed over SSH now. */
export const routedOverSsh = (url: string | undefined): boolean => {
  const ssh = url ? sshRemoteOf(url) : undefined;
  return Boolean(ssh && (routes.has(url!.trim()) || routes.has(ssh.host.https)));
};

/** The `-c` options for one git command that sends `url` over SSH (whether or not it's remembered). */
export function sshArgsFor(url: string | undefined): readonly string[] | undefined {
  const ssh = sshRemoteOf(url);
  return ssh ? ['-c', `url.${ssh.host.ssh}.insteadOf=${ssh.host.https}`] : undefined;
}

/** The `-c` options for every remembered route. */
export const sshRouteArgs = (): readonly string[] => [...routes].flatMap(([https, ssh]) => ['-c', `url.${ssh}.insteadOf=${https}`]);

/** git's subcommand in `args` (past the -c options before it). */
function subcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') i++;
    else if (!args[i]!.startsWith('-')) return args[i];
  }
  return undefined;
}

/** `args` with the remembered routes in front when the command reaches a remote; as it is otherwise. */
export function withSshRoutes(args: readonly string[]): readonly string[] {
  if (!routes.size || !NETWORK.has(subcommand(args) ?? '')) return args;
  return [...sshRouteArgs(), ...args];
}

/** Forget every route (tests). */
export function clearSshRoutes(): void {
  routes.clear();
}
