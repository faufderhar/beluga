import { monitorEventLoopDelay } from 'node:perf_hooks';

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

/**
 * How late the daemon's main thread runs things (event-loop delay): p50, p95 and max. Every
 * screen and every Claude's events go through this thread, so this is the number that says
 * whether it stays responsive while many sessions stream.
 *
 * It's measured every 30 s but only logged when a period was slow, plus once an hour for the
 * hour as a whole, so daemon.log keeps what's worth reading (it was 94% of the file, BLG-668).
 */

export const LAG_EVERY_MS = 30_000;
/** How often the summary of everything since the last one is logged. */
export const SUMMARY_EVERY_MS = 60 * 60_000;
/** A period is slow when most of its ticks ran this late at the p95… */
export const SLOW_P95_MS = 50;
/** …or when one stall was this long (a screen visibly froze). */
export const SLOW_MAX_MS = 1000;
/** How often the loop is sampled. Each sample is the time between two ticks, so this much is subtracted from it. */
const RESOLUTION_MS = 20;

export interface LagStats {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface WatchOptions {
  /** How often a period ends (default 30 s). */
  readonly everyMs?: number;
  /** Log every period, slow or not, and skip the summary (scripts/perf-lag.mjs reads each one). */
  readonly all?: boolean;
  /** Override SUMMARY_EVERY_MS (tests). */
  readonly summaryEveryMs?: number;
  /** Every period's delays, logged or not (the black box keeps them all, in memory). */
  readonly onPeriod?: (stats: LagStats) => void;
}

const delays = (s: LagStats): string => `p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, max ${s.max.toFixed(1)} ms`;

/** A period's delays in words (milliseconds). */
export const lagLine = (s: LagStats): string => `event loop delay: ${delays(s)}`;

/** The summary's delays in words. */
export const summaryLine = (s: LagStats): string => `event loop delay, last hour: ${delays(s)}`;

/** Worth a line on its own: the daemon was noticeably late in this period. */
export const isSlow = (s: LagStats): boolean => s.p95 >= SLOW_P95_MS || s.max >= SLOW_MAX_MS;

function monitor(): IntervalHistogram {
  const h = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  h.enable();
  return h;
}

// How late a tick ran, not the tick's own interval (an idle loop reads 0, not 20 ms).
const ms = (ns: number): number => Math.max(0, ns / 1e6 - RESOLUTION_MS);

/** What a histogram measured since its last reset, then reset it; nothing when it took no samples. */
export function take(h: Pick<IntervalHistogram, 'count' | 'percentile' | 'max' | 'reset'>): LagStats | undefined {
  const stats = h.count ? { p50: ms(h.percentile(50)), p95: ms(h.percentile(95)), max: ms(h.max) } : undefined;
  h.reset();
  return stats;
}

/** Measure the event loop and log its slow periods and an hourly summary; returns a stop. */
export function watchEventLoop(log: (line: string) => void, opts: WatchOptions = {}): () => void {
  const everyMs = opts.everyMs ?? LAG_EVERY_MS;
  const periodsPerSummary = Math.max(1, Math.round((opts.summaryEveryMs ?? SUMMARY_EVERY_MS) / everyMs));
  const period = monitor();
  const span = monitor();
  let periods = 0;
  const timer = setInterval(() => {
    const stats = take(period);
    if (stats) opts.onPeriod?.(stats);
    if (stats && (opts.all || isSlow(stats))) log(lagLine(stats));
    if (opts.all || ++periods < periodsPerSummary) return;
    periods = 0;
    const whole = take(span);
    if (whole) log(summaryLine(whole));
  }, everyMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    period.disable();
    span.disable();
  };
}
