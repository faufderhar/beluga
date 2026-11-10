import { describe, expect, it } from 'vitest';
import { parseGrokPlan } from '../src/agent/runtime/grok/plan-usage.js';

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
});
