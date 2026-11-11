import { ToolHost } from '../../tool-host.js';
import { CompletionError, type CompletionRequest } from '../types.js';
import { type PermissionRequest, type PromptResponse, type SessionResponse, type SessionUpdate, permissionAnswer } from '../opencode/acp.js';
import { sidePrompt } from '../opencode/complete.js';
import { type CopilotConnect, copilotArgs, spawnCopilot } from './connection.js';
import { copilotModel, httpServers } from './run-parts.js';
import { dropCopilotSession } from './sessions.js';
import { belugaToolOf, copilotCalls, copilotInput, copilotTool } from './tools.js';

export interface CopilotSideDeps {
  readonly connect?: CopilotConnect;
  readonly bin?: string;
  readonly toolHost?: ToolHost;
  /** Drops the session afterwards (tests: a fake). */
  readonly drop?: (sessionId: string) => Promise<unknown>;
}

let host: ToolHost | undefined;

/**
 * A side call on Copilot (agent/side-calls.ts): one prompt in a session of its own (dropped after),
 * without your instruction files (`--no-custom-instructions`), its request marked as input
 * (sidePrompt: Copilot keeps its own coding-agent prompt). It may use only the tools it was given,
 * each one asked about (vetTool) when Copilot asks; Beluga's suites, when given, are mounted for
 * this call alone. On Auto unless a model of Copilot's was named ('haiku' and the like mean nothing to it).
 */
export async function copilotComplete(req: CompletionRequest, deps: CopilotSideDeps = {}): Promise<string> {
  if (req.signal?.aborted) throw new Error('aborted');
  const mounted = req.suites
    ? await (deps.toolHost ?? (host ??= new ToolHost())).mount(req.suites, async (name, input) => {
        const verdict = req.vetTool?.(name, input);
        return verdict && !verdict.allow ? verdict.reason : undefined;
      })
    : undefined;
  const suites = Object.keys(mounted?.http ?? {});
  const model = copilotModel(req.model);
  const conn = await (deps.connect ?? spawnCopilot)({ cwd: req.cwd, args: ['--no-custom-instructions', ...copilotArgs(model ? { model } : {})], ...(deps.bin ? { bin: deps.bin } : {}) }).catch(() => undefined);
  if (!conn) {
    mounted?.close();
    throw new CompletionError('failed');
  }
  const stop = (): void => void conn.proc.kill();
  req.signal?.addEventListener('abort', stop, { once: true });
  let sid = '';
  let text = '';
  const calls = new Map<string, { tool: string; raw: Record<string, unknown> }>();
  try {
    if (req.signal?.aborted) throw new Error('aborted');
    const { rpc } = conn;
    rpc.onNotification((method, params) => {
      if (method !== 'session/update' || !sid || params.sessionId !== sid) return;
      const u = params.update as SessionUpdate;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' && u.content.text) text += u.content.text;
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const known = calls.get(u.toolCallId) ?? { tool: copilotTool(u), raw: {} };
        known.raw = { ...known.raw, ...copilotInput(u) };
        calls.set(u.toolCallId, known);
      }
      // A step starts: what was said before it wasn't the answer.
      if (u.sessionUpdate === 'tool_call') text = '';
    });
    rpc.onRequest(async (method, params) => {
      if (method !== 'session/request_permission') throw new Error(`${method} isn’t supported in Beluga`);
      const p = params as unknown as PermissionRequest;
      const known = calls.get(p.toolCall.toolCallId) ?? { tool: copilotTool(p.toolCall), raw: {} };
      const raw = { ...known.raw, ...copilotInput(p.toolCall) };
      if (belugaToolOf(known.tool, suites)) return permissionAnswer(p, true);
      for (const c of copilotCalls(known.tool, raw, req.cwd, suites)) {
        if (!req.tools?.includes(c.name)) return permissionAnswer(p, false);
        const verdict = req.vetTool?.(c.name, c.input);
        if (verdict && !verdict.allow) return permissionAnswer(p, false);
      }
      return permissionAnswer(p, true);
    });
    const session = await rpc.request<SessionResponse>('session/new', { cwd: req.cwd, mcpServers: mounted ? httpServers(mounted.http) : [] });
    sid = session.sessionId!;
    const blocks = [...(req.images ?? []).map((img) => ({ type: 'image' as const, mimeType: img.mime, data: img.data })), { type: 'text' as const, text: sidePrompt(req) }];
    const res = await Promise.race([rpc.request<PromptResponse>('session/prompt', { sessionId: sid, prompt: blocks }), rpc.closed.then(() => Promise.reject(new Error('Copilot stopped')))]);
    if (req.signal?.aborted) throw new Error('aborted');
    if (res.stopReason === 'max_turn_requests') throw new CompletionError('max_turns');
    if (res.stopReason !== 'end_turn' && res.stopReason !== 'max_tokens') throw new CompletionError('failed');
    if (!text.trim()) throw new CompletionError('no_answer');
    return text.trim();
  } catch (err) {
    if (req.signal?.aborted) throw new Error('aborted');
    throw err instanceof CompletionError ? err : new CompletionError('failed');
  } finally {
    req.signal?.removeEventListener('abort', stop);
    mounted?.close();
    await conn.proc.kill();
    if (sid) void (deps.drop ?? dropCopilotSession)(sid).catch(() => undefined);
  }
}
