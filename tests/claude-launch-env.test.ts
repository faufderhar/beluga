import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunInput } from '../src/agent/types.js';
import { claudeLaunchEnv } from '../src/agent/runtime/claude/runner.js';
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
