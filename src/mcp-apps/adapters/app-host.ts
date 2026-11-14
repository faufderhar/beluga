import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostName } from '../../daemon/web.js';

/**
 * Where MCP App frames load from: a server of its own on
 * 127.0.0.1, apart from the daemon's socket and the previews' server, that serves nothing but app
 * pages. Each page is at /a/<id>/, an id nobody can guess, with its own CSP; only the Beluga window
 * may frame it (the CSP's frame-ancestors), and only under a loopback host name (no DNS rebinding).
 */

export const APP_HOST = '127.0.0.1';

/** The port it asks for first, so an app's storage stays under one origin between runs. Taken: any free one. */
export const APP_PORT = 47792;

/** Pages kept (the oldest go). */
const MAX_PAGES = 200;

interface Page {
  readonly html: string;
  readonly csp: string;
}

export class McpAppHost {
  private server?: Server;
  private port?: number;
  private starting?: Promise<number>;
  private readonly pages = new Map<string, Page>();

  /** `wanted`: the port to ask for first (0: any free one). */
  constructor(private readonly wanted = APP_PORT) {}

  /** Serve a page with its CSP → its frame URL. */
  async add(html: string, csp: string): Promise<string> {
    const port = await this.start();
    const id = randomBytes(16).toString('hex');
    this.pages.set(id, { html, csp });
    while (this.pages.size > MAX_PAGES) this.pages.delete(this.pages.keys().next().value!);
    return `http://${APP_HOST}:${port}/a/${id}/`;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    this.port = undefined;
    this.pages.clear();
  }

  private start(): Promise<number> {
    if (this.port) return Promise.resolve(this.port);
    this.starting ??= this.listen(this.wanted)
      .catch(() => (this.wanted ? this.listen(0) : Promise.reject(new Error('No port for MCP Apps'))))
      .finally(() => (this.starting = undefined));
    return this.starting;
  }

  private listen(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.request(req, res));
      server.on('clientError', (_err, socket) => socket.destroy());
      server.once('error', reject);
      server.listen(port, APP_HOST, () => {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        // Never what keeps the daemon running.
        server.unref();
        resolve(this.port);
      });
    });
  }

  private request(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'GET only');
    const host = hostName(req.headers.host);
    if ((host !== APP_HOST && host !== 'localhost') || !isLoopback(req.socket.remoteAddress)) return send(res, 421, 'text/plain', 'Not here');
    const m = /^\/a\/([0-9a-f]{32})\/$/.exec((req.url ?? '/').split('?')[0]!);
    const page = m ? this.pages.get(m[1]!) : undefined;
    if (!page) return send(res, 404, 'text/plain', 'This app has closed');
    send(res, 200, 'text/html; charset=utf-8', page.html, page.csp);
  }
}

/** Never cached, never sniffed, no referrer; `csp`: the page's own (others: nothing at all). */
function send(res: ServerResponse, status: number, type: string, body: string, csp = "default-src 'none'"): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': csp });
  res.end(body);
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
