// Relative paths (not @beluga/…) so the unit tests at the repo root can load this model too.
import type { AppState, CompactMark, ContextInfo, LogItem } from '../../../../src/core/store.js';
import { type ContextTone, contextPct, contextTone, formatTokenCount } from '../../../../src/shared/context-usage.js';

/** A compaction divider in the chat. */
export type CompactItem = Extract<LogItem, { type: 'system' }> & { readonly compact: CompactMark };

export const isCompactItem = (l: LogItem): l is CompactItem => l.type === 'system' && Boolean((l as { compact?: CompactMark }).compact);

/** Everything the meter and its popover show for one conversation. */
export interface MeterModel {
  readonly info?: ContextInfo;
  readonly pct: number;
  readonly tone: ContextTone;
  readonly compacting: boolean;
  /** The last finished compaction here (its divider). */
  readonly last?: CompactItem;
  /** Claude is working here now (compacting waits for its turn to end). */
  readonly busy: boolean;
}

/** Claude is at work on a card (not just waiting in the queue). */
const WORKING = new Set(['started', 'text', 'tool', 'sub', 'awaiting_approval']);

/**
 * The meter for a conversation, from the shared state. Undefined: nothing to show yet.
 * `window`: the context window you set for this model, used instead of the one the run reported.
 */
export function meterModel(state: Pick<AppState, 'context' | 'log'>, channel: string, window?: number): MeterModel | undefined {
  const raw = state.context[channel];
  const info = raw && window && window > 0 && window !== raw.window ? { ...raw, window } : raw;
  let last: CompactItem | undefined;
  let busy = false;
  for (const l of state.log) {
    if (l.channel !== channel) continue;
    if (isCompactItem(l)) {
      if (l.compact.state === 'done') last = l;
    } else if (l.type === 'agent' && WORKING.has(l.status)) busy = true;
  }
  const compacting = Boolean(info?.compacting);
  if (!info && !compacting) return undefined;
  const pct = contextPct(info);
  return { ...(info ? { info } : {}), pct, tone: contextTone(pct), compacting, ...(last ? { last } : {}), busy };
}

/** "64% of 200k · 128k tokens". */
export function usageLine(info: ContextInfo): string {
  return `${contextPct(info)}% of ${formatTokenCount(info.window)} · ${formatTokenCount(info.used)} tokens`;
}

const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "2:14 PM", or "Oct 17, 2:14 PM" when it wasn't today. */
export function whenText(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now).toDateString() === d.toDateString();
  return today ? clock(ts) : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clock(ts)}`;
}

/** The divider's words: "Context compacted · 152k → 21k tokens · 2:14 PM". */
export function dividerText(item: CompactItem, stale: boolean, now = Date.now()): string {
  const m = item.compact;
  if (m.state === 'running' && !stale) return m.trigger === 'auto' ? 'Context nearly full · compacting…' : 'Compacting…';
  if (m.state !== 'done') return `Compaction didn’t finish · nothing changed · ${whenText(item.ts, now)}`;
  const what = m.trigger === 'auto' ? 'Auto-compacted' : 'Context compacted';
  return `${what} · ${formatTokenCount(m.pre ?? 0)} → ${formatTokenCount(m.post ?? 0)} tokens · ${whenText(item.ts, now)}`;
}

/** Breakdown rows with their share of the window (for the bar), largest story first. */
export function breakdownRows(info: ContextInfo): ReadonlyArray<{ key: 'conversation' | 'tools' | 'system'; label: string; tokens: number; share: number }> {
  const b = info.breakdown;
  if (!b) return [];
  const rows = [
    { key: 'conversation' as const, label: 'Conversation', tokens: b.conversation },
    { key: 'tools' as const, label: 'Tool results', tokens: b.tools },
    { key: 'system' as const, label: 'System & files', tokens: b.system },
  ];
  return rows.filter((r) => r.tokens > 0).map((r) => ({ ...r, share: info.window > 0 ? Math.min(1, r.tokens / info.window) : 0 }));
}
