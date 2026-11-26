/**
 * Anthropic Messages ⇄ OpenAI Chat Completions, for an endpoint that only speaks OpenAI's format
 * (see openai-bridge.ts). Claude Code sends /v1/messages; this turns that request into a
 * /chat/completions one, and the answer (streamed or whole) back into what Claude Code reads.
 * Pure: no network, so the tests can hold it to fixed inputs.
 */

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One OpenAI chat message as we build it. */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Json[] | null;
  tool_calls?: Json[];
  tool_call_id?: string;
  reasoning_content?: string;
}

/** The text of a system prompt or a tool result, however Anthropic shaped it. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b) => (isObj(b) && b.type === 'text' ? [str(b.text)] : isObj(b) && b.type === 'image' ? ['[image]'] : []))
    .join('\n');
}

/** An Anthropic image block as an OpenAI image part (base64 → a data: URL). */
function imagePart(b: Json): Json | undefined {
  const src = b.source;
  if (!isObj(src)) return undefined;
  if (src.type === 'base64') return { type: 'image_url', image_url: { url: `data:${str(src.media_type) || 'image/png'};base64,${str(src.data)}` } };
  if (src.type === 'url') return { type: 'image_url', image_url: { url: str(src.url) } };
  return undefined;
}

/** A user turn: tool results first (each its own `tool` message), then what the person said. */
function userMessages(content: unknown): OpenAIMessage[] {
  if (typeof content === 'string') return [{ role: 'user', content }];
  if (!Array.isArray(content)) return [];
  const tools: OpenAIMessage[] = [];
  const parts: Json[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'tool_result') {
      const text = textOf(b.content);
      tools.push({ role: 'tool', tool_call_id: str(b.tool_use_id), content: b.is_error ? `Error: ${text}` : text });
      // An image a tool returned (a screenshot) goes along as the next user turn's: tool messages take only text.
      if (Array.isArray(b.content)) for (const c of b.content) if (isObj(c) && c.type === 'image') parts.push(...[imagePart(c)].filter((x): x is Json => Boolean(x)));
    } else if (b.type === 'text') parts.push({ type: 'text', text: str(b.text) });
    else if (b.type === 'image') {
      const img = imagePart(b);
      if (img) parts.push(img);
    } else if (b.type === 'document') parts.push({ type: 'text', text: textOf(isObj(b.source) ? (b.source as Json).content ?? str((b.source as Json).data) : '') || '[document]' });
  }
  const out = [...tools];
  if (parts.length) out.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => str(p.text)).join('\n') : parts });
  return out;
}

/** An assistant turn: its text, its tool calls, and its thinking as `reasoning_content` (DeepSeek wants it back). */
function assistantMessage(content: unknown): OpenAIMessage {
  if (typeof content === 'string') return { role: 'assistant', content };
  const text: string[] = [];
  const thinking: string[] = [];
  const calls: Json[] = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!isObj(b)) continue;
    if (b.type === 'text') text.push(str(b.text));
    else if (b.type === 'thinking') thinking.push(str(b.thinking));
    else if (b.type === 'tool_use') calls.push({ id: str(b.id), type: 'function', function: { name: str(b.name), arguments: JSON.stringify(b.input ?? {}) } });
  }
  return {
    role: 'assistant',
    content: text.length ? text.join('') : calls.length ? null : '',
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(thinking.length ? { reasoning_content: thinking.join('') } : {}),
  };
}

/** Anthropic's tool_choice in OpenAI's words. */
function toolChoice(choice: unknown): unknown {
  if (!isObj(choice)) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool') return { type: 'function', function: { name: str(choice.name) } };
  return undefined;
}

/** A /v1/messages request body as a /chat/completions one. */
export function toOpenAIRequest(body: Json): Json {
  const messages: OpenAIMessage[] = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObj(m)) continue;
    if (m.role === 'assistant') messages.push(assistantMessage(m.content));
    else messages.push(...userMessages(m.content));
  }
  // Only tools with a schema: Anthropic's own server tools (web search…) have none and no endpoint runs them.
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((t): t is Json => isObj(t) && isObj(t.input_schema))
    .map((t) => ({ type: 'function', function: { name: str(t.name), ...(t.description ? { description: str(t.description) } : {}), parameters: t.input_schema } }));
  const choice = tools.length ? toolChoice(body.tool_choice) : undefined;
  const stream = body.stream === true;
  return {
    model: body.model,
    messages,
    ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length ? { stop: body.stop_sequences } : {}),
    ...(tools.length ? { tools } : {}),
    ...(choice !== undefined ? { tool_choice: choice } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

/** OpenAI's finish_reason as Anthropic's stop_reason. */
export function stopReason(finish: unknown, hadTools: boolean): string {
  if (hadTools || finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  return 'end_turn';
}

/** OpenAI's usage in Anthropic's words: cached prompt tokens apart from the rest. */
export function usageOf(u: unknown): { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } {
  if (!isObj(u)) return { input_tokens: 0, output_tokens: 0 };
  const prompt = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
  const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
  const details = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const cached = typeof details.cached_tokens === 'number' ? details.cached_tokens : typeof u.prompt_cache_hit_tokens === 'number' ? u.prompt_cache_hit_tokens : 0;
  return { input_tokens: Math.max(0, prompt - cached), output_tokens: output, ...(cached ? { cache_read_input_tokens: cached } : {}) };
}

const messageId = (id: unknown): string => `msg_${str(id).replace(/[^\w-]/g, '') || Math.random().toString(36).slice(2)}`;

/** Tool arguments as an object: a model that wrote broken JSON still gets its call through, as text. */
function argsOf(text: string): unknown {
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : { value: v };
  } catch {
    return { _raw: text };
  }
}

/** A whole /chat/completions answer as a /v1/messages one. */
export function fromOpenAIResponse(res: Json, model: unknown): Json {
  const choice = Array.isArray(res.choices) && isObj(res.choices[0]) ? res.choices[0] : {};
  const msg = isObj(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const reasoning = str(msg.reasoning_content) || str(msg.reasoning);
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: '' });
  if (str(msg.content)) content.push({ type: 'text', text: str(msg.content) });
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter(isObj) : [];
  calls.forEach((c, i) => {
    const fn = isObj(c.function) ? c.function : {};
    content.push({ type: 'tool_use', id: str(c.id) || `call_${i}`, name: str(fn.name), input: argsOf(str(fn.arguments)) });
  });
  return {
    id: messageId(res.id),
    type: 'message',
    role: 'assistant',
    model: str(res.model) || model,
    content,
    stop_reason: stopReason(choice.finish_reason, calls.length > 0),
    stop_sequence: null,
    usage: usageOf(res.usage),
  };
}

/** One server-sent event as Claude Code reads it. */
const sse = (event: string, data: Json): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * A streamed /chat/completions answer, chunk by chunk, as /v1/messages events. Text and thinking
 * stream as they come; tool calls are gathered and sent whole at the end (their pieces can come
 * interleaved by index, and Claude Code needs each call's JSON whole before it runs it anyway).
 */
export class StreamTranslator {
  private started = false;
  private index = 0;
  private open: 'text' | 'thinking' | undefined;
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private finish: unknown;
  private usage: unknown;
  private id: unknown;
  private done = false;

  constructor(private readonly model: unknown) {}

  /** The events for one parsed `data:` chunk. */
  chunk(c: Json): string {
    let out = this.start(c);
    if (c.usage) this.usage = c.usage;
    const choice = Array.isArray(c.choices) && isObj(c.choices[0]) ? c.choices[0] : undefined;
    if (!choice) return out;
    if (choice.finish_reason) this.finish = choice.finish_reason;
    const delta = isObj(choice.delta) ? choice.delta : {};
    const reasoning = str(delta.reasoning_content) || str(delta.reasoning);
    if (reasoning) out += this.write('thinking', reasoning);
    if (str(delta.content)) out += this.write('text', str(delta.content));
    for (const t of Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isObj) : []) {
      const at = typeof t.index === 'number' ? t.index : this.calls.size;
      const fn = isObj(t.function) ? t.function : {};
      const call = this.calls.get(at) ?? { id: '', name: '', args: '' };
      this.calls.set(at, { id: call.id || str(t.id), name: call.name || str(fn.name), args: call.args + str(fn.arguments) });
    }
    return out;
  }

  /** The closing events: open block, the tool calls, the stop reason and usage. Once. */
  end(): string {
    if (this.done) return '';
    this.done = true;
    let out = this.start({}) + this.close();
    for (const [at, call] of [...this.calls].sort((a, b) => a[0] - b[0])) {
      const i = this.index++;
      out += sse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: call.id || `call_${at}`, name: call.name, input: {} } });
      const args = JSON.stringify(argsOf(call.args));
      out += sse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: args } });
      out += sse('content_block_stop', { type: 'content_block_stop', index: i });
    }
    const usage = usageOf(this.usage);
    out += sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason(this.finish, this.calls.size > 0), stop_sequence: null }, usage });
    out += sse('message_stop', { type: 'message_stop' });
    return out;
  }

  private start(c: Json): string {
    if (this.started) return '';
    this.started = true;
    this.id = c.id;
    return sse('message_start', {
      type: 'message_start',
      message: { id: messageId(this.id), type: 'message', role: 'assistant', model: str(c.model) || this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }

  private write(kind: 'text' | 'thinking', text: string): string {
    let out = '';
    if (this.open !== kind) {
      out += this.close();
      this.open = kind;
      out += sse('content_block_start', { type: 'content_block_start', index: this.index, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' } });
    }
    const delta = kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text };
    return out + sse('content_block_delta', { type: 'content_block_delta', index: this.index, delta });
  }

  private close(): string {
    if (!this.open) return '';
    const i = this.index++;
    this.open = undefined;
    return sse('content_block_stop', { type: 'content_block_stop', index: i });
  }
}

/**
 * Reads an SSE byte stream line by line and hands each `data:` JSON to `onData` ([DONE] ends it).
 * → feed(text) for each piece as it arrives, flush() at the end.
 */
export function sseLines(onData: (data: Json) => void, onDone: () => void): { feed: (text: string) => void; flush: () => void } {
  let buf = '';
  const line = (raw: string): void => {
    const l = raw.replace(/\r$/, '');
    if (!l.startsWith('data:')) return;
    const data = l.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') return onDone();
    try {
      const v: unknown = JSON.parse(data);
      if (isObj(v)) onData(v);
    } catch {
      // A line that isn't JSON (a keep-alive comment some gateways send) is skipped.
    }
  };
  return {
    feed: (text) => {
      buf += text;
      let at: number;
      while ((at = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, at));
        buf = buf.slice(at + 1);
      }
    },
    flush: () => {
      if (buf) line(buf);
      buf = '';
    },
  };
}

/** An error in Anthropic's shape, so Claude Code shows its message. */
export function anthropicError(status: number, message: string): Json {
  const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
  return { type: 'error', error: { type, message } };
}

/** What an OpenAI endpoint said when it refused: its own message, or plain words for a web page. */
export function upstreamMessage(status: number, body: string): string {
  try {
    const v: unknown = JSON.parse(body);
    if (isObj(v)) {
      const e = v.error;
      const msg = isObj(e) ? str(e.message) : typeof e === 'string' ? e : str(v.message);
      if (msg) return `The OpenAI-format endpoint answered ${status}: ${msg}`;
    }
  } catch {
    // Not JSON: said below.
  }
  if (/^\s*</.test(body)) return `The OpenAI-format endpoint answered ${status} with a web page, not JSON. Check its address (it should end where /chat/completions goes, e.g. …/v1).`;
  return `The OpenAI-format endpoint answered ${status}${body.trim() ? `: ${body.trim().slice(0, 300)}` : ''}`;
}

/** A rough token count for /v1/messages/count_tokens (an OpenAI endpoint has none): 4 characters a token. */
export function roughTokens(body: Json): number {
  return Math.ceil(JSON.stringify([body.system ?? '', body.messages ?? [], body.tools ?? []]).length / 4);
}
