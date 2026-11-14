import { describe, expect, it } from 'vitest';
import { createMcpTools } from '../src/agent/mcp-tools.js';
import { decideTool } from '../src/agent/policy.js';
import { runToolSuites } from '../src/agent/run-tools.js';
import type { AgentBackend, AgentRunInput, McpTools } from '../src/agent/types.js';
import { ViewShelf } from '../src/agent/view-tools.js';
import { type McpBackend, mcpSignInTools } from '../src/core/mcp-sign-in.js';
import { CLAUDE_AI_CONNECTORS_URL, type McpServerRow, type McpSignIn } from '../src/shared/mcp.js';
import { room } from './runtime-conformance.js';

/** The agent signs in to your MCP servers from the chat (mcp__beluga_mcp__*): never /mcp or a terminal. */

const PAGE = 'https://auth.example/authorize?client_id=x&state=y';
const ROWS: McpServerRow[] = [
  { name: 'figma', label: 'figma', from: 'user', status: 'needs-auth', canSignIn: true },
  { name: 'plugin:vercel:vercel', label: 'vercel', from: 'plugin', where: 'vercel', status: 'needs-auth', canSignIn: true },
  { name: 'claude.ai Gmail', label: 'Gmail', from: 'claude.ai', status: 'needs-auth', canSignIn: false },
  { name: 'linear', label: 'linear', from: 'user', status: 'connected', canSignIn: false },
  { name: 'broken', label: 'broken', from: 'user', status: 'failed', error: 'timed out', canSignIn: false },
];

/** A fake agent backend, like McpConnect: one sign-in per server at a time; `finish(name, ok)` ends the one the browser is on. */
function backend(start: (name: string) => McpSignIn = () => ({ url: PAGE })) {
  const started: Array<{ projects: readonly string[]; name: string }> = [];
  const waiting = new Map<string, (ok: boolean) => void>();
  const done = new Map<string, Promise<boolean>>();
  const agent: McpBackend = {
    mcpServers: async () => ROWS,
    mcpSignIn: async (projects, name) => {
      started.push({ projects, name });
      const res = start(name);
      if ('url' in res) done.set(name, new Promise<boolean>((resolve) => waiting.set(name, resolve)).finally(() => done.delete(name)));
      return res;
    },
    mcpSignedIn: (name) => done.get(name) ?? Promise.resolve(undefined),
    mcpSigningIn: (name) => done.has(name),
  };
  return { agent, started, finish: (name: string, ok = true) => waiting.get(name)?.(ok) };
}

function tools(agent: Parameters<typeof mcpSignInTools>[0], opened: string[], waitMs = 30) {
  return mcpSignInTools(agent, { roots: () => ['/p/a', '/p/b'], openPage: async (url) => void opened.push(url), waitMs });
}

describe('mcp_servers', () => {
  it('lists each server with its status and how to sign in, never a page or a token', async () => {
    const text = await tools(backend().agent, []).servers();
    expect(text).toContain('figma: needs sign-in (mcp_sign_in)');
    expect(text).toContain('vercel (plugin:vercel:vercel): needs sign-in (mcp_sign_in)');
    expect(text).toContain('Gmail (claude.ai Gmail): needs sign-in on claude.ai (mcp_sign_in opens it)');
    expect(text).toContain('linear: connected');
    expect(text).toContain('broken: failed (timed out)');
    expect(text).not.toContain('https://');
  });
});

describe('mcp_sign_in', () => {
  it('opens the sign-in page in your browser and answers once the server is connected', async () => {
    const { agent, started, finish } = backend();
    const opened: string[] = [];
    const answer = tools(agent, opened, 1_000).signIn('figma');
    await Promise.resolve();
    setTimeout(() => finish('figma'), 5);
    expect(await answer).toEqual({ ok: true, text: expect.stringContaining('Signed in to figma') });
    expect(opened).toEqual([PAGE]);
    expect(started).toEqual([{ projects: ['/p/a', '/p/b'], name: 'figma' }]);
  });

  it('finds a server by the name shown (its label) too', async () => {
    const { agent, started, finish } = backend();
    const answer = tools(agent, [], 1_000).signIn('vercel');
    setTimeout(() => finish('plugin:vercel:vercel'), 5);
    expect((await answer).ok).toBe(true);
    expect(started.map((s) => s.name)).toEqual(['plugin:vercel:vercel']);
  });

  it('still waiting: says the page is open, and a second call waits again without a new page', async () => {
    const { agent, started, finish } = backend();
    const opened: string[] = [];
    const t = tools(agent, opened);
    const first = await t.signIn('figma');
    expect(first.ok).toBe(true);
    expect(first.text).toMatch(/page is open in the browser/);
    expect(first.text).toMatch(/call mcp_sign_in again/);
    const second = t.signIn('figma');
    setTimeout(() => finish('figma'), 5);
    expect((await second).text).toContain('Signed in to figma');
    expect(started).toHaveLength(1);
    expect(opened).toEqual([PAGE]);
  });

  it('a later run waits on the sign-in an earlier run opened: no new sign-in, no new page', async () => {
    const { agent, started, finish } = backend();
    const opened: string[] = [];
    // Each run gets tools of its own (core/agent-host.ts); the open sign-in is the backend's.
    expect((await tools(agent, opened).signIn('figma')).text).toMatch(/call mcp_sign_in again/);
    const later = tools(agent, opened, 1_000).signIn('figma');
    setTimeout(() => finish('figma'), 5);
    expect((await later).text).toContain('Signed in to figma');
    expect(started).toHaveLength(1);
    expect(opened).toEqual([PAGE]);
  });

  it('waits on a sign-in started from the MCP chip or Settings instead of starting over', async () => {
    const { agent, started, finish } = backend();
    await agent.mcpSignIn!(['/p/a'], 'figma');
    const opened: string[] = [];
    const answer = tools(agent, opened, 1_000).signIn('figma');
    setTimeout(() => finish('figma'), 5);
    expect((await answer).text).toContain('Signed in to figma');
    expect(started).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it('says so when the sign-in gave up', async () => {
    const { agent, finish } = backend();
    const answer = tools(agent, [], 1_000).signIn('figma');
    setTimeout(() => finish('figma', false), 5);
    expect(await answer).toEqual({ ok: false, text: expect.stringMatching(/didn’t finish/) });
  });

  it('a claude.ai connector: opens claude.ai’s connectors page instead', async () => {
    const { agent, started } = backend();
    const opened: string[] = [];
    const answer = await tools(agent, opened).signIn('Gmail');
    expect(opened).toEqual([CLAUDE_AI_CONNECTORS_URL]);
    expect(started).toEqual([]);
    expect(answer.text).toMatch(/claude\.ai/);
  });

  it('already connected, unknown or not signed in from here: says so and opens nothing', async () => {
    const { agent, started } = backend();
    const opened: string[] = [];
    const t = tools(agent, opened);
    expect((await t.signIn('linear')).text).toMatch(/already connected/);
    const unknown = await t.signIn('nope');
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toMatch(/No MCP server named nope.*figma/);
    expect((await t.signIn('broken')).ok).toBe(false);
    expect(opened).toEqual([]);
    expect(started).toEqual([]);
  });

  it('connected without a page, or an error from the agent: passed on', async () => {
    expect((await tools(backend(() => ({ connected: true })).agent, []).signIn('figma')).text).toContain('Signed in to figma');
    expect(await tools(backend(() => ({ error: 'Update Claude Code' })).agent, []).signIn('figma')).toEqual({ ok: false, text: expect.stringContaining('Update Claude Code') });
  });

  it('a page that can’t open is given to the user as a link', async () => {
    const { agent } = backend();
    const t = mcpSignInTools(agent, { roots: () => [], openPage: async () => Promise.reject(new Error('no screen')), waitMs: 5 });
    expect((await t.signIn('figma')).text).toContain(PAGE);
  });
});

describe('the beluga_mcp suite', () => {
  const fake: McpTools = { servers: async () => 'list', signIn: async (name) => ({ ok: name === 'figma', text: `tried ${name}` }) };
  const base = { prompt: 'hi', requesterName: 'me', viaAgent: false, context: [], scope: 'full', signal: new AbortController().signal, onEvent: () => undefined, onFileTouched: () => undefined, canUseTool: async () => true } as unknown as AgentRunInput;

  it('is mounted only for a run given the tools', () => {
    expect(runToolSuites(base, room, new ViewShelf(), '/tmp').beluga_mcp).toBeUndefined();
    expect(runToolSuites({ ...base, mcpTools: fake }, room, new ViewShelf(), '/tmp').beluga_mcp?.tools.map((t) => t.name)).toEqual(['mcp_servers', 'mcp_sign_in']);
  });

  it('a failed sign-in is an error result', async () => {
    const signIn = createMcpTools(fake).tools.find((t) => t.name === 'mcp_sign_in')!;
    expect(await signIn.handler({ name: 'figma' }, {})).toEqual({ content: [{ type: 'text', text: 'tried figma' }] });
    expect(await signIn.handler({ name: 'x' }, {})).toEqual({ content: [{ type: 'text', text: 'tried x' }], isError: true });
  });

  it('never asks you: only your own runs have it, and you finish the sign-in yourself', () => {
    const ctx = { cwd: '/tmp', roots: ['/tmp'], autoEdit: false, scope: 'full' } as never;
    expect(decideTool('mcp__beluga_mcp__mcp_servers', {}, ctx)).toBe('allow');
    expect(decideTool('mcp__beluga_mcp__mcp_sign_in', { name: 'figma' }, ctx)).toBe('allow');
  });
});
