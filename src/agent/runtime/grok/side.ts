import { type BtwRequest, btwPrompt } from '../../btw.js';
import { ToolHost } from '../../tool-host.js';
import type { AcpMcpServer, ConfigOption, ContentBlock, PermissionRequest, PromptResponse, SessionResponse, SessionUpdate } from '../opencode/acp.js';
import { permissionAnswer } from '../opencode/acp.js';
import { sidePrompt } from '../opencode/complete.js';
import { acpServers } from '../opencode/runner.js';
import { CompletionError, type CompletionRequest } from '../types.js';
import { type GrokConnect, spawnGrok } from './connection.js';
import { GROK_OWN, grokCalls, grokToolOf, isBelugaTool } from './tools.js';
import { dropGrokSession, grokSessionFolder } from './sessions.js';

/** How many times a side call goes on after a tool it may not use was turned down. */
const DENIALS = 2;

export interface GrokSideDeps {
  readonly connect?: GrokConnect;
  readonly bin?: string;
  /** Drops the session afterwards (tests: a fake). */
  readonly drop?: (sessionId: string) => Promise<unknown>;
  readonly toolHost?: ToolHost;
}

interface OneShot {
  readonly cwd: string;
  readonly system?: string;
  readonly blocks: readonly ContentBlock[];
  /** Branch this session (a side question knows the conversation); unset: a new one. */
  readonly fork?: string;
  readonly servers?: readonly AcpMcpServer[];
  /** The model, from what the session offers; undefined: its default. */
  readonly model?: (options: readonly ConfigOption[]) => string | undefined;
  /** Whether a tool call may run (undefined: yes; a string: no, and why). Unset: none may. */
  readonly judge?: (call: { readonly tool: string; readonly raw: Record<string, unknown> }) => Promise<string | undefined>;
  readonly onText?: (soFar: string) => void;
  readonly signal?: AbortSignal;
}

const lowest = (options: readonly ConfigOption[]): string | undefined => options.find((o) => o.id === 'reasoning_effort')?.options.find((o) => o.value === 'low')?.value;

/** One prompt on Grok with nothing kept: its own session, deleted after, its words collected. */
async function oneShot(req: OneShot, deps: GrokSideDeps): Promise<{ readonly text: string; readonly res: PromptResponse }> {
  if (req.signal?.aborted) throw new Error('aborted');
  const conn = await (deps.connect ?? spawnGrok)({ cwd: req.cwd, env: { ...process.env }, ...(deps.bin ? { bin: deps.bin } : {}) });
  const stop = (): void => void conn.proc.kill();
  req.signal?.addEventListener('abort', stop, { once: true });
  const opened: string[] = [];
  let sid = '';
  let text = '';
  const declined: string[] = [];
  try {
    const { rpc } = conn;
    rpc.onNotification((method, params) => {
      if (method !== 'session/update' || params.sessionId !== sid) return;
      const u = params.update as SessionUpdate;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' && u.content.text) {
        text += u.content.text;
        req.onText?.(text);
      }
      // A step starts: what was said before it wasn't the answer.
      if (u.sessionUpdate === 'tool_call') text = '';
    });
    rpc.onRequest(async (method, params) => {
      if (method !== 'session/request_permission') {
        declined.push(`Beluga can’t answer ${method}.`);
        throw new Error(`${method} isn’t supported in Beluga`);
      }
      const p = params as unknown as PermissionRequest;
      const tool = grokToolOf(p.toolCall);
      const why = GROK_OWN.has(tool) ? undefined : req.judge ? await req.judge({ tool, raw: p.toolCall.rawInput ?? {} }) : 'Not one of this call’s tools.';
      if (why) declined.push(why);
      return permissionAnswer(p, !why);
    });
    const mcpServers = [...(req.servers ?? [])];
    const forked = req.fork ? await forkGrok(conn.rpc, req.fork, req.cwd, mcpServers) : undefined;
    const session = forked ?? (await rpc.request<SessionResponse>('session/new', { cwd: req.cwd, mcpServers, ...(req.system ? { _meta: { systemPromptOverride: req.system } } : {}) }));
    sid = session.sessionId!;
    opened.push(sid);
    let options = session.configOptions ?? [];
    const choose = async (id: string, value: string | undefined): Promise<void> => {
      const option = options.find((o) => o.id === id);
      if (!value || !option || option.currentValue === value || !option.options.some((o) => o.value === value)) return;
      options = (await rpc.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', { sessionId: sid, configId: id, value })).configOptions ?? options;
    };
    await choose('model', req.model?.(options));
    await choose('reasoning_effort', lowest(options));
    const send = (prompt: readonly ContentBlock[]): Promise<PromptResponse> => Promise.race([rpc.request<PromptResponse>('session/prompt', { sessionId: sid, prompt }), rpc.closed.then(() => Promise.reject(new Error('Grok Build stopped')))]);
    let res = await send(req.blocks);
    // A step turned down ends Grok's turn: it goes on, told why.
    for (let i = 0; i < DENIALS && res.stopReason === 'cancelled' && declined.length; i++) {
      const why = declined.splice(0).join(' ');
      res = await send([{ type: 'text', text: `That step was turned down: ${why} Answer without it.` }]);
    }
    if (req.signal?.aborted) throw new Error('aborted');
    return { text: text.trim(), res };
  } finally {
    req.signal?.removeEventListener('abort', stop);
    await conn.proc.kill();
    for (const id of opened) void (deps.drop ?? ((s: string) => dropGrokSession(s, deps.bin)))(id).catch(() => undefined);
  }
}

/** Branch a session into a new one, open: Grok's own extension (`x.ai/session/fork`), then opened by its new id. Undefined when it couldn't. */
export async function forkGrok(rpc: { request<T>(method: string, params: Record<string, unknown>): Promise<T> }, source: string, cwd: string, mcpServers: readonly AcpMcpServer[], from: string = grokSessionFolder(source) ?? cwd): Promise<SessionResponse | undefined> {
  try {
    const { newSessionId } = await rpc.request<{ newSessionId?: string }>('_x.ai/session/fork', { sourceSessionId: source, sourceCwd: from, newCwd: cwd, cwd, mcpServers });
    if (!newSessionId) return undefined;
    const opened = await rpc.request<SessionResponse>('session/resume', { sessionId: newSessionId, cwd, mcpServers });
    return { ...opened, sessionId: newSessionId };
  } catch {
    return undefined;
  }
}

let host: ToolHost | undefined;

/**
 * A side call on Grok (agent/side-calls.ts): one prompt in a session of its own (dropped after),
 * `system` as its whole prompt, at its lowest effort, using only the tools it was given, each one
 * asked about (vetTool) before it runs. A model of Claude's ("haiku") means Grok's default.
 */
export async function grokComplete(req: CompletionRequest, deps: GrokSideDeps = {}): Promise<string> {
  if (req.signal?.aborted) throw new Error('aborted');
  const mounted = req.suites
    ? await (deps.toolHost ?? (host ??= new ToolHost())).mount(req.suites, async (name, input) => {
        const verdict = req.vetTool?.(name, input);
        return verdict && !verdict.allow ? verdict.reason : undefined;
      })
    : undefined;
  const suites = Object.keys(mounted?.servers ?? {});
  try {
    const { text, res } = await oneShot(
      {
        cwd: req.cwd,
        system: req.system,
        blocks: [...(req.images ?? []).map((img) => ({ type: 'image' as const, mimeType: img.mime, data: img.data })), { type: 'text', text: sidePrompt(req) }],
        servers: mounted ? acpServers(mounted.servers) : [],
        model: (options) => (req.model && options.find((o) => o.id === 'model')?.options.some((o) => o.value === req.model) ? req.model : undefined),
        judge: async ({ tool, raw }) => {
          for (const c of grokCalls(tool, raw, req.cwd)) {
            if (isBelugaTool(c.name, suites)) continue;
            if (!req.tools?.includes(c.name)) return 'Not one of this call’s tools.';
            if ((c.name === 'Read' && !c.input.file_path) || (c.name === 'Bash' && !c.input.command)) return 'Grok Build didn’t say what this is for.';
            const verdict = req.vetTool?.(c.name, c.input);
            if (verdict && !verdict.allow) return verdict.reason;
          }
          return undefined;
        },
        ...(req.signal ? { signal: req.signal } : {}),
      },
      deps,
    );
    if (res.stopReason === 'max_turn_requests') throw new CompletionError('max_turns');
    if (res.stopReason !== 'end_turn' && res.stopReason !== 'max_tokens') throw new CompletionError('failed');
    if (!text) throw new CompletionError('no_answer');
    return text;
  } catch (err) {
    if (req.signal?.aborted) throw new Error('aborted');
    throw err instanceof CompletionError ? err : new CompletionError('failed');
  } finally {
    mounted?.close();
  }
}

/** A side question about a conversation (/btw): a fork of its session, every tool turned down, answered once and the fork dropped. */
export async function askGrokBtw(req: BtwRequest, deps: GrokSideDeps = {}): Promise<string> {
  const { text } = await oneShot(
    {
      cwd: req.cwd,
      blocks: [{ type: 'text', text: btwPrompt(req.question) }],
      ...(req.resume ? { fork: req.resume } : {}),
      model: (options) => (req.model && options.find((o) => o.id === 'model')?.options.some((o) => o.value === req.model) ? req.model : undefined),
      onText: req.onText,
      signal: req.signal,
    },
    deps,
  );
  return text;
}
