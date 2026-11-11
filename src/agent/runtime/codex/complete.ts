import { ToolHost } from '../../tool-host.js';
import { CompletionError, type CompletionRequest } from '../types.js';
import { type CodexConnect, spawnAppServer } from './app-server.js';
import type { Model, ThreadItem, ThreadStartResponse, Turn } from './protocol.js';
import { RUN_FEATURES_OFF, mcpConfig, pickCodexModel } from './runner.js';
import { sideCallConfinement } from './sandbox.js';

let host: ToolHost | undefined;
const MODEL_LIST_TIMEOUT_MS = 10_000;

/**
 * A side call on Codex (agent/side-calls.ts): one turn on an ephemeral thread (nothing saved),
 * read-only and never asking, with `system` as its whole instructions. Codex's own commands can't
 * be vetted per call, so its sandbox holds what Claude's tool list would (sideCallConfinement):
 * no home, no secret stores, no `.env`, and no folder at all for a call given no tools. Beluga's
 * suites, when given, are mounted for this call alone and vetted per call.
 */
export async function codexComplete(req: CompletionRequest, deps: { readonly connect?: CodexConnect; readonly bin?: string; readonly toolHost?: ToolHost } = {}): Promise<string> {
  if (req.signal?.aborted) throw new Error('aborted');
  const mounted = req.suites
    ? await (deps.toolHost ?? (host ??= new ToolHost())).mount(req.suites, async (name, input) => {
        const verdict = req.vetTool?.(name, input);
        return verdict && !verdict.allow ? verdict.reason : undefined;
      })
    : undefined;
  const conn = await (deps.connect ?? spawnAppServer)({ cwd: req.cwd, ...(deps.bin ? { bin: deps.bin } : {}) });
  const stop = (): void => void conn.proc.kill();
  req.signal?.addEventListener('abort', stop, { once: true });
  try {
    if (req.signal?.aborted) throw new Error('aborted');
    const { rpc } = conn;
    let answer = '';
    const done = new Promise<Turn>((resolve) =>
      rpc.onNotification((method, params) => {
        const item = params.item as ThreadItem | undefined;
        if (method === 'item/completed' && item?.type === 'agentMessage') answer = (item as Extract<ThreadItem, { type: 'agentMessage' }>).text.trim() || answer;
        if (method === 'turn/completed') resolve(params.turn as Turn);
      }),
    );
    const gone = rpc.closed.then(() => undefined);
    // Claude's 'haiku' (a quick side call): Codex's small, fast model when it lists one; 'sonnet'/'opus': its default.
    const model = await pickCodexModel(req.model, () => rpc.request<{ data: Model[] }>('model/list', {}, MODEL_LIST_TIMEOUT_MS).then((r) => r.data));
    const yourServers = await rpc.request<{ config?: { mcp_servers?: Record<string, unknown> } }>('config/read', {}).then((r) => Object.keys(r.config?.mcp_servers ?? {}), () => []);
    const confined = sideCallConfinement(req.cwd, { ...(req.tools ? { tools: req.tools } : {}), yourServers });
    const thread = await rpc.request<ThreadStartResponse>('thread/start', {
      cwd: req.cwd,
      ...(model ? { model } : {}),
      ephemeral: true,
      approvalPolicy: 'never',
      baseInstructions: req.system,
      // No project docs: `system` is its whole instructions, and none to read under a sandbox that can't (#425).
      config: { ...confined.config, ...RUN_FEATURES_OFF, project_doc_max_bytes: 0, ...(mounted ? mcpConfig(mounted.servers) : {}) },
    });
    await rpc.request('turn/start', {
      threadId: thread.thread.id,
      input: [...(req.images ?? []).map((img) => ({ type: 'image', url: `data:${img.mime};base64,${img.data}` })), { type: 'text', text: req.prompt, text_elements: [] }],
    });
    const turn = await Promise.race([done, gone]);
    if (req.signal?.aborted) throw new Error('aborted');
    if (!turn || turn.status !== 'completed') throw new CompletionError('failed');
    if (!answer) throw new CompletionError('no_answer');
    return answer;
  } catch (err) {
    if (req.signal?.aborted) throw new Error('aborted');
    throw err instanceof CompletionError ? err : new CompletionError('failed');
  } finally {
    req.signal?.removeEventListener('abort', stop);
    mounted?.close();
    await conn.proc.kill();
  }
}
