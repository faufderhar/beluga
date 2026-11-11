import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type ToolSuite, toolName } from './tool-kit.js';

/** Whether one call may run (agent/tool-gate.ts): undefined allows, a string denies and says why. */
export type ToolGate = (toolName: string, input: Record<string, unknown>) => Promise<string | undefined>;

/** Answers one of Claude Code's hook calls (its JSON in, the hook's JSON out), for a terminal's `--settings` hooks. */
export type HookAnswer = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** How the stdio server is started: this Beluga's own `cli.js mcp-serve <suite>`. */
export interface ServeCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** One stdio MCP server as a runtime's config names it (Codex, an ACP agent, Claude Code's own --mcp-config). */
export interface StdioServerConfig {
  readonly type: 'stdio';
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

/** One suite served over Streamable HTTP on 127.0.0.1, for a runtime that takes no stdio servers (Copilot over ACP). */
export interface HttpServerConfig {
  readonly url: string;
  /** The run's token, as `Authorization: Bearer …`. */
  readonly headers: Record<string, string>;
}

/** A run's tools, mounted: its token, and the stdio servers that reach them. */
export interface MountedRun {
  readonly token: string;
  /** By suite name (`beluga`, `beluga_board`…), so every tool keeps its `mcp__<suite>__<tool>` name. */
  readonly servers: Record<string, StdioServerConfig>;
  /** The same suites straight over HTTP (what `beluga mcp-serve` relays to), by suite name. */
  readonly http: Record<string, HttpServerConfig>;
  /** Where its hook calls go (POST with the token), when it was mounted with one. */
  readonly hookUrl?: string;
  close(): void;
}

const MAX_BODY = 4 * 1024 * 1024;

/** This Beluga, started the way it runs now (node, its loader flags, cli.js). */
export function selfServeCommand(): ServeCommand {
  return { command: process.execPath, args: [...process.execArgv, process.argv[1] ?? 'cli.js'] };
}

/**
 * Beluga's tools for runtimes that mount MCP servers instead of taking them in-process (BLG-442).
 * Each run is mounted with its own token; `beluga mcp-serve <suite>` (src/mcp-serve.ts) pipes the
 * agent's stdio to this host on 127.0.0.1, and a call carries the token, so it is attributable to
 * exactly one run, and passes that run's gate (vetTool, policy, your approval) before its handler.
 * Tools run here, in the daemon, where the run's bridge lives.
 */
export class ToolHost {
  private readonly runs = new Map<string, { readonly suites: Readonly<Record<string, ToolSuite>>; readonly gate: ToolGate; readonly hook?: HookAnswer }>();
  private listening?: Promise<string>;
  private server?: http.Server;

  constructor(private readonly serve: ServeCommand = selfServeCommand()) {}

  /** Mount a run's suites behind a new token; close() unmounts it (calls with the token fail from then). */
  async mount(suites: Readonly<Record<string, ToolSuite>>, gate: ToolGate, hook?: HookAnswer): Promise<MountedRun> {
    const url = await this.listen();
    const token = randomBytes(32).toString('hex');
    this.runs.set(token, { suites, gate, ...(hook ? { hook } : {}) });
    const servers = Object.fromEntries(
      Object.keys(suites).map((suite) => [suite, { type: 'stdio' as const, command: this.serve.command, args: [...this.serve.args, 'mcp-serve', suite], env: { BELUGA_TOOLS_URL: url, BELUGA_TOOLS_TOKEN: token } }]),
    );
    const http = Object.fromEntries(Object.keys(suites).map((suite) => [suite, { url: `${url}/mcp/${suite}`, headers: { Authorization: `Bearer ${token}` } }]));
    return { token, servers, http, ...(hook ? { hookUrl: `${url}/hook` } : {}), close: () => void this.runs.delete(token) };
  }

  async close(): Promise<void> {
    this.runs.clear();
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private listen(): Promise<string> {
    this.listening ??= new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.unref();
        this.server = server;
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
    return this.listening;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.url === '/hook') return this.handleHook(req, res);
    const suiteName = /^\/mcp\/([\w-]+)$/.exec(req.url ?? '')?.[1];
    const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    const run = token ? this.runs.get(token) : undefined;
    const suite = run && suiteName ? run.suites[suiteName] : undefined;
    if (!run || !suite) return void res.writeHead(run ? 404 : 401).end();
    // Stateless: each request gets its own server, so a restarted stdio server needs no session.
    if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return void res.writeHead(400).end();
    }
    const server = mcpServerFor(suite, run.gate);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** A hook call from a terminal's Claude Code (via its hook script): the run's answer, as JSON. */
  private async handleHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    const hook = token ? this.runs.get(token)?.hook : undefined;
    if (!hook) return void res.writeHead(401).end();
    if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return void res.writeHead(400).end();
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return void res.writeHead(400).end();
    try {
      const answer = await hook(body as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    } catch {
      res.writeHead(500).end();
    }
  }
}

/** A suite as a real MCP server, each tool behind the run's gate (as Claude's PreToolUse hook does in-process). */
export function mcpServerFor(suite: ToolSuite, gate: ToolGate): McpServer {
  const server = new McpServer({ name: suite.name, version: suite.version });
  for (const def of suite.tools) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema, ...(def.annotations ? { annotations: def.annotations } : {}) }, async (args: Record<string, unknown>, extra: unknown) => {
      const denied = await gate(toolName(suite.name, def.name), args);
      return denied ? { content: [{ type: 'text' as const, text: denied }], isError: true } : def.handler(args, extra);
    });
  }
  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) return void req.destroy(new Error('too large'));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
