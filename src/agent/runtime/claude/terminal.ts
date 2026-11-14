import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathVariants } from './claude-sessions.js';
import { belugaHome } from '../../../core/home.js';
import type { AgentRef } from '../../../protocol.js';
import { claudeCodeCommand, claudeCodeReady } from '../../claude-code.js';
import { type PolicyContext, isYourRun } from '../../policy.js';
import { runInstructions } from '../../run-instructions.js';
import { runToolSuites } from '../../run-tools.js';
import { GATE_TOKEN_ENV, GATE_URL_ENV, gateHookFile, gateHookSettings, terminalHookAnswer } from '../../terminal-hook.js';
import { ToolHost } from '../../tool-host.js';
import { gateTool } from '../../tool-gate.js';
import type { AgentRunInput, RoomBridge, TerminalLaunch, TerminalSink } from '../../types.js';
import { TerminalShelf } from '../../view-tools.js';
import { claudeShellSetup, zshCompatEnv } from './zsh-compat.js';

/** Claude Code's own settings file (~/.claude.json, or in $CLAUDE_CONFIG_DIR). */
const claudeJson = (env: NodeJS.ProcessEnv = process.env): string => (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'));

/**
 * The folder trusted in Claude Code, as its own "Yes, I trust this folder" does: Beluga made this
 * worktree (and runs Claude in it already), so its terminal opens straight on the conversation
 * instead of asking first, where Return means "No, exit". Only this folder's flag is written, and
 * only when it isn't set; the file is replaced whole (a crash never leaves half of it).
 */
export function trustFolder(dir: string, file = claudeJson()): void {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    raw = '{}';
  }
  let config: { projects?: Record<string, Record<string, unknown>> };
  try {
    config = JSON.parse(raw) as typeof config;
  } catch {
    return; // not ours to repair
  }
  if (!config || typeof config !== 'object') return;
  const projects = (config.projects ??= {});
  // On Windows Claude Code keys its projects with forward slashes (C:/Users/…): both spellings.
  const keys = [...new Set(pathVariants(dir).flatMap((k) => (process.platform === 'win32' ? [k, k.replaceAll('\\', '/')] : [k])))];
  if (keys.some((k) => projects[k]?.hasTrustDialogAccepted === true)) return;
  for (const k of keys) projects[k] = { ...projects[k], hasTrustDialogAccepted: true };
  const tmp = `${file}.beluga-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Claude Code asks, as it always would
  }
}

/**
 * Where a run's MCP config goes: it holds the run's token, which a command line would show to every
 * process in `ps`. Under Beluga's home, as the worktree's scratch folder shows on your screens and
 * to friends sharing it, and may not exist. A file left by a crash holds a token that died with the daemon.
 */
function writeMcpConfig(servers: unknown, home = belugaHome()): { file: string; remove(): void } {
  const dir = path.join(home, 'terminal');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `mcp-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600, flag: 'wx' });
  return {
    file,
    remove: () => {
      try {
        rmSync(file, { force: true });
      } catch {
        // its token stopped working when the run closed
      }
    },
  };
}

let sharedHost: ToolHost | undefined;
const toolHost = (): ToolHost => (sharedHost ??= new ToolHost());

export interface ClaudeTerminalOptions {
  readonly bridge: RoomBridge;
  /** Claude Code to run (unset: the one Beluga downloaded, else the SDK's, else `claude` on PATH). */
  readonly claudePath?: string;
  readonly model?: string;
  readonly agentOf?: (input: AgentRunInput) => AgentRef | undefined;
  readonly toolHost?: ToolHost;
  /** Node, to run the hook (this daemon's own). */
  readonly node?: string;
  readonly home?: string;
}

/**
 * The arguments that open Claude Code on a conversation: the one it had (`--resume`), a copy of the
 * one it was forked from, or a new one under an id given up front, so its transcript is known
 * from the first word typed.
 */
export function sessionArgs(resume: string | undefined, fork: boolean, newId: () => string = randomUUID): { args: string[]; session: string; fresh: boolean } {
  if (resume && !fork) return { args: ['--resume', resume], session: resume, fresh: false };
  const session = newId();
  if (resume) return { args: ['--resume', resume, '--fork-session', '--session-id', session], session, fresh: true };
  return { args: ['--session-id', session], session, fresh: true };
}

/**
 * How the terminal's Claude Code asks, then your `claude` flags (Settings › Agents) as Terminal
 * would take them: a mode of yours (--dangerously-skip-permissions, --permission-mode) over Beluga's.
 */
export function modeArgs(autoEdit: boolean, yours: readonly string[]): string[] {
  const ownMode = yours.some((a) => /^--(dangerously-skip-permissions|permission-mode)(=|$)/.test(a));
  return [...(autoEdit && !ownMode ? ['--permission-mode', 'acceptEdits'] : []), ...yours];
}

/**
 * Claude Code's own terminal app on a workspace's conversation (BLG-534), as a chat run would have
 * it: the same session, Beluga's tools (served for it over the tool host, as Codex's are), Beluga's
 * instructions with the terminal's (visuals as tokens), your user settings only (never a project's
 * .claude/), edits without asking in a worktree, and Beluga's rules as a PreToolUse hook.
 */
export async function claudeTerminal(input: AgentRunInput, sink: TerminalSink, opts: ClaudeTerminalOptions): Promise<TerminalLaunch> {
  const place = input.place;
  if (!place) throw new Error('This conversation has no folder to open a terminal in.');
  await claudeCodeReady();
  const cwd = place.cwd;
  trustFolder(cwd);
  const askOnly = place.askOnly;
  const autoEdit = !askOnly && place.autoEdit;
  const extraDirs = place.additionalDirectories;
  const policy: PolicyContext = { cwd, roots: [cwd, ...extraDirs], autoEdit, scope: input.scope, guest: input.guest, boardAsks: input.boardAsks, dotenv: Boolean(input.canUseSecret) && !input.guest, yourRun: isYourRun(input), askOnly: Boolean(askOnly), ...(place.alsoEdit?.length ? { alsoEdit: place.alsoEdit } : {}) };
  const bridge = input.channel && opts.bridge.inChannel ? opts.bridge.inChannel(input.channel) : opts.bridge;
  const mounted = await (opts.toolHost ?? toolHost()).mount(
    runToolSuites(input, bridge, new TerminalShelf(sink), cwd),
    (name, args) => gateTool(name, args, input, policy),
    async (hook) => terminalHookAnswer(hook, input, policy),
  );
  let config: ReturnType<typeof writeMcpConfig> | undefined;
  const close = (): void => {
    mounted.close();
    config?.remove();
  };
  try {
    config = writeMcpConfig(mounted.servers, opts.home);
    const { args: session, session: id, fresh } = sessionArgs(place.resume, Boolean(place.forkSession));
    const model = input.model ?? opts.model;
    // zsh-compat.sh makes Claude Code's zsh take the bash it writes (zsh-compat.ts); the prompt says what's left.
    const env = { ...process.env, ...input.env };
    const compat = zshCompatEnv(env, opts.home);
    const instructions = runInstructions({ ...input, terminal: true }, opts.bridge.selfName(), opts.agentOf?.(input) ?? place.agent, claudeShellSetup(env, compat));
    const args = [
      ...session,
      // Yours, never a project's .claude/ (see ownerSettings in runner.ts).
      '--setting-sources',
      'user',
      '--mcp-config',
      config.file,
      // Beluga's own tools are checked by Beluga (the tool host's gate: its rules, and you for the
      // risky ones), as in a chat run: Claude Code doesn't ask about them a second time.
      '--allowedTools',
      Object.keys(mounted.servers)
        .map((suite) => `mcp__${suite}`)
        .join(','),
      '--settings',
      JSON.stringify(gateHookSettings(opts.node ?? process.execPath, gateHookFile(opts.home))),
      '--append-system-prompt',
      instructions,
      ...modeArgs(autoEdit, input.launchArgs?.claude ?? []),
      ...(model ? ['--model', model] : []),
      ...extraDirs.flatMap((d) => ['--add-dir', d]),
      // The message you sent from the chat, as the terminal's first prompt (BLG-553); after `--`, so
      // a list option before it (--add-dir) doesn't take it, and a leading "-" stays words.
      ...(input.prompt ? ['--', input.prompt] : []),
    ];
    return {
      file: opts.claudePath ?? claudeCodeCommand(),
      args,
      env: { ...compat, ...input.env, [GATE_URL_ENV]: mounted.hookUrl ?? '', [GATE_TOKEN_ENV]: mounted.token },
      session: id,
      fresh,
      close,
    };
  } catch (err) {
    close();
    throw err;
  }
}
