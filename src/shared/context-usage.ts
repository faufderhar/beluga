// How full a conversation's context window is, and when to compact it. Pure (no Node), so the
// core, the agent runner and the Mac app count the same way.

/** Claude's context window when nothing better is known (older models). */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** The long-context window: the Claude 5 family, Opus 4.6+, Sonnet 4.6, and any `[1m]` pick. */
export const LONG_CONTEXT_WINDOW = 1_000_000;

/**
 * Models whose window is 1M without a `[1m]` suffix: every Claude 5 model (Fable, Mythos, Opus,
 * Sonnet, Haiku 5.x), Opus 4.6–4.8 and Sonnet 4.6, by id or by Claude Code's alias (`opus`,
 * `sonnet`, `haiku`, `fable` pick the current 5.x model). Provider prefixes and suffixes
 * (`us.anthropic.…`, `…-v1:0`, `…@date`) don't matter. Haiku 4.5 and older stay at 200k.
 */
const LONG_CONTEXT_MODEL = /claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5|opus-4-[678]|sonnet-4-6)(?!\d)/i;
const LONG_CONTEXT_ALIAS = /^(?:opus|sonnet|haiku|fable|opusplan)$/i;

/** Auto-compact threshold: the range the setting allows, and where it starts. */
export const AUTO_COMPACT_MIN = 70;
export const AUTO_COMPACT_MAX = 95;
export const AUTO_COMPACT_DEFAULT = 85;

/** Where the meter turns amber, then red (percent used). */
export const CONTEXT_WARN_PCT = 70;
export const CONTEXT_FULL_PCT = 90;

/** Longest summary kept with a compaction divider (it travels inside one agent event). */
export const MAX_SUMMARY_CHARS = 40_000;

/**
 * What Claude is asked to keep when it compacts: the working memory that matters, so nothing
 * you agreed on is lost (the chat itself always stays on screen).
 */
export const COMPACT_INSTRUCTIONS =
  'Keep every decision made and why, the open tasks and next steps, the files and paths touched and what changed in them, commands and results that matter, errors still unresolved, and anything the user asked you to remember.';

/** Where the context comes from, roughly (for the meter's breakdown). */
export interface ContextBreakdown {
  /** What you and Claude said. */
  readonly conversation: number;
  /** Tool calls and what they returned (file reads, command output…). */
  readonly tools: number;
  /** Claude Code's system prompt, tools, CLAUDE.md and memory files. */
  readonly system: number;
}

/** The token counts on one model response (Messages API names). */
export interface ResponseUsage {
  readonly input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
}

/**
 * What the model actually saw on its last request: fresh input plus what came from the prompt
 * cache (read and newly written). Output isn't counted: it isn't in the window until the next turn.
 */
export function contextTokens(u: ResponseUsage | undefined): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/**
 * A model's context window: what Claude Code reported for it when it did, else from its id
 * (`…[1m]` or `…-1m` picks the 1M window, as do the 1M models above), else 200k.
 */
export function contextWindowFor(model?: string, reported?: number): number {
  if (reported && reported > 0) return reported;
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  if (/(\[1m\]|-1m\b)/i.test(model)) return LONG_CONTEXT_WINDOW;
  return LONG_CONTEXT_MODEL.test(model) || LONG_CONTEXT_ALIAS.test(model.trim()) ? LONG_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

/** The window of the main model among a run's per-model usage (the largest: helpers are smaller or equal). */
export function windowOfRun(modelUsage: Readonly<Record<string, { readonly contextWindow?: number }>> | undefined, model?: string): number {
  const reported = Math.max(0, ...Object.values(modelUsage ?? {}).map((u) => u.contextWindow ?? 0));
  return contextWindowFor(model, reported);
}

/** Percent of the window in use, 0–100 (whole numbers; never NaN). */
export function contextPct(info: { readonly used: number; readonly window: number } | undefined): number {
  if (!info || !(info.window > 0) || !(info.used > 0)) return 0;
  return Math.min(100, Math.round((info.used / info.window) * 100));
}

export type ContextTone = 'normal' | 'warn' | 'full';

/** Neutral, then amber at 70%, red at 90%. */
export const contextTone = (pct: number): ContextTone => (pct >= CONTEXT_FULL_PCT ? 'full' : pct >= CONTEXT_WARN_PCT ? 'warn' : 'normal');

/** A threshold from settings, kept inside the allowed range. */
export const clampThreshold = (pct: number | undefined): number =>
  Math.min(AUTO_COMPACT_MAX, Math.max(AUTO_COMPACT_MIN, Math.round(Number.isFinite(pct) ? (pct as number) : AUTO_COMPACT_DEFAULT)));

/**
 * Should Beluga compact this conversation now? Only with auto-compact on, the context known and at
 * or past the threshold, nothing compacting already, and not again before Claude has run since
 * the last try (a conversation whose summary is still big would otherwise loop).
 */
export function autoCompactDue(opts: { readonly on: boolean; readonly at: number; readonly info?: { readonly used: number; readonly window: number; readonly compacting?: boolean }; readonly triedSinceRun?: boolean }): boolean {
  if (!opts.on || !opts.info || opts.info.compacting || opts.triedSinceRun) return false;
  return contextPct(opts.info) >= clampThreshold(opts.at);
}

/** Environment for Claude Code so its own auto-compact follows the same threshold. */
export const compactEnv = (on: boolean, at: number): Record<string, string> => (on ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(clampThreshold(at)) } : {});

/** "128k", "1.2M", "940". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.max(0, Math.round(n)));
}

/** Fresh input, tokens served from the prompt cache, and tokens written into it. */
export interface CacheCounts {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

const counted = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Prompt-cache hit rate for one conversation: cache reads over fresh input, cache reads and cache
 * writes. Undefined when nothing was counted, so the screen shows nothing rather than 0% or NaN.
 * A session that wrote cache and read none is 0.
 */
export function cacheHitPct(parts: CacheCounts | undefined): number | undefined {
  if (!parts) return undefined;
  const input = counted(parts.input);
  const cacheRead = counted(parts.cacheRead);
  const cacheWrite = counted(parts.cacheWrite);
  const total = input + cacheRead + cacheWrite;
  if (total <= 0) return undefined;
  return Math.round((cacheRead / total) * 100);
}

/**
 * The current conversation's cache counts. `session` is every turn of this session added up (a
 * running total from the agent contributes only its growth). Until that exists, `last` is the
 * latest report, which for a running-total SDK is the session so far. An empty session hides `last`.
 */
export function sessionCache(usage: { readonly session?: CacheCounts; readonly last?: CacheCounts } | undefined): CacheCounts | undefined {
  if (!usage) return undefined;
  // A stored session, even an empty one, wins over the latest report so a new session doesn't keep the old rate.
  const raw = usage.session ?? usage.last;
  if (!raw) return undefined;
  const parts = { input: counted(raw.input), cacheRead: counted(raw.cacheRead), cacheWrite: counted(raw.cacheWrite) };
  return parts.input + parts.cacheRead + parts.cacheWrite > 0 ? parts : undefined;
}

/** "Fresh 2k · cache read 6k · cache write 300" — what the hit rate is made of. */
export function cacheDetail(parts: CacheCounts): string {
  return `Fresh ${formatTokenCount(parts.input)} · cache read ${formatTokenCount(parts.cacheRead)} · cache write ${formatTokenCount(parts.cacheWrite)}`;
}

/** "Cache 77%". */
export const cacheLabel = (pct: number): string => `Cache ${pct}%`;

/**
 * The hit rate for the window on screen now, from cache counts the agent put on the context
 * event. `used` is the fill (fresh input plus both cache buckets), so fresh input is what's left
 * after the cache. Undefined when this report didn't include a cache split: the meter then uses
 * the conversation's ledger (`cacheHitOf`).
 */
export function cacheHitFromContext(info: { readonly used: number; readonly cacheRead?: number; readonly cacheWrite?: number } | undefined): { readonly pct: number; readonly label: string; readonly detail: string; readonly counts: CacheCounts } | undefined {
  if (!info || (info.cacheRead === undefined && info.cacheWrite === undefined)) return undefined;
  const cacheRead = counted(info.cacheRead);
  const cacheWrite = counted(info.cacheWrite);
  return cacheHitOf({ last: { input: Math.max(0, info.used - cacheRead - cacheWrite), cacheRead, cacheWrite } });
}

/** What the context meter shows for this conversation's cache, if there is anything to divide by. */
export function cacheHitOf(usage: { readonly session?: CacheCounts; readonly last?: CacheCounts } | undefined): { readonly pct: number; readonly label: string; readonly detail: string; readonly counts: CacheCounts } | undefined {
  const counts = sessionCache(usage);
  if (!counts) return undefined;
  const pct = cacheHitPct(counts);
  if (pct === undefined) return undefined;
  return { pct, label: cacheLabel(pct), detail: cacheDetail(counts), counts };
}

/**
 * Fold one usage report into the session totals. Same session and a running total (the caller
 * found nothing went down): add only the growth. Same session and a per-turn report that dropped:
 * add the turn. A new session starts over. No session id: leave the totals (a lifetime seed is not
 * one conversation).
 */
export function foldSessionCache(
  prev: { readonly lastSession?: string; readonly last?: CacheCounts; readonly session?: CacheCounts } | undefined,
  run: CacheCounts & { readonly session?: string },
  continues: boolean,
): CacheCounts | undefined {
  if (!run.session) return prev?.session;
  const last = prev?.last;
  const same = prev?.lastSession === run.session && last !== undefined;
  const base = same ? (prev?.session ?? last) : undefined;
  const running = continues && same;
  const step = (now: number, was: number | undefined): number => counted(running && was !== undefined ? now - was : now);
  return {
    input: counted(base?.input) + step(run.input, last?.input),
    cacheRead: counted(base?.cacheRead) + step(run.cacheRead, last?.cacheRead),
    cacheWrite: counted(base?.cacheWrite) + step(run.cacheWrite, last?.cacheWrite),
  };
}

/** Claude Code's /context categories → our three rows, scaled so they add up to `used`. */
export function breakdownFrom(
  report: { readonly categories?: ReadonlyArray<{ readonly name: string; readonly tokens: number; readonly kind?: string }>; readonly messageBreakdown?: { readonly toolCallTokens?: number; readonly toolResultTokens?: number } } | undefined,
  used: number,
): ContextBreakdown | undefined {
  const rows = (report?.categories ?? []).filter((c) => (c.kind ?? 'used') === 'used' && c.tokens > 0);
  if (!rows.length) return undefined;
  const messages = rows.filter((c) => /^messages$/i.test(c.name)).reduce((n, c) => n + c.tokens, 0);
  const system = rows.reduce((n, c) => n + c.tokens, 0) - messages;
  const tools = Math.min(messages, (report?.messageBreakdown?.toolCallTokens ?? 0) + (report?.messageBreakdown?.toolResultTokens ?? 0));
  const total = messages + system;
  if (total <= 0) return undefined;
  const scale = used > 0 ? used / total : 1;
  const conversation = Math.round((messages - tools) * scale);
  const toolPart = Math.round(tools * scale);
  return { conversation, tools: toolPart, system: Math.max(0, Math.round(total * scale) - conversation - toolPart) };
}
