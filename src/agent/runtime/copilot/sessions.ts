import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePath } from '../claude/claude-sessions.js';

/** A Copilot session id (a UUID): only those name a folder of its. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where Copilot keeps its sessions: ~/.copilot/session-state (COPILOT_HOME moves it). */
export function copilotSessionsDir(env: Readonly<Record<string, string | undefined>> = process.env, home: string = os.homedir()): string {
  return path.join(env.COPILOT_HOME ?? path.join(home, '.copilot'), 'session-state');
}

/**
 * Forget Copilot's own record of a conversation (a deleted chat's, BLG-571; a side call's, which
 * was never yours to keep): its session folder. Copilot has no command to delete one, so the
 * folder goes; nothing else of Copilot's is touched, and one that's already gone is fine.
 */
export async function dropCopilotSession(sessionId: string, dir: string = copilotSessionsDir()): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false;
  const at = path.join(dir, sessionId);
  if (!existsSync(at)) return false;
  await fs.rm(at, { recursive: true, force: true });
  return true;
}

/** Every Copilot session that ran in a folder being deleted for good (its workspace.yaml's cwd), each dropped. */
export async function dropCopilotFolder(folder: string, dir: string = copilotSessionsDir()): Promise<number> {
  const ids = await fs.readdir(dir).catch(() => [] as string[]);
  let dropped = 0;
  for (const id of ids) {
    if (!SESSION_ID.test(id)) continue;
    const yaml = await fs.readFile(path.join(dir, id, 'workspace.yaml'), 'utf8').catch(() => '');
    const cwd = /^cwd:\s*(.+)$/m.exec(yaml)?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (cwd && samePath(cwd, folder) && (await dropCopilotSession(id, dir))) dropped++;
  }
  return dropped;
}
