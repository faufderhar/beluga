import { claudeHome } from '../../../core/claude-code/launch.js';
import { type RunEnd, RunFailedError, classifyRun } from '../../../shared/run-failure.js';
import { buildPrompt } from '../../prompt.js';
import { runInstructions } from '../../run-instructions.js';
import { runToolSuites } from '../../run-tools.js';
import { sideCalls } from '../../side-calls.js';
import { syncProbes } from '../../sync-main.js';
import { gateTool } from '../../tool-gate.js';
import { ToolHost } from '../../tool-host.js';
import type { AgentBackend, AgentRunInput, FollowUp, LiveStatus, RoomBridge, Steer } from '../../types.js';
import { ViewShelf } from '../../view-tools.js';
import { clampEffort } from '../codex/runner.js';
import type { ConfigOption, ContentBlock, PermissionRequest, PromptResponse, SessionResponse, SessionUpdate } from '../opencode/acp.js';
import { permissionAnswer } from '../opencode/acp.js';
import { type AcpDialect, OpenCodeEvents, type TurnSink, contextEvent } from '../opencode/events.js';
import { acpServers, promptBlocks } from '../opencode/runner.js';
import { mapOpenCodeSlash } from '../opencode/skills.js';
import { INTERRUPT_TIMEOUT_MS } from '../types.js';
import { type GrokConnect, type GrokConnection, type GrokModel, findGrok, spawnGrok } from './connection.js';
import { readGrokPlan } from './plan-usage.js';
import { modelChoice, probeGrok } from './models.js';
import { askGrokBtw, forkGrok, grokComplete } from './side.js';
import { GROK_EXIT_PLAN, GROK_OWN, GROK_SUBAGENT, GROK_WRITES, grokCalls, grokResultText, grokToolOf, isBelugaTool } from './tools.js';

export interface GrokBackendOptions {
  readonly cwd: string;
  readonly autoEdit: boolean;
  readonly additionalDirectories: readonly string[];
  readonly bridge: RoomBridge;
  readonly model?: string;
  /** Grok's executable; unset: findGrok(). */
  readonly bin?: string;
  /** How to reach Grok (tests: a scripted one). */
  readonly connect?: GrokConnect;
  /** Where Beluga's tools are served to the run over stdio (one per daemon). */
  readonly toolHost?: ToolHost;
}

const GROK_AGENT = { runtime: 'grok', label: 'Grok Build' } as const;
/** A plan sent back for changes this many times: the run ends with the last plan as its answer. */
const PLAN_ROUNDS = 5;
/** Steps turned down in one message before Beluga stops sending Grok back to work. */
const DENIALS_MAX = 8;
/** One USD in the ticks Grok counts its cost in. */
const TICKS_PER_USD = 10_000_000_000;

let sharedHost: ToolHost | undefined;
const toolHost = (): ToolHost => (sharedHost ??= new ToolHost());

/**
 * Fields that say what a Grok call is for. They arrive in the `tool_call` itself (often still
 * pending, with no `in_progress`), so the step begins as soon as one of them is present.
 */
const GROK_INPUT_KEYS = new Set(['command', 'file_path', 'path', 'target_file', 'target_directory', 'pattern', 'url', 'query', 'tool_name', 'prompt', 'content', 'old_string', 'todos']);

/** Beluga's Bash, Read and so on in place of Grok's: the shared event layer's table for it. */
export const GROK_DIALECT: AcpDialect = {
  toolOf: grokToolOf,
  // Each call's input is in its `tool_call`, before its permission request, so judging it does not wait.
  inputOf: (call) => (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}),
  callsOf: (tool, raw, cwd) => grokCalls(tool, raw, cwd),
  needsInput: new Set(),
  inputKeys: GROK_INPUT_KEYS,
  writes: GROK_WRITES,
  subTool: GROK_SUBAGENT,
  result: grokResultText,
};

/** A positive finite count; anything else is nothing reported. */
const count = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * What `session/prompt` puts on `_meta.usage`. ACP names the whole prompt `inputTokens` and the
 * cache hit `cachedReadTokens`. Headless and model-usage names (`cacheReadInputTokens`,
 * `cache_read_input_tokens`) already leave the cache out of input.
 */
interface GrokUsageCounts {
  readonly inputTokens?: number;
  readonly input_tokens?: number;
  readonly outputTokens?: number;
  readonly output_tokens?: number;
  readonly cachedReadTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cacheCreationTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cachedWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly reasoning_tokens?: number;
  readonly costUsdTicks?: number;
  readonly costUSD?: number;
}

interface GrokTurnMeta {
  readonly totalTokens?: number;
  readonly usage?: GrokUsageCounts;
}

/** The first name Grok actually filled in. Two names for one bucket are not added together. */
const firstCount = (...ns: Array<number | undefined>): number => {
  for (const n of ns) {
    const v = count(n);
    if (v) return v;
  }
  return 0;
};

interface GrokParts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

/** Fresh input, output, cache read, cache write and cost, each once. */
function grokParts(usage: GrokUsageCounts): GrokParts {
  // ACP's cachedReadTokens is inside inputTokens. The headless names are not, so only that one comes back out.
  const acpRead = count(usage.cachedReadTokens);
  const cacheRead = firstCount(usage.cachedReadTokens, usage.cacheReadInputTokens, usage.cache_read_input_tokens);
  const cacheWrite = firstCount(usage.cacheCreationTokens, usage.cacheCreationInputTokens, usage.cache_creation_input_tokens, usage.cachedWriteTokens);
  const reportedIn = usage.inputTokens ?? usage.input_tokens ?? 0;
  const input = Math.max(0, (typeof reportedIn === 'number' && Number.isFinite(reportedIn) ? reportedIn : 0) - acpRead);
  // Output already includes reasoning when Grok sends both. A turn that reports only reasoning still counts it.
  const output = firstCount(usage.outputTokens, usage.output_tokens) || firstCount(usage.reasoningTokens, usage.reasoning_tokens);
  const ticks = usage.costUsdTicks;
  const cost = typeof ticks === 'number' && Number.isFinite(ticks) ? Math.max(0, ticks / TICKS_PER_USD) : typeof usage.costUSD === 'number' && Number.isFinite(usage.costUSD) ? Math.max(0, usage.costUSD) : 0;
  return { input, output, cacheRead, cacheWrite, cost };
}

/** A turn's tokens and cost, in Beluga's shape: fresh input, output, cache read and cache write, each once. */
export function grokUsageEvent(meta: GrokTurnMeta | undefined, session: string): string | undefined {
  const usage = meta?.usage;
  if (!usage) return undefined;
  return JSON.stringify({ ...grokParts(usage), session });
}

/**
 * The context meter for one report. What's in the window is fresh input plus cache read and cache
 * write (output isn't in the window until the next turn). `totalTokens` is only the fallback when
 * that fill wasn't reported. Cache counts ride along so the hit rate can show before the ledger
 * write; both zero, they're left off.
 */
export function grokContextEvent(meta: GrokTurnMeta | undefined, size: number, model?: string): string | undefined {
  const parts = meta?.usage ? grokParts(meta.usage) : undefined;
  const fill = parts ? parts.input + parts.cacheRead + parts.cacheWrite : 0;
  const base = contextEvent(fill > 0 ? fill : count(meta?.totalTokens), size, model);
  if (!base || !parts || fill <= 0 || (parts.cacheRead <= 0 && parts.cacheWrite <= 0)) return base;
  return JSON.stringify({ ...(JSON.parse(base) as Record<string, unknown>), cacheRead: parts.cacheRead, cacheWrite: parts.cacheWrite });
}

/** Session updates that are never a usage report (a tool call can carry numbers that aren't tokens). */
const NOT_USAGE = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk', 'tool_call', 'tool_call_update', 'available_commands_update', 'config_option_update', 'current_mode_update', 'plan', 'auto_compact_completed']);

const USAGE_KEYS = ['inputTokens', 'input_tokens', 'outputTokens', 'output_tokens', 'cachedReadTokens', 'cacheReadInputTokens', 'cache_read_input_tokens', 'cacheCreationTokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens', 'cachedWriteTokens', 'totalTokens'] as const;

const hasUsageShape = (o: object): boolean => USAGE_KEYS.some((k) => typeof (o as Record<string, unknown>)[k] === 'number');

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined);

/**
 * A `session/update` (or an `_x.ai` notification) as a context event, while the turn is still
 * running. `usage_update` is the window (`used` / `size`). `turn_usage`, and any other update
 * shaped like Grok's usage, is the prompt's tokens. Anything else is ignored.
 */
export function grokLiveContext(update: unknown, size: number, model?: string): string | undefined {
  const u = asRecord(update);
  if (!u) return undefined;
  const kind = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : '';
  if (NOT_USAGE.has(kind)) return undefined;
  const nested = asRecord(u.usage);
  const shaped = hasUsageShape(u) || Boolean(nested && hasUsageShape(nested));
  if (kind !== 'usage_update' && kind !== 'turn_usage' && !shaped) return undefined;
  const usageObj = nested && hasUsageShape(nested) ? nested : hasUsageShape(u) ? u : undefined;
  const total = count(typeof u.totalTokens === 'number' ? u.totalTokens : typeof nested?.totalTokens === 'number' ? nested.totalTokens : undefined);
  const reported = typeof u.size === 'number' && u.size > 0 ? u.size : size;
  const fromTokens = usageObj || total ? grokContextEvent({ ...(total ? { totalTokens: total } : {}), ...(usageObj ? { usage: usageObj as GrokUsageCounts } : {}) }, reported, model) : undefined;
  const fromWindow = typeof u.used === 'number' ? contextEvent(u.used, reported, model) : undefined;
  // The prompt's own fill carries the cache split, so it wins. A bare `used` is the window when
  // that fill wasn't there (`totalTokens` would otherwise stand in for it).
  if (fromTokens) {
    const body = JSON.parse(fromTokens) as { cacheRead?: unknown; cacheWrite?: unknown };
    if (body.cacheRead !== undefined || body.cacheWrite !== undefined || !fromWindow) return fromTokens;
  }
  return fromWindow;
}

/**
 * A later window-only update (usage_update's `used`, with no cache split) keeps the cache counts
 * from the last report, so the hit rate stays on screen while the window moves.
 */
export function mergeLiveContext(next: string, prev: string | undefined): string {
  if (!prev) return next;
  let body: Record<string, unknown>;
  let prior: Record<string, unknown>;
  try {
    body = JSON.parse(next) as Record<string, unknown>;
    prior = JSON.parse(prev) as Record<string, unknown>;
  } catch {
    return next;
  }
  if (body.cacheRead !== undefined || body.cacheWrite !== undefined) return next;
  if (typeof prior.cacheRead !== 'number' && typeof prior.cacheWrite !== 'number') return next;
  return JSON.stringify({ ...body, ...(typeof prior.cacheRead === 'number' ? { cacheRead: prior.cacheRead } : {}), ...(typeof prior.cacheWrite === 'number' ? { cacheWrite: prior.cacheWrite } : {}) });
}

const SIGNED_OUT = /authentication required|not authenticated|grok login/i;

/** A failed Grok run, told as Grok's (not Claude Code's). */
export const grokFailure = (end: RunEnd): RunFailedError => {
  const told = classifyRun(end);
  return new RunFailedError({ ...told, ...(SIGNED_OUT.test(end.error ?? '') ? { kind: 'signed_out' as const } : {}), runtime: 'grok' });
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

interface GrokSession extends SessionResponse {
  readonly models?: { readonly availableModels?: readonly GrokModel[] };
}

/**
 * Runs turns on Grok Build through `grok agent stdio`: one process per run, one session per place
 * (its id is the place's session, so the conversation resumes), each request a prompt, its updates
 * streamed into onEvent/onStep the way Claude's are. A hook (connection.ts) makes every tool call
 * come to Beluga first, reads too, and each is judged by the same gate as Claude's (vetTool,
 * policy, you). Beluga's tools reach it as stdio MCP servers, gated per call there.
 *
 * Two things differ from other ACP agents. A step turned down ends Grok's turn (`cancelled`), so
 * Beluga starts the next one, saying why, and the work goes on as it does on Claude. And there's
 * no plan mode over ACP (it ignores `plan`), so a plan is a turn under the read-only policy.
 */
export function createGrokBackend(opts: GrokBackendOptions): AgentBackend {
  let sessionId: string | undefined;
  const connect = opts.connect ?? spawnGrok;
  const host = (): ToolHost => opts.toolHost ?? toolHost();
  const bin = (): string | undefined => opts.bin ?? (opts.connect ? undefined : findGrok());
  // A scripted Grok (tests, the demo) has no sessions of the real one's to drop.
  const side = { ...(opts.connect ? { connect: opts.connect, drop: async () => undefined } : {}), ...(opts.bin ? { bin: opts.bin } : {}) };

  return {
    async run(input: AgentRunInput): Promise<string> {
      if (input.signal.aborted) throw new Error('aborted');
      const bridge = input.channel && opts.bridge.inChannel ? opts.bridge.inChannel(input.channel) : opts.bridge;
      const place = input.place;
      const cwd = place?.cwd ?? opts.cwd;
      const extraDirs = place ? place.additionalDirectories : opts.additionalDirectories;
      const askOnly = place?.askOnly;
      const readOnly = Boolean(askOnly) || Boolean(input.dialogue?.readOnly);
      const autoEdit = !readOnly && (place?.autoEdit ?? opts.autoEdit);
      const fixup = place?.fixup;
      const syncMain = askOnly ? place?.syncMain : undefined;
      const policy = { cwd, roots: [cwd, ...extraDirs, ...(fixup ? [fixup] : [])], autoEdit, scope: input.scope, guest: input.guest, boardAsks: input.boardAsks, dotenv: Boolean(input.canUseSecret) && !input.guest, askOnly: readOnly, ...(syncMain ? { syncMain: syncProbes(cwd, syncMain) } : {}), ...(fixup ? { fixup } : {}), ...(place?.alsoEdit?.length ? { alsoEdit: place.alsoEdit } : {}) };
      const remember = (id: string): void => (place ? place.onSession(id) : void (sessionId = id));
      const shelf = new ViewShelf();

      // Beluga's tools, served for this run alone and gated per call (vetTool, policy, you).
      const mounted = await host().mount(runToolSuites(input, bridge, shelf, cwd), (name, args) => gateTool(name, args, input, policy));
      const suites = Object.keys(mounted.servers);
      const instructions = runInstructions(input, opts.bridge.selfName(), GROK_AGENT);

      let planning = Boolean(input.plan);
      let model: string | undefined;
      let window = 0;
      let lastContext: string | undefined;
      /** The turn running now, so a usage update lands on its conversation (a follow-up's, once one starts). */
      let turnSink: TurnSink | undefined;
      /** A /compact turn is running, and how full it left the window (Grok says so in its own notification). */
      let compacting = false;
      let compacted: { readonly before: number; readonly after: number } | undefined;
      const compactedNow = (): typeof compacted => compacted;
      /** Grok's own commands here (its built-ins and the skills it loaded). */
      let commands = new Set<string>();
      const events = new OpenCodeEvents(cwd, { onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}) }, {
        dialect: GROK_DIALECT,
        onFileTouched: input.onFileTouched,
        expand: (t) => shelf.expand(t),
        suites,
        onSub: (e) => input.onEvent('sub', JSON.stringify(e)),
        quiet: () => compacting,
      });
      let conn: GrokConnection | undefined;
      let failed = true;
      let closed = false;
      try {
        conn = await connect({ cwd, env: { ...process.env, ...input.env }, ...(opts.bin ? { bin: opts.bin } : {}) });
        const link = conn;
        input.onProcess?.(link.proc);
        const { rpc } = link;
        const stopped = deferred<never>();
        void rpc.closed.then(() => {
          if (!closed) stopped.reject(grokFailure({ error: 'Grok Build exited before the turn ended', stderr: link.stderr() }));
        });

        let sid = '';
        let options: readonly ConfigOption[] = [];
        /** Why steps were turned down in the turn now running: Grok is told when it's sent back. */
        const declined: string[] = [];
        /** The meter, as soon as Grok says how full the window is. Not a ledger write: that waits for the prompt's own total. */
        const publishContext = (raw: unknown): void => {
          const ev = grokLiveContext(raw, window, model);
          if (!ev || compacting) return;
          const next = mergeLiveContext(ev, lastContext);
          if (next === lastContext) return;
          (turnSink ?? { onEvent: input.onEvent }).onEvent('context', (lastContext = next));
        };
        rpc.onNotification((method, params) => {
          if (params.sessionId !== sid) return;
          if (method === '_x.ai/session_notification') {
            const u = params.update as { sessionUpdate?: string; tokens_before?: number; tokens_after?: number };
            if (u.sessionUpdate === 'auto_compact_completed') compacted = { before: u.tokens_before ?? 0, after: u.tokens_after ?? 0 };
            else publishContext(params.update);
            return;
          }
          if (method !== 'session/update') return;
          const update = params.update as SessionUpdate;
          if (update.sessionUpdate === 'available_commands_update') commands = new Set(update.availableCommands.map((c) => c.name));
          if (update.sessionUpdate === 'config_option_update') options = update.configOptions;
          publishContext(update);
          events.handle(update);
        });
        // Every tool call Grok makes: Beluga's gate decides (and you, when it asks), once each.
        rpc.onRequest(async (method, params) => {
          if (method !== 'session/request_permission') {
            // Grok ends its turn when this goes unanswered: it's told so, as for a step turned down.
            declined.push(`Beluga can’t answer ${method}.`);
            throw new Error(`${method} isn’t supported in Beluga`);
          }
          const req = params as unknown as PermissionRequest;
          const why = await judge(req);
          if (why) {
            events.denied.set(req.toolCall.toolCallId, why);
            declined.push(why);
          }
          return permissionAnswer(req, !why);
        });
        /** Why a call may not run (undefined: it may). */
        const judge = async (req: PermissionRequest): Promise<string | undefined> => {
          const call = await events.callOf(req.toolCall);
          if (!call) return 'Grok Build didn’t say which tool this is.';
          if (GROK_OWN.has(call.tool)) return undefined;
          // Allowed, it asks the screen to approve a plan in its own way, which ends the turn.
          if (call.tool === GROK_EXIT_PLAN) return planning ? 'Beluga shows your plan for approval itself: answer with the whole plan in your reply, and don’t call exit_plan_mode.' : 'There’s no plan to approve here: carry on with the work.';
          const looking = planning || readOnly;
          const onlyLooks = planning ? 'Planning only looks: nothing changes until you approve the plan.' : 'This conversation only looks: nothing may change here.';
          if (looking && call.tool === GROK_SUBAGENT) return onlyLooks;
          for (const c of grokCalls(call.tool, call.raw, cwd)) {
            // Beluga's own tools are judged where they run (the tool host's gate), not twice.
            if (isBelugaTool(c.name, suites)) continue;
            if ((c.name === 'Read' || c.name === 'Write' || c.name === 'Edit') && !c.input.file_path) return 'Grok Build didn’t say which file, so Beluga turned it down.';
            if (looking && (c.name === 'Write' || c.name === 'Edit')) return onlyLooks;
            const denied = await gateTool(c.name, c.input, input, planning ? { ...policy, askOnly: true } : policy);
            if (denied) return denied;
          }
          return undefined;
        };

        const servers = acpServers(mounted.servers);
        const forked = Boolean(place?.forkSession && place.resume);
        const resume = place ? place.resume : sessionId;
        let opened: GrokSession | undefined;
        if (resume) {
          opened = forked ? await forkGrok(rpc, resume, cwd, servers) : await rpc.request<GrokSession>('session/resume', { sessionId: resume, cwd, mcpServers: servers }).then((r) => ({ ...r, sessionId: resume })).catch(() => undefined);
          if (!opened) input.onEvent('progress', 'Started a new Grok Build conversation (the last one couldn’t be opened)');
        }
        // Grok reads Beluga's instructions only when a session is made: a session picked up again gets them in its first message.
        const preface = opened ? `<beluga-instructions>\n${instructions}\n</beluga-instructions>\n\n` : '';
        opened ??= await rpc.request<GrokSession>('session/new', { cwd, mcpServers: servers, _meta: { rules: instructions } });
        sid = opened.sessionId!;
        options = opened.configOptions ?? [];
        remember(sid);
        const contextOf = new Map((opened.models?.availableModels ?? link.init._meta?.modelState?.availableModels ?? []).map((m) => [m.modelId, m._meta?.totalContextTokens ?? 0]));
        if (input.signal.aborted) throw new Error('aborted');

        /** Set one of the session's options (model, effort) when it offers that value and isn't on it already. */
        const choose = async (id: string, value: string | undefined): Promise<boolean> => {
          const option = options.find((o) => o.id === id);
          if (!value || !option || option.currentValue === value || !option.options.some((o) => o.value === value)) return false;
          const res = await rpc.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', { sessionId: sid, configId: id, value });
          options = res.configOptions ?? options;
          return true;
        };
        /** The model and effort a turn runs on: the picked one when Grok has it (else its own), the effort clamped to what that model takes. */
        let wanted = input.model ?? place?.model ?? opts.model;
        const settle = async (): Promise<void> => {
          await choose('model', wanted);
          const list = options.find((o) => o.id === 'model');
          if (wanted && /^grok/i.test(wanted) && list && !list.options.some((o) => o.value === wanted)) input.onEvent('progress', `Grok Build has no model ${wanted} here: it runs on its own default`);
          model = list?.currentValue ?? model;
          window = (model && contextOf.get(model)) || window;
          const effort = input.effort ?? place?.effort;
          const levels = options.find((o) => o.id === 'reasoning_effort')?.options.map((o) => o.value);
          if (effort && levels?.length) await choose('reasoning_effort', clampEffort(effort, levels));
        };
        await settle();

        // Stop: cancel the turn (same contract as Claude), then the process for sure.
        let aborted = false;
        /** The turn now ending was stopped on purpose (a denial's `cancelled` is not that). */
        let stopping = false;
        const abort = deferred<never>();
        let active: { readonly done: ReturnType<typeof deferred<PromptResponse>>; readonly sink: TurnSink } | undefined;
        const cancelTurn = async (): Promise<boolean> => {
          const turn = active;
          if (!turn) return false;
          stopping = true;
          events.stopping = true;
          rpc.notify('session/cancel', { sessionId: sid });
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<false>((r) => (timer = setTimeout(() => r(false), INTERRUPT_TIMEOUT_MS)));
          return Promise.race([turn.done.promise.then(() => true, () => true), late]).finally(() => clearTimeout(timer));
        };
        const onAbort = (): void => {
          aborted = true;
          void cancelTurn().finally(() => {
            abort.reject(new Error('aborted'));
            void link.proc.kill();
          });
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
        if (input.signal.aborted) throw new Error('aborted');

        /** One prompt: what it said last, and how it ended. */
        const runPrompt = async (sink: TurnSink, blocks: ContentBlock[]): Promise<{ text: string; res: PromptResponse }> => {
          events.beginTurn(sink);
          turnSink = sink;
          const done = deferred<PromptResponse>();
          active = { done, sink };
          try {
            rpc.request<PromptResponse>('session/prompt', { sessionId: sid, prompt: blocks }).then(done.resolve, (err: unknown) => done.reject(grokFailure({ error: err instanceof Error ? err.message : String(err), stderr: link.stderr() })));
            const res = await Promise.race([done.promise, stopped.promise, abort.promise]);
            const text = events.endTurn(res.stopReason !== 'cancelled');
            const meta = res._meta as GrokTurnMeta | undefined;
            const used = grokUsageEvent(meta, sid);
            if (used) sink.onEvent('usage', used);
            const ev = grokContextEvent(meta, window, model);
            if (ev && ev !== lastContext && !compacting) sink.onEvent('context', (lastContext = ev));
            return { text, res };
          } catch (err) {
            events.endTurn(false);
            throw err;
          } finally {
            turnSink = undefined;
            active = undefined;
          }
        };
        /** A turn, sent back to work each time a step was turned down: Grok ends its turn there, and is told why. */
        const runTurn = async (sink: TurnSink, blocks: ContentBlock[]): Promise<{ text: string; res: PromptResponse }> => {
          stopping = false;
          declined.length = 0;
          let last = await runPrompt(sink, blocks);
          for (let i = 0; !stopping && last.res.stopReason === 'cancelled' && declined.length; i++) {
            const why = declined.splice(0).join(' ');
            if (i === DENIALS_MAX) return { text: last.text || `Grok Build stopped after too many steps were turned down: ${why}`, res: { ...last.res, stopReason: 'end_turn' } };
            last = await runPrompt(sink, [{ type: 'text', text: `That step was turned down: ${why} Carry on without it. If you can't, say what you couldn't do.` }]);
          }
          return last;
        };

        // Messages that came in while a turn worked (Send now): a turn of their own after it.
        const pending: FollowUp[] = [];
        let interrupting: string | undefined;
        const status = (): LiveStatus => {
          const tool = [...events.tools.values()].sort((a, b) => a.since - b.since)[0];
          return { ...(tool ? { tool } : {}), lastEventAt: events.lastEventAt, between: !active, ...(events.thinking ? { thinking: true } : {}), alive: link.proc.alive() };
        };
        const interrupt = async (followUp: FollowUp, note: string): Promise<boolean> => {
          if (closed || !active || interrupting !== undefined) return false;
          interrupting = note;
          pending.unshift(followUp);
          const ok = await cancelTurn();
          if (!ok) {
            const at = pending.indexOf(followUp);
            if (at !== -1) pending.splice(at, 1);
            interrupting = undefined;
          }
          return ok;
        };
        // Grok takes one prompt at a time: a message can't go into a running turn (Beluga queues it), only stop it.
        const steer = Object.assign((_f: FollowUp) => false, { status, interrupt }) satisfies Steer;
        input.onSteer?.(steer);

        /** A turn's end as its answer: an interrupted one ends with the note it was stopped with. */
        const answerOf = (r: { text: string; res: PromptResponse }, sink: TurnSink): string => {
          if (r.res.stopReason === 'cancelled') {
            // Stopped on purpose is an abort. Grok ending a turn by itself is a failure to say.
            if (interrupting === undefined) throw input.signal.aborted || stopping ? new Error('aborted') : grokFailure({ error: 'Grok Build ended the turn without an answer', stderr: link.stderr() });
            const note = interrupting;
            interrupting = undefined;
            sink.onEvent('text', note);
            return r.text ? `${shelf.finish(r.text)}\n\n${note}` : note;
          }
          if (r.res.stopReason === 'refusal' && !r.text) return 'Grok declined to answer this.';
          return shelf.finish(r.text);
        };
        /** What didn't carry over to Grok, said in the chat now and kept at the top of the answer. */
        const noted = (notes: readonly string[], sink: TurnSink): ((answer: string) => string) => {
          for (const note of notes) sink.onEvent('text', note);
          return (answer) => (notes.length ? `${notes.join('\n')}\n\n${answer}` : answer);
        };
        /** /compact: Grok's own, kept out of the chat, and how full the window was before and after. */
        const compact = async (sink: TurnSink): Promise<string> => {
          compacting = true;
          compacted = undefined;
          try {
            await runTurn(sink, [{ type: 'text', text: '/compact' }]);
          } finally {
            compacting = false;
          }
          const left = compactedNow();
          sink.onEvent('compact', JSON.stringify({ pre: left?.before ?? 0, post: left?.after ?? 0, trigger: 'manual', ...(window ? { window } : {}) }));
          return '';
        };
        let first = preface;
        /** A message as a turn: a /command mapped (Grok loads your Claude Code skills itself), pictures with it. */
        const turnFor = async (sink: TurnSink, prompt: string, built: (p: string) => string): Promise<string> => {
          if (/^\/compact(\s|$)/.test(prompt.trim())) return compact(sink);
          const mapped = await mapOpenCodeSlash(prompt, cwd, claudeHome(), commands, 'Grok Build');
          const said = noted(mapped.notes, sink);
          const text = mapped.prompt.startsWith('/') ? mapped.prompt : `${first}${built(mapped.prompt)}`;
          if (!mapped.prompt.startsWith('/')) first = '';
          return said(answerOf(await runTurn(sink, promptBlocks(text, prompt, Boolean(link.init.agentCapabilities?.promptCapabilities?.image))), sink));
        };

        const original: TurnSink = { onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}) };
        const answers: string[] = [];
        let answer = await turnFor(original, input.prompt, (p) => (planning ? `${buildPrompt({ ...input, prompt: p })}\n\n${PLAN_NOTE}` : buildPrompt({ ...input, prompt: p })));
        // Plan first: a read-only turn (the policy above), the plan comes to you, and once you approve it the same session does the work.
        let askedToDefine = false;
        for (let round = 0; planning && input.askUser && round < PLAN_ROUNDS; round++) {
          if (input.planTask?.needsDefinition() && !askedToDefine) {
            askedToDefine = true;
            answer = answerOf(await runTurn(original, [{ type: 'text', text: DEFINE_NOTE }]), original);
          }
          const verdict = await input.askUser({ kind: 'plan', plan: (answer || '(Grok Build proposed a plan)').slice(0, 60_000) });
          if (verdict.kind !== 'plan') break;
          if (verdict.approve) {
            input.planTask?.approved();
            planning = false;
          }
          const next = verdict.approve ? 'The plan is approved. Do the work now.' : verdict.feedback ? `Change the plan: ${verdict.feedback}\n\n${PLAN_NOTE}` : NOT_YET_NOTE;
          answer = answerOf(await runTurn(original, [{ type: 'text', text: next }]), original);
          if (verdict.approve || next === NOT_YET_NOTE) break;
        }
        answers.push(answer);
        input.onAnswered?.(answer);

        // Then each message that waits for a turn of its own (one sent with Send now).
        while (!aborted) {
          const followUp = pending.shift();
          if (!followUp) break;
          const sink: TurnSink = { onEvent: followUp.onEvent, ...(followUp.onStep ? { onStep: followUp.onStep } : {}) };
          followUp.onStart?.();
          try {
            if (followUp.model !== undefined && followUp.model !== (wanted ?? '')) {
              wanted = followUp.model;
              await settle();
            }
            followUp.onDone(await turnFor(sink, followUp.prompt, (p) => buildPrompt({ ...followUp, prompt: p })));
          } catch (err) {
            if (aborted) throw err;
            followUp.onError(err instanceof Error ? err.message : String(err));
          }
        }
        if (aborted) throw new Error('aborted');
        input.signal.removeEventListener('abort', onAbort);
        failed = false;
        return answers.join('\n\n');
      } finally {
        closed = true;
        input.onSteer?.(undefined);
        events.finish(failed || input.signal.aborted);
        mounted.close();
        await conn?.proc.kill();
      }
    },

    // Side calls (naming, drafting, chat answers…) through Grok's one-shot call.
    ...sideCalls((req) => grokComplete(req, side), opts.cwd, opts.model),

    // A side question (/btw): a fork of the conversation's session, every tool turned down, the fork dropped after.
    btw: (req) => askGrokBtw(req, side),

    // The billing period: `grok usage` on the daemon route, else `_x.ai/billing` on the shell route.
    // A scripted Grok never shells out. Filed on Grok itself (not Claude). No window: the Usage view says so from the local ledger.
    async refreshUsage() {
      if (opts.connect) return undefined;
      try {
        const plan = await readGrokPlan(bin());
        if (plan.kind === 'signed_out') opts.bridge.reportUsage({ signedIn: false }, GROK_AGENT);
        else if (plan.kind === 'team') opts.bridge.reportUsage({ plan: 'Team', signedIn: true }, GROK_AGENT);
        else if (plan.kind === 'windows') opts.bridge.reportUsage({ windows: plan.windows.map((w) => ({ ...w })), ...(plan.plan ? { plan: plan.plan } : {}), signedIn: true }, GROK_AGENT);
      } catch {
        // The period stays unreported; the view still shows tokens counted on this Mac.
      }
      return undefined;
    },

    // Its models, from what it says when it starts.
    listModels: async () => {
      const b = bin();
      if (b) return (await probeGrok(b, { cwd: opts.cwd }))?.models;
      if (!opts.connect) return undefined;
      const conn = await opts.connect({ cwd: opts.cwd, ungated: true }).catch(() => undefined);
      if (!conn) return undefined;
      try {
        return (conn.init._meta?.modelState?.availableModels ?? []).map(modelChoice);
      } finally {
        await conn.proc.kill();
      }
    },
  };
}

const PLAN_NOTE = 'Plan only: look around read-only, change nothing, and answer with a step-by-step plan for the person to approve.';
const DEFINE_NOTE =
  'Before the plan goes to the person for approval, call the beluga_board task_define tool with the task this plan is for (title, goal in your own words, context, acceptance criteria, decisions, open questions, estimate, priority). Then answer with the plan again, in full.';
const NOT_YET_NOTE = 'The person did not approve the plan yet. Ask them what they would like to change, and change nothing.';
