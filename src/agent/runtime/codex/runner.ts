import path from 'node:path';
import { linkedImages } from '../../../core/attachments.js';
import { type RunEnd, RunFailedError, classifyRun } from '../../../shared/run-failure.js';
import { fallbackFor } from '../../../shared/runtime-fallbacks.js';
import { buildPrompt } from '../../prompt.js';
import { runInstructions } from '../../run-instructions.js';
import { runToolSuites } from '../../run-tools.js';
import { ToolHost, type StdioServerConfig } from '../../tool-host.js';
import { gateTool } from '../../tool-gate.js';
import { sideCalls } from '../../side-calls.js';
import { syncProbes } from '../../sync-main.js';
import type { AgentBackend, AgentRunInput, FollowUp, LiveStatus, RoomBridge, Steer } from '../../types.js';
import { ViewShelf } from '../../view-tools.js';
import { BACKGROUND_LIMIT_MS, INTERRUPT_TIMEOUT_MS } from '../types.js';
import { type CodexConnect, type CodexConnection, spawnAppServer } from './app-server.js';
import { CodexSubAgents } from './subagents.js';
import { codexComplete } from './complete.js';
import { CodexEvents, type TurnSink, contextEvent, usageEvent } from './events.js';
import { type AskForApproval, type Model, REASONING_EFFORTS, type ReasoningEffort, type ThreadStartResponse, type ThreadTokenUsage, type Turn, type UserInput } from './protocol.js';
import { type CodexConfinement, approvalFor, codexConfinement, originOf, readsUndeniable, trustRow, withoutReadDenials } from './sandbox.js';
import { CODEX_USAGE_AGENT, type CodexRateLimits, fromRateLimits } from './rate-limits.js';
import { findCodex } from './app-server.js';
import { CodexMcp } from './mcp.js';
import { type MappedPrompt, mapSlash } from './skills.js';
import { claudeHome } from '../../../core/claude-code/launch.js';

export interface CodexBackendOptions {
  readonly cwd: string;
  readonly autoEdit: boolean;
  readonly additionalDirectories: readonly string[];
  readonly bridge: RoomBridge;
  readonly model?: string;
  /** Codex's executable; unset: findCodex(). */
  readonly codexPath?: string;
  /** How to reach an app-server (tests: a scripted one). */
  readonly connect?: CodexConnect;
  /** Where Beluga's tools are served to the run over stdio (one per daemon). */
  readonly toolHost?: ToolHost;
  /** Your saved variables for Settings' MCP check in a folder (RuntimeOptions.ownEnv). */
  readonly ownEnv?: (cwd: string) => Readonly<Record<string, string>>;
}

const CODEX_AGENT = { runtime: 'codex', label: 'Codex' } as const;
const MODEL_TIMEOUT_MS = 20_000;
/** A plan sent back for changes this many times: the run ends with the last plan as its answer. */
const PLAN_ROUNDS = 5;

let sharedHost: ToolHost | undefined;
const toolHost = (): ToolHost => (sharedHost ??= new ToolHost());

/** A model Codex knows, or undefined for its own default (Claude's aliases mean nothing to it). */
export function codexModel(model: string | undefined): string | undefined {
  if (!model || /^(default|haiku|sonnet|opus|claude|fable)/i.test(model)) return undefined;
  return model;
}

/** Words in a Codex model's name or description that say it's the small, fast one. */
const SMALL_MODEL = /\b(mini|nano|small|spark|lite|fast)\b/i;

/** Codex's small, fast model (what Claude's 'haiku' asks for), from its own list; undefined: none, so its default. */
export function smallCodexModel(models: readonly Model[]): string | undefined {
  return models.find((m) => !m.hidden && !m.isDefault && SMALL_MODEL.test(`${m.id} ${m.displayName} ${m.description}`))?.id;
}

/**
 * The model to ask Codex for: a Codex model as is; Claude's 'haiku' (a side call wanting a quick
 * answer) as Codex's small, fast model when its list has one; anything else Claude's, its default.
 * `''` (the picker's default, chosen after a run started): the default by name, so a turn switches back.
 * None picked: Codex's own config decides, unless the model it names isn't one this account can use
 * (a ChatGPT sign-in can't run every API model): then the account's default, else every turn fails.
 */
export async function pickCodexModel(model: string | undefined, list: () => Promise<readonly Model[]>, configured?: () => Promise<string | undefined>): Promise<string | undefined> {
  if (model && /haiku/i.test(model)) return smallCodexModel(await list().catch(() => []));
  if (model === '') return (await list().catch(() => [])).find((m) => m.isDefault)?.id;
  const picked = codexModel(model);
  if (picked || !configured) return picked;
  const [own, models] = await Promise.all([configured().catch(() => undefined), list().catch(() => [] as readonly Model[])]);
  if (!own || !models.length || models.some((m) => m.id === own || m.model === own)) return undefined;
  return models.find((m) => m.isDefault)?.id;
}

/** The model Codex's own config names (~/.codex/config.toml `model`), when it names one. */
export function configuredModel(rpc: CodexConnection['rpc']): Promise<string | undefined> {
  return rpc.request<{ config?: { model?: unknown } }>('config/read', {}, MODEL_TIMEOUT_MS).then((r) => (typeof r.config?.model === 'string' ? r.config.model : undefined));
}

/** Beluga's effort names as Codex's ('max' is Codex's 'xhigh' where a model has no 'max'). */
export function codexEffort(effort: AgentRunInput['effort']): ReasoningEffort | undefined {
  return effort === 'max' ? 'xhigh' : effort;
}

/**
 * The effort a model can take: the one asked if it lists it ('max' too, on a model that has it),
 * else the highest it lists below that, else its lowest. Unknown efforts (no list): as codexEffort says.
 */
export function clampEffort(effort: AgentRunInput['effort'], supported: readonly string[] | undefined): ReasoningEffort | undefined {
  if (!effort) return undefined;
  const known = (supported ?? []).filter((e): e is ReasoningEffort => (REASONING_EFFORTS as readonly string[]).includes(e));
  if (!known.length) return codexEffort(effort);
  if (known.includes(effort)) return effort;
  const rank = (e: ReasoningEffort): number => REASONING_EFFORTS.indexOf(e);
  const want = rank(codexEffort(effort)!);
  const below = known.filter((e) => rank(e) <= want).sort((a, b) => rank(b) - rank(a));
  return below[0] ?? [...known].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * How long Codex waits on one of Beluga's tools (its default is 60 s). Long on purpose: a call can
 * wait for you to approve it, and ask_agent, wait_for and run_on_peer wait up to 10 minutes.
 */
export const TOOL_TIMEOUT_SEC = 3600;

/** Beluga's tool servers as Codex config overrides (`mcp_servers.<name>`), for one thread. */
export function mcpConfig(servers: Readonly<Record<string, StdioServerConfig>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(servers).map(([name, s]) => [`mcp_servers.${name}`, { command: s.command, args: s.args, env: s.env, tool_timeout_sec: TOOL_TIMEOUT_SEC }]));
}

/**
 * Codex's own features a side call (complete.ts) never uses: its multi-agent (a one-shot answer
 * spawns no helpers).
 */
export const RUN_FEATURES_OFF = { 'features.multi_agent': false } as const;

/**
 * Codex's multi-agent for a run (BLG-519): on for your own runs, its sub-agents shown as Claude's
 * are (subagents.ts); off for a friend's task (the trust table's "your Codex tools", sandbox.ts).
 */
export const runFeatures = (yourTools: boolean): Record<string, boolean> => ({ 'features.multi_agent': yourTools });

/** A prompt as Codex's input: the text, and images it links (Codex reads them from disk). */
export function codexInput(text: string, prompt: string, skill?: MappedPrompt['skill']): UserInput[] {
  return [{ type: 'text', text, text_elements: [] }, ...linkedImages(prompt).map((file) => ({ type: 'localImage' as const, path: file })), ...(skill ? [{ type: 'skill' as const, ...skill }] : [])];
}

/** Friendly rows for the model picker from Codex's own list. */
export function toCodexModelChoices(models: readonly Model[]) {
  return models
    .filter((m) => !m.hidden)
    .map((m) => ({ value: m.isDefault ? '' : m.id, label: m.displayName, description: m.description, efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort) }));
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

/**
 * Runs turns on Codex through `codex app-server` (BLG-453): one app-server per run, one thread per
 * place (its id is the place's session, so the conversation resumes), each request a turn, its
 * items streamed into onEvent/onStep the way Claude's are. Beluga's tools reach it as stdio MCP
 * servers (agent/tool-host.ts), gated per call like Claude's. Codex's own steps are confined by
 * its sandbox (see sandbox.ts); when it asks to go further, you're asked through canUseTool.
 */
export function createCodexBackend(opts: CodexBackendOptions): AgentBackend {
  let sessionId: string | undefined;
  const connect = opts.connect ?? spawnAppServer;
  const host = (): ToolHost => opts.toolHost ?? toolHost();
  // Your Codex MCP servers for Settings (BLG-518): asked of an app-server of their own, started where
  // Claude's list starts (Codex has no per-request folder for the list, so a project's own
  // .codex/config.toml servers show only for that folder: the room's, here). It gets your saved
  // variables over Beluga's, as your runs do, so a server's bearer_token_env_var or env_vars kept in
  // Settings › Environment is found (#442).
  const mcp = new CodexMcp((cwd) => connect({ cwd, env: { ...process.env, ...opts.ownEnv?.(cwd) }, ...(opts.codexPath ? { bin: opts.codexPath } : {}) }));
  const mcpCwd = (_projects: readonly string[]): string => opts.cwd;
  /** Codex's sandbox on this computer can't deny reads (#425): learned from its refusal once, then every thread opens without them. */
  let readsOpen = false;

  return {
    async run(input: AgentRunInput): Promise<string> {
      if (input.signal.aborted) throw new Error('aborted');
      const bridge = input.channel && opts.bridge.inChannel ? opts.bridge.inChannel(input.channel) : opts.bridge;
      const place = input.place;
      const cwd = place?.cwd ?? opts.cwd;
      const extraDirs = place ? place.additionalDirectories : opts.additionalDirectories;
      const askOnly = place?.askOnly;
      // A talk dialogue's turn only looks: Codex's sandbox writes nowhere (talkReadOnly gates only Beluga's tools).
      const autoEdit = !askOnly && !input.dialogue?.readOnly && (place?.autoEdit ?? opts.autoEdit);
      const fixup = place?.fixup;
      const syncMain = askOnly ? place?.syncMain : undefined;
      const policy = { cwd, roots: [cwd, ...extraDirs, ...(fixup ? [fixup] : [])], autoEdit, scope: input.scope, guest: input.guest, boardAsks: input.boardAsks, dotenv: Boolean(input.canUseSecret) && !input.guest, askOnly: Boolean(askOnly), ...(syncMain ? { syncMain: syncProbes(cwd, syncMain) } : {}), ...(fixup ? { fixup } : {}), ...(place?.alsoEdit?.length ? { alsoEdit: place.alsoEdit } : {}) };
      const remember = (id: string): void => (place ? place.onSession(id) : void (sessionId = id));
      const shelf = new ViewShelf();
      // The model and effort, settled once Codex can list its models (see settle), and again when another model is picked mid-run.
      let model: string | undefined;
      let effort: ReasoningEffort | undefined;
      /** The model the thread runs on, as Codex said when it opened it (its default when none was asked). */
      let threadModel: string | undefined;
      let models: Promise<readonly Model[]> | undefined;
      const listOf = (rpc: CodexConnection['rpc']): Promise<readonly Model[]> => (models ??= rpc.request<{ data: Model[] }>('model/list', {}, MODEL_TIMEOUT_MS).then((r) => r.data, () => []));
      const settle = async (rpc: CodexConnection['rpc'], want: string | undefined): Promise<void> => {
        model = await pickCodexModel(want, () => listOf(rpc), () => configuredModel(rpc));
        if (!input.effort) return;
        const list = await listOf(rpc);
        const its = list.find((m) => (model ? m.id === model || m.model === model : m.isDefault));
        effort = clampEffort(input.effort, its?.supportedReasoningEfforts.map((e) => e.reasoningEffort));
      };
      // The context meter, as Claude's (agent/context-report.ts): what's in the window after each response.
      let lastContext: string | undefined;
      const onTokens = (usage: ThreadTokenUsage): void => {
        const ev = contextEvent(usage, model ?? threadModel);
        if (ev && ev !== lastContext) input.onEvent('context', (lastContext = ev));
      };

      // Beluga's tools, served for this run alone and gated per call (vetTool, policy, you).
      const mounted = await host().mount(runToolSuites(input, bridge, shelf, cwd), (name, args) => gateTool(name, args, input, policy));
      let conn: CodexConnection | undefined;
      // Codex's sub-agents (BLG-519): rows and steps on the request's card, as Claude's are.
      const subAgents = new CodexSubAgents(cwd, { onSub: (e) => input.onEvent('sub', JSON.stringify(e)), ...(input.onStep ? { onStep: input.onStep } : {}), onFileTouched: input.onFileTouched });
      const events = new CodexEvents(cwd, { onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}) }, { onFileTouched: input.onFileTouched, expand: (t) => shelf.expand(t), onTokens, subAgents });
      let failed = true;
      let closed = false;
      try {
        // Turns: the one running now, and how each ended (one can end before turn/start answers).
        let active: { id?: string; readonly done: ReturnType<typeof deferred<Turn>> } | undefined;
        /** A turn Codex started by itself (not asked for by a request): the run waits for it too. */
        let selfStarted: typeof active;
        const ended = new Map<string, Turn>();
        /** Rejects when the app-server behind the run goes away on its own. */
        let stopped = deferred<never>();
        const origin = originOf(input);

        /**
         * An app-server with this run's thread on it, confined for `planning` or for work (see
         * sandbox.ts). Planning, then working, reopens the thread: a thread's sandbox is set when
         * it's opened, never by a turn, so the work isn't done under the plan's read-only one.
         */
        const open = async (planning: boolean, resume: string | undefined): Promise<string> => {
          // Your `codex` flags (Settings › Agents) on your own runs; Beluga still sets each turn's sandbox.
          const link = await connect({ cwd, env: { ...process.env, ...input.env }, ...(opts.codexPath ? { bin: opts.codexPath } : {}), ...(input.launchArgs?.codex?.length ? { args: input.launchArgs.codex } : {}) });
          conn = link;
          const { rpc } = link;
          input.onProcess?.(link.proc);
          const gone = deferred<never>();
          stopped = gone;
          rpc.onNotification((method, params) => {
            events.handle(method, params);
            // Codex's plan windows as they move (BLG-474): filed under Codex, never Claude.
            if (method === 'account/rateLimits/updated') reportLimits(bridge, params.rateLimits as CodexRateLimits);
            // A sub-agent's turns are its own (subagents.ts), never the run's.
            if (typeof params.threadId === 'string' && subAgents.lead && params.threadId !== subAgents.lead) return;
            if (method === 'turn/started' && active && !active.id) active.id = (params.turn as Turn).id;
            // A turn Codex starts by itself, between Beluga's (its sub-agents done): the request's, as Claude's are.
            else if (method === 'turn/started' && !active && !closed) {
              active = { id: (params.turn as Turn).id, done: deferred<Turn>() };
              selfStarted = active;
              events.beginTurn({ onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}) });
            }
            if (method === 'turn/completed') {
              const turn = params.turn as Turn;
              if (active?.id === turn.id) active.done.resolve(turn);
              else ended.set(turn.id, turn);
            }
          });
          void rpc.closed.then(() => {
            if (!closed && conn === link) gone.reject(codexFailure({ error: 'Codex exited before the turn ended', stderr: link.stderr() }));
          });
          // Codex asking to go past its sandbox (your own runs only): the same gate as every other tool, so you decide.
          rpc.onRequest(async (method, params) => {
            // Planning only looks: nothing past its read-only sandbox, whoever would allow it (Claude's plan mode the same).
            if (planning && (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval' || method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval')) return { decision: 'decline' };
            if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
              const command = typeof params.command === 'string' ? params.command : Array.isArray(params.command) ? params.command.join(' ') : '';
              const denied = await gateTool('Bash', { command, ...(params.reason ? { description: params.reason } : {}) }, input, policy);
              return { decision: denied ? 'decline' : 'accept' };
            }
            if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
              const changes = events.changes.get(String(params.itemId)) ?? [];
              const files = changes.length ? changes.map((c) => path.resolve(cwd, c.path)) : [typeof params.grantRoot === 'string' ? params.grantRoot : cwd];
              for (const file of files) if (await gateTool('Edit', { file_path: file }, input, policy)) return { decision: 'decline' };
              return { decision: 'accept' };
            }
            // Anything else (more permissions, questions, elicitations) isn't Beluga's to grant.
            throw new Error(`${method} isn’t supported in Beluga`);
          });
          // A friend's task gets none of your own Codex MCP servers: their names, to switch them off.
          const yourServers = trustRow(origin, input.scope).yourTools ? [] : await rpc.request<{ config?: { mcp_servers?: Record<string, unknown> } }>('config/read', {}).then((r) => Object.keys(r.config?.mcp_servers ?? {}), () => []);
          const writableRoots = planning || !autoEdit ? (fixup ? [fixup] : []) : [cwd, ...extraDirs, ...(fixup ? [fixup] : [])];
          const confined = codexConfinement(origin, input.scope, { cwd, folders: [...extraDirs, ...(fixup ? [fixup] : [])], writable: writableRoots, yourServers });
          approval = approvalFor(confined.row, { planning, ...(input.askBeforeCommands ? { askBeforeCommands: true } : {}) });
          if (!settled) {
            settled = true;
            await settle(rpc, input.model ?? place?.model ?? opts.model);
          }
          const instructions = runInstructions(input, opts.bridge.selfName(), CODEX_AGENT);
          const begin = async (c: CodexConfinement, loose: boolean): Promise<ThreadStartResponse> => {
            const params = { cwd, ...(model ? { model } : {}), developerInstructions: loose ? `${instructions}\n\n${LOOSE_NOTE}` : instructions, config: { ...c.config, ...PROJECT_DOCS, ...runFeatures(c.row.yourTools), ...mcpConfig(mounted.servers) }, approvalPolicy: approval };
            let thread: ThreadStartResponse | undefined;
            if (resume) {
              // Its sandbox refusing the profile isn't a lost conversation: that's told by opening it again below.
              thread = await rpc.request<ThreadStartResponse>('thread/resume', { threadId: resume, ...params }).catch((err: unknown) => (readsUndeniable(err) ? Promise.reject(err) : undefined));
              if (!thread) input.onEvent('progress', 'Started a new Codex conversation (the last one couldn’t be opened)');
            }
            return thread ?? rpc.request<ThreadStartResponse>('thread/start', params);
          };
          // Codex's sandbox here can't hide a file (unelevated Windows, #425): your own run opens without its read denials, anyone else's not at all.
          const loosened = (): Promise<ThreadStartResponse> => {
            const loose = withoutReadDenials(confined);
            if (!loose) throw new Error(WINDOWS_REFUSED);
            input.onEvent('progress', WINDOWS_READS);
            return begin(loose, true);
          };
          const thread = readsOpen
            ? await loosened()
            : await begin(confined, false).catch((err: unknown) => {
                if (!readsUndeniable(err)) throw err;
                readsOpen = true;
                return loosened();
              });
          subAgents.lead = thread.thread.id;
          threadModel = thread.model || threadModel;
          // Where its windows stand now, without waiting for the turn to move them.
          void readLimits(rpc).then((limits) => reportLimits(bridge, limits));
          return thread.thread.id;
        };
        let approval: AskForApproval = 'never';
        let settled = false;
        // A fork can't branch a Codex thread (canFork: false): resuming it would write into the source's
        // own conversation, so a fork starts a new one, and says so (BLG-461).
        const forked = Boolean(place?.forkSession && place.resume);
        if (forked) input.onEvent('progress', fallbackFor('codex', 'fork')!);
        let threadId = await open(Boolean(input.plan), place ? (forked ? undefined : place.resume) : sessionId);
        remember(threadId);
        if (input.signal.aborted) throw new Error('aborted');
        const rpc = () => conn!.rpc;

        // Stop: interrupt the turn (same contract as Claude), then the process for sure.
        let aborted = false;
        const abort = deferred<never>();
        const onAbort = (): void => {
          aborted = true;
          // Its sub-agents stop with it: each one's turn interrupted, so it ends saying it was stopped.
          void Promise.all([interruptTurn(), stopSubAgents()]).finally(() => {
            abort.reject(new Error('aborted'));
            void conn?.proc.kill();
          });
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
        if (input.signal.aborted) throw new Error('aborted');

        /** Ask Codex to stop the running turn; true once it has, within INTERRUPT_TIMEOUT_MS. */
        const interruptTurn = async (): Promise<boolean> => {
          const turn = active;
          if (!turn) return false;
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS)));
          const stop = (async () => {
            while (!turn.id) {
              // turn/start failed before the turn began: nothing to stop.
              if (active !== turn) return false;
              await new Promise((r) => setTimeout(r, 20));
            }
            await rpc().request('turn/interrupt', { threadId, turnId: turn.id });
            await turn.done.promise;
            return true;
          })().catch(() => false);
          return Promise.race([stop, late]).finally(() => clearTimeout(timer));
        };

        /** Ask Codex to stop every sub-agent's running turn (`turn/interrupt` on its thread), within INTERRUPT_TIMEOUT_MS. */
        const stopSubAgents = async (): Promise<void> => {
          const turns = subAgents.running();
          if (!turns.length || !conn) return;
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, INTERRUPT_TIMEOUT_MS)));
          const asked = Promise.allSettled(turns.map((t) => rpc().request('turn/interrupt', { threadId: t.threadId, turnId: t.turnId })));
          // Then until they say they've stopped (their turns end), or the time's up.
          const settled = (async () => {
            await asked;
            while (subAgents.running().length) await subAgents.changed();
          })();
          await Promise.race([settled, late]).finally(() => clearTimeout(timer));
        };

        /** One turn: its answer's text, how it ended. */
        const runTurn = async (sink: TurnSink, text: string, prompt: string, skill?: MappedPrompt['skill']): Promise<{ text: string; turn: Turn }> => {
          events.beginTurn(sink);
          const done = deferred<Turn>();
          const turnNow: NonNullable<typeof active> = { done };
          active = turnNow;
          try {
            // No sandboxPolicy here: a turn's would replace the thread's profile (and its .env denials).
            const res = await rpc().request<{ turn: Turn }>('turn/start', { threadId, input: codexInput(text, prompt, skill), approvalPolicy: approval, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
            turnNow.id ??= res.turn.id;
            const early = ended.get(res.turn.id);
            if (early) done.resolve(early);
            const turn = await Promise.race([done.promise, stopped.promise, abort.promise]);
            const said = events.endTurn(turn.status === 'completed');
            if (said.usage) sink.onEvent('usage', usageEvent(said.usage, threadId));
            return { text: said.text, turn };
          } finally {
            active = undefined;
          }
        };

        // Messages for the run: steered in while a turn works, or a turn of their own after it.
        const pending: FollowUp[] = [];
        /** Steers Codex hasn't answered yet: one it turns down still gets a turn of its own. */
        const inflight = new Set<Promise<unknown>>();
        let interrupting: string | undefined;
        /**
         * Another model picked for the conversation since the run started (the chat's picker): the
         * next turn runs on it (Codex keeps a turn's model for the turns after), effort clamped to it.
         */
        let wanted = input.model ?? place?.model ?? opts.model;
        const switchTo = async (pick: string | undefined): Promise<void> => {
          if (pick === undefined || pick === (wanted ?? '')) return;
          wanted = pick;
          await settle(rpc(), pick);
        };
        const steerIn = (followUp: FollowUp): boolean => {
          const turn = active;
          if (closed || !turn?.id) return false;
          // Steered into a turn already running: its model holds; the switch is for the next turn.
          void switchTo(followUp.model).catch(() => undefined);
          const sent = rpc()
            .request('turn/steer', { threadId, input: codexInput(buildPrompt(followUp), followUp.prompt), expectedTurnId: turn.id })
            .then(
              () => followUp.onFolded?.(),
              // The turn ended first: the message gets a turn of its own.
              () => (closed ? followUp.onError('Codex finished before getting to this message') : void pending.push(followUp)),
            )
            .finally(() => inflight.delete(sent));
          inflight.add(sent);
          return true;
        };
        const status = (): LiveStatus => {
          const tool = [...events.tools.values()].sort((a, b) => a.since - b.since)[0];
          return { ...(tool ? { tool } : {}), lastEventAt: events.lastEventAt, between: !active, ...(events.thinking ? { thinking: true } : {}), alive: conn?.proc.alive() ?? false };
        };
        const interrupt = async (followUp: FollowUp, note: string): Promise<boolean> => {
          if (closed || !active || interrupting !== undefined) return false;
          interrupting = note;
          pending.unshift(followUp);
          const ok = await interruptTurn();
          if (!ok) {
            const at = pending.indexOf(followUp);
            if (at !== -1) pending.splice(at, 1);
            interrupting = undefined;
          }
          return ok;
        };
        input.onSteer?.(Object.assign(steerIn, { status, interrupt }) satisfies Steer);

        const original: TurnSink = { onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}) };
        /** A turn's end as its answer: an interrupted one ends with the note it was stopped with. */
        const answerOf = (r: { text: string; turn: Turn }, sink: TurnSink): string => {
          if (r.turn.status === 'interrupted' && interrupting !== undefined) {
            const note = interrupting;
            interrupting = undefined;
            sink.onEvent('text', note);
            return r.text ? `${shelf.finish(r.text)}\n\n${note}` : note;
          }
          if (r.turn.status === 'failed') throw codexFailure({ result: `${r.turn.error?.message ?? 'Codex stopped'}${r.turn.error?.codexErrorInfo === 'unauthorized' ? SIGN_IN : ''}`, ...(r.turn.error?.additionalDetails ? { error: r.turn.error.additionalDetails } : {}), ...(typeof r.turn.error?.codexErrorInfo === 'string' ? { errorInfo: r.turn.error.codexErrorInfo } : {}), stderr: conn?.stderr() ?? [] });
          if (r.turn.status === 'interrupted') throw new Error('aborted');
          return shelf.finish(r.text);
        };

        /** What didn't map to Codex, said in the chat now and kept at the top of the answer. */
        const noted = (m: MappedPrompt, sink: TurnSink): ((answer: string) => string) => {
          for (const note of m.notes) sink.onEvent('text', note);
          return (answer) => (m.notes.length ? `${m.notes.join('\n')}\n\n${answer}` : answer);
        };
        const answers: string[] = [];
        // Plan mode, the Codex way: a read-only turn that answers with a plan, for you to approve.
        // `/name`: one of Claude Code's skills or commands, mapped to Codex (what doesn't map is said, see skills.ts).
        const mapped = await mapSlash(input.prompt, cwd, claudeHome());
        const said = noted(mapped, original);
        const asked = buildPrompt({ ...input, prompt: mapped.prompt });
        let r = await runTurn(original, input.plan ? `${asked}\n\n${PLAN_NOTE}` : asked, input.prompt, mapped.skill);
        let answer = said(answerOf(r, original));
        let askedToDefine = false;
        for (let round = 0; input.plan && input.askUser && round < PLAN_ROUNDS && r.turn.status === 'completed'; round++) {
          // The plan is for a task: Codex defines it (in its own words) before the plan comes to you. Asked once, as Claude is.
          if (input.planTask?.needsDefinition() && !askedToDefine) {
            askedToDefine = true;
            r = await runTurn(original, DEFINE_NOTE, '');
            answer = said(answerOf(r, original));
            if (r.turn.status !== 'completed') break;
          }
          const verdict = await input.askUser({ kind: 'plan', plan: (r.text || '(Codex proposed a plan)').slice(0, 60_000) });
          if (verdict.kind !== 'plan') break;
          if (verdict.approve) input.planTask?.approved();
          // Kept planning without a word: Codex asks what to change (and the run ends on its question), as Claude does.
          const next = verdict.approve ? 'The plan is approved. Do the work now.' : verdict.feedback ? `Change the plan: ${verdict.feedback}\n\n${PLAN_NOTE}` : NOT_YET_NOTE;
          // Approved: the thread is reopened confined for work.
          if (verdict.approve) {
            const planned = conn;
            threadId = await open(false, threadId);
            // A resume that failed started a new thread: the place's conversation is that one now.
            remember(threadId);
            await planned?.proc.kill();
          }
          r = await runTurn(original, next, '');
          answer = said(answerOf(r, original));
          if (verdict.approve || next === NOT_YET_NOTE) break;
        }
        answers.push(answer);
        input.onAnswered?.(answer);

        // Then each message that waits for a turn of its own. While Codex's sub-agents still work
        // (spawned, not waited for), the run stays open for them, taking messages as turns of their
        // own, as Claude's background agents keep theirs (BACKGROUND_LIMIT_MS); past it they're stopped.
        let wake: (() => void) | undefined;
        let until: number | undefined;
        const send = (followUp: FollowUp): boolean => {
          if (closed || aborted) return false;
          pending.push(followUp);
          wake?.();
          return true;
        };
        while (!aborted) {
          const followUp = pending.shift();
          if (!followUp) {
            if (inflight.size) {
              await Promise.allSettled([...inflight]);
              continue;
            }
            // A turn Codex started by itself (its sub-agents came back): its words are the request's.
            const own = selfStarted;
            if (own) {
              const turn = await Promise.race([own.done.promise, stopped.promise, abort.promise]);
              const said = events.endTurn(turn.status === 'completed');
              if (said.usage) original.onEvent('usage', usageEvent(said.usage, threadId));
              if (active === own) active = undefined;
              selfStarted = undefined;
              if (turn.status === 'completed' && said.text) answers.push(shelf.finish(said.text));
              continue;
            }
            if (!subAgents.busy) break;
            if (until === undefined) {
              until = Date.now() + BACKGROUND_LIMIT_MS;
              input.onFollowUps?.(send);
            }
            const left = until - Date.now();
            if (left <= 0) {
              await stopSubAgents();
              break;
            }
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([subAgents.changed(), new Promise<void>((resolve) => ((wake = resolve), (timer = setTimeout(resolve, left)))), stopped.promise, abort.promise]).finally(() => {
              clearTimeout(timer);
              wake = undefined;
            });
            continue;
          }
          const sink: TurnSink = { onEvent: followUp.onEvent, ...(followUp.onStep ? { onStep: followUp.onStep } : {}) };
          followUp.onStart?.();
          try {
            await switchTo(followUp.model);
            const its = await mapSlash(followUp.prompt, cwd, claudeHome());
            const note = noted(its, sink);
            followUp.onDone(note(answerOf(await runTurn(sink, buildPrompt({ ...followUp, prompt: its.prompt }), followUp.prompt, its.skill), sink)));
          } catch (err) {
            if (aborted) throw err;
            followUp.onError(err instanceof Error ? err.message : String(err));
          }
        }
        if (until !== undefined) input.onFollowUps?.(undefined);
        // Stopped while its sub-agents worked: stopped, as a turn stopped is.
        if (aborted) throw new Error('aborted');
        for (const left of pending.splice(0)) left.onError('Codex finished before getting to this message');
        input.signal.removeEventListener('abort', onAbort);
        failed = false;
        return answers.join('\n\n');
      } finally {
        closed = true;
        input.onSteer?.(undefined);
        events.finish(failed || input.signal.aborted);
        // Sub-agents still working end with the run (its app-server goes with it).
        subAgents.finish(failed || input.signal.aborted);
        mounted.close();
        await conn?.proc.kill();
      }
    },

    // Side calls (naming, drafting, chat answers…) through Codex's one-shot call.
    ...sideCalls((req) => codexComplete(req, { connect, ...(opts.codexPath ? { bin: opts.codexPath } : {}) }), opts.cwd, opts.model),

    // Codex's plan windows without a run (the usage tab): reported for Codex, so nothing is filed as Claude's.
    async refreshUsage() {
      if (!opts.connect && !opts.codexPath && !findCodex()) return undefined;
      const conn = await connect({ cwd: opts.cwd, ...(opts.codexPath ? { bin: opts.codexPath } : {}) }).catch(() => undefined);
      if (!conn) return undefined;
      try {
        reportLimits(opts.bridge, await readLimits(conn.rpc));
      } finally {
        await conn.proc.kill();
      }
      return undefined;
    },

    // Your Codex MCP servers (codex/mcp.ts): what your own Codex runs get from ~/.codex/config.toml.
    mcpServers: (projects) => mcp.list(mcpCwd(projects)),
    mcpSignIn: (projects, name) => mcp.signIn(mcpCwd(projects), name),
    mcpSignedIn: (name) => mcp.signedIn(name),
    mcpSetEnabled: (projects, name, enabled) => mcp.setEnabled(mcpCwd(projects), name, enabled),

    async listModels() {
      const conn = await connect({ cwd: opts.cwd, ...(opts.codexPath ? { bin: opts.codexPath } : {}) }).catch(() => undefined);
      if (!conn) return undefined;
      try {
        const res = await conn.rpc.request<{ data: Model[] }>('model/list', {}, MODEL_TIMEOUT_MS);
        return toCodexModelChoices(res.data);
      } catch {
        return undefined;
      } finally {
        await conn.proc.kill();
      }
    },
  };
}

/** Codex's windows now (`account/rateLimits/read`); undefined when it can't say (signed out, an API key). */
async function readLimits(rpc: CodexConnection['rpc']): Promise<CodexRateLimits | undefined> {
  const res = await rpc.request<{ rateLimits?: CodexRateLimits | null }>('account/rateLimits/read', {}, MODEL_TIMEOUT_MS).catch(() => undefined);
  return res?.rateLimits ?? undefined;
}

/** Codex's windows into its own usage card (the bridge files them under Codex). */
function reportLimits(bridge: RoomBridge, limits: CodexRateLimits | undefined): void {
  const update = fromRateLimits(limits);
  if (update) bridge.reportUsage({ ...update, signedIn: true }, CODEX_USAGE_AGENT);
}

/** A project's instructions: Codex reads AGENTS.md itself, and CLAUDE.md where a project has only that. */
const PROJECT_DOCS = { project_doc_fallback_filenames: ['CLAUDE.md'] };

/** Your own run on a Codex sandbox that can't deny reads (#425): what it can read now, and how to hide it again. */
const WINDOWS_READS =
  'Codex’s Windows sandbox on this account can’t hide files, so this run can read your .env files and credential stores (its writes still stay in its folders). To hide them again, use Codex’s elevated sandbox (windows.sandbox = "elevated" in ~/.codex/config.toml, set up once as an administrator) or MXC where Windows supports it.';
const LOOSE_NOTE = "Your sandbox here can't hide .env files, keys or credential stores: don't read them unless the person asks you to.";
/** Anyone else's run there: refused, as its denials are what keeps it out of your secrets. */
const WINDOWS_REFUSED =
  'Codex’s Windows sandbox on this account can’t keep this task away from your home, .env files and credential stores, so Beluga won’t run it on Codex. Use Codex’s elevated sandbox (windows.sandbox = "elevated" in ~/.codex/config.toml, set up once as an administrator) or MXC where Windows supports it, or run it on Claude.';

/** A failed Codex run, told as Codex's (not Claude Code's). */
const codexFailure = (end: RunEnd): RunFailedError => new RunFailedError({ ...classifyRun(end), runtime: 'codex' });
const SIGN_IN = ' Sign in to Codex again (`codex login`), then resend.';

const PLAN_NOTE = 'Plan only: look around read-only, change nothing, and answer with a step-by-step plan for the person to approve.';
const DEFINE_NOTE =
  'Before the plan goes to the person for approval, call mcp__beluga_board__task_define with the task this plan is for (title, goal in your own words, context, acceptance criteria, decisions, open questions, estimate, priority). Then answer with the plan again, in full.';
const NOT_YET_NOTE = 'The person did not approve the plan yet. Ask them what they would like to change, and change nothing.';
