import { describe, expect, it } from 'vitest';
import { describeWindow, fromPercent, fromRateLimitEvent, fromUsageResponse, toMs, toPct } from '../src/agent/runtime/claude/usage.js';
import { initialAppState as initialState, reduceApp as reduce } from '../src/client/screen.js';
import type { PeerInfo } from '../src/protocol.js';
import { personMenu } from '../src/ui/menus.js';

describe('usage', () => {
  it('normalizes percentages and timestamps', () => {
    expect(toPct(0.42)).toBe(42);
    expect(toPct(42)).toBe(42);
    expect(toPct(140)).toBe(100);
    expect(toPct(null)).toBeUndefined();
    expect(toMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toMs('2026-10-17T12:00:00Z')).toBe(Date.parse('2026-10-17T12:00:00Z'));
    expect(toMs('nope')).toBeUndefined();
    expect(toMs(undefined)).toBeUndefined();
  });

  it('maps streamed rate-limit events', () => {
    expect(fromRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1_700_000_000 })).toEqual({ fiveHour: { pct: 50, resetsAt: 1_700_000_000_000 } });
    expect(fromRateLimitEvent({ rateLimitType: 'seven_day', utilization: 12 })).toEqual({ week: { pct: 12, resetsAt: undefined } });
    expect(fromRateLimitEvent({ rateLimitType: 'overage', utilization: 1 })).toBeUndefined();
    expect(fromRateLimitEvent({ rateLimitType: 'five_hour' })).toBeUndefined();
  });

  it('maps the /usage response', () => {
    const res = {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 3, resets_at: '2026-10-17T15:10:00Z' }, seven_day: { utilization: 38, resets_at: null } },
    };
    expect(fromUsageResponse(res, 5)).toEqual({
      plan: 'max',
      fiveHour: { pct: 3, resetsAt: Date.parse('2026-10-17T15:10:00Z') },
      week: { pct: 38, resetsAt: undefined },
      updatedAt: 5,
    });
    // Already percent: 1 is 1% (a fresh 5-hour session), never read as a fraction (100%).
    const low = { ...res, rate_limits: { five_hour: { utilization: 1, resets_at: null }, seven_day: { utilization: 0.5, resets_at: null } } };
    expect(fromUsageResponse(low, 5)).toMatchObject({ fiveHour: { pct: 1 }, week: { pct: 1 } });
    expect(fromPercent(null)).toBeUndefined();
    expect(fromPercent(140)).toBe(100);
    expect(fromUsageResponse({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toBeUndefined();
    expect(describeWindow(undefined)).toBe('–');
    expect(describeWindow({ pct: 3 })).toBe('3%');
    expect(describeWindow({ pct: 3, resetsAt: Date.parse('2026-10-17T15:10:00Z') })).toMatch(/^3% · resets /);
  });

  it('shows usage in the person menu', () => {
    const peers: PeerInfo[] = [
      { peerId: 'me', name: 'kay', agent: true, shares: [] },
      { peerId: 'b', name: 'bob', agent: true, shares: [], usage: { plan: 'pro', fiveHour: { pct: 42 }, week: { pct: 10 }, updatedAt: 1 } },
    ];
    const s = reduce(reduce(initialState('r'), { type: 'peers', peers }), { type: 'welcome', self: peers[0]! });
    const menu = personMenu(s, 1)!;
    expect(menu.intro.join('\n')).toContain('Claude plan usage (pro):  5-hour 42%   ·   week 10%');
    expect(menu.intro.join('\n')).toContain('How much do you trust bob? Now: Ask me each time.');
    const full = reduce(s, { type: 'trust_level', peerId: 'b', level: 'full' });
    expect(personMenu(full, 1)!.intro.join('\n')).toContain('Now: Full trust');
    expect(reduce(full, { type: 'peers', peers: [peers[0]!] }).levels).toEqual({}); // re-applied from saved choices when they return
  });
});
