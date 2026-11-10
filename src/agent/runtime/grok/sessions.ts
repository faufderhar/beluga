import { existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCode } from '../opencode/models.js';
import { findGrok } from './connection.js';

/** A Grok session id (a UUID): only those are passed to its command line. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const defaultHome = (): string => process.env.GROK_HOME || path.join(os.homedir(), '.grok');

/** The name of the folder under `sessions` holding this session, if any. */
function folderOf(sessionId: string, root: string): string | undefined {
  try {
    return readdirSync(root).find((name) => existsSync(path.join(root, name, sessionId)));
  } catch {
    return undefined;
  }
}

/**
 * Forget Grok's own record of a conversation (a deleted chat's, a side call's): `grok sessions
 * delete <id>`. It doesn't know a forked session ("No session found"), and every /btw is one, so
 * whatever it leaves of this session is removed too. One that's already gone is fine.
 */
export async function dropGrokSession(sessionId: string, bin: string | undefined = findGrok(), home: string = defaultHome()): Promise<boolean> {
  if (!bin || !SESSION_ID.test(sessionId)) return false;
  const told = (await openCode(bin, ['sessions', 'delete', sessionId], 15_000)) !== undefined;
  const root = path.join(home, 'sessions');
  const folder = folderOf(sessionId, root);
  if (!folder) return told;
  rmSync(path.join(root, folder, sessionId), { recursive: true, force: true });
  return true;
}

/**
 * The folder a Grok session ran in: forking needs it, and Grok files each session under its folder
 * (`~/.grok/sessions/<url-encoded folder>/<id>`). Undefined when it can't be told (a very long
 * folder name is filed under a slug instead).
 */
export function grokSessionFolder(sessionId: string, home: string = defaultHome()): string | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const folder = folderOf(sessionId, path.join(home, 'sessions'));
  return folder?.includes('%') ? decodeURIComponent(folder) : undefined;
}
