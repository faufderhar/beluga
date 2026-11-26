import type { WsRole } from '../protocol.js';

/**
 * What a friend you share with can do (BLG-1019), as one ladder the share sheets offer: see it, chat
 * (and ask your agent), fork it to their computer, or fork it with the secrets you ticked in What
 * Forks Bring. Underneath it's still a role (view / contribute) plus, for forks, a fork grant.
 * Browser-safe: the Mac's sheets, the core and the phone read the same words.
 */

/** May fork: the code and its context, or those and the secrets you ticked. */
export type ForkGrant = 'code' | 'secrets';
/** What a friend's Mac is told: `none` (no fork), or the grant. Unset: an older Mac's, where "work here" could fork. */
export type ForksSaid = 'none' | ForkGrant;

export type ShareLevel = 'view' | 'contribute' | 'fork' | 'secrets';

export interface ShareLevelInfo {
  readonly value: ShareLevel;
  readonly label: string;
  readonly description: string;
}

export const SHARE_LEVELS: readonly ShareLevelInfo[] = [
  { value: 'view', label: 'Can see', description: 'Reads along, read-only' },
  { value: 'contribute', label: 'Can chat', description: 'Chats and asks your agent' },
  { value: 'fork', label: 'Can fork', description: 'Also forks it to their computer, never a secret' },
  { value: 'secrets', label: 'Can fork with secrets', description: 'Forks with the secrets you ticked in What Forks Bring' },
];

/** The levels a place offers: forks only where there's a project to fork (a worktree, a project with a folder). */
export const levelsFor = (forks: boolean): readonly ShareLevelInfo[] => (forks ? SHARE_LEVELS : SHARE_LEVELS.slice(0, 2));

export function levelOf(role: WsRole, fork?: ForkGrant): ShareLevel {
  if (role !== 'contribute') return 'view';
  return fork === 'secrets' ? 'secrets' : fork === 'code' ? 'fork' : 'contribute';
}

/** A level as what the share call takes: its role, and its fork said outright (`none` takes one away). */
export function grantOfLevel(level: ShareLevel): { readonly role: WsRole; readonly fork: ForkGrant | 'none' } {
  if (level === 'view') return { role: 'view', fork: 'none' };
  if (level === 'fork') return { role: 'contribute', fork: 'code' };
  if (level === 'secrets') return { role: 'contribute', fork: 'secrets' };
  return { role: 'contribute', fork: 'none' };
}

/** Whether a friend's shared project lets you fork it: what its owner said, or (an older Mac's) whether you work there. */
export function mayFork(project: { readonly role: WsRole; readonly forks?: ForksSaid }): boolean {
  return project.forks === undefined ? project.role === 'contribute' : project.forks !== 'none';
}

/** What a friend can do at a level, in a toast: "Mia can now fork it with secrets". */
export function levelWords(level: ShareLevel): string {
  return level === 'view' ? 'can now follow along' : level === 'contribute' ? 'can now chat with you' : level === 'fork' ? 'can now chat and fork it' : 'can now chat and fork it with secrets';
}
