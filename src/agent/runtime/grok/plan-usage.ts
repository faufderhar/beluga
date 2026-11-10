import { type ChildProcess, spawn } from 'node:child_process';
import { findGrok } from './connection.js';

/**
 * The billing period `grok usage --json` prints on the daemon route. The shell route can't read it
 * and says so. Only a shape this has actually seen becomes a window. Anything else is unavailable.
 */

export interface GrokPlanWindow {
  readonly label: string;
  readonly pct: number;
  readonly resetsAt?: number;
}

export type GrokPlan = { readonly kind: 'windows'; readonly windows: readonly GrokPlanWindow[] } | { readonly kind: 'team' } | { readonly kind: 'signed_out' } | { readonly kind: 'unavailable' };

const TEAM = /usage limits are managed by your team/i;
const SIGNED_OUT = /not signed in|sign in to grok|authentication required/i;
const TIMEOUT_MS = 8_000;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The object and the one or two nests a plan payload is known to use. */
function nodesOf(raw: unknown, depth: number): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const o = raw as Record<string, unknown>;
  const nested = depth > 0 ? ['config', 'billing', 'usage', 'data'].flatMap((k) => nodesOf(o[k], depth - 1)) : [];
  return [o, ...nested];
}

function percentOf(nodes: readonly Record<string, unknown>[]): number | undefined {
  for (const o of nodes) {
    const pct = num(o.creditUsagePercent) ?? num(o.credit_usage_percent);
    if (pct !== undefined && pct >= 0 && pct <= 100) return Math.round(pct);
  }
  return undefined;
}

function ratioOf(nodes: readonly Record<string, unknown>[]): number | undefined {
  for (const o of nodes) {
    const used = num(o.includedUsed) ?? num(o.included_used);
    const total = num(o.totalUsed) ?? num(o.total_used);
    if (used !== undefined && total !== undefined && total > 0 && used >= 0) return Math.min(100, Math.round((used / total) * 100));
  }
  return undefined;
}

function epoch(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 1_000_000_000) return v < 10_000_000_000 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

function endOf(nodes: readonly Record<string, unknown>[]): number | undefined {
  for (const o of nodes) {
    const t = epoch(o.billingPeriodEnd) ?? epoch(o.billing_period_end);
    if (t !== undefined) return t;
  }
  return undefined;
}

/** What a `grok usage` run meant. A percent of 0 is a real reading. */
export function parseGrokPlan(stdout: string, stderr: string, code: number | null): GrokPlan {
  const text = `${stderr}\n${stdout}`;
  if (TEAM.test(text)) return { kind: 'team' };
  if (SIGNED_OUT.test(text)) return { kind: 'signed_out' };
  if (code !== 0) return { kind: 'unavailable' };
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { kind: 'unavailable' };
  }
  const nodes = nodesOf(raw, 2);
  const pct = percentOf(nodes) ?? ratioOf(nodes);
  if (pct === undefined) return { kind: 'unavailable' };
  const resetsAt = endOf(nodes);
  return { kind: 'windows', windows: [{ label: 'This period', pct, ...(resetsAt ? { resetsAt } : {}) }] };
}

/** Run `grok usage --json` once. Missing binary, the shell route, or a timeout: unavailable. */
export function readGrokPlan(bin?: string, run: typeof spawn = spawn): Promise<GrokPlan> {
  const command = bin ?? findGrok();
  if (!command) return Promise.resolve({ kind: 'unavailable' });
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = run(command, ['usage', '--json'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve({ kind: 'unavailable' });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(parseGrokPlan(out, err, code));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out = (out + chunk).slice(0, 64_000);
    });
    child.stderr?.on('data', (chunk: string) => {
      err = (err + chunk).slice(0, 8_000);
    });
    child.once('error', () => finish(1));
    child.once('close', (code) => finish(code));
  });
}
