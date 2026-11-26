import { claudeHome } from '../../../core/claude-code/launch.js';
import { isYourRun } from '../../policy.js';
import { buildPrompt } from '../../prompt.js';
import { runInstructions } from '../../run-instructions.js';
import { runToolSuites } from '../../run-tools.js';
import { sideCalls } from '../../side-calls.js';
import { syncProbes } from '../../sync-main.js';
import { gateTool } from '../../tool-gate.js';
import { ToolHost } from '../../tool-host.js';
import type { AgentBackend, AgentRunInput, FollowUp, LiveStatus, RoomBridge, Steer } from '../../types.js';
import type { UsageUpdate } from '../../usage.js';
import { ViewShelf } from '../../view-tools.js';
import { INTERRUPT_TIMEOUT_MS } from '../types.js';
import { type ConfigOption, type ContentBlock, type PermissionRequest, type PromptResponse, type SessionResponse, type SessionUpdate, permissionAnswer } from '../opencode/acp.js';
import { OpenCodeEvents as AcpEvents, type TurnSink, contextEvent, usageEvent } from '../opencode/events.js';
import { promptBlocks } from '../opencode/runner.js';
import { mapOpenCodeSlash as mapSlash } from '../opencode/skills.js';
import type { ClaudeQuestion } from '../../../protocol.js';
import { acpComplete } from './complete.js';
import { addDirArgs, findAcpCommand, spawnAcp } from './connection.js';
import type { AcpExtension } from './extension.js';
import { GENERIC_TOOLS, mcpServersFor } from './dialect.js';
import { type AcpSession, acpEnd, acpFailure, acpMode, acpModel, declinedNote, modeValue, settled, withInstructions } from './parts.js';
import type { AcpAgentSpec, AcpConnect, AcpConnection } from './spec.js';
import { acpStatus } from './status.js';

export interface AcpBackendOptions {
  readonly cwd: string;
  readonly autoEdit: boolean;
  readonly additionalDirectories: readonly string[];
  readonly bridge: RoomBridge;
  readonly model?: string;
  /** The agent's executable; unset: findAcpCommand(). */
  readonly bin?: string;
  /** How to reach the agent (tests: a scripted one). */
  readonly connect?: AcpConnect;
  /** Where Beluga's tools are served to the run over HTTP (one per daemon). */
  readonly toolHost?: ToolHost;
  /** Reads your quota now (tests: a fake; none with a scripted `connect`, where it's the extension's). */
  readonly readQuota?: () => Promise<UsageUpdate | undefined>;
}

/** A plan sent back for changes this many times: the run ends with the last plan as its answer. */
const PLAN_ROUNDS = 5;
/** Questions the agent asks (its question tool) in one message, one after another: past this many, its answer ends the message. */
const QUESTION_ROUNDS = 5;
/** Beluga's tools whose target is a path: one the agent didn't name is turned down, never judged as the folder. */
const PATHED = new Set(['Read', 'Write', 'Edit']);
const WRITES = new Set(['Write', 'Edit']);

let sharedHost: ToolHost | undefined;
/** Each agent's folder tidied once a daemon (its extension's tidy), by its id. */
const tidied = new Map<string, Promise<unknown>>();
const toolHost = (): ToolHost => (sharedHost ??= new ToolHost());

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

/**
 * Runs turns on an ACP agent: one process per run, one conversation per place (its id is the
 * place's session, so it goes on with session/load), the model, thinking level and mode set as the
 * session's options, Beluga's instructions in what its extension says (`_meta`), each request a
 * prompt, its updates streamed into onEvent/onStep the way Claude's are (opencode/events.ts with
 * its extension's tool names). Every step it asks about is judged by the same gate as Claude's;
 * what it runs without asking is why it gets no friends' tasks or guests. Beluga's tools reach it
 * over HTTP, gated per call there.
 */
export function createAcpBackend(spec: AcpAgentSpec, ext: AcpExtension, opts: AcpBackendOptions): AgentBackend {
  let sessionId: string | undefined;
  const connect = opts.connect ?? spawnAcp(spec, ext);
  const host = (): ToolHost => opts.toolHost ?? toolHost();
  const bin = (): string | undefined => opts.bin ?? (opts.connect ? undefined : findAcpCommand(spec));
  const side = { ...(opts.connect ? { connect: opts.connect, drop: async () => undefined } : {}), ...(opts.bin ? { bin: opts.bin } : {}) };
  const agent = { runtime: spec.id, label: spec.label } as const;
  /** What each session's turns cost so far, as its agent said (ACP's cost is the session's running total). */
  const spentBy = new Map<string, number>();
  const modelOf = (m: string | undefined): string | undefined => (ext.model ? ext.model(m) : acpModel(m));
  const fail = (end: Parameters<typeof acpFailure>[0]): Error => (ext.failure ? ext.failure(end) : acpFailure(end, spec.id));
  const noteFor = (why: readonly string[]): string => (ext.declinedNote ? ext.declinedNote(why) : declinedNote(why));

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
      const policy = { cwd, roots: [cwd, ...extraDirs, ...(fixup ? [fixup] : [])], autoEdit, scope: input.scope, guest: input.guest, boardAsks: input.boardAsks, dotenv: Boolean(input.canUseSecret) && !input.guest, yourRun: isYourRun(input), askOnly: Boolean(askOnly), ...(syncMain ? { syncMain: syncProbes(cwd, syncMain) } : {}), ...(fixup ? { fixup } : {}), ...(place?.alsoEdit?.length ? { alsoEdit: place.alsoEdit } : {}) };
      const remember = (id: string): void => (place ? place.onSession(id) : void (sessionId = id));
      const shelf = new ViewShelf();

      // Beluga's tools, served for this run alone and gated per call (vetTool, policy, you).
      const mounted = await host().mount(runToolSuites(input, bridge, shelf, cwd), (name, args) => gateTool(name, args, input, policy));
      const suites = Object.keys(mounted.http);
      const tools = ext.tools ?? GENERIC_TOOLS;
      const dialect = tools.dialect(mounted.tools);
      const env = { ...process.env, ...input.env };
      const told = runInstructions(input, opts.bridge.selfName(), agent);
      /** Beluga's instructions as the agent's own system prompt, when its extension has a way (else ahead of a new conversation's first message). */
      const meta = ext.instructions?.(told);

      let planning = Boolean(input.plan);
      let wanted = modelOf(input.model ?? place?.model ?? opts.model);
      /** The model the session is on (its own default until it says). */
      let model = wanted ?? '';
      let lastContext: string | undefined;
      /** A /compact turn is running: its summary and meter stay out of the chat. */
      let compacting = false;
      /** The question this turn asked with the agent's own question tool (its form doesn't reach a client: Beluga asks it). */
      let asking: ClaudeQuestion | undefined;
      /** The agent's own commands here (its built-ins and the skills it loaded). */
      let commands = new Set<string>();
      const events = new AcpEvents(cwd, { onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}) }, {
        onFileTouched: input.onFileTouched,
        expand: (t) => shelf.expand(t),
        suites,
        onContext: (used, size) => {
          const ev = contextEvent(used, size, model || undefined);
          if (ev && ev !== lastContext && !compacting) input.onEvent('context', (lastContext = ev));
        },
        // A /compact's summary, and the question its own ask_question left in its answer when Beluga asks it as a card instead.
        quiet: () => compacting || Boolean(asking && input.askUser),
        dialect,
      });
      let conn: AcpConnection | undefined;
      let failed = true;
      let closed = false;
      try {
        conn = await connect({ cwd, env, args: addDirArgs(spec, [...extraDirs, ...(fixup ? [fixup] : [])]), ...(opts.bin ? { bin: opts.bin } : {}) });
        const link = conn;
        input.onProcess?.(link.proc);
        const { rpc } = link;
        const stopped = deferred<never>();
        void rpc.closed.then(() => {
          if (!closed) stopped.reject(fail({ error: link.cause?.() ?? `${spec.label} exited before the turn ended`, stderr: link.stderr() }));
        });
        /** A failed request's end: once the agent is gone, why it went (its line knows: stuck, signed out, how it exited) over "stopped". */
        const endOf = (err: unknown): ReturnType<typeof acpEnd> => {
          const why = rpc.isClosed ? link.cause?.() : undefined;
          return acpEnd(why ? new Error(why) : err, link.stderr());
        };
        /** Where the turn running now says things (its notes: it went quiet). */
        let saying: TurnSink = { onEvent: input.onEvent };
        link.onNotice?.((note) => saying.onEvent('progress', note));

        // Updates count from the session's own id on: a loaded session's replay (its history) comes before.
        let sid = '';
        /**
         * A loaded session's history may still be coming in after session/load answered (its last
         * frames behind the answer): until the first turn is sent, what it says of the conversation is
         * history, not this run's work. Its state (commands, options, mode) counts. A step seen there
         * stays history when it's spoken of later, until a step is announced anew under its id.
         */
        let replaying = false;
        const replayed = new Set<string>();
        let options: readonly ConfigOption[] = [];
        /** What the session says of its models and modes in ACP's older shape (models / modes), for an agent without those options. */
        let legacy: Pick<AcpSession, 'models' | 'modes'> = {};
        /** A conversation opened new for this run (not one it goes on with): its first message carries Beluga's instructions when they have no `_meta`. */
        let fresh = false;
        /** Holds the session on Beluga's mode (set once the session is open). */
        let holdMode: (() => Promise<unknown>) | undefined;
        /** Why Beluga turned this turn's steps down. */
        const declined: string[] = [];
        /** When the agent last said anything of a session (its history too). */
        let lastUpdate = 0;
        rpc.onNotification((method, params) => {
          if (method === 'session/update') lastUpdate = Date.now();
          if (method !== 'session/update' || !sid || params.sessionId !== sid) return;
          const update = params.update as SessionUpdate;
          const call = 'toolCallId' in update && typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
          if (replaying && HISTORY.has(update.sessionUpdate)) return void (call && replayed.add(call));
          // A step announced anew is this run's, even under a history's id (an agent that counts its ids per process).
          if (call && update.sessionUpdate === 'tool_call') replayed.delete(call);
          if (call && replayed.has(call)) return;
          const q = ext.questions;
          if (q && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && dialect.toolOf(update) === q.tool) asking = q.detect(update.rawInput) ?? asking;
          if (update.sessionUpdate === 'available_commands_update') commands = new Set(update.availableCommands.map((c) => c.name));
          if (update.sessionUpdate === 'config_option_update') options = update.configOptions;
          if (update.sessionUpdate === 'current_mode_update') {
            options = options.map((o) => (o.id === 'mode' ? { ...o, currentValue: update.currentModeId } : o));
            if (legacy.modes) legacy = { ...legacy, modes: { ...legacy.modes, currentModeId: update.currentModeId } };
          }
          if (update.sessionUpdate === 'config_option_update' || update.sessionUpdate === 'current_mode_update') void holdMode?.().catch(() => undefined);
          events.handle(update);
        });
        rpc.onRequest(async (method, params) => {
          if (method !== 'session/request_permission') throw new Error(`${method} isn’t supported in Beluga`);
          const req = params as unknown as PermissionRequest;
          const why = await judge(req);
          if (why) {
            events.denied.set(req.toolCall.toolCallId, why);
            declined.push(why);
          }
          return permissionAnswer(req, !why);
        });
        /** The agent's own notes for this conversation (its plan, its task list), as its extension knows them: never yours, never judged. */
        const ownNote = (file: unknown): boolean => typeof file === 'string' && Boolean(file) && Boolean(sid) && Boolean(ext.ownNote?.(sid, file));
        /** Why a step the agent asks about may not run (undefined: it may). */
        const judge = async (req: PermissionRequest): Promise<string | undefined> => {
          const call = await events.callOf(req.toolCall);
          if (!call) return `${spec.label} didn’t say which tool this is.`;
          // Beluga's own tools are judged where they run (the tool host's gate), not twice.
          if (tools.belugaToolOf(call.tool, suites, mounted.tools)) return undefined;
          // Its own notes aren't judged; anything else a step touches is (a note moved out of its folder, where it lands).
          const calls = dialect.callsOf(call.tool, call.raw, cwd, suites).filter((c) => !(WRITES.has(c.name) && ownNote(c.input.file_path)));
          if ((planning || readOnly) && calls.some((c) => WRITES.has(c.name))) return planning ? 'Planning only looks: nothing changes until you approve the plan.' : 'This conversation only looks: nothing may change here.';
          for (const c of calls) {
            if (PATHED.has(c.name) && !c.input.file_path) return `${spec.label} didn’t say which file, so Beluga turned it down.`;
            const denied = await gateTool(c.name, c.input, input, policy);
            if (denied) return denied;
          }
          return undefined;
        };

        const servers = mcpServersFor(mounted, link.init, ext.mount);
        const withMeta = meta ? { _meta: meta } : {};
        const resume = place ? place.resume : sessionId;
        let opened: AcpSession | undefined;
        // An agent goes on with a conversation only when it says it can (session/load).
        if (resume && !place?.forkSession && link.init.agentCapabilities?.loadSession) {
          opened = await rpc.request<AcpSession>('session/load', { sessionId: resume, cwd, mcpServers: servers, ...withMeta }).catch(() => undefined);
          if (opened) {
            opened = { ...opened, sessionId: resume };
            replaying = true;
            // What it still sends of its history comes in before the first turn goes: once it's quiet a moment (never long).
            await settled(() => lastUpdate);
          }
          else input.onEvent('progress', `Started a new ${spec.label} conversation (the last one couldn’t be opened)`);
        }
        try {
          if (!opened) {
            opened = await rpc.request<AcpSession>('session/new', { cwd, mcpServers: servers, ...withMeta });
            fresh = true;
          }
        } catch (err) {
          throw fail(endOf(err));
        }
        sid = opened.sessionId!;
        options = opened.configOptions ?? [];
        legacy = { ...(opened.models ? { models: opened.models } : {}), ...(opened.modes ? { modes: opened.modes } : {}) };
        remember(sid);
        if (input.signal.aborted) throw new Error('aborted');

        /** Set one of the session's options (model, thinking level, mode) when it offers that value and isn't on it already. */
        const choose = async (id: string, value: string | undefined): Promise<boolean> => {
          const option = options.find((o) => o.id === id);
          if (!value || !option || option.currentValue === value || !option.options.some((o) => o.value === value)) return false;
          const res = await rpc.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', { sessionId: sid, configId: id, value });
          options = res.configOptions ?? options;
          return true;
        };
        /** A model through ACP's older session/set_model, when the session lists its models that way. */
        const chooseLegacyModel = async (pick: string | undefined): Promise<boolean> => {
          const m = legacy.models;
          if (!pick || !m?.availableModels?.some((a) => a.modelId === pick) || m.currentModelId === pick) return false;
          const ok = await rpc.request('session/set_model', { sessionId: sid, modelId: pick }).then(() => true, () => false);
          if (ok) legacy = { ...legacy, models: { ...m, currentModelId: pick } };
          return ok;
        };
        const chooseModel = async (pick: string | undefined): Promise<boolean> => (await choose('model', pick)) || (await chooseLegacyModel(pick));
        const current = (): string => options.find((o) => o.id === 'model')?.currentValue ?? legacy.models?.currentModelId ?? '';
        /** A model picked for a later message: the session's own option when it offers it; else it stays on the one it has. */
        const switchModel = async (pick: string | undefined, sink: TurnSink): Promise<void> => {
          wanted = pick;
          if (!pick || pick === current()) return;
          if (await chooseModel(pick)) model = current() || pick;
          else sink.onEvent('progress', `${spec.label} has no ${pick} on your plan: it stays on ${current() || 'its own model'}`);
        };
        if (wanted && !(await chooseModel(wanted)) && wanted !== current()) input.onEvent('progress', `${spec.label} has no ${wanted} on your plan: it runs on ${current() || 'its own model'}`);
        model = current() || model;
        const level = ext.effort?.(input.effort ?? place?.effort);
        if (level) await choose(level.id, level.value);
        /**
         * The session's mode is Beluga's, as Codex's approval policy is (set on each of its turns): Plan
         * while it plans, else its default, which asks before each command and write. Its other modes
         * (accept-edits, auto) don't ask, so Beluga would judge nothing: whatever moved it to one (a
         * /command, the agent itself), it's put back, before each turn and when it says its mode changed.
         */
        holdMode = async () => {
          const name = planning ? 'plan' : 'default';
          const exact = modeValue(options, name);
          if (exact) return choose('mode', exact);
          // An agent that names its modes otherwise, in either shape (acpMode): never one that doesn't ask.
          const mode = acpMode({ configOptions: options, ...legacy }, name);
          if (!mode) return false;
          if (mode.via === 'config') return choose('mode', mode.value);
          if (legacy.modes?.currentModeId === mode.value) return false;
          const ok = await rpc.request('session/set_mode', { sessionId: sid, modeId: mode.value }).then(() => true, () => false);
          if (ok && legacy.modes) legacy = { ...legacy, modes: { ...legacy.modes, currentModeId: mode.value } };
          return ok;
        };
        await holdMode();

        // Stop: cancel the turn (same contract as Claude), then the process for sure.
        let aborted = false;
        const abort = deferred<never>();
        let active: { readonly done: ReturnType<typeof deferred<PromptResponse>> } | undefined;
        const cancelTurn = async (): Promise<boolean> => {
          const turn = active;
          if (!turn) return false;
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

        /** One turn: what it said last, and how it ended. An agent may end a turn silently when a step is declined: then it's told why, once, and answers. */
        const runTurn = async (sink: TurnSink, blocks: ContentBlock[], again = true): Promise<{ text: string; res: PromptResponse }> => {
          declined.length = 0;
          asking = undefined;
          await holdMode();
          events.beginTurn(sink);
          saying = sink;
          const done = deferred<PromptResponse>();
          active = { done };
          try {
            replaying = false;
            rpc.request<PromptResponse>('session/prompt', { sessionId: sid, prompt: blocks }).then(done.resolve, (err: unknown) => done.reject(fail(endOf(err))));
            const res = await Promise.race([done.promise, stopped.promise, abort.promise]);
            const text = events.endTurn(res.stopReason !== 'cancelled');
            // This turn's cost: the session's running total less what its earlier turns came to.
            const total = events.cost;
            const spent = Math.max(0, total - (spentBy.get(sid) ?? 0));
            if (total > 0) spentBy.set(sid, total);
            const used = usageEvent(res.usage, sid, spent);
            if (used) sink.onEvent('usage', used);
            if (again && !text && res.stopReason === 'end_turn' && declined.length) {
              active = undefined;
              return runTurn(sink, [{ type: 'text', text: noteFor(declined) }], false);
            }
            return { text, res };
          } catch (err) {
            events.endTurn(false);
            throw err;
          } finally {
            active = undefined;
          }
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
        // An ACP agent takes one prompt at a time: a message can't go into a running turn (Beluga queues it), only stop it.
        const steer = Object.assign((_f: FollowUp) => false, { status, interrupt }) satisfies Steer;
        input.onSteer?.(steer);

        /** The last turn was stopped for a message (Steer Now): what it left is no plan to approve. */
        let cut = false;
        /** A turn's end as its answer: an interrupted one ends with the note it was stopped with. */
        const answerOf = (r: { text: string; res: PromptResponse }, sink: TurnSink): string => {
          cut = r.res.stopReason === 'cancelled' && interrupting !== undefined;
          if (r.res.stopReason === 'cancelled') {
            if (interrupting === undefined) throw new Error('aborted');
            const note = interrupting;
            interrupting = undefined;
            sink.onEvent('text', note);
            return r.text ? `${shelf.finish(r.text)}\n\n${note}` : note;
          }
          if (r.res.stopReason === 'refusal' && !r.text) return `${spec.label}’s model declined to answer this.`;
          return shelf.finish(r.text);
        };
        /** What didn't carry over to the agent, said in the chat now and kept at the top of the answer. */
        const noted = (notes: readonly string[], sink: TurnSink): ((answer: string) => string) => {
          for (const note of notes) sink.onEvent('text', note);
          return (answer) => (notes.length ? `${notes.join('\n')}\n\n${answer}` : answer);
        };
        /** /compact: the agent's own, its summary kept out of the chat, and how full the window is before and after. */
        const compact = async (sink: TurnSink): Promise<string> => {
          const pre = events.context.used;
          events.context = { used: 0, size: events.context.size };
          compacting = true;
          try {
            await runTurn(sink, [{ type: 'text', text: '/compact' }]);
          } finally {
            compacting = false;
          }
          sink.onEvent('compact', JSON.stringify({ pre, post: events.context.used, trigger: 'manual', ...(events.context.size ? { window: events.context.size } : {}) }));
          return '';
        };
        /** A message as a turn: a /command mapped (opencode/skills.ts), pictures with it. */
        const turnFor = async (sink: TurnSink, prompt: string, built: (p: string) => string): Promise<string> => {
          if (ext.compact && /^\/compact(\s|$)/.test(prompt.trim())) return compact(sink);
          const mapped = await mapSlash(prompt, cwd, claudeHome(), commands, spec.label);
          const said = noted(mapped.notes, sink);
          const asked = mapped.prompt.startsWith('/') ? mapped.prompt : built(mapped.prompt);
          // A new conversation on an agent without a system prompt of its own to add to: Beluga's instructions come first, once.
          const text = fresh && !meta && !asked.startsWith('/') ? withInstructions(told, asked) : asked;
          fresh = false;
          return said(await answered(sink, answerOf(await runTurn(sink, promptBlocks(text, prompt, Boolean(link.init.agentCapabilities?.promptCapabilities?.image))), sink)));
        };
        /**
         * A turn that ended on the agent's own question tool: Beluga asks you (the card, and the phone),
         * and your answer is its next turn; again while it asks. Its answer then (the question written
         * out) stayed out of the chat. Nobody to ask: its answer as it was. A turn stopped for a message
         * (Steer Now): its question is dropped, the message's own turn goes on.
         */
        const answered = async (sink: TurnSink, answer: string): Promise<string> => {
          for (let round = 0; asking && ext.questions && input.askUser && !aborted && !cut && round < QUESTION_ROUNDS; round++) {
            const asked = asking;
            const reply = await input.askUser(asked);
            if (aborted) break;
            answer = answerOf(await runTurn(sink, [{ type: 'text', text: ext.questions.answer(asked, reply) }]), sink);
          }
          return answer;
        };

        const original: TurnSink = { onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}) };
        const answers: string[] = [];
        /** While it plans, a message is asked for a plan (its own Plan mode). */
        const built = (from: Parameters<typeof buildPrompt>[0]) => (p: string): string => (planning ? `${buildPrompt({ ...from, prompt: p })}\n\n${PLAN_NOTE}` : buildPrompt({ ...from, prompt: p }));
        let askedToDefine = false;
        /**
         * A planning turn's answer is its plan: it comes to you, and once you approve it the session
         * goes back to its default mode and does the work. A turn stopped for a message left no plan:
         * that message's own turn brings the next one.
         */
        const approved = async (plan: string, sink: TurnSink): Promise<string> => {
          let answer = plan;
          for (let round = 0; planning && input.askUser && !cut && round < PLAN_ROUNDS; round++) {
            if (input.planTask?.needsDefinition() && !askedToDefine) {
              askedToDefine = true;
              answer = await answered(sink, answerOf(await runTurn(sink, [{ type: 'text', text: DEFINE_NOTE }]), sink));
              if (cut) break;
            }
            const verdict = await input.askUser({ kind: 'plan', plan: (answer || `(${spec.label} proposed a plan)`).slice(0, 60_000) });
            if (verdict.kind !== 'plan') break;
            if (verdict.approve) {
              input.planTask?.approved();
              planning = false;
              await holdMode();
            }
            const next = verdict.approve ? 'The plan is approved. Do the work now.' : verdict.feedback ? `Change the plan: ${verdict.feedback}\n\n${PLAN_NOTE}` : NOT_YET_NOTE;
            answer = await answered(sink, answerOf(await runTurn(sink, [{ type: 'text', text: next }]), sink));
            if (verdict.approve || next === NOT_YET_NOTE) break;
          }
          return answer;
        };
        const answer = await approved(await turnFor(original, input.prompt, built(input)), original);
        answers.push(answer);
        input.onAnswered?.(answer);

        // Then each message that waits for a turn of its own (one sent with Send now).
        while (!aborted) {
          const followUp = pending.shift();
          if (!followUp) break;
          const sink: TurnSink = { onEvent: followUp.onEvent, ...(followUp.onStep ? { onStep: followUp.onStep } : {}) };
          followUp.onStart?.();
          try {
            if (followUp.model !== undefined && modelOf(followUp.model) !== wanted) await switchModel(modelOf(followUp.model), sink);
            followUp.onDone(await approved(await turnFor(sink, followUp.prompt, built(followUp)), sink));
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

    // Side calls (naming, drafting, chat answers…) through a one-off conversation each.
    ...sideCalls((req) => acpComplete(spec, ext, req, side), opts.cwd, opts.model),

    // What's left of your plan's quota, without a run (the usage tab), when the agent's extension can read it:
    // reported for this agent, so nothing is filed as Claude's.
    async refreshUsage() {
      // Once a daemon: what earlier looks left behind in the agent's folder.
      if (!opts.connect && ext.tidy && !tidied.has(spec.id)) tidied.set(spec.id, ext.tidy().catch(() => undefined));
      const read = opts.readQuota ?? (opts.connect || !ext.quota ? undefined : () => ext.quota!());
      const update = await read?.().catch(() => undefined);
      if (update) opts.bridge.reportUsage({ ...update, signedIn: true }, agent);
      return undefined;
    },

    // Its models: what a session offers (the ones your plan has).
    listModels: async () => {
      const found = await acpStatus(spec, ext, { ...(bin() ? { bin: bin()! } : {}), ...(opts.connect ? { connect: opts.connect } : {}) });
      return found.state === 'ready' ? [...found.models] : undefined;
    },
  };
}

/** What a loaded session's history is made of (ACP's session/update kinds): never this run's work. */
const HISTORY = new Set<string>(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);

const PLAN_NOTE = 'Plan only: look around read-only, change nothing, and answer with a step-by-step plan for the person to approve.';
const DEFINE_NOTE =
  'Before the plan goes to the person for approval, call the beluga_board task_define tool with the task this plan is for (title, goal in your own words, context, acceptance criteria, decisions, open questions, estimate, priority). Then answer with the plan again, in full.';
const NOT_YET_NOTE = 'The person did not approve the plan yet. Ask them what they would like to change, and change nothing.';
