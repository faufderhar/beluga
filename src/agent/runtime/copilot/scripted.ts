import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { scriptedWords } from '../codex/scripted.js';
import { CodexRpc } from '../codex/rpc.js';
import type { ConfigOption } from '../opencode/acp.js';
import { acpHandshake } from '../opencode/connection.js';
import type { CopilotConnect, CopilotConnection } from './connection.js';

const MODE = (name: string): string => `https://agentclientprotocol.com/protocol/session-modes#${name}`;

/**
 * A scripted `copilot --acp` in memory, speaking ACP in the shapes Copilot CLI 1.0.107 sends
 * (recorded from a real one: a call's `tool_call` with its input and words for people as its
 * title, its kind saying which tool; reads and read-only commands run without asking; modes as
 * ACP's mode URIs; session/load replaying the conversation before it answers; a client's stdio
 * MCP servers turned down). It follows the conformance script (tests/runtime-conformance.ts): `P`
 * is answered `echo: P` after running `echo P` (read-only: not asked about); `ask…` runs a command
 * that asks first (declined: `denied: P`); `wait…` works until cancelled; `read <file>` reads it;
 * `edit <file>` writes it (asked); `room` calls one of Beluga's tools (beluga-list_peers); a plan's
 * note after the request is skipped;
 * `/compact` summarises; `noplan` answers 403 as a Free account does for a model it doesn't have.
 */
export class ScriptedCopilot {
  /** `stepMs`: a pause before each step ends, so a screen sees it run (the demo); none in tests. */
  constructor(private readonly opts: { readonly stepMs?: number; readonly models?: readonly string[] } = {}) {}

  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** Each connection's flags and folder. */
  readonly starts: Array<{ readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> }> = [];
  readonly sessions = new Map<string, string[]>();
  /** Permission answers it got, in order. */
  readonly answers: unknown[] = [];
  connections = 0;
  /** Its own commands (built-ins, and the skills it loaded). */
  commands = ['compact', 'plan', 'model', 'review', 'api-design'];

  readonly connect: CopilotConnect = async ({ args = [], cwd, env }) => {
    this.connections++;
    this.starts.push({ args: [...args], cwd, env: { ...(env ?? {}) } });
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const send = (msg: object): void => void (toClient.writable && toClient.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`));
    const update = (sessionId: string, u: object): void => send({ method: 'session/update', params: { sessionId, update: u } });
    let alive = true;
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => (exit = resolve));
    let next = 0;
    const asked = new Map<number, (result: unknown) => void>();
    const ask = (method: string, params: object): Promise<unknown> =>
      new Promise((resolve) => {
        const id = next++;
        asked.set(id, resolve);
        send({ id, method, params });
      });
    const modes = new Map<string, string>();
    const models = new Map<string, string>();
    const flag = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    let running: { sessionId: string; cancel: () => void } | undefined;
    let used = 17_500;

    const optionsOf = (sid: string): ConfigOption[] => [
      { id: 'mode', category: 'mode', currentValue: modes.get(sid) ?? MODE('agent'), options: ['agent', 'plan', 'autopilot'].map((m) => ({ value: MODE(m), name: m[0]!.toUpperCase() + m.slice(1) })) },
      { id: 'allow_all', category: 'permissions', currentValue: 'off', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] },
      ...(this.opts.models?.length ? [{ id: 'model', category: 'model', currentValue: models.get(sid) ?? 'auto', options: ['auto', ...this.opts.models].map((m) => ({ value: m, name: m === 'auto' ? 'Auto' : m })) }] : []),
    ];
    const open = (sid: string): { sessionId: string; configOptions: ConfigOption[]; modes: object } => {
      if (!this.sessions.has(sid)) this.sessions.set(sid, []);
      if (!models.has(sid)) models.set(sid, flag('--model') ?? 'auto');
      setTimeout(() => update(sid, { sessionUpdate: 'available_commands_update', availableCommands: this.commands.map((name) => ({ name, description: name })) }), 0);
      return { sessionId: sid, configOptions: optionsOf(sid), modes: { currentModeId: modes.get(sid) ?? MODE('agent'), availableModes: [] } };
    };
    const pause = (): Promise<void> => new Promise((r) => setTimeout(r, this.opts.stepMs ?? 2));
    const permission = (sid: string, toolCallId: string, title: string, kind: string, rawInput: object, locations: object[] = []): object => ({
      sessionId: sid,
      toolCall: { toolCallId, title, kind, status: 'pending', rawInput, ...(locations.length ? { locations } : {}) },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
      ],
    });
    const allowed = async (p: object): Promise<boolean> => {
      const verdict = (await ask('session/request_permission', p)) as { outcome?: { optionId?: string } };
      this.answers.push(verdict);
      return verdict?.outcome?.optionId === 'allow_once';
    };
    const rejected = (sid: string, id: string): void => update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', rawOutput: { message: 'The user rejected this tool call.', code: 'rejected' } });

    /** One shell step: read-only ones run, others ask first. */
    const command = async (sid: string, line: string, asks: boolean): Promise<'ran' | 'declined'> => {
      const id = `call_${randomUUID().slice(0, 12)}`;
      update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: `Run ${line}`, kind: 'execute', status: 'pending', rawInput: { command: line, description: `Run ${line}` } });
      if (asks && !(await allowed(permission(sid, id, line, 'execute', { command: line, commands: [line.split(' ')[0]] })))) {
        rejected(sid, id);
        return 'declined';
      }
      await pause();
      const out = `${line.replace(/^echo /, '')}\n`;
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `${out}<shellId: 0 completed with exit code 0>` } }], rawOutput: { content: out } });
      return 'ran';
    };
    const say = (sid: string, text: string): void => {
      for (const part of text.match(/.{1,6}/gs) ?? []) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part }, messageId: 'm1' });
    };
    const done = (sid: string, out: number): object => {
      used += 300;
      update(sid, { sessionUpdate: 'usage_update', used, size: 272_000 });
      return { stopReason: 'end_turn', usage: { inputTokens: 16_000, outputTokens: out, totalTokens: 16_000 + out, thoughtTokens: 9, cachedReadTokens: 8_000, cachedWriteTokens: 8_000 } };
    };

    const prompt = async (sid: string, blocks: ReadonlyArray<{ type: string; text?: string }>): Promise<object> => {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      this.sessions.get(sid)?.push(text);
      const input = /<input>\n([\s\S]*?)\n<\/input>/.exec(text);
      const words = input ? input[1]!.trim() : scriptedWords(text.replace(/\n\nPlan only:[^\n]*$/, ''));
      if (/^noplan\b/.test(words)) throw Object.assign(new Error('403 "unauthorized: not authorized to use this Copilot feature\\n"'), { code: -32603 });
      if (words === '/compact') {
        say(sid, 'Compacted the conversation.');
        used = 4_000;
        update(sid, { sessionUpdate: 'usage_update', used, size: 272_000 });
        return { stopReason: 'end_turn' };
      }
      if (/^wait\b/.test(words)) {
        const id = `call_${randomUUID().slice(0, 12)}`;
        update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: 'Wait', kind: 'execute', status: 'pending', rawInput: { command: 'sleep 600', description: 'Wait' } });
        await new Promise<void>((resolve) => (running = { sessionId: sid, cancel: resolve }));
        running = undefined;
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', rawOutput: { message: 'Operation cancelled by user' } });
        return { stopReason: 'cancelled' };
      }
      const read = /^read (\S+)/.exec(words);
      if (read) {
        const id = `call_${randomUUID().slice(0, 12)}`;
        update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: `Viewing ${read[1]}`, kind: 'read', status: 'pending', rawInput: { path: read[1] }, locations: [{ path: read[1] }] });
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: { content: 'file contents' } });
        say(sid, `read: ${read[1]}`);
        return done(sid, 8);
      }
      const edit = /^edit (\S+)/.exec(words);
      if (edit) {
        const id = `custom_call_${randomUUID().slice(0, 12)}`;
        const file = edit[1]!;
        update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: 'apply_patch', kind: 'edit', status: 'pending', rawInput: `*** Begin Patch\n*** Add File: ${file}\n+hi\n*** End Patch\n` });
        const diff = `\ndiff --git a/${file} b/${file}\ncreate file mode 100644\n--- a/dev/null\n+++ b/${file}\n@@ -1,0 +1,1 @@\n+hi\n`;
        if (!(await allowed(permission(sid, id, 'Create file', 'edit', { fileName: file, diff }, [{ path: file }])))) {
          rejected(sid, id);
          say(sid, `denied: ${words}`);
          return done(sid, 6);
        }
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'diff', path: file, oldText: '', newText: 'hi\n' }], rawOutput: { content: `Added 1 file(s): ${file}` } });
        say(sid, `edited: ${file}`);
        return done(sid, 6);
      }
      if (/^room\b/.test(words)) {
        // One of Beluga's own tools, an MCP server's (`<server>-<tool>`; a read-only one comes as a read): it asks too, by the tool's own name.
        const id = `call_${randomUUID().slice(0, 12)}`;
        update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: 'beluga-list_peers', kind: 'read', status: 'pending', rawInput: {} });
        const ok = await allowed(permission(sid, id, 'list_peers', 'read', {}));
        if (!ok) rejected(sid, id);
        else update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'kay' } }], rawOutput: { content: 'kay' } });
        say(sid, ok ? 'room: kay' : `denied: ${words}`);
        return done(sid, 6);
      }
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Running it.' } });
      const ran = await command(sid, `echo ${words}`, /^ask\b/.test(words));
      say(sid, ran === 'ran' ? `echo: ${words}` : `denied: ${words}`);
      return done(sid, 12);
    };

    const answer = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const sid = String(params.sessionId ?? '');
      switch (method) {
        case 'initialize':
          return { protocolVersion: 1, agentCapabilities: { auth: { logout: {} }, loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { close: {}, list: {} } }, agentInfo: { name: 'Copilot', title: 'Copilot', version: '1.0.107' }, authMethods: [{ id: 'copilot-login', name: 'Log in with Copilot CLI' }] };
        case 'session/new': {
          const servers = (params.mcpServers ?? []) as Array<{ type?: string }>;
          if (servers.some((s) => s.type !== 'http' && s.type !== 'sse')) throw new Error('Copilot takes only http and sse MCP servers from a client');
          return open(randomUUID());
        }
        case 'session/load': {
          const said = this.sessions.get(sid);
          if (!said) throw new Error(`Session not found: ${sid}`);
          // The conversation so far, replayed before the answer.
          for (const text of said) update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
          return open(sid);
        }
        case 'session/set_config_option': {
          const value = String(params.value);
          if (params.configId === 'mode') {
            modes.set(sid, value);
            update(sid, { sessionUpdate: 'current_mode_update', currentModeId: value });
          } else if (params.configId === 'model') models.set(sid, value);
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
        (err: Error & { code?: number }) => send({ id: msg.id, error: { code: err.code ?? -32602, message: err.message } }),
      );
    });

    const rpc = new CodexRpc(toClient, toServer, { name: 'Copilot', jsonrpc: true });
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
    const init = await acpHandshake(rpc);
    const conn: CopilotConnection = { rpc, proc, init, stderr: () => [] };
    return conn;
  };

  /** The params of every request of `method`. */
  sent(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }
}
