import { EventEmitter } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PolicyContext } from '../src/agent/policy.js';
import type { PeerInfo } from '../src/protocol.js';
import type { AgentRunInput, RoomBridge } from '../src/agent/types.js';
import type { ToolSuite } from '../src/agent/tool-kit.js';

// A Claude Code that only starts: the test reads the options the runner gave it (its canUseTool and hooks).
const seen: { options?: Options } = {};
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: ({ options }: { options: Options }) =>
    Object.assign(
      (async function* () {
        seen.options = options;
        yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's1', modelUsage: {}, total_cost_usd: 0 };
      })(),
      { interrupt: async () => undefined, setModel: async () => undefined },
    ),
}));

const { createClaudeBackend } = await import('../src/agent/runtime/claude/runner.js');
const { sdkServer } = await import('../src/agent/runtime/claude/sdk-mount.js');
const { ToolHost } = await import('../src/agent/tool-host.js');
const { gateTool } = await import('../src/agent/tool-gate.js');
const { createRoomTools } = await import('../src/agent/tools.js');

const ROOT = path.resolve(__dirname, '..');
const chats: string[] = [];
const bridge = {
  selfName: () => 'kay',
  reportUsage: () => undefined,
  sendChat: (text: string) => void chats.push(text),
  listPeers: (): readonly PeerInfo[] => [],
} as unknown as RoomBridge;

/** A friend's task: its owner said no room chat. */
const VETO = 'Your friend didn’t allow posting in the room.';
const input: AgentRunInput = {
  prompt: 'hi',
  requesterName: 'mia',
  viaAgent: true,
  context: [],
  scope: 'folder',
  signal: new AbortController().signal,
  onEvent: () => undefined,
  onFileTouched: () => undefined,
  vetTool: (name) => (name === 'mcp__beluga__send_chat' ? VETO : undefined),
  canUseTool: async () => true,
};
const policy: PolicyContext = { cwd: '/tmp', roots: ['/tmp'], autoEdit: false, scope: 'folder' };
const suites: Record<string, ToolSuite> = { beluga: createRoomTools(bridge) };

async function listed(client: Client) {
  const { tools } = await client.listTools();
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })).sort((a, b) => a.name.localeCompare(b.name));
}

const host = new ToolHost({ command: process.execPath, args: ['--import', 'tsx', path.join(ROOT, 'src/cli.ts')] });
afterAll(() => host.close());

describe("Beluga's tools over stdio (beluga mcp-serve)", () => {
  it('serves the same tools, with the same schemas, as the in-process server', async () => {
    const run = await host.mount(suites, (name, args) => gateTool(name, args, input, policy));
    const stdio = new Client({ name: 'test', version: '1' });
    const config = run.servers.beluga!;
    await stdio.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...(process.env as Record<string, string>), ...config.env }, cwd: ROOT, stderr: 'pipe' }));
    const inProcess = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await sdkServer(suites.beluga!).instance.connect(b);
    await inProcess.connect(a);
    try {
      const external = await listed(stdio);
      expect(external.map((t) => t.name)).toContain('send_chat');
      expect(external).toEqual(await listed(inProcess));

      // Allowed: it runs in the daemon, for this run.
      const peers = await stdio.callTool({ name: 'list_peers', arguments: {} });
      expect(peers.isError).toBeFalsy();

      // Denied by the run's vetTool over stdio: the handler never runs.
      const denied = await stdio.callTool({ name: 'send_chat', arguments: { text: 'hello room' } });
      expect(denied).toMatchObject({ isError: true, content: [{ type: 'text', text: VETO }] });
      expect(chats).toEqual([]);
    } finally {
      await stdio.close();
      await inProcess.close();
      run.close();
    }
  }, 60_000);

  it('denies the same call in-process (Claude’s canUseTool and PreToolUse hook)', async () => {
    await createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(input);
    const options = seen.options!;
    expect(options.mcpServers?.beluga).toMatchObject({ type: 'sdk', name: 'beluga' });
    const viaCanUse = await options.canUseTool!('mcp__beluga__send_chat', { text: 'hello room' }, { signal: new AbortController().signal, toolUseID: 't1' } as never);
    expect(viaCanUse).toEqual({ behavior: 'deny', message: VETO });
    const hook = options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
    const viaHook = await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__beluga__send_chat', tool_input: { text: 'hello room' }, tool_use_id: 't1' } as never, 't1', { signal: new AbortController().signal });
    expect(viaHook).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: VETO } });
  });

  it('answers nothing to a call without its run’s token', async () => {
    const run = await host.mount(suites, async () => undefined);
    const url = run.servers.beluga!.env.BELUGA_TOOLS_URL!;
    run.close();
    const post = (token: string) => fetch(`${url}/mcp/beluga`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect((await post(run.token)).status).toBe(401);
    expect((await post('0'.repeat(64))).status).toBe(401);
  });

  it('recovers on the next mount after a transient listen error and keeps a runtime error listener attached', async () => {
    const isolated = new ToolHost({ command: process.execPath, args: ['--import', 'tsx', path.join(ROOT, 'src/cli.ts')] });
    let attempts = 0;
    let liveServer: EventEmitter | undefined;
    const spy = vi.spyOn(http, 'createServer').mockImplementation((() => {
      attempts++;
      const fake = new EventEmitter() as EventEmitter & {
        listen: (_port: number, _host: string, cb?: () => void) => unknown;
        close: (cb?: () => void) => unknown;
        unref: () => unknown;
        address: () => { port: number };
      };
      fake.unref = () => fake;
      fake.address = () => ({ port: 54321 });
      fake.close = (cb?: () => void) => (cb?.(), fake);
      if (attempts === 1) {
        fake.listen = () => {
          queueMicrotask(() => fake.emit('error', Object.assign(new Error('listen EMFILE'), { code: 'EMFILE' })));
          return fake;
        };
      } else {
        liveServer = fake;
        fake.listen = (_port: number, _host: string, cb?: () => void) => {
          queueMicrotask(() => cb?.());
          return fake;
        };
      }
      return fake as unknown as http.Server;
    }) as typeof http.createServer);
    try {
      await expect(isolated.mount(suites, async () => undefined)).rejects.toThrow('listen EMFILE');
      // A second mount retries cleanly instead of replaying a cached rejection.
      const mounted = await isolated.mount(suites, async () => undefined);
      expect(attempts).toBe(2);
      expect(mounted.http.beluga?.url).toMatch(/:54321\/mcp\/beluga$/);
      expect(liveServer?.listenerCount('error')).toBe(1);
      expect(() => liveServer?.emit('error', new Error('late socket error'))).not.toThrow();
      mounted.close();
    } finally {
      spy.mockRestore();
      await isolated.close();
    }
  });
});
