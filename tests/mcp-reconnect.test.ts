import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerStatus, Options } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSystemAppend } from '../src/agent/prompt.js';
import { McpConnect, type McpSession } from '../src/agent/runtime/claude/mcp-connect.js';
import { createClaudeBackend } from '../src/agent/runtime/claude/runner.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { room } from './runtime-conformance.js';

/** A sign-in that connects reaches the Claude Code turns running now, so the server's tools load in this turn. */

// A fake Claude Code: the turn stays open until `release()`.
const sdk = vi.hoisted(() => ({
  reconnects: [] as string[],
  reconnectFails: false,
  release: (() => undefined) as () => void,
  started: (() => undefined) as () => void,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: ({ prompt }: { prompt: AsyncIterable<unknown>; options: Options }) => {
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const _ of prompt) break;
      sdk.started();
      await new Promise<void>((resolve) => (sdk.release = resolve));
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', modelUsage: {}, total_cost_usd: 0, session_id: 's1' };
    }
    return Object.assign(run(), {
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      close: () => undefined,
      reconnectMcpServer: async (name: string) => {
        sdk.reconnects.push(name);
        if (sdk.reconnectFails) throw new Error('no such server');
      },
    });
  },
}));

const PAGE = 'https://auth.example/oauth?state=x';

function home(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-needs-auth-'));
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { figma: { type: 'http', url: 'https://f' } } }));
  return dir;
}

/** A sign-in whose page is open: the server connects when `connect()` is called. */
function signIn(): { mcp: McpConnect; connect: () => void } {
  let connected = false;
  const session: McpSession = {
    mcpServerStatus: async () => [{ name: 'figma', status: connected ? 'connected' : 'needs-auth', scope: 'dynamic' } as McpServerStatus],
    mcpAuthenticate: async () => ({ authUrl: PAGE, requiresUserAction: true }),
    close: () => undefined,
  };
  return { mcp: new McpConnect(() => session, { env: {}, home: home(), pollMs: 1, signInMs: 500 }), connect: () => void (connected = true) };
}

function input(extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    prompt: 'hi',
    requesterName: 'kay',
    viaAgent: false,
    context: [],
    scope: 'full',
    signal: new AbortController().signal,
    onEvent: () => undefined,
    onFileTouched: () => undefined,
    canUseTool: async () => true,
    channel: 'ws:1',
    ownerMcp: true,
    place: { cwd: os.tmpdir(), additionalDirectories: [], autoEdit: true, onSession: () => undefined },
    ...extra,
  };
}

beforeEach(() => {
  sdk.reconnects = [];
  sdk.reconnectFails = false;
});

/** Runs a turn to the point Claude Code is answering, then calls `during` before the turn ends. */
async function turn(backend: ReturnType<typeof createClaudeBackend>, run: AgentRunInput, during: () => Promise<void> = async () => undefined): Promise<void> {
  const started = new Promise<void>((resolve) => (sdk.started = resolve));
  const done = backend.run(run);
  await started;
  await during();
  sdk.release();
  await done;
}

describe('a sign-in that connects', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  it('reconnects the server on every running Claude query', async () => {
    const { mcp, connect } = signIn();
    const backend = createClaudeBackend({ cwd: os.tmpdir(), autoEdit: true, additionalDirectories: [], bridge: room, mcp });
    await turn(backend, input(), async () => {
      expect(await mcp.signIn([os.tmpdir()], 'figma')).toEqual({ url: PAGE });
      connect();
      expect(await mcp.signedIn('figma')).toBe(true);
      await settle();
    });
    expect(sdk.reconnects).toEqual(['figma']);
  });

  it('never fails the turn when the reconnect fails', async () => {
    sdk.reconnectFails = true;
    const { mcp, connect } = signIn();
    const backend = createClaudeBackend({ cwd: os.tmpdir(), autoEdit: true, additionalDirectories: [], bridge: room, mcp });
    await expect(
      turn(backend, input(), async () => {
        await mcp.signIn([os.tmpdir()], 'figma');
        connect();
        await mcp.signedIn('figma');
        await settle();
      }),
    ).resolves.toBeUndefined();
    expect(sdk.reconnects).toEqual(['figma']);
  });

  it('leaves a friend’s or a guest’s run alone: they never get your servers', async () => {
    for (const extra of [{ ownerMcp: false }, { guest: true }] as const) {
      sdk.reconnects = [];
      const { mcp, connect } = signIn();
      const backend = createClaudeBackend({ cwd: os.tmpdir(), autoEdit: true, additionalDirectories: [], bridge: room, mcp });
      await turn(backend, input(extra), async () => {
        await mcp.signIn([os.tmpdir()], 'figma');
        connect();
        await mcp.signedIn('figma');
        await settle();
      });
      expect(sdk.reconnects).toEqual([]);
    }
  });

  it('says whether a sign-in is waiting for the browser', async () => {
    const { mcp, connect } = signIn();
    expect(mcp.signingIn('figma')).toBe(false);
    await mcp.signIn([os.tmpdir()], 'figma');
    expect(mcp.signingIn('figma')).toBe(true);
    connect();
    await mcp.signedIn('figma');
    expect(mcp.signingIn('figma')).toBe(false);
  });

  it('leaves a turn that already ended alone', async () => {
    const { mcp, connect } = signIn();
    const backend = createClaudeBackend({ cwd: os.tmpdir(), autoEdit: true, additionalDirectories: [], bridge: room, mcp });
    await turn(backend, input());
    await mcp.signIn([os.tmpdir()], 'figma');
    connect();
    await mcp.signedIn('figma');
    await settle();
    expect(sdk.reconnects).toEqual([]);
  });
});

describe("Beluga's appended system prompt", () => {
  it('points to mcp_sign_in, never to /mcp or a terminal', () => {
    const text = buildSystemAppend('kay').replace(/\s+/g, ' ');
    expect(text).toContain('call mcp__beluga_mcp__mcp_sign_in');
    expect(text).toContain('Never tell them to run /mcp or to open a terminal');
  });
});
