import path from 'node:path';
import type { StepRecord } from '../../../shared/steps.js';
import { summarizeTool } from '../../prompt.js';
import { StepRecorder } from '../../step-recorder.js';
import type { AgentRunInput } from '../../types.js';
import { contextWindowFor } from '../../../shared/context-usage.js';
import type { FileUpdateChange, ThreadItem, ThreadTokenUsage, TokenUsageBreakdown } from './protocol.js';

/**
 * A Codex turn as Beluga's transcript and steps (BLG-453). Codex's items become the tool calls
 * Beluga already draws: a command is a `Bash` step, a file change an `Edit` (or `Write` for a new
 * file), an MCP call `mcp__<server>__<tool>`, a web search `WebSearch`, reasoning a thinking step.
 * They go through the same StepRecorder as Claude's (shaped as its tool_use / tool_result blocks),
 * so the records, titles and words are the same and the screens need nothing Codex-specific.
 */

type OnEvent = AgentRunInput['onEvent'];

/** Where a turn's events and steps go (a follow-up's turn: the follow-up). */
export interface TurnSink {
  readonly onEvent: OnEvent;
  readonly onStep?: (record: StepRecord) => void;
}

/** A tool call as Beluga names it: Claude Code's tool names, so step titles and words read the same. */
export function toolCallOf(item: ThreadItem, cwd: string): { readonly name: string; readonly input: Record<string, unknown> } | undefined {
  switch (item.type) {
    case 'commandExecution': {
      const it = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      return { name: 'Bash', input: { command: unwrapShell(it.command), ...(it.cwd && it.cwd !== cwd ? { cwd: it.cwd } : {}) } };
    }
    case 'fileChange': {
      const changes = (item as Extract<ThreadItem, { type: 'fileChange' }>).changes;
      const first = changes[0];
      const file = first ? path.resolve(cwd, first.path) : cwd;
      if (first?.kind.type === 'add' && changes.length === 1) return { name: 'Write', input: { file_path: file } };
      return { name: 'Edit', input: { file_path: file, ...(changes.length > 1 ? { files: changes.map((c) => path.resolve(cwd, c.path)) } : {}) } };
    }
    case 'mcpToolCall': {
      const it = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
      const args = it.arguments && typeof it.arguments === 'object' && !Array.isArray(it.arguments) ? (it.arguments as Record<string, unknown>) : {};
      return { name: `mcp__${it.server}__${it.tool}`, input: args };
    }
    case 'webSearch':
      return { name: 'WebSearch', input: { query: (item as Extract<ThreadItem, { type: 'webSearch' }>).query } };
    case 'imageView':
      return { name: 'Read', input: { file_path: (item as Extract<ThreadItem, { type: 'imageView' }>).path } };
    default:
      return undefined;
  }
}

/** What a finished tool call gave back, as a tool_result's content, and whether it failed. */
export function toolResultOf(item: ThreadItem): { readonly content: unknown; readonly isError: boolean; readonly exitCode?: number } {
  switch (item.type) {
    case 'commandExecution': {
      const it = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      const failed = it.status === 'failed' || it.status === 'declined' || (it.exitCode !== null && it.exitCode !== 0);
      const out = it.aggregatedOutput ?? '';
      return { content: it.status === 'declined' ? out || 'Declined.' : it.exitCode && !out ? `Exited with code ${it.exitCode}` : out, isError: failed, ...(typeof it.exitCode === 'number' ? { exitCode: it.exitCode } : {}) };
    }
    case 'fileChange': {
      const it = item as Extract<ThreadItem, { type: 'fileChange' }>;
      return { content: it.changes.map((c) => c.diff).join('\n'), isError: it.status !== 'completed' };
    }
    case 'mcpToolCall': {
      const it = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
      return it.error ? { content: it.error.message, isError: true } : { content: it.result?.content ?? '', isError: it.status === 'failed' };
    }
    default:
      return { content: '', isError: false };
  }
}

/**
 * The command Codex ran, without the login shell around it (`/bin/zsh -lc 'npm test'` → `npm test`),
 * so it reads like the command the agent meant.
 */
export function unwrapShell(command: string): string {
  const m = /^(?:\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return m ? m[2]! : command;
}

/**
 * Tokens a turn used, in the shape Beluga's usage events carry (Claude's usageOf). Codex reports no
 * cost (0: not known). For usage statistics only: the tokens it spent reasoning (part of `output`)
 * and how many times the turn compacted the conversation.
 */
export function usageEvent(last: TokenUsageBreakdown, session: string, more: { readonly compactions?: number } = {}): string {
  return JSON.stringify({
    input: Math.max(0, last.inputTokens - last.cachedInputTokens),
    output: last.outputTokens,
    cacheRead: last.cachedInputTokens,
    cacheWrite: 0,
    cost: 0,
    session,
    ...(last.reasoningOutputTokens > 0 ? { thinking: last.reasoningOutputTokens } : {}),
    ...(more.compactions ? { compactions: more.compactions } : {}),
  });
}

/**
 * The context meter's event (as ContextReport sends Claude's): what's in the window after the last
 * response (its whole input, cached included, plus what it wrote, as Codex counts it) and the
 * model's window, as Codex reported it (else Beluga's guess for `model`). Undefined: nothing used yet.
 */
export function contextEvent(usage: ThreadTokenUsage | undefined, model?: string): string | undefined {
  const used = usedOf(usage);
  if (!(used > 0)) return undefined;
  const window = contextWindowFor(model, usage?.modelContextWindow ?? undefined);
  return JSON.stringify({ used, window, ...(model ? { model } : {}) });
}

/** What's in the window after the last response, as Codex counts it (0: nothing yet). */
export function usedOf(usage: ThreadTokenUsage | undefined): number {
  return usage?.last ? usage.last.totalTokens || usage.last.inputTokens + usage.last.outputTokens : 0;
}

/**
 * The divider's event for a compaction (as ContextReport sends Claude's): how full the window was
 * before and after. `post` is Codex's first count after it (it counts the new history right away);
 * none came: unknown, left out. `trigger`: Beluga asked (manual) or Codex did it by itself (auto).
 */
export function compactEvent(pre: number, after: ThreadTokenUsage | undefined, trigger: 'manual' | 'auto', model?: string): string {
  const post = usedOf(after);
  const window = after ? contextWindowFor(model, after.modelContextWindow ?? undefined) : undefined;
  return JSON.stringify({ pre, ...(after && post > 0 ? { post } : {}), trigger, ...(window ? { window } : {}) });
}

/** Follows one run's notifications: events and steps to the current turn's sink. */
export class CodexEvents {
  private sink: TurnSink;
  private readonly recorder: StepRecorder;
  /** Tools running now (for Steer.status). */
  readonly tools = new Map<string, { label: string; since: number }>();
  /** A file change's paths, by item, so its approval can be judged per file. */
  readonly changes = new Map<string, readonly FileUpdateChange[]>();
  /** The agent's messages this turn, in order: the last is its answer. */
  private texts: string[] = [];
  private usage?: TokenUsageBreakdown;
  /**
   * Compactions this turn, as Codex says them: a contextCompaction item and, still, the deprecated
   * thread/compacted for the same one (either alone on another version). The turn's count is the larger.
   */
  private compactItems = 0;
  private compactNotes = 0;
  /** A compaction waiting for Codex's next count (its divider's "after"): how full it was before. */
  private compactedFrom?: number;
  /** Beluga asked for this compaction (/compact): its divider says manual, else Codex did it (auto). */
  private compactAsked = false;
  /** What's in the window as Codex last counted it (across turns: a compaction's "before"). */
  private used = 0;
  lastEventAt = Date.now();
  thinking = false;

  constructor(
    private readonly cwd: string,
    sink: TurnSink,
    private readonly opts: {
      readonly onFileTouched?: (abs: string) => void;
      readonly expand?: (text: string) => string;
      readonly now?: () => number;
      /** Each token update (the context meter). */
      readonly onTokens?: (usage: ThreadTokenUsage) => void;
      /** The model the thread runs on (a divider's window when Codex didn't say it). */
      readonly model?: () => string | undefined;
      /** Codex's sub-agents (subagents.ts): sees each notification first; what it takes is theirs, not the lead's. */
      readonly subAgents?: { handle(method: string, params: Record<string, unknown>): boolean };
    } = {},
  ) {
    this.sink = sink;
    this.recorder = new StepRecorder({ cwd, emit: (record) => this.sink.onStep?.(record), ...(opts.now ? { now: opts.now } : {}) });
  }

  /** A turn begins, answering for `sink`: thinking before its first step counts from here. */
  beginTurn(sink: TurnSink): void {
    this.sink = sink;
    this.texts = [];
    this.usage = undefined;
    this.compactItems = 0;
    this.compactNotes = 0;
    this.compactedFrom = undefined;
    this.compactAsked = false;
    this.recorder.begin();
  }

  /** This turn is a compaction Beluga asked for (thread/compact/start): its divider comes when it's done. */
  compactionAsked(): void {
    this.compactAsked = true;
    this.compactedFrom = this.used;
  }

  /** What the turn said last (its answer), the tokens it used and how often it compacted. Steps it left open end with it. */
  endTurn(completed = true): { readonly text: string; readonly usage?: TokenUsageBreakdown; readonly compactions: number } {
    this.recorder.finish(!completed);
    this.tools.clear();
    this.thinking = false;
    const compactions = Math.max(this.compactItems, this.compactNotes);
    // No count came after it: the divider without its "after". One asked for that never happened (stopped, failed): none.
    if (completed || compactions > 0) this.compacted(undefined);
    this.compactedFrom = undefined;
    this.compactAsked = false;
    return { text: this.texts.at(-1) ?? '', ...(this.usage ? { usage: this.usage } : {}), compactions };
  }

  /** Codex said it compacted (`item`: its contextCompaction item; else thread/compacted): only one of a pair waits for the count. */
  private compaction(item: boolean): void {
    if (item) this.compactItems++;
    else this.compactNotes++;
    const unpaired = item ? this.compactItems > this.compactNotes : this.compactNotes > this.compactItems;
    if (unpaired) this.compactedFrom ??= this.used;
  }

  /** A compaction waiting for its count: its divider, with `after` (Codex's count of the new history) when it came. */
  private compacted(after: ThreadTokenUsage | undefined): void {
    if (this.compactedFrom === undefined) return;
    const pre = this.compactedFrom;
    this.compactedFrom = undefined;
    this.sink.onEvent('compact', compactEvent(pre, after, this.compactAsked ? 'manual' : 'auto', this.opts.model?.()));
  }

  /** The run ended: steps still open end with it. */
  finish(failed: boolean): void {
    this.recorder.finish(failed);
  }

  handle(method: string, params: Record<string, unknown>): void {
    this.lastEventAt = (this.opts.now ?? Date.now)();
    if (this.opts.subAgents?.handle(method, params)) return;
    if (method === 'item/started') return this.started(params.item as ThreadItem);
    if (method === 'item/completed') return this.completed(params.item as ThreadItem);
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') this.thinking = true;
    if (method === 'item/agentMessage/delta') this.thinking = false;
    if (method === 'thread/tokenUsage/updated') {
      const tokens = params.tokenUsage as ThreadTokenUsage | undefined;
      this.usage = tokens?.last;
      if (tokens) {
        this.compacted(tokens);
        this.used = usedOf(tokens) || this.used;
        this.opts.onTokens?.(tokens);
      }
    }
    // Compacted (asked for, or by itself when the window filled): a divider in the chat, as Claude's.
    if (method === 'thread/compacted') this.compaction(false);
    if (method === 'error' && params.willRetry) this.sink.onEvent('progress', 'Codex is retrying');
  }

  private started(item: ThreadItem): void {
    if (!item?.id) return;
    if (item.type === 'fileChange') this.changes.set(item.id, (item as Extract<ThreadItem, { type: 'fileChange' }>).changes);
    const call = toolCallOf(item, this.cwd);
    if (!call) return;
    this.thinking = false;
    const label = summarizeTool(call.name, call.input, this.cwd);
    this.tools.set(item.id, { label: call.name === 'Bash' ? String(call.input.command).split('\n')[0]!.slice(0, 80) : label, since: Date.now() });
    this.sink.onEvent('tool', label);
    this.recorder.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: call.name, input: call.input, native: item.type }] } });
  }

  private completed(item: ThreadItem): void {
    if (!item?.id) return;
    if (item.type === 'contextCompaction') return this.compaction(true);
    if (item.type === 'agentMessage') {
      const text = (item as Extract<ThreadItem, { type: 'agentMessage' }>).text.trim();
      if (!text) return;
      this.texts.push(text);
      this.sink.onEvent('text', this.opts.expand ? this.opts.expand(text) : text);
      return;
    }
    if (item.type === 'reasoning') {
      const it = item as Extract<ThreadItem, { type: 'reasoning' }>;
      const words = (it.summary.length ? it.summary : it.content).join('\n\n');
      this.recorder.observe({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: words }] } });
      return;
    }
    if (item.type === 'fileChange') {
      for (const change of (item as Extract<ThreadItem, { type: 'fileChange' }>).changes) this.opts.onFileTouched?.(path.resolve(this.cwd, change.path));
      this.changes.delete(item.id);
    }
    if (!toolCallOf(item, this.cwd)) return;
    // An item that only completes (no started first) still gets its step.
    if (!this.tools.has(item.id)) this.started(item);
    this.tools.delete(item.id);
    const { content, isError, exitCode } = toolResultOf(item);
    this.recorder.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: item.id, content, is_error: isError, ...(exitCode !== undefined ? { exit_code: exitCode } : {}) }] } });
    if (!this.tools.size) this.sink.onEvent('progress', '');
  }
}
