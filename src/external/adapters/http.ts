import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Grant } from '../domain/grant.js';
import { LIMITS, visitorOf } from '../domain/limits.js';
import { placeOfRequest, plainListenAllowed } from '../domain/reach.js';
import { EXTERNAL_HOST } from './config-file.js';

/**
 * The external agents' door: its own port, apart from the screens' socket. It listens on loopback
 * only and answers only to its loopback names and the names of its open routes (no DNS rebinding) and
 * its own origin, whatever a request carries, then asks for a token. Stateless: one MCP server per request, so nothing is lost when a client or Beluga restarts.
 */

export const MCP_PATH = '/mcp';
export const TOKEN_PATH = '/token';
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

const MAX_BODY = LIMITS.local.bodyBytes;
const RETRY_AFTER_SECONDS = 60;

/** What a route may know about the request: where this server was reached. */
export interface RequestContext {
  /** "http://127.0.0.1:7778", or a route's https name. Checked. */
  readonly origin: string;
  /** It came through a route, whatever the socket says. */
  readonly remote: boolean;
  /** Who it is, for limits: never only the socket through a route. */
  readonly visitor: string;
  /** Its MCP endpoint under that name: what a token's audience must be. */
  readonly resource: string;
}

/** Why a request is turned away before it runs. */
export interface Turned {
  readonly status: 403 | 429;
  readonly error: 'rate_limited' | 'grant_suspended';
  readonly message: string;
}

export interface ExternalListenerOptions {
  readonly port: number;
  /** Default EXTERNAL_HOST. Plain http: anything but loopback is refused. */
  readonly host?: string;
  /** The https origins of the routes open now. */
  readonly remoteOrigins?: () => readonly string[];
  /** The live grant a bearer token gives at this audience; undefined refuses it. */
  readonly authenticate: (token: string, audience: string) => Grant | undefined;
  /** Why a token is refused here, when there is more to say than "invalid": it goes to the client. */
  readonly refusal?: (token: string, audience: string) => string | undefined;
  /** Turns away this grant's request (limit, suspension) before it runs, with what it has in flight. */
  readonly admit?: (grant: Grant, inFlight: number) => Turned | undefined;
  /** Turns away a request that came through a route with no valid token, before anything else. */
  readonly admitVisitor?: (visitor: string) => Turned | undefined;
  /** The MCP server for one request of this grant. */
  readonly serve: (grant: Grant) => McpServer;
  /** Routes besides /mcp (sign-in); false when it isn't theirs. */
  readonly routes?: (req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext) => Promise<boolean>;
  readonly log?: (line: string) => void;
}

export class ExternalListener {
  private server?: http.Server;
  private port = 0;
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly opts: ExternalListenerOptions) {}

  async listen(): Promise<number> {
    const host = this.opts.host ?? EXTERNAL_HOST;
    if (!plainListenAllowed(host)) throw new Error(`External agents refuse plain http on ${host}, because tokens would travel in the clear. Use beluga mcp on --tailscale or --public.`);
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.opts.log?.(`external request failed: ${err instanceof Error ? err.name : 'error'}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const place = placeOfRequest(req.headers, this.port, this.opts.remoteOrigins?.() ?? []);
    if (!place) return refuse(res, 'Wrong Host');
    if (req.headers.origin !== undefined && req.headers.origin !== place.origin) return refuse(res, 'Wrong Origin');
    const ctx: RequestContext = { ...place, visitor: visitorOf(req.headers, req.socket.remoteAddress, place.remote), resource: `${place.origin}${MCP_PATH}` };
    // A connected agent follows its grant's own limit, whoever floods: only a request with no valid token is a visitor.
    const atMcp = pathOf(req) === MCP_PATH;
    const token = atMcp ? /^Bearer ([\w.~+/=-]+)$/i.exec(req.headers.authorization ?? '')?.[1] : undefined;
    const grant = token ? this.opts.authenticate(token, ctx.resource) : undefined;
    const crowded = place.remote && !grant && !outsideVisitorLimits(req) ? this.opts.admitVisitor?.(ctx.visitor) : undefined;
    if (crowded) return turnAway(res, crowded);
    if (await this.opts.routes?.(req, res, ctx)) return;
    if (!atMcp) return void res.writeHead(404).end();
    return this.handleMcp(req, res, ctx, token, grant);
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, token: string | undefined, grant: Grant | undefined): Promise<void> {
    if (!grant) return challenge(res, ctx, Boolean(req.headers.authorization), token && this.opts.refusal?.(token, ctx.resource));
    if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
    const turned = this.opts.admit?.(grant, this.inFlight.get(grant.id) ?? 0);
    if (turned) return turnAway(res, turned);
    // From here it counts as in flight, until its answer ends.
    this.inFlight.set(grant.id, (this.inFlight.get(grant.id) ?? 0) + 1);
    res.once('close', () => {
      const left = (this.inFlight.get(grant.id) ?? 1) - 1;
      if (left > 0) this.inFlight.set(grant.id, left);
      else this.inFlight.delete(grant.id);
    });
    const text = await readBody(req, LIMITS[grant.route].bodyBytes);
    if (text === undefined) return void res.writeHead(413).end();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return void res.writeHead(400).end();
    }
    const server = this.opts.serve(grant);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

/**
 * A valid refresh must always get through, whoever floods: so /token has its own limit, on failures
 * only, after the lookup (oauth-routes.ts), and its body is cut off early. These requests count nowhere else.
 */
const outsideVisitorLimits = (req: http.IncomingMessage): boolean => req.method === 'POST' && pathOf(req) === TOKEN_PATH;

function turnAway(res: http.ServerResponse, turned: Turned): void {
  res.writeHead(turned.status, { 'content-type': 'application/json', ...(turned.status === 429 ? { 'retry-after': String(RETRY_AFTER_SECONDS) } : {}) }).end(JSON.stringify({ error: turned.error, message: turned.message }));
}

const pathOf = (req: http.IncomingMessage): string => (req.url ?? '').split('?')[0] ?? '';

const refuse = (res: http.ServerResponse, why: string): void => void res.writeHead(403, { 'content-type': 'text/plain' }).end(why);

/** RFC 9728: where to learn how to sign in. `invalid_token` only when a token was sent (RFC 6750). */
function challenge(res: http.ServerResponse, ctx: RequestContext, sentOne: boolean, why?: string): void {
  const metadata = `resource_metadata="${ctx.origin}${RESOURCE_METADATA_PATH}"`;
  const error = sentOne ? `error="invalid_token", ${why ? `error_description="${why}", ` : ''}` : '';
  res.writeHead(401, { 'www-authenticate': `Bearer ${error}${metadata}` }).end();
}

/** The body's text; undefined past the limit. With `drain`, the connection is cut once that much has come. */
export function readBody(req: http.IncomingMessage, max = MAX_BODY, drain = Number.POSITIVE_INFINITY): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Past the limit it is read and dropped, so the client gets its answer rather than a reset.
      if (size > max) chunks.length = 0;
      else chunks.push(chunk);
      if (size > drain) {
        req.destroy();
        resolve(undefined);
      }
    });
    req.on('end', () => resolve(size > max ? undefined : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
