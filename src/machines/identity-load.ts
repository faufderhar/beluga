import path from 'node:path';
import { type Identity, generateIdentity, identityFromPem, loadIdentity } from '../net/crypto.js';
import { readJson } from '../net/mesh/files.js';
import { readAlwaysOn } from './always-on-state.js';

/**
 * Which identity each part of this install uses, by one rule (BLG-846), read at start and by Always On:
 *
 *  - `local`: identity.json, what the device set, the companion and the friends network read through.
 *    After this install handed your identity to your Always On it is a stand-in key of its own.
 *  - `you`: your own identity whenever this install has it: identity.json while it holds it, else this
 *    Mac's standby copy (identity-standby.json, kept since the handover, BLG-799). Rooms you host or
 *    join from here sign with it, so friends see the same you, with their trust, after any restart.
 *    Never the stand-in key while a standby copy of yours is here.
 *
 * Standing in for your Always On (always-on.json says so, BLG-847), `local` is your standby copy too:
 * this Mac is still you after a restart, runs your network and hands back. identity.json keeps the
 * stand-in key meanwhile, which is what this Mac goes back to once it hands back.
 */

export const IDENTITY_FILE = 'identity.json';
export const STANDBY_IDENTITY = 'identity-standby.json';

/** Whose set this install is in (device-set.json), when it says. */
const ownerOf = (dir: string): string | undefined => {
  const raw = readJson(path.join(dir, 'device-set.json')) as { owner?: { peerId?: unknown } } | undefined;
  return typeof raw?.owner?.peerId === 'string' ? raw.owner.peerId : undefined;
};

/** An identity file, if it holds a key (and it's `owner`'s, when given). */
export function readIdentityFile(file: string, owner?: string): Identity | undefined {
  const raw = readJson(file) as { privateKey?: unknown } | undefined;
  if (typeof raw?.privateKey !== 'string') return undefined;
  try {
    const identity = identityFromPem(raw.privateKey);
    return owner === undefined || identity.peerId === owner ? identity : undefined;
  } catch {
    return undefined;
  }
}

/** This Mac's standby copy of your identity, when it has one that is the owner's. */
export const standbyIdentity = (dir: string, owner = ownerOf(dir)): Identity | undefined => readIdentityFile(path.join(dir, STANDBY_IDENTITY), owner);

export interface StartIdentities {
  readonly local: Identity;
  readonly you: Identity;
}

/**
 * identity.json, or a one-off key for this run when the file is there but broken: Beluga still starts
 * (or a handover still ends), and the file stays as it is (replacing it would change your peer id and
 * the trust tied to it).
 */
export function identityOrOneOff(file: string, warn: (message: string) => void): Identity {
  try {
    return loadIdentity(file);
  } catch (err) {
    warn(`${err instanceof Error ? err.message : String(err)}. Beluga runs with a one-off identity until it's fixed: restore the file from a backup, or move it aside to get a new identity (friends will see you as someone new).`);
    return generateIdentity();
  }
}

/** The identities this install starts with (identity.json is made when missing, as ever). */
export function identitiesAtStart(dir: string, warn: (message: string) => void = (m) => console.error(m)): StartIdentities {
  const own = identityOrOneOff(path.join(dir, IDENTITY_FILE), warn);
  const standby = standbyIdentity(dir);
  const local = standby && readAlwaysOn(dir)?.standIn ? standby : own;
  return { local, you: standby ?? local };
}
