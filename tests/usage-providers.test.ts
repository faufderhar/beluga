import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { usageFor, usagesOf, withUsage } from '../src/agent/usage.js';
import { CLAUDE_AGENT, PeerInfo, Profile } from '../src/protocol.js';
import { friendRooms, providerCards, shortTokens, windowHeading } from '../src/ui/usage-cards.js';
import { usageViews } from '../src/companion/views.js';

/** The Profile an older Mac (before per-provider usage) parses frames with. */
const OldWindow = z.object({ pct: z.number().min(0).max(100), resetsAt: z.number().optional() });
const OldUsage = z.object({ plan: z.string().max(32).optional(), fiveHour: OldWindow.optional(), week: OldWindow.optional(), updatedAt: z.number() });
const OldProfile = z.object({
  name: z.string().regex(/^[\w.-]{1,32}$/),
  shares: z.array(z.object({ name: z.string(), writable: z.boolean() })).max(32),
  agent: z.boolean(),
  usage: OldUsage.optional(),
  projects: z.array(z.string().max(80)).max(60).optional(),
});
const OldPeerInfo = OldProfile.extend({ peerId: z.string().min(1).max(256), host: z.boolean().optional(), guest: z.boolean().optional() });

const codex = { runtime: 'codex', label: 'Codex' };
const local = { runtime: 'local', model: 'qwen3', label: 'Qwen' };

describe('usage per provider', () => {
  it('sends the phone an ACP agent’s week, its quiet week too', () => {
    const p = { agents: [{ runtime: 'cursor', label: 'Cursor' }] };
    const zero = { runs: 0, agentMs: 0, tokens: 0, cost: 0, days: [0, 0, 0, 0, 0, 0, 0] };
    expect(usageViews(p, undefined, undefined, () => zero).find((v) => v.runtime === 'cursor')?.week).toEqual({ runs: 0, agentMs: 0, tokens: 0, days: [0, 0, 0, 0, 0, 0, 0] });
    // A friend's card (no week passed) never has one.
    expect(usageViews(p, undefined).find((v) => v.runtime === 'cursor')).toBeUndefined();
  });

  it('gives an ACP agent’s card its week, and never a fixed agent’s', () => {
    const p = { agents: [{ runtime: 'cursor', label: 'Cursor' }, { runtime: 'codex', label: 'Codex' }] };
    const week = { runs: 3, agentMs: 1, tokens: 2, cost: 0, days: [0, 0, 0, 0, 0, 0, 1] };
    expect(providerCards(p, undefined, undefined, () => week).map((c) => [c.key, c.week?.runs])).toEqual([
      ['claude', undefined],
      ['cursor', 3],
      ['codex', undefined],
    ]);
  });

  const base = { name: 'kay', shares: [], agent: true };

  it('merges each update into its own provider and keeps the old field Claude’s', () => {
    let p: Profile = { ...base };
    p = { ...p, ...withUsage(p, CLAUDE_AGENT, { plan: 'max', fiveHour: { pct: 12 } }, 1) };
    p = { ...p, ...withUsage(p, codex, { windows: [{ label: 'Weekly', pct: 30 }] }, 2) };
    p = { ...p, ...withUsage(p, local, { tokens: { input: 900, output: 300 }, tokensPerSec: 41 }, 3) };
    p = { ...p, ...withUsage(p, CLAUDE_AGENT, { week: { pct: 40 } }, 4) };
    expect(usagesOf(p).map((u) => u.agent.runtime)).toEqual(['claude', 'codex', 'local']);
    expect(usageFor(p, 'claude')).toMatchObject({ plan: 'max', fiveHour: { pct: 12 }, week: { pct: 40 }, updatedAt: 4 });
    expect(usageFor(p, 'codex')).toMatchObject({ windows: [{ label: 'Weekly', pct: 30 }], updatedAt: 2 });
    expect(usageFor(p, 'codex')?.fiveHour).toBeUndefined();
    expect(usageFor(p, 'local')).toMatchObject({ agent: local, tokensPerSec: 41 });
    expect(p.usage).toEqual({ plan: 'max', fiveHour: { pct: 12 }, week: { pct: 40 }, updatedAt: 4 });
    expect(Profile.parse(p)).toEqual(p);
  });

  it('a Codex-only Mac sends no Claude usage in the old field', () => {
    const p = withUsage({}, codex, { windows: [{ label: '5h', pct: 5 }] }, 1);
    expect(p.usage).toBeUndefined();
    expect(p.usages).toHaveLength(1);
  });

  it('reads an older Mac’s single usage as Claude’s', () => {
    const old = { usage: { fiveHour: { pct: 9 }, updatedAt: 1 } };
    expect(usagesOf(old)).toEqual([{ fiveHour: { pct: 9 }, updatedAt: 1, agent: CLAUDE_AGENT }]);
    expect(usagesOf(undefined)).toEqual([]);
    // Its next update starts the list from that Claude entry.
    expect(withUsage(old, codex, { tokensPerSec: 3 }, 2).usages?.map((u) => u.agent.runtime)).toEqual(['claude', 'codex']);
  });

  it('an old client still parses current frames', () => {
    let p: Profile = { ...base };
    p = { ...p, ...withUsage(p, CLAUDE_AGENT, { plan: 'pro', fiveHour: { pct: 50, resetsAt: 9 } }, 1) };
    p = { ...p, ...withUsage(p, codex, { windows: [{ label: 'Weekly', pct: 3 }], signedIn: true }, 2) };
    const frame = JSON.parse(JSON.stringify(PeerInfo.parse({ ...p, peerId: 'abc', agents: [CLAUDE_AGENT, codex], defaultAgent: codex })));
    const seen = OldPeerInfo.parse(frame);
    expect(seen.usage).toEqual({ plan: 'pro', fiveHour: { pct: 50, resetsAt: 9 }, updatedAt: 1 });
    expect(OldProfile.parse(frame).name).toBe('kay');
  });

  it('makes one card per provider, in the shape its data has', () => {
    let p: Profile = { ...base, agents: [CLAUDE_AGENT, codex] };
    p = { ...p, ...withUsage(p, CLAUDE_AGENT, { plan: 'max', fiveHour: { pct: 12 }, week: { pct: 38 } }, 1) };
    p = { ...p, ...withUsage(p, local, { tokens: { input: 1000, output: 500 }, tokensPerSec: 38 }, 2) };
    const cards = providerCards(p, codex);
    expect(cards.map((c) => [c.key, c.shape, c.isDefault])).toEqual([
      ['claude', 'quota', false],
      ['codex', 'empty', true],
      ['local', 'tokens', false],
    ]);
    expect(cards[0]?.windows.map((w) => `${w.label} ${w.pct}`)).toEqual(['5-hour 12', 'Weekly 38']);
    expect(providerCards(p, undefined).find((c) => c.isDefault)?.key).toBe('claude');
    expect(providerCards(withUsage({}, codex, { signedIn: false }), undefined).find((c) => c.key === 'codex')?.signedIn).toBe(false);
    expect(shortTokens(1500)).toBe('2k');
    expect(shortTokens(1_234_567)).toBe('1.2M');
  });

  it('gives Antigravity a card of its own, its windows headed by their group of models', () => {
    const agy = { runtime: 'antigravity', label: 'Antigravity' };
    let p: Pick<Profile, 'usage' | 'usages' | 'agents'> = { agents: [CLAUDE_AGENT, agy] };
    p = { ...p, ...withUsage(p, CLAUDE_AGENT, { plan: 'max', week: { pct: 31 } }, 1) };
    p = { ...p, ...withUsage(p, agy, { plan: 'Google AI Ultra', windows: [{ group: 'Gemini Models', label: '5-hour', pct: 25 }, { group: 'Gemini Models', label: 'Weekly', pct: 8 }, { group: 'Claude and GPT models', label: '5-hour', pct: 0 }] }, 2) };
    const cards = providerCards(p, agy);
    expect(cards.map((c) => [c.key, c.isDefault, c.windows.length])).toEqual([
      ['claude', false, 1],
      ['antigravity', true, 3],
    ]);
    expect(cards[1]).toMatchObject({ plan: 'Google AI Ultra', shape: 'quota', updatedAt: 2 });
    expect(cards[1]?.windows.map((w) => [windowHeading(w), w.label, w.short])).toEqual([
      ['Gemini Models', '5-hour', '5h'],
      ['Gemini Models', 'Weekly', 'wk'],
      ['Claude and GPT models', '5-hour', '5h'],
    ]);
    // Claude's own windows have no group: no heading over them.
    expect(windowHeading(cards[0]!.windows[0]!)).toBeUndefined();
    // A group's name rides through the profile a friend's Mac parses.
    expect(Profile.parse({ ...base, ...p }).usages?.[1]?.windows?.[0]?.group).toBe('Gemini Models');
  });

  it('shows a card only while its agent is ready here, keeping one not asked about yet', () => {
    const agy = { runtime: 'antigravity', label: 'Antigravity' };
    const codexRef = { runtime: 'codex', label: 'Codex' };
    let p: Pick<Profile, 'usage' | 'usages' | 'agents'> = { agents: [CLAUDE_AGENT, codexRef, agy] };
    p = { ...p, ...withUsage(p, CLAUDE_AGENT, { plan: 'max', week: { pct: 31 } }, 1) };
    p = { ...p, ...withUsage(p, codexRef, { plan: 'plus', windows: [{ label: 'Weekly', pct: 24 }] }, 1) };
    p = { ...p, ...withUsage(p, agy, { windows: [{ group: 'Gemini Models', label: '5-hour', pct: 25 }] }, 1) };
    const keys = (runtimes?: Parameters<typeof providerCards>[2]) => providerCards(p, undefined, runtimes).map((c) => c.key);
    // Nothing asked yet: every card, as before.
    expect(keys()).toEqual(['claude', 'codex', 'antigravity']);
    expect(keys([{ id: 'claude' }, { id: 'codex' }, { id: 'antigravity' }])).toEqual(['claude', 'codex', 'antigravity']);
    // Codex signed out, Antigravity not installed: no cards for them.
    expect(keys([{ id: 'claude', state: 'ready' }, { id: 'codex', state: 'signed_out' }, { id: 'antigravity', state: 'missing' }])).toEqual(['claude']);
    // Claude signed out here: its card goes too, and Antigravity's ready one stays.
    expect(keys([{ id: 'claude', state: 'signed_out' }, { id: 'codex', state: 'signed_out' }, { id: 'antigravity', state: 'ready' }])).toEqual(['antigravity']);
    // The phone's cards follow the same rule, and a group's window says its group there.
    expect(usageViews(p, undefined, [{ id: 'codex', state: 'missing' }]).map((u) => [u.runtime, u.windows.map((w) => w.label)])).toEqual([
      ['claude', ['Week']],
      ['antigravity', ['Gemini Models · 5 hours']],
    ]);
  });

  it('shows whose agent has room left, across providers', () => {
    const mia = { ...base, name: 'mia', peerId: 'm', defaultAgent: codex, ...withUsage(withUsage({}, CLAUDE_AGENT, { fiveHour: { pct: 10 } }), codex, { fiveHour: { pct: 71 }, week: { pct: 46 } }) };
    const old = { ...base, name: 'bob', peerId: 'b', usage: { week: { pct: 80 }, updatedAt: 1 } };
    const me = { ...base, peerId: 'k', ...withUsage({}, CLAUDE_AGENT, { fiveHour: { pct: 1 } }) };
    const rooms = friendRooms([me, mia, old], 'k');
    expect(rooms.map((r) => `${r.name} ${r.agent.label} ${r.left}${r.isDefault ? ' default' : ''}`)).toEqual(['mia Codex 29 default', 'mia Claude 90', 'bob Claude 20 default']);
  });
});
