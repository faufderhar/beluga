import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseGrokPlan, readGrokPlan } from '../src/agent/runtime/grok/plan-usage.js';

const shell = "Error: grok usage can't show your plan's usage here yet. Run /usage inside grok instead.";

describe('grok plan usage', () => {
  it('treats the shell route as unavailable', () => {
    expect(parseGrokPlan('', shell, 1)).toEqual({ kind: 'unavailable' });
  });

  it('recognises a team plan and a signed-out account', () => {
    expect(parseGrokPlan('', 'Usage limits are managed by your team.', 0)).toEqual({ kind: 'team' });
    expect(parseGrokPlan('', 'You are not signed in.', 1)).toEqual({ kind: 'signed_out' });
  });

  it('reads a credit percent, including zero, and an end when one is present', () => {
    expect(parseGrokPlan(JSON.stringify({ creditUsagePercent: 12, billingPeriodEnd: '2026-12-01T00:00:00.000Z' }), '', 0)).toEqual({
      kind: 'windows',
      windows: [{ label: 'This period', pct: 12, resetsAt: Date.parse('2026-12-01T00:00:00.000Z') }],
    });
    expect(parseGrokPlan(JSON.stringify({ billing: { creditUsagePercent: 0 } }), '', 0)).toEqual({ kind: 'windows', windows: [{ label: 'This period', pct: 0 }] });
  });

  it('reads included usage over the period total', () => {
    expect(parseGrokPlan(JSON.stringify({ config: { includedUsed: 25, totalUsed: 100 } }), '', 0)).toEqual({ kind: 'windows', windows: [{ label: 'This period', pct: 25 }] });
  });

  it('does not invent a window from garbage or an unknown payload', () => {
    expect(parseGrokPlan('{', '', 0)).toEqual({ kind: 'unavailable' });
    expect(parseGrokPlan(JSON.stringify({ monthlyLimit: 20 }), '', 0)).toEqual({ kind: 'unavailable' });
  });

  it('reads the shell route’s current period and the subscription it belongs to', () => {
    const end = '2026-11-15T14:42:21.713269+00:00';
    expect(
      parseGrokPlan(
        JSON.stringify({
          config: { creditUsagePercent: 10, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end }, billingPeriodEnd: end },
          subscription_tier: 'SuperGrok Heavy',
        }),
        '',
        0,
      ),
    ).toEqual({ kind: 'windows', plan: 'SuperGrok Heavy', windows: [{ label: 'Weekly', pct: 10, resetsAt: Date.parse(end) }] });
  });
});

const SHELL = "Error: `grok usage` can't show your plan's usage here yet. Run /usage inside grok instead.\n";

/** A grok that answers `usage` and, when asked, `_x.ai/billing`. Counts how many agents it started. */
function scripted(billing: { result?: unknown; error?: { message: string } } | 'daemon'): { run: typeof spawn; agents: () => number } {
  let agents = 0;
  const run = ((_: string, args: readonly string[]) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.kill = () => {
      child.emit('close', 0, null);
      return true;
    };
    if (args[0] === 'usage') {
      setImmediate(() => {
        if (billing === 'daemon') stdout.write(`${JSON.stringify({ creditUsagePercent: 4, billingPeriodEnd: '2026-12-01T00:00:00.000Z' })}\n`);
        else stderr.write(SHELL);
        child.emit('close', billing === 'daemon' ? 0 : 1, null);
      });
      return child;
    }
    agents += 1;
    let buf = '';
    stdin.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        const msg = JSON.parse(line) as { id: number; method: string };
        if (msg.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })}\n`);
        else if (msg.method === '_x.ai/billing' && billing !== 'daemon') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...billing })}\n`);
      }
    });
    return child;
  }) as typeof spawn;
  return { run, agents: () => agents };
}

describe('reading the period', () => {
  it('keeps a daemon-route reading and does not start an agent for it', async () => {
    const grok = scripted('daemon');
    const plan = await readGrokPlan('/grok', grok.run);
    expect(plan).toEqual({ kind: 'windows', windows: [{ label: 'This period', pct: 4, resetsAt: Date.parse('2026-12-01T00:00:00.000Z') }] });
    expect(grok.agents()).toBe(0);
  });

  it('asks the shell route for the current period when grok usage cannot', async () => {
    const end = '2026-11-15T14:42:21.713269+00:00';
    const grok = scripted({
      result: { config: { creditUsagePercent: 10, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' }, billingPeriodEnd: end }, subscription_tier: 'SuperGrok Heavy' },
    });
    const plan = await readGrokPlan('/grok', grok.run);
    expect(plan).toEqual({ kind: 'windows', plan: 'SuperGrok Heavy', windows: [{ label: 'Weekly', pct: 10, resetsAt: Date.parse(end) }] });
    expect(grok.agents()).toBe(1);
  });

  it('treats an auth failure on that call as signed out, and a missing method as unavailable', async () => {
    const signedOut = scripted({ error: { message: 'Authentication required to fetch billing data' } });
    expect(await readGrokPlan('/grok', signedOut.run)).toEqual({ kind: 'signed_out' });
    const missing = scripted({ error: { message: 'Method not found' } });
    expect(await readGrokPlan('/grok', missing.run)).toEqual({ kind: 'unavailable' });
  });
});
