import type { Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk';

/** A run's launch, with your flags (Settings › Agents › Launch flags) in the SDK's words. */
export interface ClaudeLaunch {
  readonly permissionMode: PermissionMode;
  readonly allowDangerouslySkipPermissions?: true;
  readonly extraArgs: NonNullable<Options['extraArgs']>;
}

const SKIP = '--dangerously-skip-permissions';
const MODE = '--permission-mode';

/**
 * Your `claude` flags for a chat run. The two that pick how Claude Code asks become the SDK's own
 * options (passed raw, the SDK's `--permission-mode` would win over them); every other flag goes
 * through as it is. Plan mode stays first: a plan is approved before work starts (its approval
 * switches to the mode `plan: false` gives). Beluga's own rules still run first either way (its PreToolUse hook).
 */
export function claudeLaunch(args: readonly string[], run: { readonly plan: boolean; readonly autoEdit: boolean; readonly chrome?: boolean }): ClaudeLaunch {
  const extraArgs: Record<string, string | null> = {};
  let skip = false;
  let mode: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [flag, inline] = splitFlag(arg);
    const next = args[i + 1];
    const value = inline ?? (next !== undefined && !next.startsWith('-') ? (i++, next) : undefined);
    if (flag === SKIP) skip = true;
    else if (flag === MODE) mode = value;
    else extraArgs[flag.replace(/^-+/, '')] = value ?? null;
  }
  const yours = (mode as PermissionMode | undefined) ?? (skip ? 'bypassPermissions' : run.autoEdit ? 'acceptEdits' : 'default');
  const permissionMode = run.plan ? 'plan' : yours;
  return { permissionMode, ...(skip || yours === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true as const } : {}), extraArgs: withChrome(extraArgs, run.chrome) };
}

/**
 * Claude in Chrome (agent/chrome.ts): `--chrome` on a run that has it, unless your flags said
 * `--no-chrome`. A run without it never connects, whatever your flags asked for.
 */
function withChrome(extraArgs: Record<string, string | null>, chrome: boolean | undefined): Record<string, string | null> {
  const { chrome: _on, 'no-chrome': off, ...rest } = extraArgs;
  if (off !== undefined) return { ...rest, 'no-chrome': null };
  return chrome ? { ...rest, chrome: null } : rest;
}

/** `--flag=value` → ['--flag', 'value']; `--flag` → ['--flag', undefined]. */
function splitFlag(arg: string): [string, string | undefined] {
  const at = arg.indexOf('=');
  return at > 0 ? [arg.slice(0, at), arg.slice(at + 1)] : [arg, undefined];
}
