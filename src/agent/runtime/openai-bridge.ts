/**
 * The translator for OpenAI-format endpoints. Claude Code only speaks Anthropic's /v1/messages;
 * an endpoint set to 'openai' (a gateway, vLLM, a provider's OpenAI API) only has
 * /chat/completions. So a run on one points ANTHROPIC_BASE_URL here, a server on 127.0.0.1 in the
 * daemon, and this turns each request into the endpoint's format and its answer back
 * (openai-format.ts).
 *
 * The endpoint's key stays in the daemon: Claude Code gets only this bridge's own token, made
 * fresh each time the daemon starts, and the bridge refuses any request without it. Each endpoint
 * has a route of its own (an unguessable path), so a run's requests go to its endpoint only.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openaiUrl } from '../../shared/local-endpoints.js';
import { StreamTranslator, anthropicError, fromOpenAIResponse, roughTokens, sseLines, toOpenAIRequest, upstreamMessage } from './openai-format.js';

/** Where a route goes. */
export interface BridgeTarget {
  readonly baseUrl: string;
  readonly key?: string;
}

/** What Claude Code is given for a route: its base URL and the token it sends. */
export interface BridgeRoute {
  readonly baseUrl: string;
  readonly token: string;
}

/** A request body is at most this (images in a long conversation). */
const MAX_BODY = 64 * 1024 * 1024;

export class OpenAIBridge {
  private server: http.Server | undefined;
  private port: Promise<number> | undefined;
  private readonly token = randomBytes(24).toString('hex');
  /** Route id → target, and target → route id (one route per endpoint and key). */
  private readonly routes = new Map<string, BridgeTarget>();
  private readonly ids = new Map<string, string>();

  constructor(private readonly deps: { readonly fetch?: typeof fetch } = {}) {}

  /** The base URL and token for a run on `target`; starts the bridge the first time. */
  async route(target: BridgeTarget): Promise<BridgeRoute> {
    const port = await this.listen();
    const at = `${target.baseUrl}\n${target.key ?? ''}`;
    let id = this.ids.get(at);
    if (!id) {
      id = randomBytes(12).toString('hex');
      this.ids.set(at, id);
    }
    this.routes.set(id, target);
    return { baseUrl: `http://127.0.0.1:${port}/r/${id}`, token: this.token };
  }

  close(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    this.port = undefined;
    return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }

  private listen(): Promise<number> {
    this.port ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.unref();
        resolve((server.address() as AddressInfo).port);
      });
      this.server = server;
    }).catch((err: unknown) => {
      this.port = undefined;
      throw err;
    });
    return this.port;
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const given = Buffer.from(typeof header === 'string' ? header : '');
    const want = Buffer.from(this.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const fail = (status: number, message: string): void => {
      if (res.headersSent) return void res.end();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(anthropicError(status, message)));
    };
    const m = /^\/r\/([0-9a-f]{24})(\/v1\/messages(?:\/count_tokens)?)(?:\?.*)?$/.exec(req.url ?? '');
    const target = m ? this.routes.get(m[1]!) : undefined;
    if (!this.authorized(req)) return fail(401, 'Not this bridge’s token');
    if (!m || !target || req.method !== 'POST') return fail(404, 'Not something an OpenAI-format endpoint can answer');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : 'Not JSON');
    }
    if (m[2]!.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ input_tokens: roughTokens(body) }));
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let up: Response;
    try {
      up = await (this.deps.fetch ?? fetch)(openaiUrl(target.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json', ...(target.key ? { authorization: `Bearer ${target.key}` } : {}) },
        body: JSON.stringify(toOpenAIRequest(body)),
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return void res.end();
      return fail(502, `The OpenAI-format endpoint didn't answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!up.ok) return fail(up.status >= 400 ? up.status : 502, upstreamMessage(up.status, await up.text().catch(() => '')));
    const type = up.headers.get('content-type') ?? '';
    if (!body.stream || !/event-stream/.test(type)) {
      const text = await up.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return fail(502, upstreamMessage(up.status, text));
      }
      const message = fromOpenAIResponse(json, body.model);
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(message));
      }
      // Asked to stream, answered whole: sent as one streamed message.
      return streamWhole(res, message);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const t = new StreamTranslator(body.model);
    const lines = sseLines(
      (chunk) => res.write(t.chunk(chunk)),
      () => undefined,
    );
    try {
      const decoder = new TextDecoder();
      for await (const piece of up.body as unknown as AsyncIterable<Uint8Array>) lines.feed(decoder.decode(piece, { stream: true }));
      lines.flush();
      res.end(t.end());
    } catch (err) {
      if (abort.signal.aborted) return void res.end();
      res.end(`event: error\ndata: ${JSON.stringify(anthropicError(502, `The OpenAI-format endpoint stopped mid-answer: ${err instanceof Error ? err.message : String(err)}`))}\n\n`);
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (b: Buffer) => {
      size += b.length;
      if (size > MAX_BODY) {
        reject(new Error('Too big'));
        req.destroy();
      } else parts.push(b);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/** A whole message as the events of a stream. */
function streamWhole(res: http.ServerResponse, message: Record<string, unknown>): void {
  const ev = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const content = (message.content as Record<string, unknown>[]) ?? [];
  let out = ev('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  content.forEach((b, index) => {
    const empty = b.type === 'text' ? { type: 'text', text: '' } : b.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { ...b, input: {} };
    const delta = b.type === 'text' ? { type: 'text_delta', text: b.text } : b.type === 'thinking' ? { type: 'thinking_delta', thinking: b.thinking } : { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) };
    out += ev('content_block_start', { type: 'content_block_start', index, content_block: empty });
    out += ev('content_block_delta', { type: 'content_block_delta', index, delta });
    out += ev('content_block_stop', { type: 'content_block_stop', index });
  });
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage });
  out += ev('message_stop', { type: 'message_stop' });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(out);
}

/** The daemon's one bridge. */
let shared: OpenAIBridge | undefined;
export const openaiBridge = (): OpenAIBridge => (shared ??= new OpenAIBridge());
