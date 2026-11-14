import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linkedImages } from '../../../core/attachments.js';
import { claudeHome } from '../../../core/claude-code/launch.js';
import { type RunEnd, RunFailedError, classifyRun } from '../../../shared/run-failure.js';
import { buildPrompt } from '../../prompt.js';
import { isYourRun } from '../../policy.js';
import { runInstructions } from '../../run-instructions.js';
import { runToolSuites } from '../../run-tools.js';
import { sideCalls } from '../../side-calls.js';
import { syncProbes } from '../../sync-main.js';
import { gateTool } from '../../tool-gate.js';
import { ToolHost, type StdioServerConfig } from '../../tool-host.js';
import type { AgentBackend, AgentRunInput, FollowUp, LiveStatus, RoomBridge, Steer } from '../../types.js';
import { ViewShelf } from '../../view-tools.js';
import { clampEffort } from '../codex/runner.js';
import { INTERRUPT_TIMEOUT_MS } from '../types.js';
import { type AcpMcpServer, type ConfigOption, type ContentBlock, type PermissionRequest, type PromptResponse, type SessionResponse, type SessionUpdate, permissionAnswer } from './acp.js';
import { askOpenCodeBtw } from './btw.js';
import { openCodeComplete } from './complete.js';
import { type ResolvedConfig, resolveConfig, runConfig } from './config.js';
import { type OpenCodeConnect, type OpenCodeConnection, findOpenCode, spawnOpenCode } from './connection.js';
import { OpenCodeEvents, type TurnSink, contextEvent, usageEvent } from './events.js';
import { listOpenCodeModels } from './models.js';
import { RETRIES_BEFORE_FAILING, isRateLimit, providerErrorOf } from './provider.js';
import { mapOpenCodeSlash } from './skills.js';
import { belugaCalls, belugaTool } from './tools.js';

export interface OpenCodeBackendOptions {
  readonly cwd: string;
  readonly autoEdit: boolean;
  readonly additionalDirectories: readonly string[];
  readonly bridge: RoomBridge;
  readonly model?: string;
  /** OpenCode's executable; unset: findOpenCode(). */
  readonly bin?: string;
  /** How to reach OpenCode (tests: a scripted one). */
  readonly connect?: OpenCodeConnect;
  /** Your OpenCode config for a folder (tests: a fixed one). */
  readonly resolve?: (cwd: string, env: Readonly<Record<string, string | undefined>>) => Promise<ResolvedConfig | undefined>;
  /** Where Beluga's tools are served to the run over stdio (one per daemon). */
  readonly toolHost?: ToolHost;
}

const OPENCODE_AGENT = { runtime: 'opencode', label: 'OpenCode' } as const;
/** A plan sent back for changes this many times: the run ends with the last plan as its answer. */
const PLAN_ROUNDS = 5;

let sharedHost: ToolHost | undefined;
const toolHost = (): ToolHost => (sharedHost ??= new ToolHost());

/** A model OpenCode knows (`provider/model`), or undefined for its own default (Claude's aliases mean nothing to it). */
export function openCodeModel(model: string | undefined): string | undefined {
  if (!model || !model.includes('/')) return undefined;
  return model;
}

/** Beluga's tool servers as ACP's stdio MCP servers. */
export function acpServers(servers: Readonly<Record<string, StdioServerConfig>>): AcpMcpServer[] {
  return Object.entries(servers).map(([name, s]) => ({ name, command: s.command, args: [...s.args], env: Object.entries(s.env).map(([k, value]) => ({ name: k, value })) }));
}

const MIME: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** A prompt as ACP content: its text, and the pictures it links (sent along when OpenCode takes pictures). */
export function promptBlocks(text: string, prompt: string, images: boolean): ContentBlock[] {
  const pictures = images
    ? linkedImages(prompt).flatMap((file): ContentBlock[] => {
        const mimeType = MIME[path.extname(file).toLowerCase()];
        try {
          return mimeType ? [{ type: 'image', mimeType, data: readFileSync(file).toString('base64') }] : [];
        } catch {
          return [];
        }
      })
    : [];
  return [...pictures, { type: 'text', text }];
}

/** Calls Beluga lets through without asking anyone: the folder check and loop guard OpenCode asks about on top of each tool's own ask. */
const OWN_CHECKS = new Set(['external_directory', 'doom_loop']);
/** OpenCode's tools that change files. */
const EDITS = new Set(['write', 'edit', 'multiedit', 'patch', 'apply_patch']);
/** Beluga's tools whose target is a path: one OpenCode didn't name is turned down, never judged as the folder. */
const PATHED = new Set(['Read', 'Write', 'Edit']);

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

/**
 * Runs turns on OpenCode through `opencode acp` (BLG-686): one process per run, one session per
 * place (its id is the place's session, so the conversation resumes), each request a prompt, its
 * updates streamed into onEvent/onStep the way Claude's are. Every tool call OpenCode makes comes
 * to Beluga first (config.ts makes each one ask) and is judged by the same gate as Claude's
 * (vetTool, policy, you). Beluga's tools reach it as stdio MCP servers, gated per call there.
 */
export function createOpenCodeBackend(opts: OpenCodeBackendOptions): AgentBackend {
  let sessionId: string | undefined;
  const connect = opts.connect ?? spawnOpenCode;
  const host = (): ToolHost => opts.toolHost ?? toolHost();
  const bin = (): string | undefined => opts.bin ?? (opts.connect ? undefined : findOpenCode());
  const resolve = opts.resolve ?? ((cwd: string, env: Readonly<Record<string, string | undefined>>) => {
    const b = bin();
    return b ? resolveConfig(b, cwd, env) : Promise.resolve(undefined);
  });
  // A scripted OpenCode (tests, the demo) has no sessions of the real one's to drop.
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
      const policy = { cwd, roots: [cwd, ...extraDirs, ...(fixup ? [fixup] : [])], autoEdit, scope: input.scope, guest: input.guest, boardAsks: input.boardAsks, dotenv: Boolean(input.canUseSecret) && !input.guest, yourRun: isYourRun(input), askOnly: Boolean(askOnly), ...(syncMain ? { syncMain: syncProbes(cwd, syncMain) } : {}), ...(fixup ? { fixup } : {}), ...(place?.alsoEdit?.length ? { alsoEdit: place.alsoEdit } : {}) };
      const remember = (id: string): void => (place ? place.onSession(id) : void (sessionId = id));
      const shelf = new ViewShelf();

      // Beluga's tools, served for this run alone and gated per call (vetTool, policy, you).
      const mounted = await host().mount(runToolSuites(input, bridge, shelf, cwd), (name, args) => gateTool(name, args, input, policy));
      const suites = Object.keys(mounted.servers);
      // Beluga's instructions for the run, as one more of OpenCode's instructions files.
      const instructions = path.join(os.tmpdir(), `beluga-opencode-${randomUUID()}.md`);
      writeFileSync(instructions, runInstructions(input, opts.bridge.selfName(), OPENCODE_AGENT), { mode: 0o600 });

      let planning = Boolean(input.plan);
      let model: string | undefined;
      let lastContext: string | undefined;
      /** A /compact turn is running: its summary and meter stay out of the chat. */
      let compacting = false;
      /** OpenCode's own commands here (its built-ins, its commands, the skills it loaded). */
      let commands = new Set<string>();
      const events = new OpenCodeEvents(cwd, { onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}) }, {
        onFileTouched: input.onFileTouched,
        expand: (t) => shelf.expand(t),
        suites,
        onSub: (e) => input.onEvent('sub', JSON.stringify(e)),
        onContext: (used, size) => {
          const ev = contextEvent(used, size, model);
          if (ev && ev !== lastContext && !compacting) input.onEvent('context', (lastContext = ev));
        },
        quiet: () => compacting,
      });
      let conn: OpenCodeConnection | undefined;
      let failed = true;
      let closed = false;
      try {
        const env = { ...process.env, ...input.env };
        const resolved = await resolve(cwd, env);
        conn = await connect({ cwd, env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(runConfig(resolved, { instructions })) }, ...(opts.bin ? { bin: opts.bin } : {}) });
        const link = conn;
        input.onProcess?.(link.proc);
        const { rpc } = link;
        const stopped = deferred<never>();
        void rpc.closed.then(() => {
          if (!closed) stopped.reject(openCodeFailure({ error: 'OpenCode exited before the turn ended', stderr: link.stderr() }));
        });

        let sid = '';
        let options: readonly ConfigOption[] = [];
        rpc.onNotification((method, params) => {
          if (method !== 'session/update' || params.sessionId !== sid) return;
          const update = params.update as SessionUpdate;
          if (update.sessionUpdate === 'available_commands_update') commands = new Set(update.availableCommands.map((c) => c.name));
          if (update.sessionUpdate === 'config_option_update') options = update.configOptions;
          events.handle(update);
        });
        // Every tool call OpenCode makes: Beluga's gate decides (and you, when it asks), once each.
        rpc.onRequest(async (method, params) => {
          if (method !== 'session/request_permission') throw new Error(`${method} isn’t supported in Beluga`);
          const req = params as unknown as PermissionRequest;
          const why = await judge(req);
          if (why) events.denied.set(req.toolCall.toolCallId, why);
          return permissionAnswer(req, !why);
        });
        /** Why a call may not run (undefined: it may). */
        const judge = async (req: PermissionRequest): Promise<string | undefined> => {
          const call = await events.callOf(req.toolCall);
          if (!call) return 'OpenCode didn’t say which tool this is.';
          if (OWN_CHECKS.has(call.tool)) return undefined;
          // Beluga's own tools are judged where they run (the tool host's gate), not twice.
          if (belugaTool(call.tool, suites)) return undefined;
          if ((planning || readOnly) && EDITS.has(call.tool)) return planning ? 'Planning only looks: nothing changes until you approve the plan.' : 'This conversation only looks: nothing may change here.';
          for (const c of belugaCalls(call.tool, call.raw, cwd, suites)) {
            if (PATHED.has(c.name) && !c.input.file_path) return 'OpenCode didn’t say which file, so Beluga turned it down.';
            const denied = await gateTool(c.name, c.input, input, policy);
            if (denied) return denied;
          }
          return undefined;
        };

        const servers = acpServers(mounted.servers);
        const forked = Boolean(place?.forkSession && place.resume);
        const resume = place ? place.resume : sessionId;
        let opened: SessionResponse | undefined;
        if (resume) {
          opened = await rpc.request<SessionResponse>(forked ? 'session/fork' : 'session/resume', { sessionId: resume, cwd, mcpServers: servers }).catch(() => undefined);
          if (opened && !forked) opened = { ...opened, sessionId: resume };
          if (!opened) input.onEvent('progress', 'Started a new OpenCode conversation (the last one couldn’t be opened)');
        }
        opened ??= await rpc.request<SessionResponse>('session/new', { cwd, mcpServers: servers });
        sid = opened.sessionId!;
        options = opened.configOptions ?? [];
        remember(sid);
        if (input.signal.aborted) throw new Error('aborted');

        /** Set one of the session's options (model, effort, mode) when it offers that value and isn't on it already. */
        const choose = async (id: string, value: string | undefined): Promise<boolean> => {
          const option = options.find((o) => o.id === id);
          if (!value || !option || option.currentValue === value || !option.options.some((o) => o.value === value)) return false;
          const res = await rpc.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', { sessionId: sid, configId: id, value });
          options = res.configOptions ?? options;
          return true;
        };
        /** The model and effort a turn runs on: the picked one when OpenCode has it (else its own), the effort clamped to what that model takes. */
        let wanted = input.model ?? place?.model ?? opts.model;
        const settle = async (): Promise<void> => {
          const pick = openCodeModel(wanted);
          if (pick && !(await choose('model', pick)) && !options.find((o) => o.id === 'model')?.options.some((o) => o.value === pick)) input.onEvent('progress', `OpenCode has no model ${pick} here: it runs on its own default`);
          model = options.find((o) => o.id === 'model')?.currentValue ?? model;
          const effort = input.effort ?? place?.effort;
          const levels = options.find((o) => o.id === 'effort')?.options.map((o) => o.value);
          if (effort && levels?.length) await choose('effort', clampEffort(effort, levels));
        };
        await settle();
        await choose('mode', planning ? 'plan' : 'build');

        // Stop: cancel the turn (same contract as Claude), then the process for sure.
        let aborted = false;
        const abort = deferred<never>();
        let active: { readonly done: ReturnType<typeof deferred<PromptResponse>>; readonly failed: ReturnType<typeof deferred<never>>; readonly sink: TurnSink } | undefined;
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

        // A provider failing while OpenCode retries (provider.ts): said while it retries; a limit or a
        // sign-in that retrying won't fix, or the same error coming back again and again, ends the turn with it.
        const seen = new Map<string, number>();
        link.onLog?.((line) => {
          const e = providerErrorOf(line);
          const turn = active;
          if (!e || !turn) return;
          const times = (seen.get(e.text) ?? 0) + 1;
          seen.set(e.text, times);
          const fatal = e.kind !== 'retrying' ? e.kind : times >= RETRIES_BEFORE_FAILING ? (isRateLimit(e.text) ? 'usage_limit' : 'api') : undefined;
          if (!fatal) {
            if (times === 1) turn.sink.onEvent('progress', `OpenCode is retrying: ${e.text.slice(0, 200)}`);
            return;
          }
          turn.failed.reject(new RunFailedError({ kind: fatal, detail: [e.text, '', ...link.stderr().filter((l) => l.includes('level=ERROR')).slice(-4)].join('\n').trim(), runtime: 'opencode' }));
          void cancelTurn();
        });

        /** One turn: what it said last, and how it ended. */
        const runTurn = async (sink: TurnSink, blocks: ContentBlock[]): Promise<{ text: string; res: PromptResponse }> => {
          events.beginTurn(sink);
          const done = deferred<PromptResponse>();
          const failed = deferred<never>();
          active = { done, failed, sink };
          const costBefore = events.cost;
          try {
            rpc.request<PromptResponse>('session/prompt', { sessionId: sid, prompt: blocks }).then(done.resolve, (err: unknown) => done.reject(openCodeFailure({ error: err instanceof Error ? err.message : String(err), stderr: link.stderr() })));
            const res = await Promise.race([done.promise, failed.promise, stopped.promise, abort.promise]);
            const text = events.endTurn(res.stopReason !== 'cancelled');
            const used = usageEvent(res.usage, sid, events.cost - costBefore);
            if (used) sink.onEvent('usage', used);
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
        // OpenCode takes one prompt at a time: a message can't go into a running turn (Beluga queues it), only stop it.
        const steer = Object.assign((_f: FollowUp) => false, { status, interrupt }) satisfies Steer;
        input.onSteer?.(steer);

        /** A turn's end as its answer: an interrupted one ends with the note it was stopped with. */
        const answerOf = (r: { text: string; res: PromptResponse }, sink: TurnSink): string => {
          if (r.res.stopReason === 'cancelled') {
            if (interrupting === undefined) throw new Error('aborted');
            const note = interrupting;
            interrupting = undefined;
            sink.onEvent('text', note);
            return r.text ? `${shelf.finish(r.text)}\n\n${note}` : note;
          }
          if (r.res.stopReason === 'refusal' && !r.text) return 'OpenCode’s model declined to answer this.';
          return shelf.finish(r.text);
        };
        /** What didn't carry over to OpenCode, said in the chat now and kept at the top of the answer. */
        const noted = (notes: readonly string[], sink: TurnSink): ((answer: string) => string) => {
          for (const note of notes) sink.onEvent('text', note);
          return (answer) => (notes.length ? `${notes.join('\n')}\n\n${answer}` : answer);
        };
        /** /compact: OpenCode's own, its summary kept out of the chat, and how full the window is before and after. */
        const compact = async (sink: TurnSink): Promise<string> => {
          // Before: what this run saw (0 in a new run: the compactor fills in what Beluga last saw). After: OpenCode's first number once it's done.
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
        /** A message as a turn: a /command mapped (skills.ts), pictures with it. */
        const turnFor = async (sink: TurnSink, prompt: string, built: (p: string) => string): Promise<string> => {
          if (/^\/compact(\s|$)/.test(prompt.trim())) return compact(sink);
          const mapped = await mapOpenCodeSlash(prompt, cwd, claudeHome(), commands);
          const said = noted(mapped.notes, sink);
          const text = mapped.prompt.startsWith('/') ? mapped.prompt : built(mapped.prompt);
          return said(answerOf(await runTurn(sink, promptBlocks(text, prompt, Boolean(link.init.agentCapabilities?.promptCapabilities?.image))), sink));
        };

        const original: TurnSink = { onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}) };
        const answers: string[] = [];
        let answer = await turnFor(original, input.prompt, (p) => (planning ? `${buildPrompt({ ...input, prompt: p })}\n\n${PLAN_NOTE}` : buildPrompt({ ...input, prompt: p })));
        // Plan mode, OpenCode's own (its plan agent edits nothing): the plan comes to you, and once
        // you approve it the session goes back to build and does the work.
        let askedToDefine = false;
        for (let round = 0; planning && input.askUser && round < PLAN_ROUNDS; round++) {
          if (input.planTask?.needsDefinition() && !askedToDefine) {
            askedToDefine = true;
            answer = answerOf(await runTurn(original, [{ type: 'text', text: DEFINE_NOTE }]), original);
          }
          const verdict = await input.askUser({ kind: 'plan', plan: (answer || '(OpenCode proposed a plan)').slice(0, 60_000) });
          if (verdict.kind !== 'plan') break;
          if (verdict.approve) {
            input.planTask?.approved();
            planning = false;
            await choose('mode', 'build');
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
        rmSync(instructions, { force: true });
        await conn?.proc.kill();
      }
    },

    // Side calls (naming, drafting, chat answers…) through OpenCode's one-shot call.
    ...sideCalls((req) => openCodeComplete(req, side), opts.cwd, opts.model),

    // A side question (/btw): a fork of the conversation's OpenCode session, no tools, the fork dropped after.
    btw: (req) => askOpenCodeBtw(req, side),

    // Its models: from its command line (every provider's, with the efforts each takes), or, reached
    // another way (a scripted one), from what a session offers.
    listModels: async () => {
      const b = bin();
      if (b) return listOpenCodeModels(b);
      if (!opts.connect) return undefined;
      const conn = await opts.connect({ cwd: opts.cwd }).catch(() => undefined);
      if (!conn) return undefined;
      try {
        const s = await conn.rpc.request<SessionResponse>('session/new', { cwd: opts.cwd, mcpServers: [] });
        return s.configOptions?.find((o) => o.id === 'model')?.options.map((o) => ({ value: o.value, label: o.name.split('/').at(-1) ?? o.name, description: o.value.split('/')[0] ?? '' }));
      } catch {
        return undefined;
      } finally {
        await conn.proc.kill();
      }
    },
  };
}

/** A failed OpenCode run, told as OpenCode's (not Claude Code's). */
export const openCodeFailure = (end: RunEnd): RunFailedError => new RunFailedError({ ...classifyRun(end), runtime: 'opencode' });

const PLAN_NOTE = 'Plan only: look around read-only, change nothing, and answer with a step-by-step plan for the person to approve.';
const DEFINE_NOTE =
  'Before the plan goes to the person for approval, call the beluga_board task_define tool with the task this plan is for (title, goal in your own words, context, acceptance criteria, decisions, open questions, estimate, priority). Then answer with the plan again, in full.';
const NOT_YET_NOTE = 'The person did not approve the plan yet. Ask them what they would like to change, and change nothing.';
