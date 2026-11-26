import { ToolHost } from '../../tool-host.js';
import { CompletionError, type CompletionRequest } from '../types.js';
import { type ConfigOption, type PermissionRequest, type PromptResponse, type SessionResponse, type SessionUpdate, permissionAnswer } from '../opencode/acp.js';
import { sidePrompt } from '../opencode/complete.js';
import { spawnAcp } from './connection.js';
import type { AcpExtension } from './extension.js';
import { GENERIC_TOOLS, mcpServersFor } from './dialect.js';
import { acpModel, declinedNote } from './parts.js';
import type { AcpAgentSpec, AcpConnect } from './spec.js';

export interface AcpSideDeps {
  readonly connect?: AcpConnect;
  readonly bin?: string;
  readonly toolHost?: ToolHost;
  /** Drops the conversation afterwards (tests: a fake; else the extension's). */
  readonly drop?: (sessionId: string) => Promise<unknown>;
}

let host: ToolHost | undefined;

/**
 * A side call on an ACP agent (agent/side-calls.ts): one prompt in a conversation of its own
 * (dropped after), its request marked as input (sidePrompt: the agent keeps its own system
 * prompt). It may use only the tools it was given, each one asked about (vetTool) when the agent
 * asks; Beluga's suites, when given, are mounted for this call alone. A model of the agent's
 * when one was named; 'haiku' (small and fast) is its default model at its lowest thinking level.
 */
export async function acpComplete(spec: AcpAgentSpec, ext: AcpExtension, req: CompletionRequest, deps: AcpSideDeps = {}): Promise<string> {
  if (req.signal?.aborted) throw new Error('aborted');
  const mounted = req.suites
    ? await (deps.toolHost ?? (host ??= new ToolHost())).mount(req.suites, async (name, input) => {
        const verdict = req.vetTool?.(name, input);
        return verdict && !verdict.allow ? verdict.reason : undefined;
      })
    : undefined;
  const suites = Object.keys(mounted?.http ?? {});
  const ours = mounted?.tools ?? new Set<string>();
  const tools = ext.tools ?? GENERIC_TOOLS;
  const dialect = tools.dialect(ours);
  const conn = await (deps.connect ?? spawnAcp(spec, ext))({ cwd: req.cwd, look: true, ...(deps.bin ? { bin: deps.bin } : {}) }).catch(() => undefined);
  if (!conn) {
    mounted?.close();
    throw new CompletionError('failed');
  }
  const stop = (): void => void conn.proc.kill();
  req.signal?.addEventListener('abort', stop, { once: true });
  let sid = '';
  let text = '';
  /** Why this call's steps were turned down (an agent may end its turn silently on one). */
  const declined: string[] = [];
  const calls = new Map<string, { tool: string; raw: Record<string, unknown> }>();
  try {
    if (req.signal?.aborted) throw new Error('aborted');
    const { rpc } = conn;
    rpc.onNotification((method, params) => {
      if (method !== 'session/update' || !sid || params.sessionId !== sid) return;
      const u = params.update as SessionUpdate;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' && u.content.text) text += u.content.text;
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const known = calls.get(u.toolCallId) ?? { tool: dialect.toolOf(u), raw: {} };
        known.raw = { ...known.raw, ...dialect.inputOf(u) };
        calls.set(u.toolCallId, known);
      }
      // A step starts: what was said before it wasn't the answer.
      if (u.sessionUpdate === 'tool_call') text = '';
    });
    rpc.onRequest(async (method, params) => {
      if (method !== 'session/request_permission') throw new Error(`${method} isn’t supported in Beluga`);
      const p = params as unknown as PermissionRequest;
      const known = calls.get(p.toolCall.toolCallId) ?? { tool: dialect.toolOf(p.toolCall), raw: {} };
      const raw = { ...known.raw, ...dialect.inputOf(p.toolCall) };
      if (tools.belugaToolOf(known.tool, suites, ours)) return permissionAnswer(p, true);
      for (const c of dialect.callsOf(known.tool, raw, req.cwd, suites)) {
        if (!req.tools?.includes(c.name)) return (declined.push(`${c.name} isn’t one of this request’s tools.`), permissionAnswer(p, false));
        const verdict = req.vetTool?.(c.name, c.input);
        if (verdict && !verdict.allow) return (declined.push(verdict.reason || `${c.name} isn’t allowed here.`), permissionAnswer(p, false));
      }
      return permissionAnswer(p, true);
    });
    const session = await rpc.request<SessionResponse>('session/new', { cwd: req.cwd, mcpServers: mounted ? mcpServersFor(mounted, conn.init, ext.mount) : [] });
    sid = session.sessionId!;
    const options: readonly ConfigOption[] = session.configOptions ?? [];
    const set = async (id: string, value: string | undefined): Promise<void> => {
      const option = options.find((o) => o.id === id);
      if (value && option && option.currentValue !== value && option.options.some((o) => o.value === value)) await rpc.request('session/set_config_option', { sessionId: sid, configId: id, value }).catch(() => undefined);
    };
    await set('model', ext.model ? ext.model(req.model) : acpModel(req.model));
    const low = ext.effort?.('low');
    if (req.model && /haiku/i.test(req.model) && low) await set(low.id, low.value);
    const blocks = [...(req.images ?? []).map((img) => ({ type: 'image' as const, mimeType: img.mime, data: img.data })), { type: 'text' as const, text: sidePrompt(req) }];
    const ask = (prompt: typeof blocks | Array<{ type: 'text'; text: string }>): Promise<PromptResponse> => Promise.race([rpc.request<PromptResponse>('session/prompt', { sessionId: sid, prompt }), rpc.closed.then(() => Promise.reject(new Error(`${spec.label} stopped`)))]);
    let res = await ask(blocks);
    if (!text.trim() && res.stopReason === 'end_turn' && declined.length) res = await ask([{ type: 'text', text: ext.declinedNote ? ext.declinedNote(declined) : declinedNote(declined) }]);
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
    const drop = deps.drop ?? (ext.dropSession ? (id: string) => ext.dropSession!(id) : undefined);
    if (sid && drop) void drop(sid).catch(() => undefined);
  }
}
