import type { StepRecord } from '../../../shared/steps.js';
import { contextWindowFor } from '../../../shared/context-usage.js';
import { summarizeTool } from '../../prompt.js';
import { StepRecorder } from '../../step-recorder.js';
import type { AgentRunInput, SubAgentEvent } from '../../types.js';
import type { PromptResponse, SessionUpdate, ToolCall } from './acp.js';
import { type BelugaCall, belugaCalls, resultText, touchedFiles } from './tools.js';

/** What differs between one ACP agent and another: how it names its tools, and what they mean. OpenCode's unless a run says otherwise (Grok Build's: grok/runner.ts). */
export interface EventsDialect {
  /** Which tool a call is (the name the rest of this table goes by). */
  readonly toolOf: (call: Pick<ToolCall, 'title' | 'rawInput' | '_meta'>) => string;
  readonly calls: (tool: string, raw: Record<string, unknown>, cwd: string, suites?: readonly string[]) => BelugaCall[];
  readonly result: (call: ToolCall) => string;
  /** Tools that change files. */
  readonly writes: ReadonlySet<string>;
  /** Its sub-agent tool: each call a row on the card. */
  readonly subAgent: string;
  /** A tool whose input may come after its permission request, so judging it waits for that. */
  readonly needsInput: (tool: string) => boolean;
}

/**
 * An OpenCode turn as Beluga's transcript and steps (BLG-686). ACP streams the answer in chunks and
 * each tool call as a `tool_call` then its updates; they become the same tool_use / tool_result
 * blocks Claude's do (through StepRecorder), named as Claude Code's tools (tools.ts), so the
 * screens need nothing OpenCode-specific. Its `task` tool (a sub-agent) is a sub-agent row too.
 */

type OnEvent = AgentRunInput['onEvent'];

/** Where a turn's events and steps go (a follow-up's turn: the follow-up). */
export interface TurnSink {
  readonly onEvent: OnEvent;
  readonly onStep?: (record: StepRecord) => void;
}

/** One call as it's known so far: OpenCode's tool id (its first title), its latest input, whether its step began. */
interface Known {
  readonly tool: string;
  raw: Record<string, unknown>;
  started: boolean;
  calls: BelugaCall[];
}

/** Tokens a turn used, in the shape Beluga's usage events carry (Claude's usageOf); cost: what OpenCode says this turn cost. */
export function usageEvent(usage: PromptResponse['usage'], session: string, cost = 0): string | undefined {
  if (!usage) return undefined;
  const cacheRead = usage.cachedReadTokens ?? 0;
  return JSON.stringify({ input: Math.max(0, usage.inputTokens ?? 0), output: (usage.outputTokens ?? 0) + (usage.thoughtTokens ?? 0), cacheRead, cacheWrite: usage.cachedWriteTokens ?? 0, cost: Math.max(0, cost), session });
}

/** The context meter's event (as Claude's): what's in the window now, and the window, as OpenCode says it. */
export function contextEvent(used: number, size: number, model?: string): string | undefined {
  if (!(used > 0)) return undefined;
  return JSON.stringify({ used, window: contextWindowFor(model, size > 0 ? size : undefined), ...(model ? { model } : {}) });
}

/** Follows one run's session updates: events and steps to the current turn's sink. */
export class OpenCodeEvents {
  private sink: TurnSink;
  private readonly recorder: StepRecorder;
  private readonly dialect: EventsDialect;
  private readonly calls = new Map<string, Known>();
  /** Tools running now (for Steer.status). */
  readonly tools = new Map<string, { label: string; since: number }>();
  /** Why Beluga turned a call down, by call: its step says that, not OpenCode's generic words. */
  readonly denied = new Map<string, string>();
  /** The turn's words: each stretch between steps, the last is its answer. */
  private texts: string[] = [];
  private text = '';
  private thought = '';
  /** What's in the context window now (usage_update), and the session's running cost. */
  context = { used: 0, size: 0 };
  cost = 0;
  lastEventAt = Date.now();
  thinking = false;
  /** The turn is being stopped: a step that ends now was cut short (OpenCode reports a cancelled command as completed). */
  stopping = false;
  /** Waiters for a call's input (a permission request can come before OpenCode has said what the call is for). */
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly cwd: string,
    sink: TurnSink,
    private readonly opts: {
      readonly onFileTouched?: (abs: string) => void;
      readonly expand?: (text: string) => string;
      readonly now?: () => number;
      /** Beluga's tool suites mounted for the run (their MCP names). */
      readonly suites?: readonly string[];
      /** Each context change (the meter). */
      readonly onContext?: (used: number, size: number) => void;
      /** Sub-agent rows: OpenCode's `task` tool (its general and explore agents). */
      readonly onSub?: (e: SubAgentEvent) => void;
      /** The turn's words stay out of the chat (a /compact's summary). */
      readonly quiet?: () => boolean;
      /** Another ACP agent's tools; unset: OpenCode's. */
      readonly dialect?: EventsDialect;
    } = {},
  ) {
    this.sink = sink;
    this.dialect = opts.dialect ?? OPENCODE_DIALECT;
    this.recorder = new StepRecorder({ cwd, emit: (record) => this.sink.onStep?.(record), ...(opts.now ? { now: opts.now } : {}) });
  }

  /** A turn begins, answering for `sink`. */
  beginTurn(sink: TurnSink): void {
    this.sink = sink;
    this.texts = [];
    this.text = '';
    this.thought = '';
    this.stopping = false;
    this.recorder.begin();
  }

  /** What the turn said last (its answer). Steps it left open end with it. */
  endTurn(completed = true): string {
    this.flush();
    for (const [id, known] of this.calls) if (known.started && known.tool === this.dialect.subAgent) this.opts.onSub?.({ id, phase: 'done', failed: !completed });
    this.recorder.finish(!completed);
    this.tools.clear();
    this.calls.clear();
    this.thinking = false;
    return this.texts.at(-1) ?? '';
  }

  /** The run ended: steps still open end with it. */
  finish(failed: boolean): void {
    this.recorder.finish(failed);
  }

  /**
   * A call as Beluga judges it: its tool and, for one whose input OpenCode hasn't sent yet (a read's
   * permission comes before its path), waits up to `waitMs` for it. Undefined: never heard of.
   */
  async callOf(toolCall: ToolCall, waitMs = 3_000): Promise<{ readonly tool: string; readonly raw: Record<string, unknown> } | undefined> {
    const known = this.calls.get(toolCall.toolCallId);
    const merged = (): Record<string, unknown> => ({ ...(this.calls.get(toolCall.toolCallId)?.raw ?? {}), ...(toolCall.rawInput ?? {}) });
    const tool = known?.tool ?? this.dialect.toolOf(toolCall);
    if (!tool) return undefined;
    if (!this.dialect.needsInput(tool) || Object.keys(merged()).some((k) => INPUT_KEYS.has(k))) return { tool, raw: merged() };
    const until = Date.now() + waitMs;
    while (Date.now() < until && !Object.keys(merged()).some((k) => INPUT_KEYS.has(k))) {
      await new Promise<void>((resolve) => {
        const wake = (): void => (this.waiters.delete(wake), resolve());
        this.waiters.add(wake);
        setTimeout(wake, Math.max(0, until - Date.now()));
      });
    }
    return { tool, raw: merged() };
  }

  handle(update: SessionUpdate): void {
    this.lastEventAt = (this.opts.now ?? Date.now)();
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.thinkingDone();
        this.thinking = false;
        if (update.content.type === 'text' && update.content.text) this.text += update.content.text;
        return;
      case 'agent_thought_chunk':
        this.thinking = true;
        if (update.content.type === 'text' && update.content.text) this.thought += update.content.text;
        return;
      case 'tool_call':
      case 'tool_call_update':
        return this.toolUpdate(update);
      case 'usage_update':
        this.context = { used: update.used, size: update.size };
        if (update.cost) this.cost = update.cost.amount;
        this.opts.onContext?.(update.used, update.size);
        return;
      default:
        return;
    }
  }

  /** Words said so far go out as one message (a step, or the turn's end, follows them). */
  private flush(): void {
    this.thinkingDone();
    const text = this.text.trim();
    this.text = '';
    if (!text) return;
    this.texts.push(text);
    if (!this.opts.quiet?.()) this.sink.onEvent('text', this.opts.expand ? this.opts.expand(text) : text);
  }

  private thinkingDone(): void {
    const words = this.thought.trim();
    this.thought = '';
    if (words) this.recorder.observe({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: words }] } });
  }

  private toolUpdate(call: ToolCall & { readonly sessionUpdate: string }): void {
    const id = call.toolCallId;
    let known = this.calls.get(id);
    if (!known) {
      known = { tool: this.dialect.toolOf(call) || 'tool', raw: {}, started: false, calls: [] };
      this.calls.set(id, known);
    }
    if (call.rawInput && Object.keys(call.rawInput).length) known.raw = { ...known.raw, ...call.rawInput };
    for (const wake of [...this.waiters]) wake();
    const done = call.status === 'completed' || call.status === 'failed';
    if (!known.started && (done || call.status === 'in_progress' || Object.keys(known.raw).some((k) => INPUT_KEYS.has(k)))) this.start(id, known);
    if (!done) return;
    const failed = call.status === 'failed' || this.stopping;
    const output = this.denied.get(id) ?? this.dialect.result(call);
    if (!failed && this.dialect.writes.has(known.tool)) for (const file of touchedFiles(call, this.cwd).length ? touchedFiles(call, this.cwd) : known.calls.map((c) => String(c.input.file_path ?? '')).filter(Boolean)) this.opts.onFileTouched?.(file);
    if (known.tool === this.dialect.subAgent) this.opts.onSub?.({ id, phase: 'done', ...(failed ? { failed: true } : {}) });
    this.recorder.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output || (failed ? 'Failed.' : ''), is_error: failed }] } });
    this.tools.delete(id);
    this.calls.delete(id);
    this.denied.delete(id);
    if (!this.tools.size) this.sink.onEvent('progress', '');
  }

  private start(id: string, known: Known): void {
    this.flush();
    this.thinking = false;
    known.started = true;
    known.calls = this.dialect.calls(known.tool, known.raw, this.cwd, this.opts.suites);
    const call = known.calls[0]!;
    const label = summarizeTool(call.name, call.input, this.cwd);
    this.tools.set(id, { label: call.name === 'Bash' ? String(call.input.command).split('\n')[0]!.slice(0, 80) : label, since: Date.now() });
    this.sink.onEvent('tool', label);
    if (known.tool === this.dialect.subAgent) this.opts.onSub?.({ id, phase: 'start', title: String(call.input.description || 'Sub-agent'), kind: 'agent' });
    this.recorder.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: call.name, input: call.input }] } });
  }
}

/** Tools whose permission is judged on a path or a command OpenCode sends after the call starts. */
const NEEDS_INPUT = new Set(['read', 'write', 'edit', 'multiedit', 'patch', 'apply_patch', 'bash', 'glob', 'grep', 'list', 'lsp', 'webfetch']);
const INPUT_KEYS = new Set(['filePath', 'file_path', 'filepath', 'path', 'command', 'pattern', 'patchText', 'url']);
const WRITES = new Set(['write', 'edit', 'multiedit', 'patch', 'apply_patch']);

const OPENCODE_DIALECT: EventsDialect = { toolOf: (call) => call.title ?? '', calls: belugaCalls, result: resultText, writes: WRITES, subAgent: 'task', needsInput: (tool) => NEEDS_INPUT.has(tool) };
