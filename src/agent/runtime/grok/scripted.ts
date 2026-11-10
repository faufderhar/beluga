import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { CodexRpc } from '../codex/rpc.js';
import { scriptedWords } from '../codex/scripted.js';
import type { ConfigOption } from '../opencode/acp.js';
import { acpHandshake } from '../opencode/connection.js';
import type { GrokConnect, GrokConnection, GrokInit } from './connection.js';

const toolMeta = (name: string, kind: string): object => ({ 'x.ai/tool': { version: 1, name, kind, namespace: 'grok_build', label: name, read_only: kind === 'read' } });

/**
 * A scripted `grok agent stdio` in memory, speaking ACP in the shapes Grok Build 1.0.77 sends
 * (recorded from a real one), following the conformance script (tests/runtime-conformance.ts): `P`
 * is answered `echo: P` after running `echo P`; `ask…` too (every command asks; declined, the turn
 * ends `cancelled` as Grok's does, and the next message gets `denied: P`); `wait…` works until
 * cancelled; `read <file>` reads a file; `write <file>` writes one; `stubborn` keeps trying a step
 * however often it's turned down; `exitplan` calls its own plan tool, which asks the screen for an
 * approval; `newask` sends the screen a request it can't know; `giveup` ends the turn unasked; `board` calls one of Beluga's tools through `use_tool`; `/compact`
 * summarises. Sessions outlive a connection, as Grok keeps them.
 */
export class ScriptedGrok {
  /** `stepMs`: a pause before each step ends, so a screen sees it run (the demo); none in tests. */
  constructor(private readonly opts: { readonly stepMs?: number } = {}) {}

  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly starts: Array<{ readonly ungated: boolean; readonly cwd: string }> = [];
  readonly sessions = new Set<string>();
  /** Permission answers it got, in order. */
  readonly answers: unknown[] = [];
  /** Its models: the first is its default. */
  models = [
    { value: 'grok-4.7', name: 'Grok 4.7', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { value: 'grok-4.5', name: 'Grok 4.5', efforts: ['low', 'medium', 'high'] },
  ];
  commands = ['compact', 'init', 'api-design'];

  readonly connect: GrokConnect = async ({ ungated, cwd }) => {
    this.starts.push({ ungated: Boolean(ungated), cwd });
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const send = (msg: object): void => void (toClient.writable && toClient.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`));
    const update = (sessionId: string, u: object): void => send({ method: 'session/update', params: { sessionId, update: u } });
    let alive = true;
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => (exit = resolve));
    let next = 1000;
    const asked = new Map<number, (result: unknown) => void>();
    const ask = (method: string, params: object): Promise<unknown> =>
      new Promise((resolve) => {
        const id = ++next;
        asked.set(id, resolve);
        send({ id, method, params });
      });
    const chosen = new Map<string, { model: string; effort: string }>();
    let running: { sessionId: string; cancel: () => void } | undefined;
    /** Words of the step turned down last, per session: Beluga's next message gets the answer for them. */
    const declinedWords = new Map<string, string>();
    /** Sessions that keep trying a step however often it's turned down. */
    const stubborn = new Set<string>();
    let used = 12_000;

    const optionsOf = (sid: string): ConfigOption[] => {
      const c = chosen.get(sid)!;
      const model = this.models.find((m) => m.value === c.model)!;
      return [
        { id: 'model', category: 'model', currentValue: c.model, options: this.models.map((m) => ({ value: m.value, name: m.name })) },
        { id: 'reasoning_effort', category: 'thought_level', currentValue: c.effort, options: model.efforts.map((e) => ({ value: e, name: e })) },
      ];
    };
    const open = (sid: string): { sessionId: string; configOptions: ConfigOption[] } => {
      this.sessions.add(sid);
      if (!chosen.has(sid)) chosen.set(sid, { model: this.models[0]!.value, effort: 'high' });
      setTimeout(() => update(sid, { sessionUpdate: 'available_commands_update', availableCommands: this.commands.map((name) => ({ name, description: name })) }), 0);
      return { sessionId: sid, configOptions: optionsOf(sid) };
    };
    const pause = (): Promise<void> => new Promise((r) => setTimeout(r, this.opts.stepMs ?? 2));
    const verdictOf = async (sid: string, id: string, title: string, kind: string, rawInput: object, tool: string): Promise<boolean> => {
      const verdict = (await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: id, kind, title: `${title} — hook 'plugin/beluga-gate' asks: Beluga decides`, rawInput, _meta: toolMeta(tool, kind) }, options: [{ optionId: 'always', kind: 'allow_always', name: 'Always' }, { optionId: 'once', kind: 'allow_once', name: 'Once' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] })) as { outcome?: { optionId?: string } };
      this.answers.push(verdict);
      return verdict?.outcome?.optionId === 'once';
    };
    /** A step: its call (the model's arguments), its update (Grok's own shape), asked about, then run or refused as Grok does. */
    const step = async (sid: string, tool: string, kind: string, args: object, full: object, title: string, output: object, words: string): Promise<boolean> => {
      const id = `call-${randomUUID()}-0`;
      update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: tool, rawInput: args, _meta: toolMeta(tool, kind) });
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, kind, title, locations: [], rawInput: full, _meta: toolMeta(tool, kind) });
      if (!(await verdictOf(sid, id, title, kind, full, tool))) {
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: `User rejected the execution for tool \`${tool}\`` } }], _meta: { toolNotRun: 'rejected' } });
        declinedWords.set(sid, words);
        return false;
      }
      await pause();
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', ...output });
      return true;
    };
    const say = (sid: string, text: string): void => {
      for (const part of text.match(/.{1,6}/gs) ?? []) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } });
    };
    const done = (sid: string, out: number): object => {
      used += 400;
      return { stopReason: 'end_turn', _meta: { sessionId: sid, totalTokens: used, usage: { inputTokens: 300, outputTokens: out, cachedReadTokens: 100, cacheCreationTokens: 0, costUsdTicks: 25_000_000 } } };
    };
    const refused = (sid: string): object => ({ stopReason: 'cancelled', _meta: { sessionId: sid, totalTokens: used } });

    const prompt = async (sid: string, blocks: ReadonlyArray<{ type: string; text?: string }>): Promise<object> => {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      const input = /<input>\n([\s\S]*?)\n<\/input>/.exec(text);
      const words = input ? input[1]!.trim() : scriptedWords(text);
      if (/^stubborn\b/.test(words)) stubborn.add(sid);
      if (stubborn.has(sid)) {
        await step(sid, 'run_terminal_command', 'execute', { command: 'echo again' }, { variant: 'Bash', command: 'echo again' }, 'Execute `echo again`', {}, words);
        return refused(sid);
      }
      if (/^giveup\b/.test(words)) return refused(sid);
      if (/^newask\b/.test(words)) {
        await ask('_x.ai/brand_new', { sessionId: sid });
        declinedWords.set(sid, words);
        return refused(sid);
      }
      if (/^exitplan\b/m.test(text)) {
        if (await step(sid, 'exit_plan_mode', 'other', {}, { variant: 'ExitPlanMode' }, 'Plan: Exit', {}, 'exitplan')) await ask('_x.ai/exit_plan_mode', { sessionId: sid, planContent: null });
        return refused(sid);
      }
      // Anywhere in the message: a plan's first turn ends with Beluga's note about planning.
      const write = /^write (\S+)/m.exec(text);
      if (write) {
        const file = write[1]!;
        const ok = await step(sid, 'write', 'edit', { file_path: file, content: 'x' }, { variant: 'Write', file_path: file, content: 'x' }, `Write \`${file}\``, {}, words);
        if (!ok) return refused(sid);
        say(sid, `wrote: ${file}`);
        return done(sid, 8);
      }
      const declined = declinedWords.get(sid);
      if (declined !== undefined) {
        declinedWords.delete(sid);
        say(sid, `denied: ${declined}`);
        return done(sid, 8);
      }
      if (words === '/compact') {
        send({ method: '_x.ai/session_notification', params: { sessionId: sid, update: { sessionUpdate: 'auto_compact_completed', tokens_before: used, tokens_after: 900 } } });
        used = 900;
        return { stopReason: 'end_turn', _meta: { sessionId: sid, totalTokens: 0 } };
      }
      if (/^wait\b/.test(words)) {
        const id = `call-${randomUUID()}-0`;
        update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: 'run_terminal_command', rawInput: { command: 'sleep 600' }, _meta: toolMeta('run_terminal_command', 'execute') });
        await new Promise<void>((resolve) => (running = { sessionId: sid, cancel: resolve }));
        running = undefined;
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Interrupted' } }] });
        return { stopReason: 'cancelled', _meta: { sessionId: sid } };
      }
      const read = /^read (\S+)/.exec(words);
      if (read) {
        const file = read[1]!;
        const ok = await step(sid, 'read_file', 'read', { target_file: file }, { variant: 'ReadFile', target_file: file }, `Read \`${file}\``, { content: [{ type: 'content', content: { type: 'text', text: '1→file contents\n' } }] }, words);
        if (!ok) return refused(sid);
        say(sid, `read: ${file}`);
        return done(sid, 8);
      }
      if (/^board\b/.test(words)) {
        const name = 'beluga_board__task_get';
        const ok = await step(sid, 'use_tool', 'use_tool', { tool_name: name, tool_input: {} }, { variant: 'UseTool', tool_name: name, tool_input: {} }, name, { rawOutput: { type: 'MCP', output: { OkayOutput: 'BLG-1: a task' } } }, words);
        if (!ok) return refused(sid);
        say(sid, 'board: BLG-1');
        return done(sid, 6);
      }
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Running it.' } });
      const command = `echo ${words}`;
      const ok = await step(sid, 'run_terminal_command', 'execute', { command, description: 'Echo' }, { variant: 'Bash', command, description: 'Echo', is_background: false }, `Execute \`${command}\``, { content: [{ type: 'content', content: { type: 'text', text: `${words}\n` } }] }, words);
      if (!ok) return refused(sid);
      say(sid, `echo: ${words}`);
      return done(sid, 12);
    };

    const answer = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const sid = String(params.sessionId ?? '');
      switch (method) {
        case 'initialize':
          return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { resume: {}, close: {}, list: {} } }, authMethods: [{ id: 'cached_token' }], _meta: { defaultAuthMethodId: 'cached_token', modelState: { currentModelId: this.models[0]!.value, availableModels: this.models.map((m) => ({ modelId: m.value, name: m.name, description: m.name, _meta: { totalContextTokens: 256_000, reasoningEfforts: m.efforts.map((value) => ({ value })) } })) } } };
        case 'session/new':
          return open(randomUUID());
        case 'session/resume':
          if (!this.sessions.has(sid)) throw new Error(`Session not found: ${sid}`);
          return { configOptions: open(sid).configOptions };
        case '_x.ai/session/fork': {
          const from = String(params.sourceSessionId ?? '');
          if (!this.sessions.has(from)) throw new Error(`Session not found: ${from}`);
          const forked = randomUUID();
          this.sessions.add(forked);
          chosen.set(forked, { ...(chosen.get(from) ?? { model: this.models[0]!.value, effort: 'high' }) });
          return { newSessionId: forked, parentSessionId: from };
        }
        case 'session/set_config_option': {
          const c = chosen.get(sid)!;
          const value = String(params.value);
          if (params.configId === 'model') c.model = value;
          else if (params.configId === 'reasoning_effort') c.effort = value;
          return { configOptions: optionsOf(sid) };
        }
        case 'session/prompt':
          return prompt(sid, (params.prompt ?? []) as Array<{ type: string; text?: string }>);
        default:
          throw new Error(`Method not found: ${method}`);
      }
    };

    readline.createInterface({ input: toServer }).on('line', (line) => {
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      if (!msg.method && msg.id !== undefined) return void asked.get(msg.id)?.(msg.result);
      if (!msg.method) return;
      this.requests.push({ method: msg.method, params: msg.params ?? {} });
      if (msg.method === 'session/cancel') return void (running?.sessionId === msg.params?.sessionId && running?.cancel());
      if (msg.id === undefined) return;
      answer(msg.method, msg.params ?? {}).then(
        (result) => send({ id: msg.id, result }),
        (err: Error) => send({ id: msg.id, error: { code: -32602, message: err.message } }),
      );
    });

    const rpc = new CodexRpc(toClient, toServer, { name: 'Grok Build', jsonrpc: true });
    const proc = {
      pid: 4545,
      alive: () => alive,
      exited,
      kill: async () => {
        if (!alive) return;
        alive = false;
        running?.cancel();
        toClient.end();
        toServer.end();
        exit();
      },
    };
    const init = (await acpHandshake(rpc)) as GrokInit;
    const conn: GrokConnection = { rpc, proc, init, stderr: () => [] };
    return conn;
  };

  /** The params of every request of `method`. */
  sent(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }
}
