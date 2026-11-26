import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerStatus, Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunInput, McpTools } from '../src/agent/types.js';
import { CHROME_SERVER, chromeLaunch, chromeNote, chromeRow, withChrome } from '../src/agent/runtime/claude/chrome-status.js';
import { SHELL_RESTORE, holdSignIn, signInChanges, signedInWith } from '../src/agent/runtime/claude/sign-in-env.js';
import { ZSH_COMPAT } from '../src/agent/runtime/claude/zsh-compat.js';
import { onEndpoint, usageMeter } from '../src/agent/runtime/local.js';
import { room } from './runtime-conformance.js';

/**
 * BLG-1027: a chat keeps Claude in Chrome (and the claude.ai connectors) for its whole life. Claude
 * Code signs in with an Anthropic key in its environment instead of your claude.ai login, and then
 * starts without them, so a key in the project's or chat's variables must never reach it.
 */

const sdk = vi.hoisted(() => ({ options: [] as Options[], servers: [] as McpServerStatus[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) => {
    sdk.options.push(options);
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const _ of prompt) yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', modelUsage: {}, total_cost_usd: 0, session_id: 's1' };
    }
    return Object.assign(run(), { interrupt: async () => undefined, setModel: async () => undefined, setPermissionMode: async () => undefined, close: () => undefined, mcpServerStatus: async () => sdk.servers });
  },
}));
// The suites a run mounts, as they are: its tools are called here as Claude Code would.
const mounted = vi.hoisted(() => ({ suites: [] as Record<string, { tools: { name: string; handler: (a: unknown, extra: unknown) => Promise<{ content: { text: string }[] }> }[] } | undefined>[] }));
vi.mock('../src/agent/runtime/claude/sdk-mount.js', async (original) => {
  const real = await original<typeof import('../src/agent/runtime/claude/sdk-mount.js')>();
  return { ...real, sdkServers: (suites: Parameters<typeof real.sdkServers>[0]) => (mounted.suites.push(suites as never), real.sdkServers(suites)) };
});
vi.mock('../src/agent/claude-code.js', async (original) => ({ ...(await original<object>()), claudeCodeReady: async () => undefined }));

const { createClaudeBackend } = await import('../src/agent/runtime/claude/runner.js');

const input = (cwd: string, extra: Partial<AgentRunInput>): AgentRunInput => ({
  prompt: 'look at the dashboard',
  requesterName: 'kay',
  viaAgent: false,
  context: [],
  scope: 'full',
  signal: new AbortController().signal,
  onEvent: () => undefined,
  onFileTouched: () => undefined,
  canUseTool: async () => true,
  ownerMcp: true,
  channel: 'ws:1',
  chrome: {},
  place: { cwd, additionalDirectories: [], autoEdit: true, onSession: () => undefined },
  ...extra,
});

const KEY = 'sk-ant-api03-project-key';

describe('a project’s Anthropic key never signs Claude Code in', () => {
  it('holds a key the run adds for the shell, and keeps the daemon’s own', () => {
    expect(signInChanges({ ANTHROPIC_API_KEY: KEY, PATH: '/bin' }, {})).toEqual(['ANTHROPIC_API_KEY']);
    // The same value the daemon signs in with: nothing changes.
    expect(signInChanges({ ANTHROPIC_API_KEY: KEY }, { ANTHROPIC_API_KEY: KEY })).toEqual([]);
    const env = holdSignIn({ PATH: '/bin', ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: 'oat-project' }, { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: 'oat-project' }, { CLAUDE_CODE_OAUTH_TOKEN: 'oat-mine' });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oat-mine', BELUGA_SHELL_ANTHROPIC_API_KEY: KEY, BELUGA_SHELL_CLAUDE_CODE_OAUTH_TOKEN: 'oat-project' });
    expect(signedInWith(env!)).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(holdSignIn(undefined, { ANTHROPIC_API_KEY: KEY }, {})).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('gives the key back to each command, in sh and zsh alike', () => {
    expect(ZSH_COMPAT).toContain(SHELL_RESTORE);
    const shells = ['/bin/sh', ...(existsSync('/bin/zsh') ? ['/bin/zsh'] : [])];
    for (const shell of shells) {
      const out = execFileSync(shell, ['-c', `${ZSH_COMPAT}printf '%s|%s' "$ANTHROPIC_API_KEY" "\${BELUGA_SHELL_ANTHROPIC_API_KEY-gone}"`], { encoding: 'utf8', env: { PATH: process.env.PATH, BELUGA_SHELL_ANTHROPIC_API_KEY: KEY } });
      expect(out).toBe(`${KEY}|gone`);
    }
  });
});

describe.skipIf(process.platform === 'win32')('a resumed chat keeps Claude in Chrome', () => {
  afterEach(() => {
    sdk.options = [];
    sdk.servers = [];
    vi.unstubAllEnvs();
  });

  it('the turn after a key shows up in the chat’s variables resumes with --chrome and your own sign-in', async () => {
    vi.stubEnv('CLAUDE_ENV_FILE', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-chrome-resume-'));
    let session: string | undefined;
    const place = { cwd: dir, additionalDirectories: [], autoEdit: true, onSession: (id: string) => void (session = id), get resume() { return session; } };
    const backend = createClaudeBackend({ cwd: dir, autoEdit: true, additionalDirectories: [], bridge: room });
    await backend.run(input(dir, { place, env: { BELUGA_WORKTREE: dir } }));
    // A key pasted into the chat (BLG-965) is the worktree's variable from now on.
    await backend.run(input(dir, { place, env: { BELUGA_WORKTREE: dir, ANTHROPIC_API_KEY: KEY } }));
    const [first, resumed] = sdk.options;
    expect(resumed?.resume).toBe('s1');
    for (const options of [first, resumed]) {
      expect(options?.extraArgs).toMatchObject({ chrome: null });
      expect(options?.settingSources).toEqual(['user']);
      expect(signedInWith(options?.env ?? {})).toBeUndefined();
    }
    // Its commands still get the key, from Beluga's CLAUDE_ENV_FILE.
    expect(resumed?.env?.BELUGA_SHELL_ANTHROPIC_API_KEY).toBe(KEY);
    expect(resumed?.env?.CLAUDE_ENV_FILE).toBeTruthy();
    const append = (resumed?.systemPrompt as { append?: string }).append ?? '';
    expect(append).not.toContain('Claude in Chrome isn’t available');
  });

  it('a local model’s endpoint key signs Claude Code in, never held for the shell', async () => {
    vi.stubEnv('CLAUDE_ENV_FILE', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-endpoint-sign-in-'));
    const backend = createClaudeBackend({ cwd: dir, autoEdit: true, additionalDirectories: [], bridge: room });
    const target = { label: 'sandu18', baseUrl: 'http://127.0.0.1:9/v1', key: 'endpoint-key', model: 'Deepseek-V4.1-Flash' };
    await backend.run(onEndpoint(input(dir, { env: { BELUGA_WORKTREE: dir } }), target, () => undefined, usageMeter(), { dir, missed: [] }));
    const env = sdk.options.at(-1)?.env ?? {};
    expect(env.CLAUDE_ENV_FILE).toBeTruthy();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('endpoint-key');
    expect(env.ANTHROPIC_BASE_URL).toBe(target.baseUrl);
    expect(Object.keys(env).filter((name) => name.startsWith('BELUGA_SHELL_'))).toEqual([]);
  });

  it('with a sign-in it can’t hold back, the run is told why it has no Chrome', async () => {
    vi.stubEnv('CLAUDE_ENV_FILE', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-daemon');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-chrome-resume-'));
    const backend = createClaudeBackend({ cwd: dir, autoEdit: true, additionalDirectories: [], bridge: room });
    await backend.run(input(dir, {}));
    const append = (sdk.options.at(-1)?.systemPrompt as { append?: string }).append ?? '';
    expect(append).toContain('Claude in Chrome isn’t available in this run');
    expect(append).toContain('signs in with ANTHROPIC_API_KEY');
    expect(append).toContain('never tell them to start a new chat');
  });

  it('mcp_servers lists Claude in Chrome as the running session has it', async () => {
    vi.stubEnv('CLAUDE_ENV_FILE', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    sdk.servers = [{ name: CHROME_SERVER, status: 'connected' } as McpServerStatus];
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-chrome-resume-'));
    const mcpTools: McpTools = { servers: async () => 'figma: connected', signIn: async () => ({ ok: true, text: 'signed in' }) };
    const backend = createClaudeBackend({ cwd: dir, autoEdit: true, additionalDirectories: [], bridge: room });
    await backend.run(input(dir, { mcpTools }));
    const call = mounted.suites.at(-1)?.beluga_mcp?.tools.find((t) => t.name === 'mcp_servers')?.handler;
    expect(call).toBeTypeOf('function');
    const res = await call!({}, {});
    expect(res.content[0]!.text).toBe('figma: connected\nClaude in Chrome (claude-in-chrome): connected');
  });
});

describe('Claude in Chrome in mcp_servers and mcp_sign_in', () => {
  const tools: McpTools = { servers: async () => 'figma: connected', signIn: async (name) => ({ ok: true, text: `signed in to ${name}` }) };
  const on = chromeLaunch({ allowed: true, noChromeFlag: false });

  it('says how it is: connected, extension not found, off, or why the run has none', () => {
    expect(chromeRow(on, { name: CHROME_SERVER, status: 'connected' } as McpServerStatus)).toBe('Claude in Chrome (claude-in-chrome): connected');
    expect(chromeRow(on, undefined)).toContain('extension not found');
    expect(chromeRow(on, { name: CHROME_SERVER, status: 'failed', error: 'no browser' } as McpServerStatus)).toContain('extension not found (no browser)');
    expect(chromeRow(on, { name: CHROME_SERVER, status: 'disabled' } as McpServerStatus)).toContain('off in this session');
    const flagged = chromeLaunch({ allowed: false, noChromeFlag: true });
    expect(chromeRow(flagged, undefined)).toContain('--no-chrome');
    const keyed = chromeLaunch({ allowed: true, noChromeFlag: false, signIn: 'ANTHROPIC_API_KEY', signInFromPlace: true });
    expect(chromeRow(keyed, undefined)).toContain('comes from this project’s or this chat’s variables');
    expect(chromeNote(keyed, true)).toContain('never tell them to start a new chat');
    expect(chromeNote(on, true)).toBe('');
    expect(chromeNote(flagged, false)).toBe('');
  });

  it('mcp_sign_in claude-in-chrome reconnects it in the running session', async () => {
    let status: McpServerStatus['status'] = 'failed';
    const reconnect = vi.fn(async () => void (status = 'connected'));
    const enable = vi.fn(async () => undefined);
    const wrapped = withChrome(tools, { launch: on, servers: async () => [{ name: CHROME_SERVER, status } as McpServerStatus], reconnect, enable }, { waitMs: 200, pollMs: 10 });
    expect(await wrapped.servers()).toContain('extension not found');
    const res = await wrapped.signIn('claude-in-chrome');
    expect(reconnect).toHaveBeenCalledWith(CHROME_SERVER);
    expect(enable).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true });
    expect(res.text).toContain('Reconnected Claude in Chrome');
    expect(await wrapped.servers()).toBe('figma: connected\nClaude in Chrome (claude-in-chrome): connected');
    // Any other name is still one of your MCP servers.
    expect(await wrapped.signIn('figma')).toEqual({ ok: true, text: 'signed in to figma' });
  });

  it('turns it back on when it was off, and says why when it can’t come back', async () => {
    const enable = vi.fn(async () => undefined);
    const off = withChrome(tools, { launch: on, servers: async () => [{ name: CHROME_SERVER, status: 'disabled' } as McpServerStatus], reconnect: async () => undefined, enable }, { waitMs: 50, pollMs: 10 });
    const res = await off.signIn('Claude in Chrome');
    expect(enable).toHaveBeenCalledWith(CHROME_SERVER);
    expect(res.ok).toBe(false);
    const gone = withChrome(tools, { launch: chromeLaunch({ allowed: true, noChromeFlag: false, signIn: 'ANTHROPIC_API_KEY' }), servers: async () => [], reconnect: async () => undefined, enable }, { waitMs: 50, pollMs: 10 });
    const why = await gone.signIn('chrome');
    expect(why.ok).toBe(false);
    expect(why.text).toContain('signs in with ANTHROPIC_API_KEY instead of a claude.ai account');
  });
});
