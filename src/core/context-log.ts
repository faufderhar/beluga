import { type ContextBreakdown, DEFAULT_CONTEXT_WINDOW, MAX_SUMMARY_CHARS, formatTokenCount } from '../shared/context-usage.js';

// Context meter updates and compactions, applied to the conversation: the meter's numbers, and a
// divider in the chat where Claude's working memory was compacted (the messages all stay).

/** A compaction, as its divider in the chat shows it. */
export interface CompactMark {
  /** Running (Claude is summarizing), done, or it didn't finish (the conversation is unchanged). */
  readonly state: 'running' | 'done' | 'failed';
  readonly pre?: number;
  readonly post?: number;
  /** You asked for it (Compact now, /compact), or it happened because the context was nearly full. */
  readonly trigger?: 'manual' | 'auto';
  /** What Claude kept: the summary it continues from. */
  readonly summary?: string;
  /** Pairs a summary that arrives later with its compaction (Claude Code's boundary id). */
  readonly key?: string;
}

/** How full a conversation's context window is. */
export interface ContextInfo {
  readonly used: number;
  readonly window: number;
  /** Claude is compacting this conversation right now. */
  readonly compacting?: boolean;
  /** Roughly where the tokens come from, when Claude Code reported it. */
  readonly breakdown?: ContextBreakdown;
  /** The model the window is for. */
  readonly model?: string;
  /**
   * Cache reads and writes inside `used`, when the agent reported them. The meter turns these
   * into the hit rate while a turn is still running, before the usage ledger has this turn.
   */
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** The slice of a system log item this module writes. */
export interface CompactItem {
  readonly id: string;
  readonly type: 'system';
  readonly channel: string;
  readonly text: string;
  readonly ts: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly compact?: CompactMark;
}

/** A 'context' or 'compact' agent event's JSON (anything else in it is ignored). */
export interface ContextEventData {
  readonly used?: number;
  readonly window?: number;
  readonly compacting?: boolean;
  readonly breakdown?: ContextBreakdown;
  readonly model?: string;
  /** Cache reads and writes inside `used` (see ContextInfo). */
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly pre?: number;
  readonly post?: number;
  readonly trigger?: string;
  readonly summary?: string;
  readonly key?: string;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);

function breakdownOf(v: unknown): ContextBreakdown | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const b = v as Record<string, unknown>;
  const conversation = num(b.conversation);
  const tools = num(b.tools);
  const system = num(b.system);
  return conversation !== undefined && tools !== undefined && system !== undefined ? { conversation, tools, system } : undefined;
}

/** Read an event's JSON safely (peers send it; unknown or malformed fields are dropped). */
export function parseContextEvent(text: string): ContextEventData | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  const breakdown = breakdownOf(d.breakdown);
  return {
    ...(num(d.used) !== undefined ? { used: num(d.used) } : {}),
    ...(num(d.window) ? { window: num(d.window) } : {}),
    ...(typeof d.compacting === 'boolean' ? { compacting: d.compacting } : {}),
    ...(breakdown ? { breakdown } : {}),
    ...(str(d.model, 120) ? { model: str(d.model, 120) } : {}),
    ...(num(d.cacheRead) !== undefined ? { cacheRead: num(d.cacheRead) } : {}),
    ...(num(d.cacheWrite) !== undefined ? { cacheWrite: num(d.cacheWrite) } : {}),
    ...(num(d.pre) !== undefined ? { pre: num(d.pre) } : {}),
    ...(num(d.post) !== undefined ? { post: num(d.post) } : {}),
    ...(d.trigger === 'auto' || d.trigger === 'manual' ? { trigger: d.trigger } : {}),
    ...(str(d.summary, MAX_SUMMARY_CHARS) ? { summary: str(d.summary, MAX_SUMMARY_CHARS) } : {}),
    ...(str(d.key, 120) ? { key: str(d.key, 120) } : {}),
  };
}

/** The words a compaction shows where it's drawn as plain text. */
export function compactText(mark: CompactMark): string {
  if (mark.state === 'running') return 'Compacting the conversation…';
  if (mark.state === 'failed') return "Compaction didn't finish. The conversation is unchanged.";
  const pre = mark.pre ?? 0;
  const post = mark.post ?? 0;
  const saved = pre > 0 ? Math.round((1 - post / pre) * 100) : 0;
  return `Context compacted: ${formatTokenCount(pre)} → ${formatTokenCount(post)} tokens (${saved}% freed)`;
}

const isCompact = (l: { type: string; channel: string; compact?: CompactMark }, channel: string): boolean => l.type === 'system' && l.channel === channel && Boolean(l.compact);

/** The newest divider in the channel matching `pick` (its index), if any. */
function lastIndex<T extends { type: string; channel: string; compact?: CompactMark }>(log: readonly T[], channel: string, pick: (m: CompactMark) => boolean): number {
  for (let i = log.length - 1; i >= 0; i--) {
    const l = log[i]!;
    if (isCompact(l, channel) && pick(l.compact!)) return i;
  }
  return -1;
}

export interface ContextSlice<L> {
  readonly context: Readonly<Record<string, ContextInfo>>;
  readonly compactions: Readonly<Record<string, { readonly pre: number; readonly post: number; readonly at: number }>>;
  readonly log: readonly L[];
}

/**
 * Apply a 'context' or 'compact' event to the meter and the chat. `append` adds a log item the
 * way the store does (keeping the per-conversation limit).
 */
export function applyContextEvent<L extends { readonly id: string; readonly type: string; readonly channel: string; readonly compact?: CompactMark }, S extends ContextSlice<L>>(
  state: S,
  e: { readonly event: 'context' | 'compact'; readonly channel: string; readonly id: string; readonly ts: number; readonly data: ContextEventData },
  append: (log: readonly L[], item: L) => readonly L[],
): S {
  const { channel, data } = e;
  const prev = state.context[channel];
  const window = data.window ?? prev?.window ?? DEFAULT_CONTEXT_WINDOW;
  const replace = (i: number, item: L): readonly L[] => state.log.map((l, k) => (k === i ? item : l));
  const item = (id: string, ts: number, mark: CompactMark): L => ({ id, type: 'system', channel, text: compactText(mark), ts, level: mark.state === 'failed' ? 'warn' : 'info', compact: mark }) as CompactItem as unknown as L;

  if (e.event === 'context') {
    if (data.used === undefined && data.compacting === undefined && !data.breakdown) return state;
    // A new fill replaces the cache split. A flag-only update (compacting) keeps the split it had.
    const pair = (read: number | undefined, write: number | undefined): { cacheRead: number; cacheWrite: number } | undefined => (read !== undefined || write !== undefined ? { cacheRead: read ?? 0, cacheWrite: write ?? 0 } : undefined);
    const cache = data.used === undefined ? pair(prev?.cacheRead, prev?.cacheWrite) : pair(data.cacheRead, data.cacheWrite);
    const info: ContextInfo = {
      used: data.used ?? prev?.used ?? 0,
      window,
      ...(data.compacting ? { compacting: true } : {}),
      ...((data.breakdown ?? (data.used === undefined ? prev?.breakdown : undefined)) ? { breakdown: data.breakdown ?? prev?.breakdown } : {}),
      ...((data.model ?? prev?.model) ? { model: data.model ?? prev?.model } : {}),
      ...(cache ? cache : {}),
    };
    // "Compacting" before any numbers came: the meter shows it (and the divider), with nothing used yet.
    const context = data.used === undefined && !prev && !data.compacting ? state.context : { ...state.context, [channel]: info };
    const running = lastIndex(state.log, channel, (m) => m.state === 'running');
    if (data.compacting === true && running < 0) {
      return { ...state, context, log: append(state.log, item(`${e.id}:compact`, e.ts, { state: 'running', ...(data.trigger === 'auto' || data.trigger === 'manual' ? { trigger: data.trigger } : {}) })) };
    }
    if (data.compacting === false && running >= 0) {
      const was = state.log[running] as unknown as CompactItem;
      return { ...state, context, log: replace(running, item(was.id, was.ts, { ...was.compact!, state: 'failed' })) };
    }
    return { ...state, context };
  }

  // A summary arriving after its compaction: add it to that divider.
  if (data.pre === undefined) {
    if (!data.summary) return state;
    const at = lastIndex(state.log, channel, (m) => m.state === 'done' && (data.key ? m.key === data.key : !m.summary));
    if (at < 0) return state;
    const was = state.log[at] as unknown as CompactItem;
    return { ...state, log: replace(at, item(was.id, was.ts, { ...was.compact!, summary: data.summary })) };
  }

  const post = data.post ?? 0;
  const mark: CompactMark = {
    state: 'done',
    pre: data.pre,
    post,
    ...(data.trigger === 'auto' || data.trigger === 'manual' ? { trigger: data.trigger } : {}),
    ...(data.summary ? { summary: data.summary } : {}),
    ...(data.key ? { key: data.key } : {}),
  };
  const context = { ...state.context, [channel]: { used: post, window, ...(prev?.model ? { model: prev.model } : {}) } };
  const compactions = { ...state.compactions, [channel]: { pre: data.pre, post, at: e.ts } };
  // The divider that said "Compacting…" becomes the result, where the compaction began.
  const running = lastIndex(state.log, channel, (m) => m.state === 'running');
  if (running >= 0) {
    const was = state.log[running] as unknown as CompactItem;
    return { ...state, context, compactions, log: replace(running, item(was.id, was.ts, { ...mark, trigger: mark.trigger ?? was.compact?.trigger ?? 'manual' })) };
  }
  // The same compaction reported again (a resent event): leave the divider as it is.
  if (data.key && lastIndex(state.log, channel, (m) => m.key === data.key) >= 0) return { ...state, context, compactions };
  return { ...state, context, compactions, log: append(state.log, item(`${e.id}:compact${data.key ? `:${data.key}` : ''}`, e.ts, mark)) };
}
