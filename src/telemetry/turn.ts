import { commandFacts } from './command.js';
import { type AttrValue, type OtlpSpan, attrs, nanos, pseudonym, spanId, traceId } from './otlp.js';
import { agentTypeOf, toolDetail } from './tool-detail.js';

/**
 * One turn of an agent, as Beluga saw it (src/telemetry/observe.ts), and that turn as spans.
 * Text is here only at level "on", and only for your own turns; so is what each tool was given and
 * gave back. Both are masked before they're turned into spans (src/telemetry/service.ts).
 */

/** At most this many declared tools go on a turn (the count says how many there were). */
export const DEFINITIONS_MAX = 512;
/** At most this many hook events go on a turn (the count and the total time say the rest). */
export const HOOK_EVENTS_MAX = 200;
/** A question's words are cut to this (masked first). */
export const QUESTION_MAX = 1_000;

export interface TurnUsage {
  /** Fresh input tokens (cache not included, as Beluga's usage events count them). */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** In dollars. 0: the runtime reports none (Codex), so none is sent and a price book prices the tokens. */
  readonly cost: number;
  /** Output tokens spent thinking (part of `output`), when the runtime says. */
  readonly thinking?: number;
}

export interface TurnTool {
  readonly id: string;
  /** As the agent named it: "Bash", "mcp__beluga_board__task_update", "mcp__github__search". */
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly ok: boolean;
  /** Failed: the class of failure (src/telemetry/tool-error.ts). */
  readonly error?: string;
  /** Failed, one of Beluga's own tools: what it said, short and stripped (src/telemetry/error-text.ts). */
  readonly errorMessage?: string;
  /** When it really started running (its step starts when the model asked for it): it waited behind the calls before it until then. */
  readonly ranAt?: number;
  /** A sub-agent's step: the id of the tool call that started that sub-agent. */
  readonly parent?: string;
  /** Level "on": what the call was given (bounded, secrets redacted; masked before it's turned into spans). */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Level "on": what came back (bounded; masked before it's turned into spans). */
  readonly output?: string;
  /** A command's exit code, when the runtime gave it (Codex). */
  readonly exitCode?: number;
  /** The runtime's own name for the tool, when Beluga renamed it ("commandExecution" → "Bash"). */
  readonly native?: string;
  /** The id of the model request that asked for it, and of the sub-agent that made it (Claude Code's own; never sent). */
  readonly requestId?: string;
  readonly agentId?: string;
  /** A Skill call: where Claude Code said the skill lives ("userSettings", "projectSettings", "plugin"…). */
  readonly skillSource?: string;
  /** Whether it was let run, and what decided, in Claude Code's words ("config", "hook", "user_temporary"…). */
  readonly decision?: 'allow' | 'deny';
  readonly decisionSource?: string;
}

/** Where a turn ran, by name (plain: the owner's own repos). */
export interface RunContext {
  readonly repo?: string;
  readonly branch?: string;
  readonly worktree?: string;
  /** The board task its worktree is doing ("BLG-42"). */
  readonly task?: string;
  /** Its open pull request's number. */
  readonly pr?: number;
}

/** What the agent's own program said about itself when the run started. */
export interface Harness {
  readonly version?: string;
  /** How it asks before acting: "default", "acceptEdits", "plan", "bypassPermissions". */
  readonly permissionMode?: string;
  /** The tools the model was given, by name, and the MCP servers they come from. */
  readonly tools?: readonly string[];
  readonly mcpServers?: readonly string[];
}

/** The context was compacted: when, what started it, and its size before and after. */
export interface TurnCompaction {
  readonly at: number;
  readonly trigger?: string;
  readonly pre?: number;
  readonly post?: number;
}

export type WaitKind = 'permission' | 'secret' | 'question' | 'plan';
export type WaitOutcome = 'approved' | 'declined' | 'answered' | 'skipped' | 'timeout';

/** The run waited for a person: an approval (a tool, a .env file), a question, a plan to approve. */
export interface TurnWait {
  readonly kind: WaitKind;
  /** The tool that waited, as the agent named it. */
  readonly tool?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: WaitOutcome;
  /** Level "on", a run whose content may go: what was asked (masked before it's turned into spans). */
  readonly question?: string;
}

/** Hooks that ran for one event (Claude Code's own report): which, how long in all, how they ended. */
export interface TurnHook {
  readonly at: number;
  /** "PreToolUse", "SessionStart", "Stop"… */
  readonly event: string;
  readonly name?: string;
  /** Where the hook is set: "user", "project", "plugin", "sdk"… */
  readonly source?: string;
  readonly durationMs: number;
  readonly outcome: 'success' | 'blocked' | 'error' | 'cancelled';
  /** How many hooks ran for it. */
  readonly count: number;
}

/** One model request (Claude Code's own telemetry has one per request: src/telemetry/claude-otel.ts). */
export interface TurnCall {
  readonly model?: string;
  /** What asked for it, in Claude Code's words: "sdk" (the turn itself), "generate_session_title"… */
  readonly source?: string;
  readonly at: number;
  readonly durationMs: number;
  readonly usage: TurnUsage;
  readonly error?: string;
  /** The request's id, to tie a tool call to the request that asked for it. Never sent. */
  readonly requestId?: string;
  /** A sub-agent's request: Claude Code's id for that sub-agent (never sent), and its type ("Explore"). */
  readonly agentId?: string;
  readonly agentName?: string;
}

export type TurnOutcome = 'ok' | 'error' | 'stopped';

export interface TurnFacts {
  readonly runtime: string;
  /** The model as it was picked: an id, or a name the agent resolves ("opus"). */
  readonly model?: string;
  /** The model's id as the run itself reported it, when it did. */
  readonly resolvedModel?: string;
  readonly effort?: string;
  /** The agent's own session (hashed with the install id before it's sent). */
  readonly session?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: TurnOutcome;
  /** What kind of error (its class: usage_limit, signed_out, crash, network, api, or the error's name). */
  readonly errorKind?: string;
  /** Failed: what it said, short and stripped (src/telemetry/error-text.ts). */
  readonly errorMessage?: string;
  readonly usage?: TurnUsage;
  readonly calls?: readonly TurnCall[];
  readonly tools: readonly TurnTool[];
  /** Your own turn, or one someone else asked for (a friend, a friend's agent). */
  readonly own: boolean;
  /** Its tools' arguments and results may go: level "on", and a run of yours (never a friend's or a guest's). */
  readonly content?: boolean;
  /** The skill or custom command you started the turn with ("/loop-do …"), by name. */
  readonly slash?: string;
  /** Where it ran: a worktree, a project, a chat, a plan, a sentinel… */
  readonly place: string;
  readonly subagents: number;
  readonly compactions: number;
  readonly promptChars: number;
  readonly answerChars: number;
  /** Its stretches of thinking: how long they took in all, and how many. Never what was thought. */
  readonly thinking?: { readonly ms: number; readonly blocks: number };
  /** Level "on", your own turn: the text, already masked. */
  readonly text?: { readonly prompt: string; readonly answer: string };
  readonly context?: RunContext;
  readonly harness?: Harness;
  /** Each compaction of the turn, when the runtime says them one by one (`compactions` counts them all). */
  readonly compacted?: readonly TurnCompaction[];
  readonly waits?: readonly TurnWait[];
  readonly hooks?: readonly TurnHook[];
  /** The context as the run last reported it: tokens in the window, and the window's size. */
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  /** In a project left out of usage statistics: it goes only to your own trace destinations. */
  readonly leftOut?: boolean;
}

const PROVIDERS: Readonly<Record<string, string>> = { claude: 'anthropic', local: 'local', codex: 'openai', copilot: 'github', grok: 'xai', antigravity: 'google', opencode: 'opencode' };

/** Ratel's words for how a call ended. */
const finish = (f: TurnFacts, last: boolean): string => (f.outcome === 'error' ? 'error' : f.outcome === 'stopped' ? 'stop' : !last ? 'tool_call' : 'stop');

const usageAttrs = (u: TurnUsage | undefined) =>
  u
    ? {
        // Ratel follows the semconv: input includes the cache.
        'gen_ai.usage.input_tokens': u.input + u.cacheRead + u.cacheWrite,
        'gen_ai.usage.output_tokens': u.output,
        'gen_ai.usage.cache_read.input_tokens': u.cacheRead,
        'gen_ai.usage.cache_creation.input_tokens': u.cacheWrite,
        'gen_ai.usage.reasoning.output_tokens': u.thinking,
        'ratel.usage.cost_usd': known(u.cost),
      }
    : {};

/** A cost, when the runtime reported one (zero is "not known": Codex reports none). */
const known = (cost: number | undefined): number | undefined => (cost ? cost : undefined);

/** A model's id without the variant some pickers add ("claude-opus-5-5[1m]"): the price book has the id. */
const bare = (model: string | undefined): string | undefined => model?.replace(/\[[^\]]*\]$/, '') || undefined;

/**
 * The turn's model as an id a price book knows. The run's own word for it, else the name picked,
 * is checked against its own requests (never a sub-agent's): they hold the id a name stands for
 * ("opus" → "claude-opus-5-5"). Nothing reported or picked: the model that wrote the most.
 */
function modelOf(f: TurnFacts): string | undefined {
  const named = bare(f.resolvedModel) ?? bare(f.model);
  return mostWritten((f.calls ?? []).filter((c) => !c.agentId && !c.agentName), named) ?? named;
}

/** A name the runtime resolves itself ("opus", "sonnet[1m]", "default"): Claude's pickers' words, never an id. */
export const isModelAlias = (runtime: string, model: string | undefined): boolean => runtime === 'claude' && /^[a-z]+$/.test(bare(model) ?? '');

/** The turn's model as a full id, never a name ("opus" splits a model's statistics from "claude-opus-5-5"). */
export function modelIdOf(f: TurnFacts): string | undefined {
  const model = modelOf(f);
  return model && !isModelAlias(f.runtime, model) ? model : undefined;
}

/**
 * The ids the names picked stood for, as this computer's runs reported them (BLG-1029): a turn that
 * didn't say (it failed before its first request, or ran in a terminal) still goes out with the id.
 */
export class ModelIds {
  private readonly ids = new Map<string, string>();

  /** The turn with the id its picked name stands for, when it didn't say and an earlier turn did. */
  settle(f: TurnFacts): TurnFacts {
    const picked = bare(f.model);
    if (!picked || !isModelAlias(f.runtime, picked)) return f;
    const key = `${f.runtime}:${picked}`;
    const id = modelIdOf(f);
    if (id) {
      this.ids.set(key, id);
      return f;
    }
    const known = this.ids.get(key);
    return known ? { ...f, resolvedModel: known } : f;
  }
}

/** Of these requests, the model that wrote the most (only ids that hold `named`, when given). */
function mostWritten(calls: readonly TurnCall[], named?: string): string | undefined {
  const written = new Map<string, number>();
  for (const c of calls) {
    const id = bare(c.model);
    if (id && (!named || id.includes(named))) written.set(id, (written.get(id) ?? 0) + c.usage.output);
  }
  return [...written].sort((x, y) => y[1] - x[1])[0]?.[0];
}

/** The tools that start a sub-agent, as Claude Code names them (Codex's launches are recorded as Agent too). */
const LAUNCHERS = new Set(['Agent', 'Task']);
/** A request that isn't part of the turn's own loop: it never asked for a tool. */
const TITLE = 'generate_session_title';

/** A sub-agent: the call that started it, and the span its work goes under. */
interface SubAgent {
  readonly call: TurnTool;
  readonly type: string;
  readonly span: string;
}

/** One model request as its span, and whose it is ('' the turn's own, else the id of the call that started the sub-agent). */
interface Chat {
  readonly call: TurnCall;
  readonly scope: string;
  readonly span: string;
  readonly start: number;
  readonly end: number;
}

/**
 * A turn as one trace:
 *   invoke_agent <runtime>                 the turn
 *   ├── chat <model>                       one per model request
 *   │   ├── execute_tool <tool>            under the request that asked for it
 *   │   └── execute_tool Agent
 *   │       └── invoke_agent <type>        a sub-agent: its own requests and tools below it, the same way
 *   └── chat <model>
 */
export function turnSpans(f: TurnFacts, installId: string): OtlpSpan[] {
  const trace = traceId();
  const root = spanId();
  const conversation = f.session ? pseudonym(installId, f.session) : undefined;
  const provider = PROVIDERS[f.runtime] ?? f.runtime;
  const model = modelIdOf(f);
  const picked = bare(f.model);
  const agents = subAgentsOf(f);
  // On every span: Ratel resolves a span's session from its own attributes when a batch splits.
  const who = (scope: string) => ({ ...(conversation ? { 'gen_ai.conversation.id': conversation } : {}), 'gen_ai.agent.name': agents.get(scope)?.type ?? f.runtime, 'ratel.agent.parent_call_id': scope || undefined });

  const waited = waitsByTool(f);
  const waitMs = (f.waits ?? []).reduce((n, w) => n + lasted(w), 0);
  // A step that failed only because a person said no, or said nothing, is a wait and not a failed tool.
  const failed = (t: TurnTool): boolean => !t.ok && !waited.of(t).some(unanswered);
  const effects = f.tools.flatMap((t) => (t.name === 'Bash' && typeof t.input?.command === 'string' ? (commandFacts(t.input.command)?.effects ?? []).map((effect) => ({ effect, ok: t.ok })) : []));
  const did = (effect: string, ok?: boolean): number | undefined => effects.filter((e) => e.effect === effect && (ok === undefined || e.ok === ok)).length || undefined;
  const hooks = [...(f.hooks ?? [])].sort((a, b) => a.at - b.at);

  // The model requests: Claude Code's own (one per request) when they came, else the turn's total as one.
  const told = Boolean(f.calls?.length);
  const calls: TurnCall[] = f.calls?.length ? [...f.calls].sort((a, b) => a.at - b.at) : f.usage ? [{ ...(model ? { model } : {}), at: f.endedAt, durationMs: f.endedAt - f.startedAt, usage: f.usage }] : [];
  const scopeOf = callScopes(f, calls, agents);
  const chats: Chat[] = calls.map((call) => ({ call, scope: scopeOf(call), span: spanId(), start: Math.max(f.startedAt, call.at - call.durationMs), end: call.at }));
  const looped = (scope: string): Chat[] => chats.filter((c) => c.scope === scope && c.call.source !== TITLE);
  const own = looped('');
  // What you typed goes on the turn's own first request, and its answer on its last.
  const first = own[0] ?? chats[0];
  const last = own.at(-1) ?? chats.at(-1);

  /** Where a scope's spans hang: the sub-agent's span, or the turn's. */
  const home = (scope: string): string => agents.get(scope)?.span ?? root;
  /** The request that asked for a tool: its own by id, else the last of its scope that ended before it started. */
  const parentOf = (t: TurnTool): string => {
    const scope = t.parent && agents.has(t.parent) ? t.parent : '';
    const asked = t.requestId ? chats.find((c) => c.call.requestId === t.requestId && c.call.source !== TITLE) : undefined;
    if (asked) return asked.span;
    const mine = looped(scope);
    return ([...mine].reverse().find((c) => c.end <= t.startedAt + 1) ?? mine[0])?.span ?? home(scope);
  };

  const spans: OtlpSpan[] = [
    {
      traceId: trace,
      spanId: root,
      name: `invoke_agent ${f.runtime}`,
      kind: 1,
      startTimeUnixNano: nanos(f.startedAt),
      endTimeUnixNano: nanos(f.endedAt),
      attributes: attrs({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.provider.name': provider,
        ...who(''),
        'gen_ai.request.model': model,
        'ratel.model.alias': picked !== model ? picked : undefined,
        'ratel.harness.name': f.runtime,
        'ratel.harness.version': f.harness?.version,
        'ratel.harness.permission_mode': f.harness?.permissionMode,
        'ratel.harness.effort': f.effort,
        'ratel.run.place': f.place,
        'ratel.run.repo': f.context?.repo,
        'ratel.run.branch': f.context?.branch,
        'ratel.run.worktree': f.context?.worktree,
        'ratel.run.task': f.context?.task,
        'ratel.run.pr': f.context?.pr,
        'ratel.run.own': f.own,
        'ratel.run.outcome': f.outcome,
        'ratel.run.tool_calls': f.tools.length,
        'ratel.run.tool_errors': f.tools.filter(failed).length,
        // Time spent waiting for a person, apart: it is neither a tool's time nor the model's.
        'ratel.run.human_waits': f.waits?.length || undefined,
        'ratel.run.human_wait_ms': f.waits?.length ? waitMs : undefined,
        'ratel.run.hooks': hooks.length || undefined,
        'ratel.run.hook_ms': hooks.length ? hooks.reduce((n, h) => n + h.durationMs, 0) : undefined,
        'ratel.run.commits': did('commit', true),
        'ratel.run.prs_opened': did('pr_open', true),
        'ratel.run.test_runs': did('test'),
        'ratel.run.test_failures': did('test', false),
        'ratel.run.subagents': f.subagents,
        'ratel.run.compactions': f.compactions,
        'ratel.run.prompt_chars': f.promptChars,
        'ratel.run.answer_chars': f.answerChars,
        // The turn's whole cost, under its own name: a chat span's is ratel.usage.cost_usd, so a sum never counts twice.
        'ratel.run.cost_usd': known(f.usage?.cost),
        // Thinking: how long and how many tokens, never its words.
        'ratel.run.thinking_ms': f.thinking?.ms,
        'ratel.run.thinking_blocks': f.thinking?.blocks,
        'ratel.run.thinking_tokens': f.usage?.thinking,
        'ratel.skill.name': f.slash,
        'ratel.skill.trigger': f.slash ? 'slash_command' : undefined,
        ...runError(f),
      }),
      ...withEvents([
        ...(f.compacted ?? []).map((c) => spanEvent('ratel.compaction', c.at, { 'ratel.compaction.trigger': c.trigger, 'ratel.compaction.pre_tokens': c.pre, 'ratel.compaction.post_tokens': c.post })),
        ...hooks.slice(0, HOOK_EVENTS_MAX).map((h) =>
          spanEvent('ratel.hook', h.at, { 'ratel.hook.event': h.event, 'ratel.hook.name': h.name, 'ratel.hook.source': h.source, 'ratel.hook.duration_ms': h.durationMs, 'ratel.hook.outcome': h.outcome, 'ratel.hook.count': h.count }),
        ),
        // A wait no step of this turn owns.
        ...waited.loose.map((w) => waitEvent(w, w.tool, f.content === true)),
      ]),
      status: runStatus(f),
    },
  ];
  const declared = f.harness?.tools;
  for (const c of chats) {
    const text = f.text;
    const answered = bare(c.call.model) ?? model;
    // The last request of a loop ended it; the ones before it each asked for a tool.
    const ended = c === looped(c.scope).at(-1) || c.call.source === TITLE;
    spans.push({
      traceId: trace,
      spanId: c.span,
      parentSpanId: home(c.scope),
      name: `chat ${answered ?? f.runtime}`,
      kind: 3,
      startTimeUnixNano: nanos(c.start),
      endTimeUnixNano: nanos(c.end),
      attributes: attrs({
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': provider,
        ...who(c.scope),
        'gen_ai.request.model': answered,
        'gen_ai.response.model': answered,
        'ratel.request.source': c.call.source,
        ...usageAttrs(c.call.usage),
        // What the model saw: a request's own input, or (the turn told as one) what the run last reported.
        'ratel.context.tokens': told ? c.call.usage.input + c.call.usage.cacheRead + c.call.usage.cacheWrite || undefined : f.contextTokens,
        // The window is the turn's own model's: a sub-agent may run another.
        'ratel.context.window': c.scope ? undefined : f.contextWindow,
        // The turn as one request spans its waits for a person: said apart, so they aren't read as model time.
        'ratel.wait.human_ms': !told && f.waits?.length ? waitMs : undefined,
        // The tools the model had, on the turn's first request: names and kinds, never descriptions.
        ...(declared?.length && c === first
          ? {
              'gen_ai.tool.definitions': JSON.stringify(declared.slice(0, DEFINITIONS_MAX).map((name) => ({ type: name.startsWith('mcp__') ? 'extension' : 'function', name }))),
              'ratel.tool.declared_count': declared.length,
              'ratel.mcp.servers': f.harness?.mcpServers?.length ? f.harness.mcpServers : undefined,
            }
          : {}),
        'gen_ai.response.finish_reasons': [c.call.error ? 'error' : finish(f, ended)],
        'error.type': c.call.error,
        ...(text && c === first ? { 'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: text.prompt }] }]) } : {}),
      }),
      ...(text && c === last ? { events: [{ name: 'gen_ai.client.inference.operation.details', timeUnixNano: nanos(c.end), attributes: attrs({ 'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: text.answer }], finish_reason: finish(f, true) }]) }) }] } : {}),
      status: { code: c.call.error ? 2 : 1 },
    });
  }
  for (const t of f.tools) {
    const scope = t.parent && agents.has(t.parent) ? t.parent : '';
    const detail = toolDetail(t, f.content === true);
    const id = spanId();
    const waits = waited.of(t);
    const ok = !failed(t);
    const asked = waits.at(-1);
    spans.push({
      traceId: trace,
      spanId: id,
      parentSpanId: parentOf(t),
      name: `execute_tool ${detail.name}`,
      kind: 1,
      startTimeUnixNano: nanos(t.startedAt),
      endTimeUnixNano: nanos(t.endedAt ?? t.startedAt),
      // A sub-agent's step says which sub-agent, even when the call that started it isn't in this turn.
      attributes: attrs({
        ...toolAttrs(t, who(scope)),
        'gen_ai.tool.name': detail.name,
        ...detail.attributes,
        ...(asked ? { 'ratel.wait.kind': asked.kind, 'ratel.wait.outcome': asked.outcome, 'ratel.wait.human_ms': waits.reduce((n, w) => n + lasted(w), 0) } : {}),
        ...(ok ? { 'error.type': undefined, 'error.message': undefined } : {}),
      }),
      ...withEvents([
        ...waits.map((w) => waitEvent(w, detail.name, f.content === true)),
        // No one was asked: what Claude Code itself decided, and by what.
        ...(!waits.some(isPermission) && t.decision ? [spanEvent('ratel.permission.decision', t.startedAt, { 'gen_ai.tool.name': detail.name, 'ratel.permission.decision': t.decision, 'ratel.permission.source': t.decisionSource })] : []),
      ]),
      status: toolStatus(t, ok),
    });
    const agent = agents.get(t.id);
    if (!agent) continue;
    // The sub-agent it started: as long as its work (a background launch returns at once), with no usage of its own.
    const work = [...chats.filter((c) => c.scope === t.id).map((c) => c.end), ...f.tools.filter((x) => x.parent === t.id).map((x) => x.endedAt ?? x.startedAt)];
    spans.push({
      traceId: trace,
      spanId: agent.span,
      parentSpanId: id,
      name: `invoke_agent ${agent.type}`,
      kind: 1,
      startTimeUnixNano: nanos(t.startedAt),
      endTimeUnixNano: nanos(Math.max(t.endedAt ?? t.startedAt, ...work)),
      attributes: attrs({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.provider.name': provider,
        ...who(t.id),
        'gen_ai.request.model': mostWritten(chats.filter((c) => c.scope === t.id).map((c) => c.call)),
        'error.type': t.ok ? undefined : (t.error ?? 'tool_error'),
      }),
      status: { code: t.ok ? 1 : 2 },
    });
  }
  return spans;
}

type SpanEvent = NonNullable<OtlpSpan['events']>[number];

const spanEvent = (name: string, at: number, fields: Readonly<Record<string, AttrValue>>): SpanEvent => ({ name, timeUnixNano: nanos(at), attributes: attrs(fields) });
const withEvents = (events: readonly SpanEvent[]): { events?: readonly SpanEvent[] } => (events.length ? { events } : {});

const lasted = (w: TurnWait): number => Math.max(0, w.endedAt - w.startedAt);
const isPermission = (w: TurnWait): boolean => w.kind === 'permission' || w.kind === 'secret';
/** The person said no, or said nothing. */
const unanswered = (w: TurnWait): boolean => w.outcome === 'declined' || w.outcome === 'skipped' || w.outcome === 'timeout';

/**
 * A wait as its event: an approval is a permission decision (what you decided, how long you took),
 * a question or a plan is a human wait. What was asked goes only when the run's content may.
 */
function waitEvent(w: TurnWait, tool: string | undefined, content: boolean): SpanEvent {
  const wait = { 'ratel.wait.kind': w.kind, 'ratel.wait.outcome': w.outcome, 'ratel.wait.human_ms': lasted(w) };
  if (isPermission(w)) return spanEvent('ratel.permission.decision', w.endedAt, { 'gen_ai.tool.name': tool, 'ratel.permission.decision': w.outcome === 'approved' ? 'allow' : 'deny', 'ratel.permission.source': 'user', ...wait });
  return spanEvent('ratel.human.wait', w.endedAt, { 'gen_ai.tool.name': tool, ...wait, 'ratel.wait.question': content && w.question ? w.question.slice(0, QUESTION_MAX) : undefined });
}

/**
 * Each wait with the step that waited: the latest step of that tool that had started and not ended
 * when the wait began (a wait carries no call id). `loose`: the waits no step of this turn owns.
 */
function waitsByTool(f: TurnFacts): { readonly of: (t: TurnTool) => readonly TurnWait[]; readonly loose: readonly TurnWait[] } {
  const by = new Map<string, TurnWait[]>();
  const loose: TurnWait[] = [];
  for (const w of [...(f.waits ?? [])].sort((a, b) => a.startedAt - b.startedAt)) {
    const owner = f.tools.filter((t) => t.name === w.tool && t.startedAt <= w.startedAt + 1 && (t.endedAt === undefined || t.endedAt + 1 >= w.startedAt)).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (owner) by.set(owner.id, [...(by.get(owner.id) ?? []), w]);
    else loose.push(w);
  }
  return { of: (t) => by.get(t.id) ?? [], loose };
}

/** The calls of a turn that started a sub-agent: every Agent call, and any call other steps name as their parent. */
function subAgentsOf(f: TurnFacts): Map<string, SubAgent> {
  const parents = new Set(f.tools.flatMap((t) => (t.parent ? [t.parent] : [])));
  return new Map(f.tools.filter((t) => LAUNCHERS.has(t.name) || parents.has(t.id)).map((t) => [t.id, { call: t, type: agentTypeOf(t), span: spanId() }]));
}

/**
 * Whose each request is: '' the turn's own, else the id of the call that started its sub-agent.
 * Claude Code names a request's sub-agent (an id of its own, and its type); the same id is on the
 * sub-agent's tool calls, whose steps name the call that started it. A sub-agent that used no tool
 * is matched by its type to a call that started one, each call taken once. No match: the turn's own.
 */
function callScopes(f: TurnFacts, calls: readonly TurnCall[], agents: ReadonlyMap<string, SubAgent>): (call: TurnCall) => string {
  const owner = new Map<string, string>();
  for (const t of f.tools) if (t.agentId && t.parent && agents.has(t.parent)) owner.set(t.agentId, t.parent);
  const taken = new Set(owner.values());
  for (const c of calls) {
    const key = c.agentId ?? (c.agentName ? `name:${c.agentName}` : undefined);
    if (!key || owner.has(key)) continue;
    const started = [...agents.values()].filter((a) => a.type === c.agentName && a.call.startedAt <= c.at && !taken.has(a.call.id)).sort((x, y) => x.call.startedAt - y.call.startedAt)[0];
    if (!started) continue;
    owner.set(key, started.call.id);
    taken.add(started.call.id);
  }
  return (c) => owner.get(c.agentId ?? (c.agentName ? `name:${c.agentName}` : '')) ?? '';
}

/** What every tool span says, in both projects: which call, whose, and how it failed. Never what it was given. */
const toolAttrs = (t: TurnTool, who: Readonly<Record<string, string | undefined>>) => ({
  'gen_ai.operation.name': 'execute_tool',
  ...who,
  'gen_ai.tool.name': t.name,
  'gen_ai.tool.call.id': t.id,
  'ratel.agent.parent_call_id': t.parent,
  // Waiting behind the calls before it (the model asked for several at once): not the tool's own time.
  'ratel.tool.queued_ms': t.ranAt !== undefined ? Math.max(0, t.ranAt - t.startedAt) : undefined,
  'error.type': t.ok ? undefined : (t.error ?? 'tool_error'),
  'error.message': t.ok ? undefined : t.errorMessage,
});

/** A failed tool's status says what it said (Ratel keeps attributes, other tools the status message). */
const toolStatus = (t: TurnTool, ok: boolean): { readonly code: number; readonly message?: string } => (ok ? { code: 1 } : { code: 2, ...(t.errorMessage ? { message: t.errorMessage } : {}) });

/** A failed run says how (its class, always) and what it said; a stopped or finished one, neither. */
const runError = (f: TurnFacts) => (f.outcome === 'error' ? { 'error.type': f.errorKind ?? 'error', 'error.message': f.errorMessage } : {});
const runStatus = (f: TurnFacts): { readonly code: number; readonly message?: string } => (f.outcome === 'error' ? { code: 2, ...(f.errorMessage ? { message: f.errorMessage } : {}) } : { code: 1 });

/** One of Beluga's own MCP tools (mcp__beluga__send_chat, mcp__beluga_board__task_update…), as every runtime names them. */
export const isBelugaTool = (name: string): boolean => /^mcp__beluga(_\w+)?__/.test(name);

/**
 * A turn as Beluga's own project sees it: only the calls to Beluga's own tools, under an
 * `invoke_agent` root that says which agent ran and where. No model, tokens, cost, length, text or
 * other tools: those are your agents' sessions (turnSpans, at On). Nothing when it used none.
 */
export function belugaToolSpans(f: TurnFacts, installId: string): OtlpSpan[] {
  const tools = f.tools.filter((t) => isBelugaTool(t.name));
  if (!tools.length) return [];
  // As in the whole turn: a call you declined, or didn't answer, is a wait and not a failed tool.
  const waited = waitsByTool(f);
  const failed = (t: TurnTool): boolean => !t.ok && !waited.of(t).some(unanswered);
  const trace = traceId();
  const root = spanId();
  const conversation = f.session ? pseudonym(installId, f.session) : undefined;
  const who = { ...(conversation ? { 'gen_ai.conversation.id': conversation } : {}), 'gen_ai.agent.name': f.runtime };
  return [
    {
      traceId: trace,
      spanId: root,
      name: `invoke_agent ${f.runtime}`,
      kind: 1,
      startTimeUnixNano: nanos(f.startedAt),
      endTimeUnixNano: nanos(f.endedAt),
      attributes: attrs({
        'gen_ai.operation.name': 'invoke_agent',
        ...who,
        'ratel.harness.name': f.runtime,
        'ratel.run.place': f.place,
        'ratel.run.own': f.own,
        'ratel.run.outcome': f.outcome,
        'ratel.run.tool_calls': tools.length,
        'ratel.run.tool_errors': tools.filter(failed).length,
        ...runError(f),
      }),
      status: runStatus(f),
    },
    ...tools.map((t) => {
      // Its waits for you (an approval, a question), approved or not: a long call that waited on a person isn't a stall.
      const waits = waited.of(t);
      const asked = waits.at(-1);
      return {
        traceId: trace,
        spanId: spanId(),
        parentSpanId: root,
        name: `execute_tool ${t.name}`,
        kind: 1,
        startTimeUnixNano: nanos(t.startedAt),
        endTimeUnixNano: nanos(t.endedAt ?? t.startedAt),
        attributes: attrs({
          ...toolAttrs(t, who),
          ...(asked ? { 'ratel.wait.kind': asked.kind, 'ratel.wait.outcome': asked.outcome, 'ratel.wait.human_ms': waits.reduce((n, w) => n + lasted(w), 0) } : {}),
          ...(failed(t) || t.ok ? {} : { 'error.type': undefined, 'error.message': undefined }),
        }),
        status: toolStatus(t, !failed(t)),
      };
    }),
  ];
}
