import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchAttachmentSweep, SWEEP_GRACE_MS, sweepAttachments } from '../src/core/attachment-sweep.js';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 13, 12);

let home: string;
let dir: string;

/** A file written at `ageMs` before NOW. */
function put(file: string, ageMs: number, body = 'png'): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  const t = (NOW - ageMs) / 1000;
  utimesSync(file, t, t);
  return file;
}
const image = (name: string, ageMs = 3 * DAY, sub = ''): string => put(path.join(dir, sub, name), ageMs);
const link = (name: string, owner = 'me'): string => `[📎 image 1 (png, 1K)](klaud-attachment:${owner}/${name})`;
const save = (rel: string, text: string): void => void put(path.join(home, rel), 0, text);
const sweep = (keep: readonly string[] = []) => sweepAttachments({ home, dir, now: NOW, keep: new Set(keep.map((p) => path.resolve(p))) });

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'beluga-sweep-'));
  dir = path.join(home, 'attachments');
  mkdirSync(dir);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('sweepAttachments', () => {
  it('deletes an old image no conversation links, and keeps one a chat history still links', async () => {
    const gone = image('20261101-090000-aaaa.png');
    const kept = image('20261101-090000-bbbb.png');
    save('history/wt-1.json', JSON.stringify([{ text: `look ${link('20261101-090000-bbbb.png')}` }]));
    const r = await sweep();
    expect(r.removed).toEqual([gone]);
    expect(r.bytes).toBe(3);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it('a worktree deleted takes its images: its history went, nothing else names them', async () => {
    const img = image('20261101-090000-cccc.png');
    save('history/wt-gone.json', JSON.stringify([{ text: link('20261101-090000-cccc.png') }]));
    expect((await sweep()).removed).toEqual([]);
    rmSync(path.join(home, 'history/wt-gone.json'));
    expect((await sweep()).removed).toEqual([img]);
  });

  it('any place Beluga keeps a message keeps the image: DMs, groups, the board, sentinels, queued messages', async () => {
    const places = ['dms/bob.json', 'groups/g1/log.jsonl', 'board.json', 'sentinel/chat/chats/x/history.json', 'outbox.json', 'tasks/tasks.json'];
    const imgs = places.map((rel, i) => {
      const name = `20261101-09000${i}-dddd.png`;
      save(rel, `{"text":"${link(name).replace(/"/g, '\\"')}"}`);
      return image(name);
    });
    expect((await sweep()).removed).toEqual([]);
    for (const img of imgs) expect(existsSync(img)).toBe(true);
  });

  it('keeps images younger than a day (still in the box, or the history not written yet)', async () => {
    const fresh = image('20261113-100000-eeee.png', SWEEP_GRACE_MS - 60_000);
    const old = image('20261110-100000-ffff.png', SWEEP_GRACE_MS + 60_000);
    expect((await sweep()).removed).toEqual([old]);
    expect(existsSync(fresh)).toBe(true);
  });

  it('never takes an image pasted this session, however old the file', async () => {
    const pasted = image('Screenshot 2026-10-01.png', 30 * DAY);
    expect((await sweep([pasted])).removed).toEqual([]);
  });

  it('sweeps room copies, friends’ images and phone uploads too', async () => {
    const room = image('20261101-090000-gggg.png', 3 * DAY, 'room');
    const theirs = image('20261101-090000-hhhh.jpg', 3 * DAY, 'received');
    const phone = image('Ab12Cd34Ef56Gh78Ij90Kl12-report.pdf', 3 * DAY, 'phone');
    const phoneLinked = image('Zz12Cd34Ef56Gh78Ij90Kl12-1000210021.jpg', 3 * DAY, 'phone');
    const cutShort = put(path.join(dir, 'phone', '.0123456789abcdef.part'), 3 * DAY);
    save('history/chat-1.json', JSON.stringify([{ text: `\`${path.join(dir, 'phone', 'Zz12Cd34Ef56Gh78Ij90Kl12-1000210021.jpg')}\`` }]));
    const r = await sweep();
    expect(new Set(r.removed)).toEqual(new Set([room, theirs, phone, cutShort]));
    expect(existsSync(phoneLinked)).toBe(true);
  });

  it('only touches image files right in its folders: not other files, folders below, or links', async () => {
    const notes = put(path.join(dir, 'notes.txt'), 3 * DAY);
    const deeper = image('20261101-090000-iiii.png', 3 * DAY, 'room/deeper');
    const outside = put(path.join(home, 'elsewhere', '20261101-090000-jjjj.png'), 3 * DAY);
    symlinkSync(outside, path.join(dir, '20261101-090000-jjjj.png'));
    expect((await sweep()).removed).toEqual([]);
    for (const f of [notes, deeper, outside]) expect(existsSync(f)).toBe(true);
  });

  it('a mention in a worktree folder, an archive, a log or a step record keeps nothing', async () => {
    const img = image('20261101-090000-kkkk.png');
    for (const rel of ['workspaces/p/wt/.beluga/scratch/notes.md', 'archives/wt-1/manifest.json', 'logs/daemon.txt', 'steps/abc.json', 'history/node_modules/x.json']) save(rel, link('20261101-090000-kkkk.png'));
    expect((await sweep()).removed).toEqual([img]);
  });

  it('does nothing when there is no attachments folder', async () => {
    rmSync(dir, { recursive: true });
    expect(await sweep()).toEqual({ removed: [], bytes: 0 });
  });
});

describe('launchAttachmentSweep', () => {
  afterEach(() => vi.useRealTimers());

  it('sweeps soon after a worktree is deleted, once for several in a row, and stops listening when stopped', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const img = image('20261101-090000-llll.png');
    let removed: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const lines: string[] = [];
    const stop = launchAttachmentSweep(
      {
        onRemoved: (l) => {
          removed = l;
          return unsubscribe;
        },
        log: (line) => lines.push(line),
      },
      { home, dir, now: NOW, keep: new Set() },
    );
    removed!();
    removed!();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(lines).toEqual(['attachments: removed 1 image no chat links any more (0 KB)']));
    expect(existsSync(img)).toBe(false);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
