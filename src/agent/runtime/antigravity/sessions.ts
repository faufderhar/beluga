import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePath } from '../claude/claude-sessions.js';
import { type AgyConnect, agyDataDir, agyLogDir, spawnAgy } from './connection.js';

export { agyDataDir };

/** An Antigravity conversation id (a UUID): only those name its files. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A conversation's own folder of notes (its plan, its task list): written there without being yours. */
export function agyBrainDir(sessionId: string, dir: string = agyDataDir()): string {
  return path.join(dir, 'brain', sessionId);
}

/**
 * Forget Antigravity's own record of a conversation (a deleted chat's, BLG-571; a side call's,
 * which was never yours to keep): its conversation file, its annotations and its notes folder.
 * The CLI has no command to delete one, so the files go; nothing else of Antigravity's is touched,
 * and one that's already gone is fine.
 */
export async function dropAgySession(sessionId: string, dir: string = agyDataDir()): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false;
  // Its SQLite file's journal and shared memory too (`.db-wal`, `.db-shm`), or they stay behind it.
  const db = path.join(dir, 'conversations', `${sessionId}.db`);
  const files = [db, `${db}-wal`, `${db}-shm`, path.join(dir, 'conversations', `${sessionId}.pb`), path.join(dir, 'annotations', `${sessionId}.pbtxt`), agyBrainDir(sessionId, dir)];
  const gone = await Promise.all(files.map((f) => fs.rm(f, { recursive: true, force: true }).then(() => true, () => false)));
  return gone.some(Boolean);
}

/** `session/list` comes a page at a time: this many at most, so a list that never ends does. */
const LIST_PAGES = 200;

/**
 * Every Antigravity conversation that ran in a folder being deleted for good (as `session/list`
 * says, every page of it), each dropped: Beluga's and any you had there in Antigravity itself, as
 * the folder they were about is gone.
 */
export async function dropAgyFolder(folder: string, deps: { readonly connect?: AgyConnect; readonly dir?: string } = {}): Promise<number> {
  const conn = await (deps.connect ?? spawnAgy)({ cwd: os.tmpdir(), look: true }).catch(() => undefined);
  if (!conn) return 0;
  try {
    const there: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGES; page++) {
      const listed = await conn.rpc.request<{ sessions?: Array<{ sessionId?: string; cwd?: string }>; nextCursor?: string | null }>('session/list', cursor ? { cursor } : {}, 30_000).catch(() => undefined);
      for (const s of listed?.sessions ?? []) if (s.sessionId && s.cwd && samePath(s.cwd, folder)) there.push(s.sessionId);
      if (!listed?.nextCursor || listed.nextCursor === cursor) break;
      cursor = listed.nextCursor;
    }
    let dropped = 0;
    for (const id of new Set(there)) if (await dropAgySession(id, deps.dir)) dropped++;
    return dropped;
  } finally {
    await conn.proc.kill();
  }
}

/** A run's log is kept this long, then goes (a look's goes when it stops). */
export const AGY_LOG_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

/**
 * What Beluga's own `agy acp` processes left behind before they cleaned up after themselves: a
 * conversation's SQLite journal and shared memory (`<id>.db-wal`, `<id>.db-shm`) whose conversation
 * is gone, and their logs older than AGY_LOG_DAYS. Only those: a conversation that's still there,
 * and every other file of Antigravity's (its own CLI's logs too), stay.
 */
export async function tidyAgyData(dir: string = agyDataDir(), now: number = Date.now()): Promise<{ readonly journals: number; readonly logs: number }> {
  const conversations = path.join(dir, 'conversations');
  const names = new Set(await fs.readdir(conversations).catch(() => [] as string[]));
  const orphans = [...names].filter((n) => {
    const m = /^(.+)\.db-(wal|shm)$/.exec(n);
    return Boolean(m && SESSION_ID.test(m[1]!) && !names.has(`${m[1]}.db`));
  });
  await Promise.all(orphans.map((n) => fs.rm(path.join(conversations, n), { force: true }).catch(() => undefined)));
  const logs = agyLogDir(dir);
  const old = (
    await Promise.all(
      (await fs.readdir(logs).catch(() => [] as string[]))
        .filter((n) => /^acp-server-.*-\d+\.log$/.test(n))
        .map(async (n) => ((await fs.stat(path.join(logs, n)).catch(() => undefined))?.mtimeMs ?? now) < now - AGY_LOG_DAYS * DAY_MS ? n : undefined),
    )
  ).filter((n): n is string => Boolean(n));
  await Promise.all(old.map((n) => fs.rm(path.join(logs, n), { force: true }).catch(() => undefined)));
  return { journals: orphans.length, logs: old.length };
}
