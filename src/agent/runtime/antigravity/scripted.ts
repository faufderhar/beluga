import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { scriptedWords } from '../codex/scripted.js';
import { CodexRpc } from '../codex/rpc.js';
import type { ConfigOption } from '../opencode/acp.js';
import { acpHandshake } from '../opencode/connection.js';
import type { AgyConnect, AgyConnection } from './connection.js';

const MODES = ['default', 'accept-edits', 'auto', 'plan'];
const LEVELS = ['low', 'medium', 'high'];

/**
 * A scripted `agy acp` in memory, speaking ACP in the shapes the Antigravity CLI 1.5.8 sends
 * (recorded from a real one: a call's `tool_call` with its tool's `name` and its input in
 * PascalCase; files read without asking, commands and writes asked about with Allow/Deny; model,
 * thinking level and mode as the session's options; Beluga's instructions taken in `_meta`;
 * session/load replaying the conversation before it answers; an MCP tool as
 * `mcp_<server>_<tool>`). It follows the conformance script (tests/runtime-conformance.ts): `P`
 * is answered `echo: P` after running `echo P` (asked first; declined, it ends the turn without a word, as
 * agy does, and answers `denied: P` once Beluga says why); `wait…` works
 * until cancelled; `read <file>` reads it (not asked); `edit <file>` writes it (asked); `room`
 * calls one of Beluga's tools (mcp_beluga_list_peers); `own <tool>` calls a tool of a server of
 * your own by that name and `move <a> <b>` moves a file (both asked); `mode <m>` goes to that
 * mode itself and answers once its mode is set again; `question` asks with its own ask_question (run at once, the
 * question left in its answer) and answers `answered: <pick>` once told what the person picked (`question wait`: then works until stopped; `question zh`: in Chinese);
 * `/compact` summarises; `quota` answers as a
 * plan that has run out does.
 */
export class ScriptedAgy {
  /** `stepMs`: a pause before each step ends, so a screen sees it run (the demo); none in tests. */
  constructor(
    private readonly opts: {
      readonly stepMs?: number;
      readonly models?: readonly string[];
      /** session/list a page of this many at a time. */
      readonly listPage?: number;
      /** Each turn costs this much (USD): its usage_update says the session's running total, as ACP does. */
      readonly cost?: number;
      /** More of a loaded conversation's history, sent after session/load answered (just before the next request is), as an agent that streams it late does. */
      readonly lateHistory?: readonly object[];
      /** Called as each turn comes in. */
      readonly onPrompt?: () => void;
    } = {},
  ) {}

  /** What each session's turns cost so far. */
  private readonly spent = new Map<string, number>();

  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** Each connection's flags and folder. */
  readonly starts: Array<{ readonly args: readonly string[]; readonly cwd: string }> = [];
  readonly sessions = new Map<string, string[]>();
  /** Where each session was opened (its `cwd`), as session/list says. */
  readonly folders = new Map<string, string>();
  /** What each session was told to add to its system prompt. */
  readonly appended = new Map<string, string>();
  /** Permission answers it got, in order. */
  readonly answers: unknown[] = [];
  connections = 0;
  /** Its own commands (built-ins, and the skills it loaded). */
  commands = ['compact', 'plan', 'goal', 'browser'];

  private get models(): readonly string[] {
    return this.opts.models ?? ['gemini-3.8-flash', 'claude-sonnet-4-6'];
  }

  readonly connect: AgyConnect = async ({ args = [], cwd }) => {
    this.connections++;
    this.starts.push({ args: [...args], cwd });
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const send = (msg: object): void => void (toClient.writable && toClient.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`));
    const update = (sessionId: string, u: object): void => send({ method: 'session/update', params: { sessionId, update: u } });
    let alive = true;
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => (exit = resolve));
    let next = 0;
    const asked = new Map<string, (result: unknown) => void>();
    const ask = (method: string, params: object): Promise<unknown> =>
      new Promise((resolve) => {
        const id = String(++next);
        asked.set(id, resolve);
        send({ id, method, params });
      });
    const state = new Map<string, { mode: string; model: string; level: string }>();
    let running: { sessionId: string; cancel: () => void } | undefined;
    /** What a session's declined step was for, so its answer after Beluga says why can name it. */
    const declinedWords = new Map<string, string>();
    /** A `mode` turn waiting for its session's mode to be set again. */
    const modeSet = new Map<string, () => void>();
    let used = 16_500;

    const optionsOf = (sid: string): ConfigOption[] => {
      const s = state.get(sid)!;
      return [
        { id: 'model', category: 'model', currentValue: s.model, options: this.models.map((m) => ({ value: m, name: m })) },
        // Only Gemini takes a thinking level.
        ...(s.model.startsWith('gemini') ? [{ id: 'thought_level', category: 'thought_level', currentValue: s.level, options: LEVELS.map((l) => ({ value: l, name: l[0]!.toUpperCase() + l.slice(1) })) }] : []),
        { id: 'mode', category: 'mode', currentValue: s.mode, options: MODES.map((m) => ({ value: m, name: m })) },
      ];
    };
    const open = (sid: string, meta: unknown): object => {
      if (!this.sessions.has(sid)) this.sessions.set(sid, []);
      if (!state.has(sid)) state.set(sid, { mode: 'default', model: this.models[0]!, level: 'high' });
      const append = (meta as { antigravity?: { systemPrompt?: { append?: string } } } | undefined)?.antigravity?.systemPrompt?.append;
      if (append) this.appended.set(sid, append);
      setTimeout(() => update(sid, { sessionUpdate: 'available_commands_update', availableCommands: this.commands.map((name) => ({ name, description: name })) }), 0);
      return { sessionId: sid, configOptions: optionsOf(sid), modes: { currentModeId: state.get(sid)!.mode, availableModes: MODES.map((id) => ({ id, name: id })) }, _meta: { antigravity: { tier: { name: 'Antigravity Starter Quota', id: 'g1-plus-tier' } } } };
    };
    const pause = (): Promise<void> => new Promise((r) => setTimeout(r, this.opts.stepMs ?? 2));
    const call = (toolCallId: string, name: string, kind: string, title: string, rawInput: object, locations: object[] = []): object => ({ toolCallId, name, kind, title, rawInput, args: rawInput, ...(locations.length ? { locations } : {}) });
    const allowed = async (sid: string, c: object): Promise<boolean> => {
      const verdict = (await ask('session/request_permission', {
        sessionId: sid,
        toolCall: { sessionUpdate: 'tool_call', status: 'pending', ...c },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      })) as { outcome?: { optionId?: string } };
      this.answers.push(verdict);
      return verdict?.outcome?.optionId === 'allow';
    };
    const failed = (sid: string, c: object): void => update(sid, { sessionUpdate: 'tool_call_update', ...c, status: 'failed' });

    /** One command: it asks first, as every command does. */
    const command = async (sid: string, line: string): Promise<'ran' | 'declined'> => {
      const c = call(`call_${randomUUID().slice(0, 12)}`, 'run_command', 'execute', line, { CommandLine: line, WaitMsBeforeAsync: 5000, toolSummary: `Run ${line}` });
      update(sid, { sessionUpdate: 'tool_call', ...c, status: 'in_progress' });
      update(sid, { sessionUpdate: 'tool_call_update', ...c, status: 'pending' });
      if (!(await allowed(sid, c))) {
        failed(sid, c);
        return 'declined';
      }
      update(sid, { sessionUpdate: 'tool_call_update', ...c, status: 'in_progress' });
      await pause();
      const out = `${line.replace(/^echo /, '')}\r\n`;
      const text = `Command exited with code 0.\n\nCommand output:\n${out}`;
      update(sid, { sessionUpdate: 'tool_call_update', ...c, status: 'completed', rawOutput: { output: text, exit_code: 0 }, content: [{ type: 'content', content: { type: 'text', text } }] });
      return 'ran';
    };
    const say = (sid: string, text: string): void => {
      for (const part of text.match(/.{1,6}/gs) ?? []) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } });
    };
    const done = (sid: string, out: number): object => {
      used += 300;
      const total = (this.spent.get(sid) ?? 0) + (this.opts.cost ?? 0);
      this.spent.set(sid, total);
      update(sid, { sessionUpdate: 'usage_update', used, size: 1_048_576, ...(this.opts.cost ? { cost: { amount: total, currency: 'USD' } } : {}) });
      return { stopReason: 'end_turn', usage: { inputTokens: 15_000, outputTokens: out, cachedReadTokens: 9_000, cachedWriteTokens: 0, thoughtTokens: 7, totalTokens: 24_000 + out } };
    };

    const prompt = async (sid: string, blocks: ReadonlyArray<{ type: string; text?: string }>): Promise<object> => {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      this.sessions.get(sid)?.push(text);
      update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
      const input = /<input>\n([\s\S]*?)\n<\/input>/.exec(text);
      const words = input ? input[1]!.trim() : scriptedWords(text.replace(/\n\nPlan only:[^\n]*$/, ''));
      if (/^quota\b/.test(words)) throw Object.assign(new Error('RESOURCE_EXHAUSTED: You have reached your Five Hour Limit'), { code: -32603 });
      // Told why a step was declined: it answers.
      if (text.startsWith('Beluga declined that step:')) {
        say(sid, `denied: ${declinedWords.get(sid) ?? ''}`);
        return done(sid, 6);
      }
      if (words === '/compact') {
        say(sid, 'Compacted the conversation.');
        used = 4_000;
        update(sid, { sessionUpdate: 'usage_update', used, size: 1_048_576 });
        return { stopReason: 'end_turn' };
      }
      if (/^wait\b/.test(words)) {
        const c = call(`call_${randomUUID().slice(0, 12)}`, 'run_command', 'execute', 'sleep 600', { CommandLine: 'sleep 600' });
        update(sid, { sessionUpdate: 'tool_call', ...c, status: 'in_progress' });
        await new Promise<void>((resolve) => (running = { sessionId: sid, cancel: resolve }));
        running = undefined;
        failed(sid, c);
        return { stopReason: 'cancelled' };
      }
      const read = /^read (\S+)/.exec(words);
      if (read) {
        // Reads run without asking.
        const c = call(`call_${randomUUID().slice(0, 12)}`, 'read_file', 'read', `File ${read[1]}`, { Path: read[1] }, [{ path: read[1] }]);
        update(sid, { sessionUpdate: 'tool_call', ...c, status: 'in_progress' });
        update(sid, { sessionUpdate: 'tool_call_update', ...c, status: 'completed' });
        say(sid, `read: ${read[1]}`);
        return done(sid, 8);
      }
      const edit = /^edit (\S+)/.exec(words);
      if (edit) {
        const file = edit[1]!;
        const c = call(`call_${randomUUID().slice(0, 12)}`, 'write_file', 'edit', `File ${file}`, { Content: 'hi', Path: file }, [{ path: file }]);
        update(sid, { sessionUpdate: 'tool_call', ...c, status: 'in_progress' });
        update(sid, { sessionUpdate: 'tool_call_update', ...c, status: 'pending' });
        if (!(await allowed(sid, { ...c, content: [{ type: 'diff', path: file, oldText: null, newText: 'hi' }] }))) {
          failed(sid, c);
          declinedWords.set(sid, words);
          return done(sid, 0);
        }
        update(sid, { sessionUpdate: 'tool_call_update', ...c, status: 'completed', rawOutput: {}, content: [{ type: 'diff', path: file, oldText: null, newText: 'hi\n' }] });
        say(sid, `edited: ${file}`);
        return done(sid, 6);
      }
      // Told what the person answered to its ask_question: it answers with that.
      const replied = /^The person (answered|skipped) your question \(ask_question\)[^\n]*(?:\n- [^\n]*\n {2}→ ([^\n]*))?/.exec(text);
      if (replied) {
        say(sid, replied[1] === 'skipped' ? 'skipped: going on' : `answered: ${replied[2] ?? ''}`);
        return done(sid, 6);
      }
      if (/^question\b/.test(words)) {
        // Its own question tool: run at once (nothing asked), the form never reaching the client;
        // the question and its options written into its answer, and the turn ends.
        // `question zh`: the same question in Chinese, as agy asks in the language you write in.
        const zh = /^question zh\b/.test(words);
        const question = zh ? '现在部署到服务器吗？' : 'Deploy to the server now?';
        const options = zh ? ['是，通过 SSH', '已完成（我自己做了）', '暂不'] : ['Yes, over SSH', 'Done (I did it)', 'Not now'];
        const c = call(`call_${randomUUID().slice(0, 12)}`, 'ask_question', 'other', 'ask_question', { questions: [{ is_multi_select: false, options, question }] });
        update(sid, { sessionUpdate: 'tool_call', ...c, status: 'in_progress' });
        update(sid, { sessionUpdate: 'tool_call_update', ...c, status: 'completed' });
        // `question wait`: it goes on working after asking, until it's stopped.
        if (/^question wait\b/.test(words)) {
          await new Promise<void>((resolve) => (running = { sessionId: sid, cancel: resolve }));
          running = undefined;
          return { stopReason: 'cancelled' };
        }
        say(sid, `${question}\n${options.map((o, i) => `- [${i + 1}] ${o}`).join('\n')}`);
        return done(sid, 20);
      }
      if (/^room\b/.test(words)) {
        // One of Beluga's own tools: it asks too, by the tool's MCP name, with no arguments said.
        const c = call(`call_${randomUUID().slice(0, 12)}`, 'mcp_beluga_list_peers', 'other', 'Run mcp_beluga_list_peers', { toolSummary: 'List peers' });
        update(sid, { sessionUpdate: 'tool_call', ...c, status: 'in_progress' });
        const ok = await allowed(sid, c);
        if (!ok) failed(sid, c);
        else update(sid, { sessionUpdate: 'tool_call_update', ...c, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'kay' } }] });
        say(sid, ok ? 'room: kay' : `denied: ${words}`);
        return done(sid, 6);
      }
      const mode = /^mode (\S+)/.exec(words);
      if (mode) {
        // It goes to another mode itself (as its own /command does), and works on once its mode is set again.
        state.get(sid)!.mode = mode[1]!;
        const again = new Promise<void>((resolve) => modeSet.set(sid, resolve));
        update(sid, { sessionUpdate: 'config_option_update', configOptions: optionsOf(sid) });
        await again;
        modeSet.delete(sid);
        say(sid, `mode: ${state.get(sid)!.mode}`);
        return done(sid, 4);
      }
      const own = /^own (\S+)/.exec(words);
      const move = /^move (\S+) (\S+)/.exec(words);
      if (own || move) {
        // A tool of a server of your own (asked by its MCP name, no arguments said), or a file moved (asked, with where it lands).
        const c = own ? call(`call_${randomUUID().slice(0, 12)}`, own[1]!, 'other', `Run ${own[1]}`, { toolSummary: own[1] }) : call(`call_${randomUUID().slice(0, 12)}`, 'move', 'move', `Move ${move![1]}`, { Path: move![1] }, [{ path: move![1] }, { path: move![2] }]);
        update(sid, { sessionUpdate: 'tool_call', ...c, status: 'in_progress' });
        const ok = await allowed(sid, c);
        if (!ok) failed(sid, c);
        else update(sid, { sessionUpdate: 'tool_call_update', ...c, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] });
        say(sid, ok ? `done: ${words}` : `denied: ${words}`);
        return done(sid, 6);
      }
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Running it.' } });
      const ran = await command(sid, `echo ${words}`);
      // A declined step ends its turn without a word, as agy does.
      if (ran === 'declined') return (declinedWords.set(sid, words), done(sid, 0));
      say(sid, `echo: ${words}`);
      return done(sid, 12);
    };

    const answer = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const sid = String(params.sessionId ?? '');
      switch (method) {
        case 'initialize':
          return {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} }, auth: { logout: {} }, _meta: { antigravity: { tier: true, systemPrompt: { append: true } } } },
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' },
            authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
          };
        case 'session/new': {
          const id = randomUUID();
          this.folders.set(id, String(params.cwd ?? ''));
          return open(id, params._meta);
        }
        case 'session/load': {
          const said = this.sessions.get(sid);
          if (!said) throw Object.assign(new Error(`Session not found: ${sid}`), { code: -32602 });
          // The conversation so far, replayed before the answer.
          for (const text of said) update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
          return open(sid, params._meta);
        }
        case 'session/list': {
          const all = [...this.sessions.keys()].map((sessionId) => ({ sessionId, cwd: this.folders.get(sessionId) ?? '' }));
          const size = this.opts.listPage;
          if (!size) return { sessions: all };
          const from = Number(params.cursor ?? 0);
          return { sessions: all.slice(from, from + size), ...(from + size < all.length ? { nextCursor: String(from + size) } : {}) };
        }
        case 'session/set_config_option': {
          const s = state.get(sid);
          if (!s) throw new Error(`Session not found: ${sid}`);
          const value = String(params.value);
          if (params.configId === 'mode') {
            s.mode = value;
            modeSet.get(sid)?.();
            update(sid, { sessionUpdate: 'current_mode_update', currentModeId: value });
          } else if (params.configId === 'model') s.model = value;
          else if (params.configId === 'thought_level') s.level = value;
          update(sid, { sessionUpdate: 'config_option_update', configOptions: optionsOf(sid) });
          return { configOptions: optionsOf(sid) };
        }
        case 'session/prompt':
          return prompt(sid, (params.prompt ?? []) as Array<{ type: string; text?: string }>);
        default:
          throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
      }
    };

    /** A session loaded whose late history hasn't gone out yet. */
    let late: string | undefined;
    readline.createInterface({ input: toServer }).on('line', (line) => {
      const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown };
      if (!msg.method && msg.id !== undefined) return void asked.get(String(msg.id))?.(msg.result);
      if (!msg.method) return;
      this.requests.push({ method: msg.method, params: msg.params ?? {} });
      if (late && msg.method !== 'session/load') {
        for (const u of this.opts.lateHistory ?? []) update(late, u);
        late = undefined;
      }
      if (msg.method === 'session/load' && this.opts.lateHistory?.length) late = String(msg.params?.sessionId ?? '');
      if (msg.method === 'session/prompt') this.opts.onPrompt?.();
      if (msg.method === 'session/cancel') return void (running?.sessionId === msg.params?.sessionId && running?.cancel());
      if (msg.id === undefined) return;
      answer(msg.method, msg.params ?? {}).then(
        (result) => send({ id: msg.id, result }),
        (err: Error & { code?: number }) => send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } }),
      );
    });

    const rpc = new CodexRpc(toClient, toServer, { name: 'Antigravity', jsonrpc: true });
    const proc = {
      pid: 4646,
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
    const conn: AgyConnection = { rpc, proc, init, stderr: () => [] };
    return conn;
  };

  /** The params of every request of `method`. */
  sent(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }
}
