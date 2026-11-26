import type { SubAgentEvent } from '../agent/types.js';
import type { AgentBackend, AgentRunInput } from '../agent/types.js';
import { CLAUDE_BUILT_INS } from '../shared/skills.js';
import type { StepRecord } from '../shared/steps.js';
import type { TelemetryLevel } from '../core/telemetry-store.js';
import type { Refusal, ToolLink } from './claude-otel.js';
import { RunFailedError, failureText } from '../shared/run-failure.js';
import { safeErrorText } from './error-text.js';
import { toolErrorType } from './tool-error.js';
import { type Harness, type RunContext, type TurnCall, type TurnCompaction, type TurnFacts, type TurnHook, type TurnOutcome, type TurnTool, type TurnUsage, type TurnWait, type WaitKind, type WaitOutcome, isBelugaTool } from './turn.js';

/**
 * A runtime's backend that also tells usage statistics what each turn did, whatever the runtime:
 * every run goes through `run()`, with its usage, its steps and its answer on the callbacks it
 * already has. Off, it's the backend itself (the input untouched). It only listens: what the run
 * sees, returns and throws is the same, and nothing here can make a run fail.
 */

export interface ObserveDeps {
  readonly level: () => TelemetryLevel;
  /** A turn ended (queued, sent later: the level is checked again then). */
  readonly turn: (facts: TurnFacts) => void;
  /** A run in a project left out of usage statistics: it goes straight through, as at off. */
  readonly excluded?: (input: AgentRunInput) => boolean;
  /**
   * A run in a project left out of usage statistics that's still watched, for your own trace
   * destinations only: its turn says `leftOut` and never reaches usage statistics.
   */
  readonly leftOut?: (input: AgentRunInput) => boolean;
  /** Extra environment for the agent's process (Claude Code's own telemetry, to this daemon only). */
  readonly env?: (runtime: string) => Readonly<Record<string, string>> | undefined;
  /** The model requests Claude Code reported for a session in a time window (claude-otel.ts). */
  readonly calls?: (session: string, from: number, to: number) => readonly TurnCall[];
  /** The tool calls of a session Claude Code said were refused, by tool call id (claude-otel.ts). */
  readonly refused?: (session: string) => ReadonlyMap<string, Refusal>;
  /** For these tool calls of a session, by tool call id: the request that asked for each and the sub-agent that made it (claude-otel.ts). */
  readonly links?: (session: string, ids: readonly string[]) => ReadonlyMap<string, ToolLink>;
  /** Where each skill the model called in a time window lives, in order (claude-otel.ts). */
  readonly skills?: (session: string, from: number, to: number) => readonly string[];
  /** The hooks Claude Code ran for a session in a time window (claude-otel.ts). */
  readonly hooks?: (session: string, from: number, to: number) => readonly TurnHook[];
  /** Where a run is: its repo, branch, worktree, task and pull request (service.ts). */
  readonly context?: (input: AgentRunInput) => RunContext | undefined;
  /** How long after a turn to wait for those reports (Claude Code sends them every second or so). */
  readonly settleMs?: number;
  readonly now?: () => number;
}

const SETTLE_MS = 6_000;
/** An approval settled faster than this was a rule's, not a person's: no one was waited for. */
const HUMAN_MIN_MS = 100;
/** Beluga stops waiting for an answer after this long (core/session.ts approvalTimeoutMs). */
const HUMAN_TIMEOUT_MS = 5 * 60_000;

/**
 * Where a turn ran, in one word. Every run of yours has the sentinel tools and a note about them, so
 * only a sentinel's own run is "sentinel" (BLG-1029: every run was, from 3.7.0).
 */
export function placeOf(input: AgentRunInput): string {
  if (input.sentinelRun) return 'sentinel';
  if (input.planTools) return 'plan';
  if (input.guest) return 'friend';
  if (input.place?.askOnly) return 'project';
  if (input.place) return 'worktree';
  return 'room';
}

/** Every runtime ends a stopped run with this (`new Error('aborted')`): a stop, never a failure. */
const ABORTED_MESSAGE = 'aborted';

/**
 * An error's kind, never its whole message (messages carry paths and names): how a run failed as
 * Beluga classified it (usage_limit, signed_out, crash, network, api), else the error's own name.
 */
export function errorKind(err: unknown): string {
  if (err instanceof RunFailedError) return err.failure.kind;
  if (err instanceof Error) return err.name === 'Error' ? (err.message === ABORTED_MESSAGE ? 'stopped' : 'error') : err.name.slice(0, 60);
  return typeof err;
}

/** How a run that threw ended: stopped (you, a steer, a timeout: its signal), else failed. */
export function thrownOutcome(err: unknown, signal?: AbortSignal): TurnOutcome {
  if (signal?.aborted) return 'stopped';
  const kind = errorKind(err);
  return kind === 'AbortError' || kind === 'stopped' ? 'stopped' : 'error';
}

/** What a failed run said, short and stripped (src/telemetry/error-text.ts): a classified failure's first line. */
export function errorMessage(err: unknown): string | undefined {
  if (err instanceof RunFailedError) return safeErrorText(failureText(err.message));
  if (err instanceof Error) return err.message === ABORTED_MESSAGE ? undefined : safeErrorText(err.message);
  return undefined;
}

const parseUsage = (text: string): (TurnUsage & { session?: string; compactions?: number }) | undefined => {
  try {
    const u = JSON.parse(text) as Partial<TurnUsage> & { session?: string; compactions?: number };
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      input: n(u.input),
      output: n(u.output),
      cacheRead: n(u.cacheRead),
      cacheWrite: n(u.cacheWrite),
      cost: n(u.cost),
      ...(n(u.thinking) > 0 ? { thinking: n(u.thinking) } : {}),
      ...(typeof u.session === 'string' ? { session: u.session } : {}),
      // A runtime that says its compactions with its usage, not as events of their own (Codex).
      ...(n(u.compactions) > 0 ? { compactions: n(u.compactions) } : {}),
    };
  } catch {
    return undefined;
  }
};

/** The skill or custom command a message starts with ("/loop-do fix it"), never one of Claude Code's own commands. */
export function slashOf(words: string | undefined): string | undefined {
  const name = /^\/\/?([\w.:-]{1,64})(?:\s|$)/.exec(words?.trimStart() ?? '')?.[1];
  return name && !CLAUDE_BUILT_INS.has(name) ? name : undefined;
}

/**
 * Where each Skill call's skill lives, by tool call id. Claude Code reports a skill the model called
 * without the call's id, so they are paired in order, and only when there is one report for each call.
 */
function skillSources(tools: readonly TurnTool[], sources: readonly string[]): ReadonlyMap<string, string> {
  const calls = tools.filter((t) => t.name === 'Skill' && t.ok).sort((a, b) => a.startedAt - b.startedAt);
  return new Map(calls.length === sources.length ? calls.map((t, i) => [t.id, sources[i]!] as const) : []);
}

const addUsage = (a: TurnUsage | undefined, b: TurnUsage): TurnUsage => {
  const thinking = (a?.thinking ?? 0) + (b.thinking ?? 0);
  return { input: (a?.input ?? 0) + b.input, output: (a?.output ?? 0) + b.output, cacheRead: (a?.cacheRead ?? 0) + b.cacheRead, cacheWrite: (a?.cacheWrite ?? 0) + b.cacheWrite, cost: (a?.cost ?? 0) + b.cost, ...(thinking > 0 ? { thinking } : {}) };
};

export function observedBackend(backend: AgentBackend, runtime: string, deps: ObserveDeps): AgentBackend {
  return Object.assign(Object.create(backend) as AgentBackend, {
    run: (input: AgentRunInput): Promise<string> => {
      const level = deps.level();
      if (level === 'off' || deps.excluded?.(input)) return backend.run(input);
      const leftOut = deps.leftOut?.(input) === true;
      const now = deps.now ?? Date.now;
      const startedAt = now();
      // Yours: you asked for it on this computer (only then does the run carry the words you typed).
      const own = input.ownWords !== undefined;
      // What a tool was given and gave back is kept only at On; it goes only on a run of yours (typed, or started for you).
      const detail = level === 'on';
      const content = detail && (own || input.ownerMcp === true);
      const slash = detail ? slashOf(input.ownWords) : undefined;
      let usage: TurnUsage | undefined;
      let session = input.place?.resume;
      let compactions = 0;
      const compacted: TurnCompaction[] = [];
      const waits: TurnWait[] = [];
      let harness: Harness | undefined;
      let contextTokens: number | undefined;
      let contextWindow: number | undefined;
      let resolvedModel: string | undefined;
      const subs = new Set<string>();
      const tools = new Map<string, TurnTool>();
      /** When each tool call really started running, by id (the runtimes that say: Claude). */
      const ran = new Map<string, number>();
      const thinking = { ms: 0, blocks: 0 };
      const onEvent: AgentRunInput['onEvent'] = (kind, text) => {
        input.onEvent(kind, text);
        try {
          if (kind === 'usage') {
            const u = parseUsage(text);
            if (u) {
              const { session: said, compactions: compacted, ...tokens } = u;
              usage = addUsage(usage, tokens);
              session = said ?? session;
              compactions += compacted ?? 0;
            }
          } else if (kind === 'compact') {
            // A compaction says its sizes; its summary comes apart (the same compaction, and its words stay here).
            const c = JSON.parse(text) as { pre?: unknown; post?: unknown; trigger?: unknown };
            if (typeof c.pre !== 'number') return;
            compactions++;
            compacted.push({ at: now(), ...(typeof c.trigger === 'string' ? { trigger: c.trigger.slice(0, 20) } : {}), pre: c.pre, ...(typeof c.post === 'number' ? { post: c.post } : {}) });
            if (typeof c.post === 'number') contextTokens = c.post;
          } else if (kind === 'context') {
            // The run's own word for its model (Claude's init message): an id, where the picker may hold a name ("opus").
            const said = JSON.parse(text) as { model?: unknown; used?: unknown; window?: unknown };
            if (typeof said.model === 'string' && said.model) resolvedModel = said.model;
            if (typeof said.used === 'number' && said.used > 0) contextTokens = said.used;
            if (typeof said.window === 'number' && said.window > 0) contextWindow = said.window;
          }
          else if (kind === 'sub') {
            const e = JSON.parse(text) as Partial<SubAgentEvent>;
            if (e.id && e.kind !== 'background') subs.add(e.id);
          }
        } catch {
          // Something it couldn't read: the run goes on, this turn just says less.
        }
      };
      const onStep = (record: StepRecord): void => {
        input.onStep?.(record);
        // Thinking: only how long it took and that it happened; its words stay in the step.
        if (record.kind === 'thinking') {
          thinking.ms += record.durationMs ?? 0;
          thinking.blocks++;
        }
        if (record.kind !== 'tool' || !record.tool) return;
        const ok = record.status !== 'error' && !record.isError;
        // A failure's class; and for Beluga's own tools, whose words Beluga wrote, those words short and stripped.
        const said = ok || !isBelugaTool(record.tool) ? undefined : safeErrorText(record.output);
        tools.set(record.id, {
          id: record.id,
          name: record.tool,
          startedAt: record.startedAt,
          ...(record.endedAt ? { endedAt: record.endedAt } : {}),
          ok,
          ...(ok ? {} : { error: toolErrorType(record) }),
          ...(said ? { errorMessage: said } : {}),
          ...(record.parent ? { parent: record.parent } : {}),
          ...(detail && record.input ? { input: record.input } : {}),
          ...(detail && record.output !== undefined ? { output: record.output } : {}),
          ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
          ...(record.native ? { native: record.native } : {}),
        });
      };
      /** A wait for a person, timed: the run gets the same answer, and only how it ended is kept. */
      const waited = async <T>(kind: WaitKind, tool: string, ask: () => Promise<T>, ended: (answer: T) => 'approved' | 'answered' | 'declined' | 'skipped', question?: string): Promise<T> => {
        const from = now();
        const answer = await ask();
        try {
          const to = now();
          const said = ended(answer);
          const outcome: WaitOutcome = (said === 'declined' || said === 'skipped') && to - from >= HUMAN_TIMEOUT_MS - 1_000 ? 'timeout' : said;
          // What was asked goes only on a run whose content may (never a friend's or a guest's).
          if (to - from >= HUMAN_MIN_MS || kind === 'question' || kind === 'plan') waits.push({ kind, tool, startedAt: from, endedAt: to, outcome, ...(content && question ? { question } : {}) });
        } catch {
          // Never the run's problem.
        }
        return answer;
      };
      const yes = (ok: boolean) => (ok ? 'approved' : 'declined');
      const asks: Partial<AgentRunInput> = {
        canUseTool: (tool, toolInput) => waited('permission', tool, () => input.canUseTool(tool, toolInput), yes),
        ...(input.canUseSecret ? { canUseSecret: (tool, toolInput) => waited('secret', tool, () => input.canUseSecret!(tool, toolInput), yes) } : {}),
        ...(input.askUser
          ? {
              askUser: (q) =>
                q.kind === 'plan'
                  ? waited('plan', 'ExitPlanMode', () => input.askUser!(q), (a) => (a.kind === 'plan' ? yes(a.approve) : 'skipped'))
                  : waited('question', 'AskUserQuestion', () => input.askUser!(q), (a) => (a.kind === 'answers' ? 'answered' : 'skipped'), q.questions.map((x) => x.question).join('\n')),
            }
          : {}),
        onHarness: (facts) => {
          input.onHarness?.(facts);
          harness = facts;
        },
        onToolRun: (id, at) => {
          input.onToolRun?.(id, at);
          if (!ran.has(id)) ran.set(id, at);
        },
      };
      const place = input.place ? { ...input.place, onSession: (id: string) => ((session = id), input.place!.onSession(id)) } : undefined;
      // Someone who set Claude Code's telemetry up in their own variables keeps theirs: nothing is added.
      const offered = deps.env?.(runtime);
      const extra = offered && !Object.keys(offered).some((k) => input.env?.[k] !== undefined) ? offered : undefined;
      const observed: AgentRunInput = { ...input, ...asks, onEvent, onStep, ...(place ? { place } : {}), ...(extra ? { env: { ...input.env, ...extra } } : {}) };
      const finish = (outcome: TurnOutcome, answer: string, err?: unknown): void => {
        const endedAt = now();
        const done = (): void => {
          try {
            const calls = session ? deps.calls?.(session, startedAt, endedAt + 1_000) : undefined;
            const refused = session ? deps.refused?.(session) : undefined;
            const links = session ? deps.links?.(session, [...tools.keys()]) : undefined;
            const sources = skillSources([...tools.values()], session ? (deps.skills?.(session, startedAt, endedAt + 1_000) ?? []) : []);
            const hooks = session ? deps.hooks?.(session, startedAt, endedAt + 1_000) : undefined;
            const context = deps.context?.(input);
            const model = input.place?.model ?? input.model;
            const effort = input.place?.effort ?? input.effort;
            deps.turn({
              runtime,
              ...(model ? { model } : {}),
              ...(resolvedModel && resolvedModel !== model ? { resolvedModel } : {}),
              ...(effort ? { effort } : {}),
              ...(session ? { session } : {}),
              startedAt,
              endedAt,
              outcome,
              ...(err !== undefined ? { errorKind: errorKind(err) } : {}),
              ...(err !== undefined && outcome === 'error' && errorMessage(err) ? { errorMessage: errorMessage(err)! } : {}),
              ...(usage ? { usage } : {}),
              ...(calls?.length ? { calls } : {}),
              tools: [...tools.values()].map((t) => ({
                ...t,
                ...(ran.has(t.id) && ran.get(t.id)! > t.startedAt ? { ranAt: ran.get(t.id)! } : {}),
                ...(!t.ok && refused?.has(t.id) ? { error: refused.get(t.id)! } : {}),
                ...links?.get(t.id),
                ...(sources.has(t.id) ? { skillSource: sources.get(t.id)! } : {}),
              })),
              own,
              ...(content ? { content } : {}),
              ...(slash ? { slash } : {}),
              place: placeOf(input),
              subagents: subs.size,
              compactions,
              promptChars: input.prompt.length,
              answerChars: answer.length,
              ...(thinking.blocks ? { thinking: { ...thinking } } : {}),
              // At "on", your own turns' text: the words you typed (never what Beluga added to the prompt,
              // nor the context: other people's words), and the answer. Masked before it's sent.
              ...(level === 'on' && input.ownWords !== undefined ? { text: { prompt: input.ownWords, answer } } : {}),
              ...(context ? { context } : {}),
              ...(harness ? { harness } : {}),
              ...(compacted.length ? { compacted } : {}),
              ...(waits.length ? { waits: [...waits] } : {}),
              ...(hooks?.length ? { hooks } : {}),
              ...(contextTokens !== undefined ? { contextTokens } : {}),
              ...(contextWindow !== undefined ? { contextWindow } : {}),
              ...(leftOut ? { leftOut } : {}),
            });
          } catch {
            // Never the run's problem.
          }
        };
        if ((deps.calls || deps.refused || deps.links || deps.skills || deps.hooks) && session) setTimeout(done, deps.settleMs ?? SETTLE_MS).unref?.();
        else done();
      };
      return backend.run(observed).then(
        (answer) => (finish('ok', answer), answer),
        (err: unknown) => {
          finish(thrownOutcome(err, input.signal), '', err);
          throw err;
        },
      );
    },
  });
}
