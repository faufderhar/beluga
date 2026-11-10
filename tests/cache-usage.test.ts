import { describe, expect, it } from 'vitest';
import { cacheHitRows } from '../src/ui/cache-usage.js';
import { usageViews } from '../src/companion/views.js';
import { withLocalUsage, type ProviderCard } from '../src/ui/usage-cards.js';

const counts = (input: number, cacheRead: number, cacheWrite: number) => ({ input, cacheRead, cacheWrite });

describe('cache hit by session and model', () => {
  it('omits a conversation that counted nothing, and keeps a real zero', () => {
    const tables = cacheHitRows([
      {
        name: 'beluga',
        workspaces: [
          { id: 'empty', name: 'Empty', usage: { session: counts(0, 0, 0) } },
          { id: 'wrote', name: 'Wrote', agent: { runtime: 'grok', model: 'grok-4.7' }, usage: { session: counts(0, 0, 400), lastAt: 2 } },
          { id: 'hit', name: 'Hit', agent: { runtime: 'grok', model: 'grok-4.7' }, usage: { session: counts(100, 300, 0), lastAt: 3 }, archived: true },
        ],
      },
    ]);
    expect(tables.sessions.map((r) => [r.label, r.pct])).toEqual([
      ['Hit', 75],
      ['Wrote', 0],
    ]);
    expect(tables.models).toEqual([{ key: 'grok:grok-4.7', scope: 'model', label: 'Grok 4.7', pct: 38 }]);
  });

  it('does not use Claude’s model for a Grok conversation, and does not drop an unknown model', () => {
    const tables = cacheHitRows(
      [
        {
          name: 'beluga',
          workspaces: [
            { id: 'g', name: 'Grok chat', agent: { runtime: 'grok' }, usage: { session: counts(10, 10, 0) } },
            { id: 'c', name: 'Claude chat', agent: { runtime: 'claude', model: 'claude-opus-4-6' }, usage: { session: counts(10, 30, 0) } },
          ],
        },
      ],
      {},
      { runtime: 'claude', model: 'claude-opus-4-6' },
    );
    expect(tables.models.map((r) => r.label).sort()).toEqual(['Model not recorded', 'Opus 4.6']);
    expect(tables.models.find((r) => r.key === 'grok:')?.pct).toBe(50);
  });

  it('groups by the model the conversation uses now, keeping runtimes apart', () => {
    const tables = cacheHitRows([{ name: 'beluga', workspaces: [{ id: 'g', name: 'Now', model: 'grok-4.5', agent: { runtime: 'grok', model: 'grok-4.7' }, usage: { last: counts(0, 80, 20) } }] }], { 'ws:g': { model: 'grok-4.6' } });
    expect(tables.models[0]).toMatchObject({ key: 'grok:grok-4.6', label: 'Grok 4.6', pct: 80 });
  });
});

const grokRuntime = { id: 'grok', label: 'Grok Build', available: true, state: 'ready' };

describe('Grok usage on this Mac', () => {
  it('shows a note instead of hiding the row when the period was not read', () => {
    const cards = withLocalUsage([], { runtimes: [grokRuntime], projects: [] });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: 'grok', shape: 'empty', signedIn: true });
    expect(cards[0]!.note).toMatch(/can't report its billing period/);
    expect(cards[0]!.tokens).toBeUndefined();
    const phone = usageViews(undefined, undefined, { runtimes: [grokRuntime], projects: [] });
    expect(phone.map((u) => u.provider)).toEqual(['Grok Build']);
    expect(phone[0]!.note).toMatch(/can't report its billing period/);
    expect(phone[0]!.tokens).toBeUndefined();
  });

  it('adds tokens counted in Grok conversations, and does not replace a period window', () => {
    const ledger = { runtimes: [grokRuntime], defaultRuntime: 'claude', projects: [{ name: 'beluga', workspaces: [{ agent: { runtime: 'grok' }, usage: { input: 1000, output: 250 } }, { agent: { runtime: 'claude' }, usage: { input: 9, output: 9 } }] }] };
    const noted = withLocalUsage([], ledger);
    expect(noted[0]).toMatchObject({ shape: 'tokens', tokens: { input: 1000, output: 250 } });
    expect(noted[0]!.note).toMatch(/conversations on this Mac/);
    const quota: ProviderCard = { key: 'grok', agent: { runtime: 'grok', label: 'Grok Build' }, shape: 'quota', windows: [{ label: 'This period', short: 'thi', pct: 12 }], signedIn: true, isDefault: false };
    expect(withLocalUsage([quota], ledger)[0]).toBe(quota);
  });

  it('keeps a signed-out Grok signed out, and a team plan in its own words', () => {
    const signedOut = withLocalUsage([], { runtimes: [{ ...grokRuntime, state: 'signed_out' }], projects: [{ name: 'beluga', workspaces: [{ agent: { runtime: 'grok' }, usage: { input: 5, output: 5 } }] }] });
    expect(signedOut[0]).toMatchObject({ signedIn: false, shape: 'empty' });
    expect(signedOut[0]!.tokens).toBeUndefined();
    const team: ProviderCard = { key: 'grok', agent: { runtime: 'grok', label: 'Grok Build' }, shape: 'empty', windows: [], plan: 'Team', signedIn: true, isDefault: false };
    expect(withLocalUsage([team], { runtimes: [grokRuntime], projects: [] })[0]!.note).toBe('Usage limits are managed by your team.');
  });

  it('does not give a friend’s profile this Mac’s ledger', () => {
    expect(usageViews({ usages: [], agents: [{ runtime: 'grok', label: 'Grok Build' }] }, undefined)).toEqual([]);
  });
});
