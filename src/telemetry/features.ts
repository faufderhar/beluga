/**
 * What gets used: every action a screen takes (the Mac, the phone, the command line) is one API
 * method (src/ipc/api.ts), so counting methods counts features. Only the method's name, how often,
 * how many failed and how long they took, summed per minute: never its arguments or its answer.
 * A no-op until usage statistics are on (daemon/dispatch.ts calls it for every call).
 */

export interface MethodCount {
  readonly method: string;
  readonly calls: number;
  readonly errors: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

class FeatureCounter {
  private on = false;
  private counts = new Map<string, { calls: number; errors: number; totalMs: number; maxMs: number }>();
  private since = Date.now();

  enable(on: boolean): void {
    this.on = on;
    if (!on) this.counts.clear();
  }

  call(method: string, ms: number, ok: boolean): void {
    if (!this.on) return;
    const c = this.counts.get(method) ?? { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
    c.calls++;
    if (!ok) c.errors++;
    c.totalMs += ms;
    if (ms > c.maxMs) c.maxMs = ms;
    this.counts.set(method, c);
  }

  /** The counts since the last drain, and since when. */
  drain(now = Date.now()): { readonly since: number; readonly counts: readonly MethodCount[] } {
    const counts = [...this.counts].map(([method, c]) => ({ method, calls: c.calls, errors: c.errors, totalMs: Math.round(c.totalMs), maxMs: Math.round(c.maxMs) }));
    const since = this.since;
    this.counts = new Map();
    this.since = now;
    return { since, counts };
  }
}

export const featureCounter = new FeatureCounter();
