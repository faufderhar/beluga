import { randomUUID } from 'node:crypto';
import type { AgentBackend, AgentPlace } from '../agent/types.js';
import { COMPACT_INSTRUCTIONS, autoCompactDue, clampThreshold } from '../shared/context-usage.js';
import { savedModelWindow } from '../shared/open-models.js';
import type { Store } from './store.js';

/** What the compactor needs from the agent host. */
export interface CompactorDeps {
  readonly store: Store;
  readonly agent: () => AgentBackend | undefined;
  /** Where the conversation's Claude runs (a workspace's folder and session), if it's a workspace. */
  readonly place: (channel: string) => AgentPlace | undefined;
  /** Send one of your Claude's events for the conversation (to you and whoever follows it). */
  readonly emit: (requestId: string, kind: 'context' | 'compact' | 'usage', text: string, channel: string) => void;
  readonly requesterName: () => string;
  readonly modelFor: (place?: AgentPlace) => { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
}

type Trigger = 'manual' | 'auto';

/**
 * Compacting conversations: Claude summarizes its working memory and continues from the summary,
 * while the chat stays on screen with a divider where it happened. Runs only between Claude's
 * turns (the agent host runs it in the conversation's queue), never in the middle of a tool call.
 * Auto-compact follows Settings › Claude: past the threshold when a run ends, or before the next
 * message goes, the conversation is compacted first.
 */
export class Compactor {
  /** Context per conversation, as your Claude's runs reported it (ahead of the store's copy). */
  private readonly seen = new Map<string, { used: number; window: number }>();
  /** Auto-compacted with no run since: don't try again until Claude has run (a big summary would loop). */
  private readonly tried = new Set<string>();

  constructor(private readonly deps: CompactorDeps) {}

  /** A run's event: keep the latest numbers for the conversation. */
  observe(channel: string, kind: string, text: string): void {
    if (kind !== 'context' && kind !== 'compact') return;
    let data: { used?: unknown; window?: unknown; post?: unknown; pre?: unknown };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      return;
    }
    const prev = this.seen.get(channel);
    const window = typeof data.window === 'number' && data.window > 0 ? data.window : (prev?.window ?? this.deps.store.getState().context[channel]?.window ?? 200_000);
    const used = kind === 'compact' ? (typeof data.pre === 'number' ? (typeof data.post === 'number' ? data.post : 0) : undefined) : typeof data.used === 'number' ? data.used : undefined;
    if (used !== undefined) this.seen.set(channel, { used, window });
  }

  /** A normal run finished here: auto-compact may try again. */
  ran(channel: string): void {
    this.tried.delete(channel);
  }

  /** Forget a conversation's numbers (its chat was cleared, or it starts fresh). */
  forget(channel: string): void {
    this.seen.delete(channel);
    this.tried.delete(channel);
  }

  /** Is this conversation full enough that it should be compacted before anything else runs? */
  due(channel: string): boolean {
    const state = this.deps.store.getState();
    const prefs = state.prefs;
    const stored = state.context[channel];
    const info = this.seen.get(channel) ?? stored;
    const place = channel === 'room' ? undefined : this.deps.place(channel);
    const runtime = place?.agent?.runtime ?? prefs.defaultAgent?.runtime ?? 'claude';
    const picked = place?.model ?? place?.agent?.model ?? (runtime === 'claude' ? (prefs.model ?? '') : undefined);
    const reported = stored?.model;
    const over = savedModelWindow(prefs.modelWindows, runtime, picked) ?? (reported !== picked ? savedModelWindow(prefs.modelWindows, runtime, reported) : undefined);
    const counted = info && over ? { used: info.used, window: over } : info;
    return autoCompactDue({ on: prefs.autoCompact, at: prefs.autoCompactAt, ...(counted ? { info: counted } : {}), triedSinceRun: this.tried.has(channel) });
  }

  /** For a run: the threshold Claude Code's own auto-compact should use (nothing when it's off). */
  threshold(): { autoCompactAt?: number } {
    const prefs = this.deps.store.getState().prefs;
    return prefs.autoCompact ? { autoCompactAt: clampThreshold(prefs.autoCompactAt) } : {};
  }

  /**
   * Compact one conversation now. The chat shows "Compacting…" until it's done, then the divider
   * (with the summary Claude kept). Resolves when Claude is done, whatever happened.
   */
  async run(channel: string, trigger: Trigger, signal: AbortSignal, instructions = ''): Promise<void> {
    const agent = this.deps.agent();
    if (!agent) return;
    if (trigger === 'auto') this.tried.add(channel);
    const requestId = `compact-${randomUUID()}`;
    const place = channel === 'room' ? undefined : this.deps.place(channel);
    if (channel !== 'room' && !place) return;
    const info = this.seen.get(channel) ?? this.deps.store.getState().context[channel];
    const emit = (kind: 'context' | 'compact' | 'usage', text: string): void => this.deps.emit(requestId, kind, text, channel);
    emit('context', JSON.stringify({ compacting: true, trigger, ...(info ? { used: info.used, window: info.window } : {}) }));
    let landed = false;
    try {
      await agent.run({
        prompt: `/compact ${instructions.trim() || COMPACT_INSTRUCTIONS}`,
        requesterName: this.deps.requesterName(),
        viaAgent: false,
        context: [],
        scope: 'full',
        signal,
        ...(place ? { place } : {}),
        // Compacting only rewrites Claude's memory: the chat (text, steps) shows nothing of it but the divider.
        onEvent: (kind, text) => {
          if (kind !== 'context' && kind !== 'compact' && kind !== 'usage') return;
          if (kind === 'compact') landed = true;
          const out = kind === 'compact' ? withTrigger(text, trigger, info?.used) : text;
          this.observe(channel, kind, out);
          emit(kind, out);
        },
        onFileTouched: () => undefined,
        canUseTool: async () => false,
        ...this.deps.modelFor(place),
      });
    } catch {
      // Stopped or failed: the divider says it didn't finish (below).
    } finally {
      if (!landed) emit('context', JSON.stringify({ compacting: false, ...(info ? { used: info.used, window: info.window } : {}) }));
    }
  }
}

/**
 * Claude Code always calls /compact "manual"; say auto when Beluga started it. A runtime that
 * can't tell how full it was before (OpenCode: each run is a new process, its first number comes
 * after the compaction) says 0: then it's what Beluga last saw (`before`).
 */
function withTrigger(text: string, trigger: Trigger, before?: number): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const pre = data.pre === 0 && before ? { pre: before } : {};
    return typeof data.pre === 'number' ? JSON.stringify({ ...data, ...pre, trigger }) : text;
  } catch {
    return text;
  }
}
