import type { Usage } from '../../../protocol.js';

/** Utilization may come as a 0–1 fraction or a 0–100 percentage depending on the source. */
export function toPct(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  const pct = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** A value already in percent (0–100), never a fraction: 1 is 1%, not 100%. */
export function fromPercent(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Seconds, milliseconds or ISO strings → epoch ms. */
export function toMs(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return value < 1e12 ? value * 1000 : value;
}

interface RateLimitInfo {
  readonly rateLimitType?: string;
  readonly utilization?: number;
  readonly resetsAt?: number;
}

/** Map a streamed rate_limit_event into a partial usage update. */
export function fromRateLimitEvent(info: RateLimitInfo): Partial<Usage> | undefined {
  const pct = toPct(info.utilization);
  if (pct === undefined) return undefined;
  const window = { pct, resetsAt: toMs(info.resetsAt) };
  if (info.rateLimitType === 'five_hour') return { fiveHour: window };
  if (info.rateLimitType === 'seven_day') return { week: window };
  return undefined;
}

interface UsageWindowResponse {
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

interface UsageResponse {
  readonly subscription_type: string | null;
  readonly rate_limits_available: boolean;
  readonly rate_limits: { five_hour?: UsageWindowResponse | null; seven_day?: UsageWindowResponse | null } | null;
}

/** Map the (experimental) /usage response into our Usage shape. Its utilization is a percentage (0–100, per the SDK's types). */
export function fromUsageResponse(res: UsageResponse, now = Date.now()): Usage | undefined {
  if (!res.rate_limits_available || !res.rate_limits) return undefined;
  const win = (w: UsageWindowResponse | null | undefined) => {
    const pct = fromPercent(w?.utilization);
    return pct === undefined ? undefined : { pct, resetsAt: toMs(w?.resets_at) };
  };
  return {
    plan: res.subscription_type ?? undefined,
    fiveHour: win(res.rate_limits.five_hour),
    week: win(res.rate_limits.seven_day),
    updatedAt: now,
  };
}

/** "42% · resets 3:10 PM" style summary. */
export function describeWindow(w: { pct: number; resetsAt?: number } | undefined): string {
  if (!w) return '–';
  const reset = w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  return `${w.pct}%${reset}`;
}
