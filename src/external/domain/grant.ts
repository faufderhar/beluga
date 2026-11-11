import { redactSecrets } from '../../shared/steps.js';
import type { Level, Route } from './decide.js';

/** Which chats it reaches beyond its projects' own: none by default. */
export interface ChatScope {
  readonly dms: boolean;
  readonly groups: boolean;
}

export type ProjectScope = 'all' | readonly string[];

/** One external agent's grant, as callers see it: its token hashes stay in the store. */
export interface Grant {
  readonly id: string;
  readonly name: string;
  readonly clientId: string;
  readonly redirectHost: string;
  readonly route: Route;
  readonly level: Level;
  /** 'all': each project, also those added later, and your chats with no project. A list reaches only what it names: empty reaches nothing. */
  readonly projects: ProjectScope;
  readonly chats: ChatScope;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastSeen: number;
  /** The owner chose full for this remote grant, on its pairing code. */
  readonly allowRemoteFull?: boolean;
  /** A person must lift it: until then every call gets grant_suspended. */
  readonly suspendedAt?: number;
}

export type NewGrant = Pick<Grant, 'name' | 'clientId' | 'redirectHost' | 'route' | 'level' | 'projects' | 'expiresAt'> & { readonly chats?: ChatScope; readonly allowRemoteFull?: boolean };

export const DEFAULT_CHATS: ChatScope = { dms: false, groups: false };

/** In a grant's projects: all your chats with no project (the sidebar's), which can be private. Off by default. */
export const STANDALONE_CHATS = 'chats';

/** What a new grant reaches unless its code says less: what you reach in the UI. */
export const FULL_REACH = { level: 'full', projects: 'all', chats: { dms: true, groups: true } } as const;

/** A code's level when it says none. Outside this computer, Full takes an explicit choice for that one code. */
export const defaultLevel = (remote: boolean | undefined): 'trusted' | 'full' => (remote ? 'trusted' : FULL_REACH.level);

export function reachesProject(grant: Pick<Grant, 'projects'>, projectId: string): boolean {
  return grant.projects === 'all' || grant.projects.includes(projectId);
}

/** The ids of what a grant reaches, out of those that exist now. */
export function reachedProjects(grant: Pick<Grant, 'projects'>, existing: readonly string[]): readonly string[] {
  return grant.projects === 'all' ? existing : grant.projects;
}

export function isExpired(grant: Pick<Grant, 'expiresAt'>, now: number): boolean {
  return grant.expiresAt <= now;
}

const NAME_MAX = 80;

/** A name a client or a command chose, as Beluga shows and logs it: one line, short, no secret in it. */
export function cleanAgentName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const line = redactSecrets(name.replace(/[\u0000-\u001f\u007f]/g, ' ')).trim().slice(0, NAME_MAX);
  return line || 'An MCP client';
}
