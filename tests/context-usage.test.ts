import { describe, expect, it } from 'vitest';
import {
  AUTO_COMPACT_DEFAULT,
  COMPACT_INSTRUCTIONS,
  autoCompactDue,
  breakdownFrom,
  cacheHitOf,
  cacheHitPct,
  clampThreshold,
  compactEnv,
  contextPct,
  contextTokens,
  contextTone,
  contextWindowFor,
  foldSessionCache,
  formatTokenCount,
  sessionCache,
  windowOfRun,
} from '../src/shared/context-usage.js';
import { Settings } from '../src/shared/settings-schema.js';
import { DEFAULT_PREFS, prefsFrom } from '../src/core/store.js';

describe('context accounting', () => {
  it('counts what the model saw: fresh input plus cache reads and cache writes (not output)', () => {
    expect(contextTokens({ input_tokens: 1_200, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 6_800 })).toBe(98_000);
    expect(contextTokens({ input_tokens: 500 })).toBe(500);
    expect(contextTokens({ input_tokens: null, cache_read_input_tokens: null })).toBe(0);
    expect(contextTokens(undefined)).toBe(0);
  });

  it('knows each model’s window: what Claude Code reported, else 1M for 1M models and [1m] picks, else 200k', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6', 'opus', 'sonnet', 'haiku', 'fable', 'us.anthropic.claude-opus-5-5', 'anthropic.claude-sonnet-5-5-v1:0']) {
      expect(contextWindowFor(m), m).toBe(1_000_000);
    }
    for (const m of ['claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-sonnet-20241022', 'something-else']) {
      expect(contextWindowFor(m), m).toBe(200_000);
    }
    expect(contextWindowFor('claude-opus-5-5', 200_000)).toBe(200_000);
    expect(contextWindowFor('claude-opus-5-5[1m]')).toBe(1_000_000);
    expect(contextWindowFor('sonnet[1m]')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-5-1m')).toBe(1_000_000);
    expect(contextWindowFor(undefined)).toBe(200_000);
    expect(contextWindowFor('claude-opus-5-5', 1_000_000)).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-5-5[1m]', 0)).toBe(1_000_000);
  });

  it('takes the main model’s window from a run’s per-model usage (helpers like Haiku are smaller)', () => {
    expect(windowOfRun({ 'claude-haiku-5-5': { contextWindow: 200_000 }, 'claude-opus-5-5': { contextWindow: 1_000_000 } })).toBe(1_000_000);
    expect(windowOfRun({}, 'opus[1m]')).toBe(1_000_000);
    expect(windowOfRun(undefined)).toBe(200_000);
  });

  it('turns usage into a whole percentage and a tone: neutral, amber at 70, red at 90', () => {
    expect(contextPct({ used: 128_000, window: 200_000 })).toBe(64);
    expect(contextPct({ used: 300_000, window: 200_000 })).toBe(100);
    expect(contextPct({ used: 0, window: 200_000 })).toBe(0);
    expect(contextPct({ used: 10, window: 0 })).toBe(0);
    expect(contextPct(undefined)).toBe(0);
    expect([69, 70, 89, 90, 100].map(contextTone)).toEqual(['normal', 'warn', 'warn', 'full', 'full']);
  });

  it('formats token counts briefly', () => {
    expect(formatTokenCount(940)).toBe('940');
    expect(formatTokenCount(128_400)).toBe('128k');
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
    expect(formatTokenCount(-3)).toBe('0');
  });
});

describe('auto-compact threshold', () => {
  it('keeps the threshold within 70–95 and defaults to 85', () => {
    expect(clampThreshold(50)).toBe(70);
    expect(clampThreshold(99)).toBe(95);
    expect(clampThreshold(82.4)).toBe(82);
    expect(clampThreshold(undefined)).toBe(AUTO_COMPACT_DEFAULT);
    expect(clampThreshold(Number.NaN)).toBe(85);
  });

  it('is due at or past the threshold, only when on, not while compacting, and once per run', () => {
    const info = (pct: number) => ({ used: pct * 2_000, window: 200_000 });
    expect(autoCompactDue({ on: true, at: 85, info: info(85) })).toBe(true);
    expect(autoCompactDue({ on: true, at: 85, info: info(84) })).toBe(false);
    expect(autoCompactDue({ on: false, at: 85, info: info(99) })).toBe(false);
    expect(autoCompactDue({ on: true, at: 85 })).toBe(false);
    expect(autoCompactDue({ on: true, at: 85, info: { ...info(95), compacting: true } })).toBe(false);
    expect(autoCompactDue({ on: true, at: 85, info: info(95), triedSinceRun: true })).toBe(false);
    // A threshold outside the range counts as its nearest end.
    expect(autoCompactDue({ on: true, at: 10, info: info(71) })).toBe(true);
  });

  it('tells Claude Code’s own auto-compact the same threshold (nothing when off)', () => {
    expect(compactEnv(true, 80)).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' });
    expect(compactEnv(true, 120)).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '95' });
    expect(compactEnv(false, 80)).toEqual({});
  });

  it('is a saved setting: off by default (85% once on), a bad saved value falls back to 85', () => {
    expect(DEFAULT_PREFS).toMatchObject({ autoCompact: false, autoCompactAt: 85 });
    expect(Settings.parse({})).toMatchObject({ autoCompact: false, autoCompactAt: 85 });
    expect(Settings.parse({ autoCompactAt: 400 }).autoCompactAt).toBe(85);
    expect(prefsFrom(Settings.parse({ autoCompact: false, autoCompactAt: 72 }))).toMatchObject({ autoCompact: false, autoCompactAt: 72 });
  });

  it('asks Claude to keep decisions, open tasks and file paths', () => {
    expect(COMPACT_INSTRUCTIONS).toMatch(/decision/);
    expect(COMPACT_INSTRUCTIONS).toMatch(/open tasks/);
    expect(COMPACT_INSTRUCTIONS).toMatch(/paths/);
  });
});

describe('context breakdown', () => {
  const report = {
    categories: [
      { name: 'System prompt', tokens: 3_000, kind: 'used' },
      { name: 'System tools', tokens: 12_000, kind: 'used' },
      { name: 'Memory files', tokens: 5_000, kind: 'used' },
      { name: 'Messages', tokens: 80_000, kind: 'used' },
      { name: 'Free space', tokens: 80_000, kind: 'free' },
      { name: 'Autocompact buffer', tokens: 20_000, kind: 'buffer' },
      { name: 'MCP tools (deferred)', tokens: 9_000, kind: 'deferred' },
    ],
    messageBreakdown: { toolCallTokens: 6_000, toolResultTokens: 30_000 },
  };

  it('splits into conversation, tool results and system & files, scaled to what the model saw', () => {
    expect(breakdownFrom(report, 100_000)).toEqual({ conversation: 44_000, tools: 36_000, system: 20_000 });
    const scaled = breakdownFrom(report, 50_000)!;
    expect(scaled.conversation + scaled.tools + scaled.system).toBe(50_000);
  });

  it('says nothing when Claude Code reported nothing usable', () => {
    expect(breakdownFrom(undefined, 1000)).toBeUndefined();
    expect(breakdownFrom({ categories: [{ name: 'Free space', tokens: 10, kind: 'free' }] }, 1000)).toBeUndefined();
    expect(breakdownFrom({ categories: [{ name: 'Messages', tokens: 900 }], messageBreakdown: { toolResultTokens: 5_000 } }, 0)).toEqual({ conversation: 0, tools: 900, system: 0 });
  });
});

describe('prompt-cache hit rate', () => {
  it('is cache reads over fresh input, cache reads and cache writes', () => {
    expect(cacheHitPct(undefined)).toBeUndefined();
    expect(cacheHitPct({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    expect(cacheHitPct({ input: Number.NaN, cacheRead: Number.NaN, cacheWrite: Number.NaN })).toBeUndefined();
    expect(cacheHitPct({ input: 0, cacheRead: 100, cacheWrite: 0 })).toBe(100);
    expect(cacheHitPct({ input: 1_500, cacheRead: 6_000, cacheWrite: 300 })).toBe(77);
    expect(cacheHitPct({ input: 0, cacheRead: 0, cacheWrite: 50 })).toBe(0);
    expect(cacheHitPct({ input: -5, cacheRead: 10, cacheWrite: -1 })).toBe(100);
  });

  it('reads the session total, and the latest report until a session total exists', () => {
    const session = { input: 100, cacheRead: 50, cacheWrite: 50 };
    const last = { input: 10, cacheRead: 0, cacheWrite: 90 };
    expect(sessionCache({ session, last })).toEqual(session);
    expect(cacheHitOf({ session, last })).toMatchObject({ pct: 25, label: 'Cache 25%', counts: session });
    expect(cacheHitOf({ session, last })?.detail).toBe('Fresh 100 · cache read 50 · cache write 50');
    // Older records kept only the latest running total.
    expect(cacheHitOf({ last: { input: 20, cacheRead: 60, cacheWrite: 20 } })).toMatchObject({ pct: 60, label: 'Cache 60%' });
    expect(cacheHitOf({ last: { input: 1_500, cacheRead: 6_000, cacheWrite: 300 } })?.detail).toBe('Fresh 2k · cache read 6k · cache write 300');
    // A new session with nothing counted yet does not keep the previous session's rate.
    expect(cacheHitOf({ session: { input: 0, cacheRead: 0, cacheWrite: 0 }, last: { input: 0, cacheRead: 100, cacheWrite: 0 } })).toBeUndefined();
    expect(cacheHitOf(undefined)).toBeUndefined();
    expect(cacheHitOf({})).toBeUndefined();
  });

  it('adds a session up across turns, and starts over when the session changes', () => {
    const first = foldSessionCache(undefined, { input: 1_000, cacheRead: 5_000, cacheWrite: 300, session: 's1' }, false);
    expect(first).toEqual({ input: 1_000, cacheRead: 5_000, cacheWrite: 300 });
    // A running total: only the growth is new, so the session matches the report.
    const grown = foldSessionCache({ lastSession: 's1', last: { input: 1_000, cacheRead: 5_000, cacheWrite: 300 }, session: first }, { input: 1_500, cacheRead: 6_000, cacheWrite: 300, session: 's1' }, true);
    expect(grown).toEqual({ input: 1_500, cacheRead: 6_000, cacheWrite: 300 });
    expect(cacheHitPct(grown)).toBe(77);
    // A per-turn report that dropped: the whole turn is added.
    const turns = foldSessionCache({ lastSession: 's1', last: { input: 100, cacheRead: 10, cacheWrite: 40 }, session: { input: 100, cacheRead: 10, cacheWrite: 40 } }, { input: 20, cacheRead: 80, cacheWrite: 0, session: 's1' }, false);
    expect(turns).toEqual({ input: 120, cacheRead: 90, cacheWrite: 40 });
    expect(cacheHitPct(turns)).toBe(36);
    // A new session replaces the totals.
    expect(foldSessionCache({ lastSession: 's1', last: { input: 100, cacheRead: 10, cacheWrite: 40 }, session: turns }, { input: 5, cacheRead: 0, cacheWrite: 50, session: 's2' }, false)).toEqual({ input: 5, cacheRead: 0, cacheWrite: 50 });
    expect(cacheHitPct({ input: 5, cacheRead: 0, cacheWrite: 50 })).toBe(0);
    // No session id (a lifetime seed): the session totals stay put.
    expect(foldSessionCache({ session: first }, { input: 9, cacheRead: 9, cacheWrite: 9 }, false)).toEqual(first);
    expect(foldSessionCache(undefined, { input: 9, cacheRead: 9, cacheWrite: 9 }, false)).toBeUndefined();
  });
});
