import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import type { CodexConnect, CodexConnection } from './app-server.js';
import { handshake } from './app-server.js';
import { CodexRpc } from './rpc.js';

/** What codex-cli says opening a thread on its unelevated Windows sandbox under a profile that denies reads (#425). */
const UNELEVATED_WINDOWS =
  'error creating thread: failed to load AGENTS.md instructions for environment local: failed to prepare fs sandbox: failed to prepare windows sandbox wrapper: windows unelevated restricted-token sandbox cannot enforce deny-read restrictions directly; refusing to run unsandboxed';

/** A thread's permissions profile denies a read somewhere. */
const deniesReads = (params: Record<string, unknown>): boolean => {
  const profiles = Object.entries((params.config ?? {}) as Record<string, unknown>).filter(([k]) => k.startsWith('permissions.'));
  return profiles.some(([, p]) => Object.values((p as { filesystem?: Record<string, string> }).filesystem ?? {}).includes('deny'));
};

/** The words a scripted agent reads from a built prompt: its last line. */
export const scriptedWords = (prompt: string): string => prompt.trim().split('\n').at(-1)!.trim();

/** The two sub-agents a `spawn…` prompt starts (BLG-519): who, what they're asked, their steps and report. */
export const SUB_AGENTS = [
  { nickname: 'Darwin', role: 'explorer', prompt: 'Find the tests that cover the login flow', steps: ['ls tests', 'rg -n login tests'], report: 'Three tests cover the login flow: login.test.ts, session.test.ts and auth.test.ts.' },
  { nickname: 'Noether', role: 'worker', prompt: 'Check the docs mention the --remember flag', steps: ['rg -n -- --remember docs'], report: 'docs/usage.md mentions --remember; docs/cli.md does not yet.' },
] as const;

/**
 * A scripted `codex app-server` in memory, speaking its JSON-RPC (shapes as codex-cli 0.135's
 * generate-ts writes them, recorded from a real one), following the conformance script
 * (tests/runtime-conformance.ts): `P` is answered `echo: P` after running `echo P`; `ask…` asks
 * your approval first (declined: `denied: P`); `wait…` works until interrupted; `spawn…` starts two
 * sub-agents (Codex's multi_agent, shapes from codex-cli 0.166; see spawnTurn). Threads outlive a
 * connection, as Codex keeps them on disk, so a thread resumes in a later run. The conformance and
 * Codex tests drive it, and so does the demo (its Codex worktrees, for the Mac e2e: BLG-462).
 */
export class ScriptedCodex {
  /** `stepMs`: a pause before each step ends, so a screen sees it run (the demo); none in tests. */
  constructor(private readonly opts: { readonly stepMs?: number } = {}) {}

  /** Every request each app-server got, in order (for assertions). */
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly threads = new Set<string>();
  /** Answers for server requests Codex sends (approvals), by item. */
  readonly approvals: unknown[] = [];
  /** Set: a command step asks for approval before running (the prompt's words start with "ask"). */
  connections = 0;
  /** Signed in (account/read says who), or not. */
  signedIn = true;
  /** Its plan windows as the app-server says them (a signed-in Plus account's shape). */
  /** Its models, as model/list gives them. */
  models: unknown[] = [{ id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Frontier', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }];
  rateLimits: unknown = { limitId: 'codex', limitName: null, primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1780409235 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1780862132 }, credits: null, planType: 'plus', rateLimitReachedType: null };
  /**
   * Your MCP servers in its ~/.codex/config.toml (BLG-518), as config/read gives them, with how
   * each answers mcpServerStatus/list (shapes recorded from codex-cli 0.166): a web one waiting
   * for a sign-in, a working one with its tools, one that won't start. A plugin's has no config entry.
   */
  mcpServers: Record<string, { url?: string; command?: string; enabled: boolean }> = {
    figma: { url: 'https://figma.example/mcp', enabled: true },
    github: { command: 'github-mcp', enabled: true },
    sentry: { command: '/nonexistent/sentry-mcp', enabled: true },
  };
  /** Signed in to (oauth), by name. */
  readonly mcpSignedIn = new Set<string>();
  /** How a sign-in ends once its page is "opened": true signs in, false fails, undefined waits forever. */
  mcpLoginEnds: boolean | undefined = true;
  /**
   * Codex's unelevated Windows sandbox (#425: a standard account, without MXC or the elevated
   * sandbox): a thread whose profile denies any read won't open, in codex-cli's words.
   */
  unelevatedWindows = false;

  readonly connect: CodexConnect = async () => {
    this.connections++;
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const send = (msg: object): void => void (toClient.writable && toClient.write(`${JSON.stringify(msg)}\n`));
    const notify = (method: string, params: object): void => send({ method, params });
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
    /** The running turn: how to stop it. */
    let running: { id: string; threadId: string; stop: () => void } | undefined;
    /** Sub-agents' running turns (BLG-519): how to stop each, by turn. */
    const childStops = new Map<string, () => void>();

    /**
     * One spawned sub-agent's turn on its own thread: a command per step, then its report. `hold`:
     * its first step runs until its turn is interrupted. Resolves with its report, or undefined if stopped.
     */
    const subAgent = async (threadId: string, sub: (typeof SUB_AGENTS)[number], hold: boolean): Promise<string | undefined> => {
      const turnId = randomUUID();
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', error: null, items: [] } });
      for (const [i, step] of sub.steps.entries()) {
        const item = { type: 'commandExecution', id: `${threadId}-cmd-${i}`, command: `/bin/zsh -lc '${step}'`, cwd: process.cwd(), status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null };
        notify('item/started', { threadId, turnId, item });
        const stopped = await new Promise<boolean>((resolve) => {
          childStops.set(turnId, () => resolve(true));
          if (!hold) setTimeout(() => resolve(false), this.opts.stepMs ?? 5);
        });
        if (stopped) {
          childStops.delete(turnId);
          notify('item/completed', { threadId, turnId, item: { ...item, status: 'failed', aggregatedOutput: '', exitCode: 130 } });
          notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } });
          return undefined;
        }
        notify('item/completed', { threadId, turnId, item: { ...item, status: 'completed', aggregatedOutput: `${step}: ok\n`, exitCode: 0, durationMs: 5 } });
      }
      childStops.delete(turnId);
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `${threadId}-m`, text: sub.report, phase: null } });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } });
      return sub.report;
    };

    /**
     * `spawn…`: the lead spawns two sub-agents (Codex's multi_agent: a collabAgentToolCall
     * `spawnAgent` each, their threads started under it), then `wait`s for both and answers.
     * `…background…`: it answers without waiting, and they work on. `…hold…`: they work until stopped.
     */
    const spawnTurn = async (threadId: string, turnId: string, words: string): Promise<void> => {
      const background = /\bbackground\b/.test(words);
      const hold = /\bhold\b/.test(words);
      const kids = SUB_AGENTS.map((sub) => ({ sub, id: randomUUID() }));
      const call = (id: string, tool: string, extra: object) => ({ type: 'collabAgentToolCall', id, tool, status: 'inProgress', senderThreadId: threadId, receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {}, ...extra });
      for (const [i, k] of kids.entries()) {
        const spawn = call(`spawn-${i}-${turnId}`, 'spawnAgent', { prompt: k.sub.prompt });
        notify('item/started', { threadId, turnId, item: spawn });
        this.threads.add(k.id);
        notify('thread/started', { thread: { id: k.id, parentThreadId: threadId, agentNickname: k.sub.nickname, agentRole: k.sub.role, preview: '', cwd: process.cwd(), status: { type: 'idle' }, turns: [] } });
        notify('item/completed', { threadId, turnId, item: { ...spawn, status: 'completed', receiverThreadIds: [k.id], agentsStates: { [k.id]: { status: 'pendingInit', message: null } } } });
      }
      const work = Promise.all(kids.map((k) => subAgent(k.id, k.sub, hold)));
      if (!background) {
        const wait = call(`wait-${turnId}`, 'wait', { receiverThreadIds: kids.map((k) => k.id) });
        notify('item/started', { threadId, turnId, item: wait });
        // The lead waits in its turn: a message can be steered in, and Stop interrupts it.
        const reports = await Promise.race([work, new Promise<'stopped'>((resolve) => (running = { id: turnId, threadId, stop: () => resolve('stopped') }))]);
        if (reports === 'stopped') {
          notify('item/completed', { threadId, turnId, item: { ...wait, status: 'interrupted' } });
          notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } });
          return;
        }
        running = undefined;
        notify('item/completed', { threadId, turnId, item: { ...wait, status: 'completed', agentsStates: Object.fromEntries(kids.map((k, i) => [k.id, { status: reports[i] ? 'completed' : 'interrupted', message: reports[i] ?? null }])) } });
      }
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `m-${turnId}`, text: `echo: ${words}`, phase: null } });
      notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 }, total: {}, modelContextWindow: 258400 } });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } });
    };

    const turn = async (threadId: string, turnId: string, text: string): Promise<void> => {
      const words = scriptedWords(text);
      const cmd = `cmd-${randomUUID()}`;
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', error: null, items: [] } });
      if (words.startsWith('fail')) return void notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'Your access token could not be refreshed.', codexErrorInfo: 'unauthorized', additionalDetails: null }, items: [] } });
      if (words.startsWith('spawn')) return spawnTurn(threadId, turnId, words);
      notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: cmd, command: `/bin/zsh -lc 'echo ${words}'`, cwd: process.cwd(), status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null } });
      if (words.startsWith('edit')) {
        const item = { type: 'fileChange', id: `f-${turnId}`, status: 'inProgress', changes: [{ path: '/etc/hosts', kind: { type: 'update', move_path: null }, diff: '+x' }] };
        notify('item/started', { threadId, turnId, item });
        this.approvals.push(await ask('item/fileChange/requestApproval', { threadId, turnId, itemId: item.id, reason: 'outside the workspace' }));
      }
      // Asks also when the request asked, under a note after it (a plan's turn ends with its note).
      if (words.startsWith('ask') || /^Request from [^\n]*:\nask/m.test(text)) {
        const verdict = (await ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: cmd, command: `echo ${words}`, cwd: process.cwd() })) as { decision?: string } | undefined;
        this.approvals.push(verdict);
        // Declined: the command never runs, and Codex says so (as codex-cli does: the item ends `declined`).
        if (verdict?.decision === 'decline') {
          notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: cmd, command: `/bin/zsh -lc 'echo ${words}'`, cwd: process.cwd(), status: 'declined', aggregatedOutput: null, exitCode: null, durationMs: null } });
          notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `m-${turnId}`, text: `denied: ${words}`, phase: null } });
          notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 }, total: {}, modelContextWindow: 258400 } });
          notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } });
          return;
        }
      }
      if (words.startsWith('wait')) {
        await new Promise<void>((resolve) => (running = { id: turnId, threadId, stop: resolve }));
        notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } });
        return;
      }
      if (this.opts.stepMs) await new Promise((resolve) => setTimeout(resolve, this.opts.stepMs));
      notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: cmd, command: `/bin/zsh -lc 'echo ${words}'`, cwd: process.cwd(), status: 'completed', aggregatedOutput: `${words}\n`, exitCode: 0, durationMs: 5 } });
      if (this.signedIn) notify('account/rateLimits/updated', { rateLimits: { ...(this.rateLimits as object), primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1780409235 } } });
      notify('item/completed', { threadId, turnId, item: { type: 'reasoning', id: `r-${turnId}`, summary: ['Saying it back.'], content: [] } });
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `m-${turnId}`, text: `echo: ${words}`, phase: null } });
      notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 }, total: {}, modelContextWindow: 258400 } });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } });
    };

    const answer = (method: string, params: Record<string, unknown>): unknown => {
      switch (method) {
        case 'initialize':
          return { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
        case 'thread/start': {
          if (this.unelevatedWindows && deniesReads(params)) throw new Error(UNELEVATED_WINDOWS);
          const id = randomUUID();
          this.threads.add(id);
          return { thread: { id }, model: 'gpt-fake' };
        }
        case 'thread/resume':
          if (!this.threads.has(String(params.threadId))) throw new Error('no rollout found');
          if (this.unelevatedWindows && deniesReads(params)) throw new Error(UNELEVATED_WINDOWS);
          return { thread: { id: params.threadId }, model: 'gpt-fake' };
        case 'turn/start': {
          const id = randomUUID();
          const input = params.input as Array<{ type: string; text?: string }>;
          setImmediate(() => void turn(String(params.threadId), id, input.find((i) => i.type === 'text')?.text ?? ''));
          return { turn: { id, status: 'inProgress', error: null, items: [] } };
        }
        case 'turn/steer':
          if (running?.id !== params.expectedTurnId) throw new Error('no active turn');
          return { turnId: params.expectedTurnId };
        case 'turn/interrupt': {
          // A sub-agent's turn, on its own thread.
          const child = childStops.get(String(params.turnId));
          if (child) return setImmediate(child), {};
          const stop = running?.id === params.turnId ? running?.stop : undefined;
          if (stop) setImmediate(stop);
          running = undefined;
          return {};
        }
        case 'account/read':
          return this.signedIn ? { account: { type: 'chatgpt', email: 'kay@example.com', planType: 'plus' }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true };
        case 'account/rateLimits/read':
          if (!this.signedIn) throw new Error('not signed in');
          return { rateLimits: this.rateLimits, rateLimitsByLimitId: null };
        case 'config/read': {
          const file = '/home/.codex/config.toml';
          const origins = Object.fromEntries(Object.entries(this.mcpServers).map(([name, s]) => [`mcp_servers.${name}.${s.url ? 'url' : 'command'}`, { name: { type: 'user', file, profile: null }, version: 'sha256:0' }]));
          return { config: { mcp_servers: this.mcpServers }, origins, layers: null };
        }
        case 'config/value/write': {
          const m = /^mcp_servers\.([\w-]+)\.enabled$/.exec(String(params.keyPath));
          const server = m ? this.mcpServers[m[1]!] : undefined;
          if (!server || typeof params.value !== 'boolean') throw new Error(`can't write ${String(params.keyPath)}`);
          server.enabled = params.value;
          return { status: 'ok', version: 'sha256:1', filePath: params.filePath ?? '/home/.codex/config.toml', overriddenMetadata: null };
        }
        case 'mcpServerStatus/list':
          return { data: this.mcpStatuses(), nextCursor: null };
        case 'mcpServer/oauth/login': {
          const name = String(params.name);
          const server = this.mcpServers[name];
          if (!server) throw new Error(`No MCP server named ${name}`);
          if (!server.url) throw new Error('OAuth login is only supported for streamable HTTP servers.');
          const loginId = randomUUID();
          const ends = this.mcpLoginEnds;
          if (ends !== undefined)
            setTimeout(() => {
              if (ends) this.mcpSignedIn.add(name);
              notify('mcpServer/oauthLogin/completed', { name, threadId: null, loginId, success: ends, ...(ends ? {} : { error: 'access denied' }) });
            }, this.opts.stepMs ?? 5);
          return { authorizationUrl: `https://example.com/oauth/${encodeURIComponent(name)}/authorize?client_id=codex&state=${loginId}`, loginId };
        }
        case 'model/list':
          return { data: this.models, nextCursor: null };
        default:
          throw new Error(`unknown method ${method}`);
      }
    };

    readline.createInterface({ input: toServer }).on('line', (line) => {
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      if (!msg.method && msg.id !== undefined) return void asked.get(msg.id)?.(msg.result);
      if (!msg.method) return;
      this.requests.push({ method: msg.method, params: msg.params ?? {} });
      if (msg.id === undefined) return;
      try {
        send({ id: msg.id, result: answer(msg.method, msg.params ?? {}) });
      } catch (err) {
        send({ id: msg.id, error: { code: -32600, message: (err as Error).message } });
      }
    });

    const rpc = new CodexRpc(toClient, toServer);
    const conn: CodexConnection = {
      rpc,
      stderr: () => [],
      proc: {
        pid: 4242,
        alive: () => alive,
        exited,
        kill: async () => {
          if (!alive) return;
          alive = false;
          running?.stop();
          for (const stop of childStops.values()) stop();
          toClient.end();
          toServer.end();
          exit();
        },
      },
    };
    await handshake(rpc);
    return conn;
  };

  /** mcpServerStatus/list's data: each configured server tried (a turned-off one isn't), and a plugin's. */
  private mcpStatuses(): unknown[] {
    const base = { runtimeStatus: null, pluginId: null, httpOrigin: null, serverInfo: null, serverCapabilities: null, toolListMeta: null, tools: {}, toolsError: null, resources: [], resourceTemplates: [], authStatus: 'unsupported' };
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
    const configured = Object.entries(this.mcpServers).map(([name, s]) => {
      if (!s.enabled) return { ...base, name };
      if (s.url) {
        const origin = new URL(s.url).origin;
        return this.mcpSignedIn.has(name)
          ? { ...base, name, httpOrigin: origin, serverInfo: { name, version: '1.0.0' }, tools: { get_design: tool('get_design'), get_screenshot: tool('get_screenshot') }, authStatus: 'oAuth' }
          : { ...base, name, httpOrigin: origin, toolsError: 'MCP startup failed: handshaking with MCP server failed: Send message error Transport [rmcp::transport::worker::WorkerTransport<x>] error: Auth required, when send initialize request', authStatus: 'notLoggedIn' };
      }
      if (s.command?.startsWith('/nonexistent')) return { ...base, name, toolsError: 'MCP startup failed: No such file or directory (os error 2)' };
      return { ...base, name, serverInfo: { name, version: '1.0.0' }, tools: { search_code: tool('search_code'), create_issue: tool('create_issue'), list_prs: tool('list_prs') } };
    });
    const plugin = { ...base, name: 'linear', pluginId: 'linear@openai-curated', httpOrigin: 'https://mcp.linear.app', serverInfo: { name: 'linear', version: '1.0.0' }, tools: { list_issues: tool('list_issues') }, authStatus: 'oAuth' };
    return [...configured, plugin].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The params of every request of `method`. */
  sent(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }
}
