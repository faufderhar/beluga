import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunInput } from '../src/agent/types.js';
import { claudeLaunchEnv, withSignInHint, withZshCompat } from '../src/agent/runtime/claude/runner.js';
import { ZSH_COMPAT, ZSH_COMPAT_FILE } from '../src/agent/runtime/claude/zsh-compat.js';
import { failureTitle } from '../src/shared/run-failure.js';
import { room } from './runtime-conformance.js';

const sdk = vi.hoisted(() => ({ options: undefined as Options | undefined }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: ({ options }: { options: Options }) => {
    sdk.options = options;
    async function* run() {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', modelUsage: {}, total_cost_usd: 0, session_id: 's1' };
    }
    return Object.assign(run(), { interrupt: async () => undefined, setModel: async () => undefined, setPermissionMode: async () => undefined, close: () => undefined });
  },
}));

const { createClaudeBackend } = await import('../src/agent/runtime/claude/runner.js');

const PLANTED = ['AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'BELUGA_PLAIN_MARKER'] as const;
const saved: Record<string, string | undefined> = {};
let planted = false;

function plant(): void {
  if (!planted) for (const key of PLANTED) saved[key] = process.env[key];
  planted = true;
  process.env.AWS_SECRET_ACCESS_KEY = 'planted-aws';
  process.env.ANTHROPIC_API_KEY = 'planted-api';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'planted-oauth';
  process.env.BELUGA_PLAIN_MARKER = 'planted-plain';
}

function restore(): void {
  if (!planted) return;
  for (const key of PLANTED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  planted = false;
}

function input(dir: string, extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    prompt: 'look',
    requesterName: 'mia',
    viaAgent: false,
    context: [],
    scope: 'folder',
    signal: new AbortController().signal,
    onEvent: () => undefined,
    onFileTouched: () => undefined,
    canUseTool: async () => true,
    place: { cwd: dir, additionalDirectories: [], autoEdit: false, onSession: () => undefined },
    ...extra,
  };
}

describe('a friend or guest Claude launch', () => {
  afterEach(() => {
    sdk.options = undefined;
    restore();
  });

  it('does not inherit the daemon environment, and still has PATH and HOME', async () => {
    plant();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-launch-env-'));
    const backend = createClaudeBackend({ cwd: dir, autoEdit: false, additionalDirectories: [], bridge: room });
    await backend.run(input(dir, { channel: 'room', env: { BELUGA_WORKTREE: dir, AWS_SECRET_ACCESS_KEY: 'from-the-run' } }));
    const env = sdk.options?.env;
    expect(env).toBeDefined();
    expect(env?.PATH).toBe(process.env.PATH);
    expect(env?.HOME).toBe(process.env.HOME);
    expect(env?.CI).toBe('1');
    expect(env?.BELUGA_WORKTREE).toBe(dir);
    expect(env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env?.BELUGA_PLAIN_MARKER).toBeUndefined();
  });

  it('keeps your own run’s environment, including a compaction and a dialogue', () => {
    plant();
    const own = claudeLaunchEnv({ ownerMcp: true, viaAgent: false, channel: 'room', autoCompactAt: 70 });
    expect(own?.AWS_SECRET_ACCESS_KEY).toBe('planted-aws');
    expect(own?.ANTHROPIC_API_KEY).toBe('planted-api');
    expect(own?.BELUGA_PLAIN_MARKER).toBe('planted-plain');
    expect(own?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('70');
    // Nothing passed in: your own Claude inherits the process, tokens included.
    expect(claudeLaunchEnv({ ownerMcp: true, viaAgent: false, channel: 'ws:1' })).toBeUndefined();
    // Compaction has none of the friend markers, so it keeps the daemon environment too.
    const compact = claudeLaunchEnv({ viaAgent: false, autoCompactAt: 80 });
    expect(compact?.AWS_SECRET_ACCESS_KEY).toBe('planted-aws');
    expect(claudeLaunchEnv({ viaAgent: false })).toBeUndefined();
    const dialogue = claudeLaunchEnv({ viaAgent: false, channel: 'room', vetTool: () => undefined, dialogue: {} as NonNullable<AgentRunInput['dialogue']>, autoCompactAt: 70 });
    expect(dialogue?.CLAUDE_CODE_OAUTH_TOKEN).toBe('planted-oauth');
    const guest = claudeLaunchEnv({ guest: true, ownerMcp: true, viaAgent: false });
    expect(guest?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(guest?.PATH).toBe(process.env.PATH);
  });

  it('narrows a directory search so the credential file is not what runs', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'beluga-launch-search-'));
    const dir = path.join(base, 'work');
    const outside = path.join(base, 'outside');
    mkdirSync(dir);
    mkdirSync(outside);
    writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    writeFileSync(path.join(dir, 'credentials.json'), 'x');
    writeFileSync(path.join(outside, 'id_ed25519'), 'x');
    symlinkSync(path.join(outside, 'id_ed25519'), path.join(dir, 'alias.txt'));
    const backend = createClaudeBackend({ cwd: dir, autoEdit: false, additionalDirectories: [], bridge: room });
    await backend.run(input(dir, { channel: 'room' }));
    const hook = sdk.options?.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const verdict = (await hook({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'KEY', path: dir }, tool_use_id: 't1' } as never, 't1', { signal: new AbortController().signal })) as {
      hookSpecificOutput?: { permissionDecision?: string; updatedInput?: { glob?: string } };
    };
    expect(verdict.hookSpecificOutput?.permissionDecision).toBe('allow');
    const glob = verdict.hookSpecificOutput?.updatedInput?.glob ?? '';
    expect(glob.startsWith('!')).toBe(true);
    expect(glob).toContain('credentials.json');
    expect(glob).toContain('alias.txt');
    const viaCanUse = await sdk.options?.canUseTool?.('Glob', { pattern: '**/*', path: dir }, { signal: new AbortController().signal, toolUseID: 't2' } as never);
    expect(viaCanUse).toMatchObject({ behavior: 'allow' });
    expect(String((viaCanUse as { updatedInput?: { pattern?: string } }).updatedInput?.pattern)).toContain('credentials.json');
    const listed = await hook({ hook_event_name: 'PreToolUse', tool_name: 'LS', tool_input: { path: dir }, tool_use_id: 't3' } as never, 't3', { signal: new AbortController().signal });
    expect(listed).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});

describe("a friend's run keeps Claude Code's own settings", () => {
  const friend = { channel: 'room', vetTool: () => undefined } as unknown as AgentRunInput;
  it('keeps where its config lives, its endpoint and a plain proxy; drops keys, tokens and a proxy with a password', () => {
    const env = claudeLaunchEnv(friend, {
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      HTTPS_PROXY: 'http://proxy.example:3128',
      HTTP_PROXY: 'http://me:hunter2@proxy.example:3128',
      ANTHROPIC_API_KEY: 'sk-ant-planted',
      CLAUDE_CODE_OAUTH_TOKEN: 'planted',
    })!;
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/me/.claude-work');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
    expect(env.HTTPS_PROXY).toBe('http://proxy.example:3128');
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("a friend's run that can't sign in", () => {
  const signedOut = { kind: 'signed_out', detail: 'Invalid API key · Please run /login' } as const;
  const daemon = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-planted' };

  it('says the owner signs Claude Code in with a variable friends never get', () => {
    const scrubbed = claudeLaunchEnv({ channel: 'room', vetTool: () => undefined } as unknown as AgentRunInput, daemon)!;
    const hinted = withSignInHint(signedOut, scrubbed, false, daemon);
    expect(hinted.envSignIn).toBe('ANTHROPIC_API_KEY');
    expect(failureTitle(hinted)).toContain('ANTHROPIC_API_KEY');
    expect(failureTitle(hinted)).not.toContain('isn’t signed in on this Mac');
    // An auth error from the API says it too; one about something else doesn't.
    expect(withSignInHint({ kind: 'api', detail: 'authentication_failed' }, scrubbed, false, daemon).envSignIn).toBe('ANTHROPIC_API_KEY');
    expect(withSignInHint({ kind: 'api', detail: 'overloaded' }, scrubbed, false, daemon).envSignIn).toBeUndefined();
  });

  it("leaves your own run's failure, and a sign-in that isn't from a variable, as they were", () => {
    expect(withSignInHint(signedOut, undefined, true, daemon)).toEqual(signedOut);
    expect(withSignInHint(signedOut, { PATH: '/usr/bin' }, false, { PATH: '/usr/bin' })).toEqual(signedOut);
    expect(withSignInHint({ kind: 'crash', detail: 'exit 1' }, { PATH: '/usr/bin' }, false, daemon).envSignIn).toBeUndefined();
  });
});

/** zsh-compat.sh (runtime/claude/zsh-compat.ts) reaches Claude Code on every kind of run, on top of the env it has. */
describe.skipIf(process.platform === 'win32')("zsh-compat in Claude Code's launch (Git Bash on Windows)", () => {
  const compatFile = (): string => path.join(process.env.BELUGA_HOME!, ZSH_COMPAT_FILE);
  afterEach(() => {
    sdk.options = undefined;
    vi.unstubAllEnvs();
    restore();
  });

  it('gives your own run the daemon environment with CLAUDE_ENV_FILE added', async () => {
    plant();
    vi.stubEnv('CLAUDE_ENV_FILE', '');
    vi.stubEnv('CLAUDE_CODE_SHELL', '');
    vi.stubEnv('SHELL', '/bin/zsh');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-launch-zsh-'));
    const backend = createClaudeBackend({ cwd: dir, autoEdit: false, additionalDirectories: [], bridge: room });
    await backend.run(input(dir, { ownerMcp: true, channel: 'ws:1' }));
    const env = sdk.options?.env;
    expect(env?.CLAUDE_ENV_FILE).toBe(compatFile());
    expect(readFileSync(compatFile(), 'utf8')).toBe(ZSH_COMPAT);
    // Still everything your own run inherits.
    expect(env?.ANTHROPIC_API_KEY).toBe('planted-api');
    expect(env?.PATH).toBe(process.env.PATH);
    const append = (sdk.options?.systemPrompt as { append?: string } | undefined)?.append ?? '';
    if (existsSync('/bin/zsh')) expect(append).toContain('set up to take common bash');
  });

  it("gives a friend's scrubbed run the file, and still none of the daemon's secrets", async () => {
    plant();
    vi.stubEnv('CLAUDE_ENV_FILE', '');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-launch-zsh-'));
    const backend = createClaudeBackend({ cwd: dir, autoEdit: false, additionalDirectories: [], bridge: room });
    await backend.run(input(dir, { channel: 'room', env: { BELUGA_WORKTREE: dir } }));
    const env = sdk.options?.env;
    expect(env?.CLAUDE_ENV_FILE).toBe(compatFile());
    expect(env?.CI).toBe('1');
    expect(env?.BELUGA_WORKTREE).toBe(dir);
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('leaves your own CLAUDE_ENV_FILE: your run inherits it as it was', async () => {
    vi.stubEnv('CLAUDE_ENV_FILE', '/x/yours.sh');
    vi.stubEnv('CLAUDE_CODE_SHELL', '');
    vi.stubEnv('SHELL', '/bin/zsh');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-launch-zsh-'));
    const backend = createClaudeBackend({ cwd: dir, autoEdit: false, additionalDirectories: [], bridge: room });
    await backend.run(input(dir, { ownerMcp: true, channel: 'ws:1' }));
    expect(sdk.options?.env).toBeUndefined();
    const append = (sdk.options?.systemPrompt as { append?: string } | undefined)?.append ?? '';
    if (existsSync('/bin/zsh')) expect(append).toContain('Your shell commands run in zsh, not bash.');
  });

  it('adds nothing when there is nothing to add', () => {
    expect(withZshCompat(undefined, {})).toBeUndefined();
    const scrubbed = { PATH: '/usr/bin', CI: '1' };
    expect(withZshCompat(scrubbed, {})).toBe(scrubbed);
    expect(withZshCompat(scrubbed, { CLAUDE_ENV_FILE: '/b/zsh-compat.sh' })).toEqual({ ...scrubbed, CLAUDE_ENV_FILE: '/b/zsh-compat.sh' });
    expect(withZshCompat(undefined, { CLAUDE_ENV_FILE: '/b/zsh-compat.sh' }, { PATH: '/bin' })).toEqual({ PATH: '/bin', CLAUDE_ENV_FILE: '/b/zsh-compat.sh' });
  });
});
