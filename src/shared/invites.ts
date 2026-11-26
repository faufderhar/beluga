import type { Guest } from '../core/collab-store.js';
import type { GuestCan, WsRole } from '../protocol.js';
import type { TrustLevel } from './settings-schema.js';
import { knownOr } from './known-or.js';

// Project links as data (no network, no keys): shared by the core and the Mac app.

export interface LinkOptions {
  /** A project id, or 'room' for everything. */
  readonly scope: string;
  readonly can: GuestCan;
  readonly knock: boolean;
  readonly singleUse: boolean;
  /** 0: never expires. */
  readonly expiresInMs: number;
}

export const DAY_MS = 24 * 60 * 60_000;
export const DEFAULT_LINK: Omit<LinkOptions, 'scope'> = { can: 'prompt', knock: true, singleUse: true, expiresInMs: DAY_MS };

export const CAN_INFO: Readonly<Record<GuestCan, { label: string; short: string; detail: string }>> = knownOr({
  watch: { label: 'Watch', short: 'can watch', detail: 'see the chat history and browse the files' },
  prompt: { label: 'Prompt', short: 'can prompt', detail: 'talk to your agent there; edits and commands follow your approval rules' },
  edit: { label: 'Edit', short: 'can edit', detail: 'your agent edits files in that folder without asking; commands still ask you' },
}, (v) => ({ label: v, short: v, detail: '' }));

/** Watching is following along; prompting and editing are working there. */
export const roleFor = (can: GuestCan): WsRole => (can === 'watch' ? 'view' : 'contribute');

/** The trust level a guest gets for your Claude (editing inside their projects is allowed separately). */
export const trustFor = (can: GuestCan): TrustLevel => (can === 'watch' ? 'blocked' : can === 'edit' ? 'trusted' : 'ask');

/** "bob-api · can prompt", or "everything · can watch". */
export function guestSummary(guest: Guest, projectName: (id: string) => string): string {
  const where = guest.room ? 'everything' : guest.projects.map(projectName).join(', ') || 'nothing yet';
  return `${where} · ${CAN_INFO[guest.can].short}`;
}

/** "in 23h", "in 40 min", "expired". */
export function expiresIn(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return 'never expires';
  const left = expiresAt - now;
  if (left <= 0) return 'expired';
  return left >= 60 * 60_000 ? `expires in ${Math.round(left / (60 * 60_000))}h` : `expires in ${Math.max(1, Math.round(left / 60_000))} min`;
}
