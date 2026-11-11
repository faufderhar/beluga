import type { TrustLevel } from '../shared/settings-schema.js';
import type { DomainState } from './store.js';

export type { TrustLevel } from '../shared/settings-schema.js';

/** Plain-language names and what each level means, used everywhere it's shown. */
export const TRUST_INFO: Readonly<Record<TrustLevel, { label: string; short: string; detail: string }>> = {
  blocked: { label: "Can't use my agent", short: 'blocked', detail: 'They can chat, but requests for your agent are declined.' },
  ask: { label: 'Ask me each time', short: 'asks you', detail: 'You approve each request. Their agent only reaches your shared folders; reading anything else asks you.' },
  trusted: { label: 'Trusted', short: 'trusted', detail: 'Requests run without asking. Commands, edits and files outside your shared folders still ask you.' },
  full: { label: 'Full trust', short: 'full trust', detail: 'Anything on this computer, without asking, like you would yourself. Beluga refuses commands and files that name secrets (.env, keys) and keeps your tokens out of their commands, but a determined friend could still get around that.' },
};

/** The same levels seen from the other side: what a friend's trust lets you (and your Claude) do there. */
export const GRANT_INFO: Readonly<Record<TrustLevel, { short: string; detail: string }>> = {
  blocked: { short: 'nothing', detail: 'requests to their agent and their computer are declined' },
  ask: { short: 'ask each time', detail: 'they approve every request and every command' },
  trusted: { short: 'use their agent without asking', detail: 'requests run right away; commands and files outside shared folders ask them' },
  full: { short: 'anything, without asking', detail: 'requests and commands run right away, anywhere on their computer (Beluga refuses anything naming secrets)' },
};

/** May you ask this friend's computer to run commands? (they still approve unless they fully trust you) */
export const canRunOn = (level: TrustLevel | undefined): boolean => level !== undefined && level !== 'blocked';

/**
 * A command someone asks your Beluga to run on this computer: 'run' without asking (full trust),
 * 'ask' you first (Yes / No / Always for this person), or 'decline' (blocked).
 */
export function shellGate(level: TrustLevel): 'run' | 'ask' | 'decline' {
  return level === 'full' ? 'run' : level === 'blocked' ? 'decline' : 'ask';
}

/** The level someone gets when you haven't picked one: your default for new people. */
export function defaultTrust(state: Pick<DomainState, 'policy'>): TrustLevel {
  return state.policy === 'deny' ? 'blocked' : state.policy === 'auto' ? 'trusted' : 'ask';
}

/** What trustOf reads: `remembered` is optional only so small test states can leave it out. */
type TrustState = Pick<DomainState, 'policy' | 'levels' | 'self'> & Partial<Pick<DomainState, 'remembered'>>;

/**
 * How much you trust this person right now (you always fully trust yourself): chosen in the room,
 * else what you saved for them, else your default. `levels` only holds people in the room: a
 * friend reaching you through the friends network (a shared worktree's chat, a DM) is never in
 * it, and keeps the level you gave them all the same.
 */
export function trustOf(state: TrustState, peerId: string): TrustLevel {
  if (peerId === state.self?.peerId) return 'full';
  return state.levels[peerId] ?? state.remembered?.[peerId]?.trust ?? defaultTrust(state);
}

/** How far a request from this person may reach: 'full' lets their Claude read anywhere without asking. */
export function reachOf(state: TrustState & Pick<DomainState, 'access'>, peerId: string): 'folder' | 'full' {
  return trustOf(state, peerId) === 'full' ? 'full' : (state.access[peerId] ?? 'folder');
}

/** What one requester of a run may do: its level and how far it reaches. */
export interface RequesterTrust {
  readonly level: TrustLevel;
  readonly reach: 'folder' | 'full';
}

/** An external agent as a requester: `ext:<grant id>`. It is you on another screen, with its own grant, name, Stop and Revoke. */
const EXTERNAL_PREFIX = 'ext:';
export const externalRequester = (grantId: string): string => `${EXTERNAL_PREFIX}${grantId}`;
export const isExternalRequester = (requester: string): boolean => requester.startsWith(EXTERNAL_PREFIX);

/** A live grant, as a run sees it. */
export interface ExternalAgent {
  readonly name: string;
  readonly level: TrustLevel;
}
/** The live grant behind an `ext:` requester. Undefined: revoked, expired or never there. */
export type ExternalLookup = (requester: string) => ExternalAgent | undefined;

/**
 * The one place a run asks who its requester is worth: each check on a run reads its answer. An
 * external agent's worth is its grant's, read each time, so the people book can't change it and a
 * grant that's gone is worth nothing.
 */
export function requesterTrust(state: Pick<DomainState, 'policy' | 'levels' | 'self' | 'access'>, requester: string, external?: ExternalLookup): RequesterTrust {
  if (isExternalRequester(requester)) {
    const level = external?.(requester)?.level ?? 'blocked';
    return { level, reach: level === 'full' ? 'full' : 'folder' };
  }
  return { level: trustOf(state, requester), reach: reachOf(state, requester) };
}
