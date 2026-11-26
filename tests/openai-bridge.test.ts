import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAIBridge } from '../src/agent/runtime/openai-bridge.js';
import { StreamTranslator, fromOpenAIResponse, sseLines, toOpenAIRequest, upstreamMessage } from '../src/agent/runtime/openai-format.js';
import { endpointEnv, wireFor } from '../src/agent/runtime/local.js';
import { openaiUrl } from '../src/shared/local-endpoints.js';
import { EnvVars } from '../src/core/env-vars.js';
import { LocalEndpoints } from '../src/core/local-endpoints.js';
import { Store, initialState } from '../src/core/store.js';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The events of an Anthropic stream, parsed. */
const events = (text: string): Array<Record<string, any>> =>
  text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, any>);

describe('OpenAI format: the request', () => {
  it('turns system, text, images, tool calls and tool results into chat messages', () => {
    const out = toOpenAIRequest({
      model: 'Deepseek-V4.1-Flash',
      max_tokens: 1000,
      stream: true,
      stop_sequences: ['END'],
      system: [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }, { type: 'web_search_20250305', name: 'web_search' }],
      tool_choice: { type: 'any' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: '' }, { type: 'text', text: 'Reading' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'file body' }] }, { type: 'text', text: 'and?' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'nope', is_error: true }] },
      ],
    });
    expect(out).toMatchObject({ model: 'Deepseek-V4.1-Flash', max_tokens: 1000, stop: ['END'], stream: true, stream_options: { include_usage: true }, tool_choice: 'required' });
    // Anthropic's own server tools have no schema and go.
    expect(out.tools).toEqual([{ type: 'function', function: { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]);
    expect(out.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
      { role: 'assistant', content: 'Reading', reasoning_content: 'hmm', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      { role: 'user', content: 'and?' },
      { role: 'tool', tool_call_id: 'call_2', content: 'Error: nope' },
    ]);
  });

  it('a version already in the address is kept; a bare address gets /v1', () => {
    expect(openaiUrl('https://sandu18.com/v1', 'chat/completions')).toBe('https://sandu18.com/v1/chat/completions');
    expect(openaiUrl('https://sandu18.com/', 'chat/completions')).toBe('https://sandu18.com/v1/chat/completions');
    expect(openaiUrl('https://open.bigmodel.cn/api/paas/v4', 'models')).toBe('https://open.bigmodel.cn/api/paas/v4/models');
  });
});

describe('OpenAI format: the answer', () => {
  it('a whole answer: thinking, text, tool calls, stop reason and cached tokens', () => {
    const msg = fromOpenAIResponse(
      {
        id: 'chatcmpl-1',
        model: 'm',
        choices: [{ finish_reason: 'tool_calls', message: { reasoning_content: 'r', content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"x"}' } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } },
      },
      'm',
    );
    expect(msg).toMatchObject({
      type: 'message',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'thinking', thinking: 'r' }, { type: 'text', text: 'hi' }, { type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'x' } }],
      usage: { input_tokens: 60, output_tokens: 7, cache_read_input_tokens: 40 },
    });
    expect(fromOpenAIResponse({ choices: [{ finish_reason: 'length', message: { content: 'cut' } }] }, 'm').stop_reason).toBe('max_tokens');
  });

  it('a stream: text as it comes, tool calls whole at the end in order, then the stop reason and usage', () => {
    const t = new StreamTranslator('m');
    let out = '';
    const lines = sseLines((c) => (out += t.chunk(c)), () => undefined);
    const chunks = [
      { id: 'x', choices: [{ delta: { reasoning_content: 'think' } }] },
      { id: 'x', choices: [{ delta: { content: 'Hel' } }] },
      { id: 'x', choices: [{ delta: { content: 'lo' } }] },
      { id: 'x', choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'Two', arguments: '{"n":' } }] } }] },
      { id: 'x', choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'One', arguments: '{}' } }] } }] },
      { id: 'x', choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] }, finish_reason: 'tool_calls' }] },
      { id: 'x', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    // Pieces split mid-line, as a network delivers them.
    const text = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(': keep-alive\n')}data: [DONE]\n\n`;
    for (let i = 0; i < text.length; i += 17) lines.feed(text.slice(i, i + 17));
    lines.flush();
    out += t.end();
    expect(t.end()).toBe('');
    const ev = events(out);
    expect(ev.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ]);
    expect(ev[1]!.content_block.type).toBe('thinking');
    expect(ev.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join('')).toBe('Hello');
    const tools = ev.filter((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
    expect(tools.map((e) => [e.index, e.content_block.name])).toEqual([[2, 'One'], [3, 'Two']]);
    expect(ev.filter((e) => e.delta?.type === 'input_json_delta').map((e) => JSON.parse(e.delta.partial_json))).toEqual([{}, { n: 2 }]);
    expect(ev.at(-2)).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 5 } });
  });

  it('says plainly when the endpoint answered a web page instead of JSON', () => {
    expect(upstreamMessage(500, '<html>oops</html>')).toMatch(/web page, not JSON/);
    expect(upstreamMessage(503, '{"error":{"message":"no such model in group"}}')).toBe('The OpenAI-format endpoint answered 503: no such model in group');
  });
});

describe('OpenAI format: the bridge', () => {
  let upstream: http.Server;
  let base = '';
  const seen: Array<{ url: string; auth: string; body: any }> = [];

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (b) => (raw += b));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '', body });
        if (body.model === 'broken') {
          res.writeHead(500, { 'content-type': 'text/html' });
          return void res.end('<html>bad gateway</html>');
        }
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ id: 'w', choices: [{ finish_reason: 'stop', message: { content: 'whole' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 's', choices: [{ delta: { content: 'str' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 's', choices: [{ delta: { content: 'eamed' }, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it('answers Claude Code’s /v1/messages from the endpoint’s /chat/completions, the key kept in the bridge', async () => {
    const bridge = new OpenAIBridge();
    try {
      const route = await bridge.route({ baseUrl: base, key: 'sk-upstream' });
      expect(route.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/[0-9a-f]{24}$/);
      expect(route.token).not.toContain('sk-upstream');
      const post = (body: unknown, token = route.token, at = '/v1/messages') => fetch(`${route.baseUrl}${at}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

      const streamed = await post({ model: 'm', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] });
      expect(streamed.status).toBe(200);
      const ev = events(await streamed.text());
      expect(ev.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join('')).toBe('streamed');
      expect(ev.at(-1)!.type).toBe('message_stop');
      expect(seen.at(-1)).toMatchObject({ url: '/v1/chat/completions', auth: 'Bearer sk-upstream', body: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] } });

      const whole = await post({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      expect(await whole.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'whole' }], stop_reason: 'end_turn' });

      const count = await post({ model: 'm', messages: [{ role: 'user', content: 'hello there' }] }, route.token, '/v1/messages/count_tokens');
      expect((await count.json()).input_tokens).toBeGreaterThan(0);

      // The endpoint's web page comes back as an Anthropic error Claude Code shows.
      const broken = await post({ model: 'broken', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      expect(broken.status).toBe(500);
      expect(await broken.json()).toMatchObject({ type: 'error', error: { type: 'api_error', message: expect.stringMatching(/web page/) } });

      // Without the bridge's token, nothing goes through (another program on this computer can't use your key).
      const before = seen.length;
      expect((await post({ model: 'm', messages: [] }, 'wrong')).status).toBe(401);
      expect(seen.length).toBe(before);
    } finally {
      await bridge.close();
    }
  });

  it('a run on an OpenAI-format endpoint points Claude Code at the bridge; an Anthropic one at the endpoint itself', async () => {
    const target = { label: 'Sandu', baseUrl: 'https://sandu18.com/v1', key: 'sk-up', model: 'Deepseek-V4.1-Flash', format: 'openai' as const };
    const wire = await wireFor(target, async () => ({ baseUrl: 'http://127.0.0.1:1/r/abc', token: 'tok' }));
    expect(wire).toEqual({ baseUrl: 'http://127.0.0.1:1/r/abc', key: 'tok' });
    const env = endpointEnv(target, '/tmp/x', wire);
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/r/abc', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'Deepseek-V4.1-Flash' });
    expect(Object.values(env)).not.toContain('sk-up');
    expect(await wireFor({ ...target, format: 'anthropic' })).toEqual({ baseUrl: 'https://sandu18.com/v1', key: 'sk-up' });
  });

  it('keeps the format with the endpoint, lists its models from …/v1/models, and resolves runs with it', async () => {
    const env = new EnvVars({ store: new Store(initialState('t')), file: path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-openai-')), 'env.json') });
    const id = env.saveEndpoint({ label: 'Sandu', baseUrl: `${base}/`, key: 'sk-up', format: 'openai' });
    expect(env.endpoints()[0]).toMatchObject({ id, format: 'openai', baseUrl: base });
    // An edit that doesn't say keeps it; one that says Anthropic drops it.
    env.saveEndpoint({ id, label: 'Sandu', baseUrl: base });
    expect(env.endpoints()[0]!.format).toBe('openai');
    const urls: string[] = [];
    const local = new LocalEndpoints({
      endpoints: () => env.endpoints(),
      fetch: (async (u: string | URL | Request) => (urls.push(String(u)), new Response(JSON.stringify({ data: [{ id: 'Deepseek-V4.1-Flash' }] }), { status: 200 }))) as typeof fetch,
    });
    await local.look();
    expect(urls).toContain(`${base}/models`);
    expect(local.views().find((v) => v.id === id)).toMatchObject({ format: 'openai', found: ['Deepseek-V4.1-Flash'], reachable: true });
    expect(local.resolve(`${id}/Deepseek-V4.1-Flash`)).toMatchObject({ format: 'openai', key: 'sk-up', model: 'Deepseek-V4.1-Flash' });
    env.saveEndpoint({ id, label: 'Sandu', baseUrl: base, format: 'anthropic' });
    expect(env.endpoints()[0]!.format).toBeUndefined();
  });
});
