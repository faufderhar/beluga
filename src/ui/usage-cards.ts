import { providersOf, usagesOf } from '../agent/usage.js';
import { type AgentRef, CLAUDE_AGENT, type PeerInfo, type Profile, type ProviderUsage } from '../protocol.js';

/** A plan window ready to draw: "5-hour", "Weekly", or the provider's own name for it. */
export interface CardWindow {
  readonly label: string;
  /** Two or three letters for tight rows ("5h", "wk"). */
  readonly short: string;
  readonly pct: number;
  readonly resetsAt?: number;
}

/**
 * One provider on the Usage tab (Mac and phone): quota windows where its plan has them, tokens and
 * speed where it doesn't (a local model), or nothing yet until its first run.
 */
export interface ProviderCard {
  /** Its runtime: one card per provider. */
  readonly key: string;
  readonly agent: AgentRef;
  readonly shape: 'quota' | 'tokens' | 'empty';
  readonly windows: readonly CardWindow[];
  readonly plan?: string;
  readonly tokens?: TokenCounts;
  readonly tokensPerSec?: number;
  readonly signedIn: boolean;
  /** The agent that answers when nobody names one (the make-default chip's state). */
  readonly isDefault: boolean;
  readonly updatedAt?: number;
  /**
   * Why a card has no plan window (Grok Build, when `grok usage` can't read the period).
   * Computed for this Mac's own view. Not part of the profile friends see.
   */
  readonly note?: string;
}

/** Two or three letters for a named window ("Weekly" -> "wk"). */
function shortOf(label: string): string {
  if (label === 'Weekly') return 'wk';
  if (label === 'Monthly') return 'mo';
  if (label === 'Daily') return 'day';
  return label.slice(0, 3).toLowerCase();
}

/** A provider's quota windows in order: 5-hour, weekly, then its own. */
export function windowsOf(u: Pick<ProviderUsage, 'fiveHour' | 'week' | 'windows'> | undefined): CardWindow[] {
  if (!u) return [];
  const out: CardWindow[] = [];
  if (u.fiveHour) out.push({ label: '5-hour', short: '5h', ...u.fiveHour });
  if (u.week) out.push({ label: 'Weekly', short: 'wk', ...u.week });
  for (const w of u.windows ?? []) out.push({ label: w.label, short: shortOf(w.label), pct: w.pct, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) });
  return out;
}

function cardOf(agent: AgentRef, u: ProviderUsage | undefined, isDefault: boolean): ProviderCard {
  const windows = windowsOf(u);
  const shape = windows.length ? 'quota' : u?.tokens || u?.tokensPerSec !== undefined ? 'tokens' : 'empty';
  return {
    key: agent.runtime,
    agent: u?.agent ?? agent,
    shape,
    windows,
    ...(u?.plan ? { plan: u.plan } : {}),
    ...(u?.tokens ? { tokens: u.tokens } : {}),
    ...(u?.tokensPerSec !== undefined ? { tokensPerSec: u.tokensPerSec } : {}),
    signedIn: u?.signedIn !== false,
    isDefault,
    ...(u ? { updatedAt: u.updatedAt } : {}),
  };
}

/**
 * Your providers as cards: Claude always, then every other one you run or that reported usage, in a
 * stable order (tapping make-default never moves them). `defaultAgent` is your setting's.
 */
export function providerCards(self: Pick<Profile, 'usage' | 'usages' | 'agents'> | undefined, defaultAgent: AgentRef | undefined): ProviderCard[] {
  const usages = usagesOf(self);
  const def = (defaultAgent ?? CLAUDE_AGENT).runtime;
  return providersOf(self).map((a) => cardOf(a, usages.find((u) => u.agent.runtime === a.runtime), a.runtime === def));
}

/** One friend's provider with quota windows: whose agent has room left. */
export interface FriendRoom {
  readonly peerId: string;
  readonly name: string;
  readonly agent: AgentRef;
  readonly windows: readonly CardWindow[];
  /** Percent left in its tightest window. */
  readonly left: number;
  /** It's the agent that answers when you ask them without naming one. */
  readonly isDefault: boolean;
}

/** Friends' providers that share quota windows, their default agent first, then by name. */
export function friendRooms(peers: readonly PeerInfo[], selfId: string | undefined): FriendRoom[] {
  return peers
    .filter((p) => p.peerId !== selfId)
    .flatMap((p) => {
      const def = (p.defaultAgent ?? p.agents?.[0] ?? CLAUDE_AGENT).runtime;
      return usagesOf(p)
        .map((u) => ({ peerId: p.peerId, name: p.name, agent: u.agent, windows: windowsOf(u), isDefault: u.agent.runtime === def }))
        .filter((r) => r.windows.length)
        .map((r) => ({ ...r, left: 100 - Math.max(...r.windows.map((w) => w.pct)) }))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    });
}

/** Workspaces and runtimes the Usage view already has, so a provider can show its local ledger before a refresh. */
export interface LocalLedger {
  readonly projects?: ReadonlyArray<{
    readonly name: string;
    readonly workspaces: ReadonlyArray<{
      readonly agent?: { readonly runtime: string };
      readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead?: number; readonly cacheWrite?: number };
    }>;
  }>;
  readonly runtimes?: ReadonlyArray<{ readonly id: string; readonly label?: string; readonly available: boolean; readonly state?: string }>;
  readonly defaultRuntime?: string;
  readonly projectAgents?: Readonly<Record<string, { readonly runtime: string }>>;
}

const GROK = 'grok';

const grokNote = (team: boolean, tokens: boolean): string => {
  if (team) return tokens ? 'Usage limits are managed by your team. These tokens are from conversations on this Mac.' : 'Usage limits are managed by your team.';
  return tokens ? "Grok Build can't report its billing period from here. These tokens are from conversations on this Mac." : "Grok Build can't report its billing period from here. It shows up after a conversation reports tokens.";
};

/**
 * Grok Build's card for this Mac. A plan window from `grok usage` is left as it is. Otherwise the
 * card says the period isn't available here and, when conversations counted tokens, shows those.
 * A signed-out Grok stays signed out. Friends' profiles pass no ledger, so their cards are unchanged.
 */
export function withLocalUsage(cards: readonly ProviderCard[], ledger?: LocalLedger): ProviderCard[] {
  if (!ledger) return [...cards];
  const grok = ledger.runtimes?.find((r) => r.id === GROK);
  const available = Boolean(grok?.available && grok.state !== 'missing');
  const fallback = ledger.defaultRuntime ?? 'claude';
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const project of ledger.projects ?? []) {
    for (const ws of project.workspaces) {
      const runtime = ws.agent?.runtime ?? ledger.projectAgents?.[project.name]?.runtime ?? fallback;
      if (runtime !== GROK || !ws.usage) continue;
      input += ws.usage.input;
      output += ws.usage.output;
      cacheRead += ws.usage.cacheRead ?? 0;
      cacheWrite += ws.usage.cacheWrite ?? 0;
    }
  }
  const counted: TokenCounts = { input, output, ...(cacheRead > 0 ? { cacheRead } : {}), ...(cacheWrite > 0 ? { cacheWrite } : {}) };
  const hasTokens = tokenTotal(counted) > 0;
  const existing = cards.find((c) => c.key === GROK);
  if (existing?.signedIn === false || grok?.state === 'signed_out') {
    if (existing?.signedIn === false) return [...cards];
    if (!available && !existing) return [...cards];
    const signedOut: ProviderCard = {
      key: GROK,
      agent: existing?.agent ?? { runtime: GROK, label: grok?.label || 'Grok Build' },
      shape: 'empty',
      windows: [],
      signedIn: false,
      isDefault: existing?.isDefault ?? fallback === GROK,
      ...(existing?.updatedAt ? { updatedAt: existing.updatedAt } : {}),
    };
    return existing ? cards.map((c) => (c.key === GROK ? signedOut : c)) : [...cards, signedOut];
  }
  // A period already read from grok usage stays. A runtime that isn't on this Mac, with nothing counted, stays as it was.
  if (existing?.shape === 'quota') return [...cards];
  if (!available && !hasTokens) return [...cards];
  const tokens = hasTokens ? counted : existing?.tokens;
  const team = existing?.plan === 'Team';
  const note = grokNote(team, Boolean(tokens));
  const next: ProviderCard = {
    key: GROK,
    agent: existing?.agent ?? { runtime: GROK, label: grok?.label || 'Grok Build' },
    shape: tokens ? 'tokens' : 'empty',
    windows: existing?.windows ?? [],
    ...(existing?.plan ? { plan: existing.plan } : {}),
    ...(tokens ? { tokens } : {}),
    ...(existing?.tokensPerSec !== undefined ? { tokensPerSec: existing.tokensPerSec } : {}),
    signedIn: true,
    isDefault: existing?.isDefault ?? fallback === GROK,
    ...(existing?.updatedAt ? { updatedAt: existing.updatedAt } : {}),
    note,
  };
  return existing ? cards.map((c) => (c.key === GROK ? next : c)) : [...cards, next];
}

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
