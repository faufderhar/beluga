import { type AcpMcpServer, type ConfigOption, type ContentBlock, type PermissionRequest, type PromptResponse, type SessionResponse, type SessionUpdate, permissionAnswer } from './acp.js';
import { type OpenCodeConnect, spawnOpenCode } from './connection.js';
import { dropOpenCodeSession } from './sessions.js';

/** One prompt on OpenCode with nothing kept: a side call (complete.ts) or a side question (btw.ts). */
export interface OneShot {
  readonly cwd: string;
  /** OPENCODE_CONFIG_CONTENT for it. */
  readonly config: Record<string, unknown>;
  readonly blocks: readonly ContentBlock[];
  /** Branch this session (a side question knows the conversation); unset: a new one. */
  readonly fork?: string;
  readonly servers?: readonly AcpMcpServer[];
  /** The session's mode (agent) to run as. */
  readonly mode?: string;
  /** The model, from what the session offers; undefined: its default. */
  readonly model?: (options: readonly ConfigOption[]) => string | undefined;
  /** Whether a tool call may run (undefined: yes; a string: no, and why): its tool (OpenCode's id) and input. Unset: none may. */
  readonly judge?: (call: { readonly tool: string; readonly raw: Record<string, unknown> }) => Promise<string | undefined>;
  /** The answer so far, as it's written. */
  readonly onText?: (soFar: string) => void;
  readonly signal?: AbortSignal;
}

export interface OneShotDeps {
  readonly connect?: OpenCodeConnect;
  readonly bin?: string;
  /** Drops the session afterwards (tests: a fake). */
  readonly drop?: (sessionId: string) => Promise<unknown>;
}

/**
 * Run one prompt and give its answer: OpenCode started without your plugins (`--pure`), one
 * session (dropped afterwards, so it isn't left in your OpenCode history), its words collected.
 */
export async function oneShot(req: OneShot, deps: OneShotDeps = {}): Promise<{ readonly text: string; readonly res: PromptResponse }> {
  if (req.signal?.aborted) throw new Error('aborted');
  const conn = await (deps.connect ?? spawnOpenCode)({ cwd: req.cwd, env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(req.config) }, pure: true, ...(deps.bin ? { bin: deps.bin } : {}) });
  const stop = (): void => void conn.proc.kill();
  req.signal?.addEventListener('abort', stop, { once: true });
  let sid = '';
  let text = '';
  // Each call's tool and input as OpenCode says them (a read's path comes in an update, not its permission request).
  const calls = new Map<string, { tool: string; raw: Record<string, unknown> }>();
  try {
    if (req.signal?.aborted) throw new Error('aborted');
    const { rpc } = conn;
    rpc.onNotification((method, params) => {
      if (method !== 'session/update' || params.sessionId !== sid) return;
      const u = params.update as SessionUpdate;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' && u.content.text) {
        text += u.content.text;
        req.onText?.(text);
      }
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const known = calls.get(u.toolCallId) ?? { tool: u.title ?? '', raw: {} };
        if (u.rawInput) known.raw = { ...known.raw, ...u.rawInput };
        calls.set(u.toolCallId, known);
      }
      // A step starts: what was said before it wasn't the answer.
      if (u.sessionUpdate === 'tool_call') text = '';
    });
    rpc.onRequest(async (method, params) => {
      if (method !== 'session/request_permission') throw new Error(`${method} isn’t supported in Beluga`);
      const p = params as unknown as PermissionRequest;
      if (!req.judge) return permissionAnswer(p, false);
      const known = calls.get(p.toolCall.toolCallId);
      const why = await req.judge({ tool: known?.tool || p.toolCall.title || '', raw: { ...(known?.raw ?? {}), ...(p.toolCall.rawInput ?? {}) } });
      return permissionAnswer(p, !why);
    });
    const servers = [...(req.servers ?? [])];
    const opened = req.fork
      ? await rpc.request<SessionResponse>('session/fork', { sessionId: req.fork, cwd: req.cwd, mcpServers: servers }).catch(() => undefined)
      : undefined;
    const session = opened ?? (await rpc.request<SessionResponse>('session/new', { cwd: req.cwd, mcpServers: servers }));
    sid = session.sessionId!;
    let options = session.configOptions ?? [];
    const choose = async (id: string, value: string | undefined): Promise<void> => {
      const option = options.find((o) => o.id === id);
      if (!value || !option || option.currentValue === value || !option.options.some((o) => o.value === value)) return;
      options = (await rpc.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', { sessionId: sid, configId: id, value })).configOptions ?? options;
    };
    await choose('mode', req.mode);
    await choose('model', req.model?.(options));
    const res = await Promise.race([rpc.request<PromptResponse>('session/prompt', { sessionId: sid, prompt: req.blocks }), rpc.closed.then(() => Promise.reject(new Error('OpenCode stopped')))]);
    if (req.signal?.aborted) throw new Error('aborted');
    return { text: text.trim(), res };
  } finally {
    req.signal?.removeEventListener('abort', stop);
    await conn.proc.kill();
    if (sid) void (deps.drop ?? ((id: string) => dropOpenCodeSession(id, deps.bin)))(sid).catch(() => undefined);
  }
}
