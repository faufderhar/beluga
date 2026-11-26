import { type StepRecord, boundInput, boundText, redactSecrets, resultText, thinkingOf, thinkingTitle, wordsOf } from '../shared/steps.js';
import { summarizeTool } from './prompt.js';

/**
 * Follows a Claude Agent SDK message stream and keeps a record of every step: each tool call
 * (its input, then its result and how long it took) and each stretch of thinking. Sub-agents'
 * steps are recorded too, tagged with the sub-agent they belong to. Every change to a record
 * goes to `emit` as the whole record (bounded and with secrets redacted, see shared/steps.ts).
 * Pure apart from the clock; no I/O.
 */

interface Block {
  readonly type?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
  readonly thinking?: unknown;
  /** A tool_use: the runtime's own name for the tool, when `name` is Claude Code's for it (Codex). */
  readonly native?: string;
  /** A tool_result: the command's exit code, when the runtime gives it apart from the output (Codex). */
  readonly exit_code?: number | null;
}

/** The parts of an SDK message the recorder reads. */
export interface RecorderMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly parent_tool_use_id?: string | null;
  readonly message?: { readonly content?: unknown };
  readonly tool_use_id?: string;
  readonly elapsed_time_seconds?: number;
}

export interface StepRecorderOptions {
  /** Paths in titles are shown relative to this folder. */
  readonly cwd?: string;
  readonly emit: (record: StepRecord) => void;
  readonly now?: () => number;
}

/** What a step that never finished says came back (its run stopped, or failed, first). */
export const STOPPED_OUTPUT = 'Stopped before it finished';

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]).filter((b) => b && typeof b === 'object') : []);

export class StepRecorder {
  private readonly open = new Map<string, StepRecord>();
  /** When each thread (main, or a sub-agent) last heard something: thinking took from then until it arrived. */
  private readonly lastAt = new Map<string, number>();
  private thoughts = 0;
  private readonly now: () => number;

  constructor(private readonly opts: StepRecorderOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The run started (its prompt went in): thinking before the first step counts from here. */
  begin(): void {
    this.lastAt.set('', this.now());
  }

  observe(msg: RecorderMessage): void {
    const parent = msg.parent_tool_use_id ?? undefined;
    const thread = parent ?? '';
    const now = this.now();
    if (msg.type === 'assistant') {
      for (const block of blocksOf(msg.message?.content)) {
        if (block.type === 'thinking' || block.type === 'redacted_thinking') this.thinking(block, parent, thread, now);
        else if (block.type === 'tool_use' && block.id && block.name) this.toolUse(block, parent, now);
      }
      this.lastAt.set(thread, now);
      return;
    }
    if (msg.type === 'user') {
      for (const block of blocksOf(msg.message?.content)) if (block.type === 'tool_result' && block.tool_use_id) this.toolResult(block, now);
      this.lastAt.set(thread, now);
      return;
    }
    // A long tool call reporting it's still going: the step's clock moves on screen.
    if (msg.type === 'tool_progress' && msg.tool_use_id && typeof msg.elapsed_time_seconds === 'number') {
      const rec = this.open.get(msg.tool_use_id);
      if (rec) this.update({ ...rec, durationMs: Math.round(msg.elapsed_time_seconds * 1000) });
    }
  }

  /** The run ended: steps still open end with it (stopped, or never answered). */
  finish(failed: boolean): void {
    const now = this.now();
    for (const rec of [...this.open.values()]) {
      this.open.delete(rec.id);
      this.opts.emit({ ...rec, status: failed ? 'error' : 'done', endedAt: now, durationMs: now - rec.startedAt, ...(failed ? { isError: true, output: rec.output ?? STOPPED_OUTPUT } : {}) });
    }
  }

  private update(rec: StepRecord): void {
    this.open.set(rec.id, rec);
    this.opts.emit(rec);
  }

  private thinking(block: Block, parent: string | undefined, thread: string, now: number): void {
    const { text, hidden, truncated } = block.type === 'redacted_thinking' ? { text: '', hidden: true, truncated: false } : thinkingOf(block);
    const since = this.lastAt.get(thread);
    const durationMs = since !== undefined ? Math.max(0, now - since) : undefined;
    this.opts.emit({
      id: `think-${++this.thoughts}`,
      kind: 'thinking',
      title: thinkingTitle(durationMs, hidden),
      status: 'done',
      startedAt: since ?? now,
      endedAt: now,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(hidden ? { hidden: true } : { text }),
      ...(truncated ? { truncated: true } : {}),
      ...(parent ? { parent } : {}),
    });
  }

  private toolUse(block: Block, parent: string | undefined, now: number): void {
    const raw = (block.input ?? {}) as Record<string, unknown>;
    const { input, truncated } = boundInput(raw);
    this.update({
      id: block.id!,
      kind: 'tool',
      tool: block.name!,
      title: redactSecrets(summarizeTool(block.name!, raw, this.opts.cwd)),
      ...wordsOf(block.name!, raw, this.opts.cwd),
      status: 'running',
      startedAt: now,
      input,
      ...(truncated ? { truncated: true } : {}),
      ...(parent ? { parent } : {}),
      ...(block.native ? { native: block.native } : {}),
    });
  }

  private toolResult(block: Block, now: number): void {
    const rec = this.open.get(block.tool_use_id!);
    if (!rec) return;
    this.open.delete(rec.id);
    const out = boundText(redactSecrets(resultText(block.content)));
    const error = block.is_error === true;
    this.opts.emit({
      ...rec,
      status: error ? 'error' : 'done',
      endedAt: now,
      durationMs: now - rec.startedAt,
      output: out.text,
      ...(error ? { isError: true } : {}),
      ...(typeof block.exit_code === 'number' ? { exitCode: block.exit_code } : {}),
      ...(out.truncated || rec.truncated ? { truncated: true } : {}),
    });
  }
}
