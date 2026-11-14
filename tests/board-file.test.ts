import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { pack, unpack } from '../src/core/board/board-file.js';
import type { Actor, Issue } from '../src/core/board/model.js';
import { Store, initialState } from '../src/core/store.js';
import type { Project } from '../src/workspaces/types.js';
import { waitFor } from './helpers.js';

/**
 * BLG-942: board.json was 17 MB on a busy Mac and written whole a few times a second. Now a change
 * writes only the tasks it touched, to a journal, folded into board.json in the background now and
 * then and whole on quit; and a brief's history is written without the text it can work out.
 */

const me: Actor = { kind: 'person', id: 'p-me', name: 'Kay' };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'board-file-'));
  dirs.push(dir);
  return dir;
}

function open(dir: string, foldMinBytes = 50_000_000) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [{ id: 'api', name: 'bob-api', root: '/tmp/bob-api', base: 'main', workspaces: [] } as Project] });
  return new Board({ store, dir, projectName: () => 'bob-api', saveDelayMs: 0, foldMinBytes });
}

/** Everything a board holds, to compare one with its copy read back. */
const all = (b: Board): Issue[] => [...b.list()].sort((x, y) => x.id.localeCompare(y.id));
const tick = () => new Promise((r) => setTimeout(r, 5));
const journal = (dir: string) => readdirSync(dir).filter((f) => f.startsWith('board.log'));
const lines = (dir: string) => journal(dir).flatMap((f) => readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean));

describe('the board on disk', () => {
  it('a change writes only the task it touched, and the board reads back the same', async () => {
    const dir = home();
    const board = open(dir);
    const made = Array.from({ length: 60 }, (_, n) => board.create({ projectId: 'api', title: `Task ${n}`, brief: { goal: `goal ${n} `.repeat(50) } }, me));
    board.flush();
    const snapshot = statSync(path.join(dir, 'board.json'));
    expect(journal(dir)).toEqual([]);

    board.update(made[7]!.id, { status: 'in_progress' }, me);
    await tick();
    // One line, for that task: the snapshot wasn't touched.
    expect(lines(dir)).toHaveLength(1);
    expect(lines(dir)[0]).toContain(made[7]!.id);
    expect(statSync(path.join(dir, 'board.json')).mtimeMs).toBe(snapshot.mtimeMs);
    expect(lines(dir)[0]!.length).toBeLessThan(snapshot.size / 20);

    // Without a quit (as after a crash): snapshot and journal read back as the board was.
    board.comment(made[3]!.id, 'a note', me);
    board.remove(made[5]!.id);
    await tick();
    expect(all(open(dir))).toEqual(all(board));
  });

  it('folds the journal into board.json in the background, and reads back the same', async () => {
    const dir = home();
    const board = open(dir, 1);
    const t = board.create({ projectId: 'api', title: 'One' }, me);
    for (let n = 0; n < 5; n++) {
      board.update(t.id, { title: `One, take ${n}` }, me);
      await tick();
    }
    await waitFor(() => journal(dir).length === 0 || journal(dir).every((f) => f === 'board.log'));
    await waitFor(() => existsSync(path.join(dir, 'board.json')));
    expect(all(open(dir))).toEqual(all(board));
  });

  it('a fold cut short (quit, crash) loses nothing: what was set aside is read again', async () => {
    const dir = home();
    const board = open(dir);
    const a = board.create({ projectId: 'api', title: 'A' }, me);
    board.flush();
    board.update(a.id, { title: 'A2' }, me);
    const b = board.create({ projectId: 'api', title: 'B' }, me);
    await tick();
    // As a fold leaves it before its snapshot lands: the journal set aside, a new one after it.
    renameSync(path.join(dir, 'board.log'), path.join(dir, 'board.log.999'));
    board.update(b.id, { status: 'in_review' }, me);
    board.update(a.id, { title: 'A3' }, me);
    await tick();
    const back = open(dir);
    expect(all(back)).toEqual(all(board));
    expect(back.get(a.id)?.title).toBe('A3');
  });

  it('a background fold that lands after quitting can’t put an older board back', async () => {
    const dir = home();
    const board = open(dir, 1);
    const t = board.create({ projectId: 'api', title: 'Before' }, me);
    await tick();
    board.update(t.id, { title: 'Last' }, me);
    board.flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(open(dir).get(t.id)?.title).toBe('Last');
  });

  it('quitting leaves one board.json and no journal', async () => {
    const dir = home();
    const board = open(dir);
    board.create({ projectId: 'api', title: 'Kept' }, me);
    await tick();
    expect(journal(dir)).toEqual(['board.log']);
    board.flush();
    expect(journal(dir)).toEqual([]);
    expect((JSON.parse(readFileSync(path.join(dir, 'board.json'), 'utf8')) as { issues: unknown[] }).issues).toHaveLength(1);
  });

  it('a board.json it can’t read is set aside with its journal, never written over', async () => {
    const dir = home();
    const board = open(dir);
    board.create({ projectId: 'api', title: 'Kept' }, me);
    await tick();
    writeFileSync(path.join(dir, 'board.json'), '{ not json');
    const fresh = open(dir);
    expect(fresh.list()).toEqual([]);
    const names = readdirSync(dir);
    expect(names.some((f) => f.startsWith('board.json.unreadable-'))).toBe(true);
    expect(names.some((f) => f.startsWith('board.log.unreadable-'))).toBe(true);
    expect(names).not.toContain('board.log');
  });
});

describe('names from before the rename', () => {
  it('a board written as Klaud reads with Beluga’s name, in board.json and in its journal (and only then is it walked)', async () => {
    const dir = home();
    const board = open(dir);
    const t = board.create({ projectId: 'api', title: 'Old one' }, me);
    const u = board.create({ projectId: 'api', title: 'Old two' }, me);
    board.flush();
    // As Klaud wrote them: the first task's line in board.json, the second's in the journal.
    const file = path.join(dir, 'board.json');
    const snap = JSON.parse(readFileSync(file, 'utf8')) as { seq: number; issues: Array<{ id: string; activity: Array<{ by: unknown }> }> };
    snap.issues.find((i) => i.id === t.id)!.activity[0]!.by = { kind: 'klaud' };
    writeFileSync(file, JSON.stringify(snap));
    const two = { ...snap.issues.find((i) => i.id === u.id)!, title: 'Old two, changed' };
    two.activity = [{ ...two.activity[0]!, by: { kind: 'klaud' } }];
    writeFileSync(path.join(dir, 'board.log'), `${JSON.stringify({ s: snap.seq + 1, u: two })}\n`);
    const back = open(dir);
    expect(back.get(t.id)!.activity[0]!.by).toEqual({ kind: 'beluga' });
    expect(back.get(u.id)!.activity[0]!.by).toEqual({ kind: 'beluga' });
    expect(back.get(u.id)!.title).toBe('Old two, changed');
  });
});

describe('a brief’s history as written', () => {
  it('leaves out each version’s “after” it can work out, and reads back every one', async () => {
    const dir = home();
    const board = open(dir);
    const t = board.create({ projectId: 'api', title: 'Briefed', brief: { goal: 'first' } }, me);
    for (let n = 0; n < 8; n++) board.editBrief(t.id, n % 2 ? 'goal' : 'context', `version ${n} `.repeat(200), me);
    const issue = board.get(t.id)!;
    expect(issue.revisions.length).toBeGreaterThan(4);
    const packed = pack(issue);
    const written = JSON.stringify(packed);
    expect(written.length).toBeLessThan(JSON.stringify(issue).length * 0.7);
    expect(unpack(JSON.parse(written) as Record<string, unknown>)).toEqual(JSON.parse(JSON.stringify(issue)));
    board.flush();
    expect(open(dir).get(t.id)).toEqual(issue);
  });

  it('keeps an “after” that isn’t the next “before” (a change made without a version of its own)', () => {
    const issue = {
      id: 'i',
      brief: { goal: 'now' },
      revisions: [
        { id: 'r1', at: 1, by: me, section: 'goal', before: '', after: 'one' },
        { id: 'r2', at: 2, by: me, section: 'goal', before: 'one and a bit', after: 'two' },
      ],
    } as unknown as Issue;
    const packed = pack(issue) as { revisions: Array<Record<string, unknown>> };
    expect(packed.revisions[0]).toHaveProperty('after', 'one');
    expect(packed.revisions[1]).toHaveProperty('after', 'two');
    expect(unpack(packed as unknown as Record<string, unknown>)).toEqual(issue);
  });
});
