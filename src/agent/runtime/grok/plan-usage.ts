import { type ChildProcess, spawn } from 'node:child_process';
import { findGrok } from './connection.js';

/**
 * The current billing period. On the daemon route `grok usage --json` prints it. On the shell route
 * that command refuses, and the same period `/usage` shows comes back from `_x.ai/billing` on
 * `grok agent --no-leader stdio` (recorded from Grok Build 1.0.77). Only a shape this has actually
 * seen becomes a window. Anything else is unavailable.
 */

export interface GrokPlanWindow {
  readonly label: string;
  readonly pct: number;
  readonly resetsAt?: number;
}

export type GrokPlan = { readonly kind: 'windows'; readonly windows: readonly GrokPlanWindow[]; readonly plan?: string } | { readonly kind: 'team' } | { readonly kind: 'signed_out' } | { readonly kind: 'unavailable' };

const TEAM = /usage limits are managed by your team/i;
const SIGNED_OUT = /not signed in|sign in to grok|authentication required/i;
const TIMEOUT_MS = 8_000;
/** A cold `grok agent` handshake plus the billing call. */
const BILLING_TIMEOUT_MS = 15_000;
const BILLING_METHOD = '_x.ai/billing';

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

function periodOf(o: Record<string, unknown>): Record<string, unknown> | undefined {
  const period = o.currentPeriod ?? o.current_period;
  return period && typeof period === 'object' && !Array.isArray(period) ? (period as Record<string, unknown>) : undefined;
}

function endOf(nodes: readonly Record<string, unknown>[]): number | undefined {
  for (const o of nodes) {
    const t = epoch(o.billingPeriodEnd) ?? epoch(o.billing_period_end) ?? epoch(periodOf(o)?.end);
    if (t !== undefined) return t;
  }
  return undefined;
}

/** "Weekly" when the period says so. An unrecognised type stays "This period". */
function labelOf(nodes: readonly Record<string, unknown>[]): string {
  for (const o of nodes) {
    const type = periodOf(o)?.type;
    if (typeof type !== 'string') continue;
    const t = type.toUpperCase();
    if (t.includes('WEEK')) return 'Weekly';
    if (t.includes('MONTH')) return 'Monthly';
    if (t.includes('DAY')) return 'Daily';
  }
  return 'This period';
}

/** The subscription name, cut to what a profile plan can carry. */
function tierOf(nodes: readonly Record<string, unknown>[]): string | undefined {
  for (const o of nodes) {
    const tier = o.subscription_tier ?? o.subscriptionTier;
    if (typeof tier !== 'string') continue;
    const name = tier.trim();
    if (name) return name.slice(0, 32);
  }
  return undefined;
}

/** A billing object this has seen: a percent (0 is real), the period's end, and the tier when named. */
export function billingPlan(raw: unknown): GrokPlan {
  const nodes = nodesOf(raw, 2);
  const pct = percentOf(nodes) ?? ratioOf(nodes);
  if (pct === undefined) return { kind: 'unavailable' };
  const resetsAt = endOf(nodes);
  const plan = tierOf(nodes);
  return { kind: 'windows', ...(plan ? { plan } : {}), windows: [{ label: labelOf(nodes), pct, ...(resetsAt ? { resetsAt } : {}) }] };
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
  return billingPlan(raw);
}

interface CliRead {
  readonly plan: GrokPlan;
  /** The process exited. A timeout is not an answer, so the billing call is not started on top of it. */
  readonly answered: boolean;
}

/** Run `grok usage --json` once. Missing binary or a timeout: unavailable, and not answered. */
function runUsage(command: string, run: typeof spawn): Promise<CliRead> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = run(command, ['usage', '--json'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve({ plan: { kind: 'unavailable' }, answered: false });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ plan: parseGrokPlan(out, err, code), answered: code !== null });
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

interface RpcReply {
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

/** What `_x.ai/billing` meant. An auth failure is signed out. A missing method stays unavailable. */
function planFromReply(reply: RpcReply): GrokPlan {
  const message = reply.error?.message ?? '';
  if (message) {
    if (TEAM.test(message)) return { kind: 'team' };
    if (SIGNED_OUT.test(message)) return { kind: 'signed_out' };
    return { kind: 'unavailable' };
  }
  return billingPlan(reply.result);
}

/**
 * The shell route's period: one `grok agent` that is only asked for billing, then stopped.
 * No session is opened. A missing answer is unavailable.
 */
function readBilling(command: string, run: typeof spawn): Promise<GrokPlan> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = run(command, ['agent', '--no-leader', 'stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve({ kind: 'unavailable' });
      return;
    }
    let settled = false;
    let buf = '';
    let next = 0;
    const pending = new Map<number, (reply: RpcReply) => void>();
    const finish = (plan: GrokPlan): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const res of pending.values()) res({ error: { message: 'closed' } });
      pending.clear();
      child.kill();
      resolve(plan);
    };
    const timer = setTimeout(() => finish({ kind: 'unavailable' }), BILLING_TIMEOUT_MS);
    const request = (method: string, params: object): Promise<RpcReply> => {
      const id = ++next;
      return new Promise((res) => {
        pending.set(id, res);
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      // initialize lists every model. Past this, the answer is not the billing object.
      if (buf.length > 2_000_000) return finish({ kind: 'unavailable' });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        } catch {
          continue;
        }
        if (msg.id === undefined) continue;
        const wait = pending.get(msg.id);
        if (!wait) continue;
        pending.delete(msg.id);
        wait({ ...(msg.result !== undefined ? { result: msg.result } : {}), ...(msg.error ? { error: msg.error } : {}) });
      }
    });
    child.once('error', () => finish({ kind: 'unavailable' }));
    child.once('close', () => finish({ kind: 'unavailable' }));
    void (async () => {
      const init = await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'beluga', title: 'Beluga', version: '0' },
      });
      if (settled || init.error || init.result === undefined) return finish({ kind: 'unavailable' });
      const bill = await request(BILLING_METHOD, {});
      if (settled) return;
      finish(planFromReply(bill));
    })().catch(() => finish({ kind: 'unavailable' }));
  });
}

/**
 * The current period. `grok usage --json` when that command can read it (the daemon route).
 * When it answers that it can't (the shell route), `_x.ai/billing`. A timeout does not start the second ask.
 */
export async function readGrokPlan(bin?: string, run: typeof spawn = spawn): Promise<GrokPlan> {
  const command = bin ?? findGrok();
  if (!command) return { kind: 'unavailable' };
  const cli = await runUsage(command, run);
  if (cli.plan.kind !== 'unavailable' || !cli.answered) return cli.plan;
  return readBilling(command, run);
}
