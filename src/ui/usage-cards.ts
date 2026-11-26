import { providersOf, usagesOf } from '../agent/usage.js';
import { isFixedRuntime } from '../shared/agent-runtimes.js';
import { THIS_COMPUTER } from '../shared/assistant.js';
import { type TokenCounts, shortTokens, tokenDetail, tokenTotal } from '../shared/token-format.js';
import type { AgentWeek } from './agent-week.js';
import { type AgentRef, CLAUDE_AGENT, type PeerInfo, type Profile, type ProviderUsage } from '../protocol.js';

export { type TokenCounts, shortTokens, tokenDetail, tokenTotal };

/** A plan window ready to draw: "5-hour", "Weekly", or the provider's own name for it. */
export interface CardWindow {
  readonly label: string;
  /** Two or three letters for tight rows ("5h", "wk"). */
  readonly short: string;
  readonly pct: number;
  readonly resetsAt?: number;
  /** The models it's for, when its provider keeps a limit per group of models ("Gemini Models"). */
  readonly group?: string;
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
  /** An ACP agent's week, as Beluga counted it (none for the fixed agents, or before your stats are here). */
  readonly week?: AgentWeek;
}

/** A provider's quota windows in order: 5-hour, weekly, then its own. */
/** The short names Claude's own windows have, for a provider's windows of the same length. */
const SHORT: Readonly<Record<string, string>> = { '5-hour': '5h', Weekly: 'wk', Monthly: 'mo', Daily: 'day' };

/** The heading over a window: its group of models, when its provider keeps a limit per group ("Gemini Models"). */
export const windowHeading = (w: Pick<CardWindow, 'group'>): string | undefined => w.group;

export function windowsOf(u: Pick<ProviderUsage, 'fiveHour' | 'week' | 'windows'> | undefined): CardWindow[] {
  if (!u) return [];
  const out: CardWindow[] = [];
  if (u.fiveHour) out.push({ label: '5-hour', short: '5h', ...u.fiveHour });
  if (u.week) out.push({ label: 'Weekly', short: 'wk', ...u.week });
  for (const w of u.windows ?? []) out.push({ label: w.label, short: SHORT[w.label] ?? w.label.slice(0, 3).toLowerCase(), pct: w.pct, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), ...(w.group ? { group: w.group } : {}) });
  return out;
}

function cardOf(agent: AgentRef, u: ProviderUsage | undefined, isDefault: boolean, week?: AgentWeek): ProviderCard {
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
    ...(week ? { week } : {}),
  };
}

/** Where a runtime stands here, as the agent pickers have it (shared/agent-runtimes.ts): unknown until asked. */
export type RuntimeReadiness = ReadonlyArray<{ readonly id: string; readonly state?: string }>;

/**
 * Your providers as cards: Claude always, then every other one you run or that reported usage, in a
 * stable order (tapping make-default never moves them). `defaultAgent` is your setting's. With
 * `runtimes` (yours, as the pickers have them), a card shows only while its agent is ready here:
 * one that isn't installed or signed in has no card. One not asked about yet keeps its card.
 * `weekOf`: an ACP agent's week (the Mac: the Usage tab's stats; the phone: the daemon's).
 */
export function providerCards(self: Pick<Profile, 'usage' | 'usages' | 'agents'> | undefined, defaultAgent: AgentRef | undefined, runtimes?: RuntimeReadiness, weekOf?: (runtime: string) => AgentWeek | undefined): ProviderCard[] {
  const usages = usagesOf(self);
  const def = (defaultAgent ?? CLAUDE_AGENT).runtime;
  const ready = (runtime: string): boolean => {
    const state = runtimes?.find((r) => r.id === runtime)?.state;
    return state === undefined || state === 'ready';
  };
  return providersOf(self)
    .filter((a) => ready(a.runtime))
    .map((a) => cardOf(a, usages.find((u) => u.agent.runtime === a.runtime), a.runtime === def, isFixedRuntime(a.runtime) ? undefined : weekOf?.(a.runtime)));
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
  if (team) return tokens ? `Usage limits are managed by your team. These tokens are from conversations on ${THIS_COMPUTER}.` : 'Usage limits are managed by your team.';
  return tokens ? `Grok Build can't report its billing period from here. These tokens are from conversations on ${THIS_COMPUTER}.` : "Grok Build can't report its billing period from here. It shows up after a conversation reports tokens.";
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
