/** Fresh input, output, and the cache buckets a run reported. Absent cache means that bucket was not counted. */
export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** "1.2M", "84k", "512" tokens. */
export function shortTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** Every bucket: fresh input, output, cache read and cache write. */
export function tokenTotal(t: TokenCounts): number {
  return t.input + t.output + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
}

/** "1k in · 250 out · 8k cache read · 40 cache write". A cache part is left out when that bucket is empty. */
export function tokenDetail(t: TokenCounts): string {
  const parts = [`${shortTokens(t.input)} in`, `${shortTokens(t.output)} out`];
  if (t.cacheRead) parts.push(`${shortTokens(t.cacheRead)} cache read`);
  if (t.cacheWrite) parts.push(`${shortTokens(t.cacheWrite)} cache write`);
  return parts.join(' · ');
}
