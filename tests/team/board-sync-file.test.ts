import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Board } from '../../src/core/board/board.js';
import type { SharedTask } from '../../src/core/team/crdt.js';
import { TeamBoardSync } from '../../src/core/team/board-sync.js';
import type { TeamBoards } from '../../src/core/team/service.js';

/**
 * BLG-942: the team's copy of the board (team-board.json, megabytes for a busy team) is kept as
 * a snapshot and a journal: a change writes the tasks it touched, not the whole copy.
 */

type Inside = { tasks: Record<string, Record<string, SharedTask>>; clocks: Record<string, number>; save(): void };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-file-'));
  dirs.push(dir);
  return dir;
}

const open = (dir: string) => new TeamBoardSync({ self: 'me' } as unknown as TeamBoards, { board: {} as Board, live: () => false, dir });
const inside = (s: TeamBoardSync) => s as unknown as Inside;
const task = (id: string, title: string, l: number): SharedTask => ({ id, fields: { title: { v: title, l, a: 'ata' } }, acts: [] });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the team’s copy on disk', () => {
  it('reads a team-board.json written before the journal as it was', () => {
    const dir = home();
    writeFileSync(path.join(dir, 'team-board.json'), JSON.stringify({ clocks: { api: 7 }, tasks: { api: [task('i_a', 'One', 3), task('i_b', 'Two', 7)], web: [] } }, null, 2));
    const s = inside(open(dir));
    expect(s.clocks).toEqual({ api: 7 });
    expect(Object.keys(s.tasks.api!)).toEqual(['i_a', 'i_b']);
    // A team with no tasks yet is still a team.
    expect(s.tasks.web).toEqual({});
  });

  it('a change writes only its task, and reads back the same without a quit (as after a crash), and after one', async () => {
    const dir = home();
    writeFileSync(path.join(dir, 'team-board.json'), JSON.stringify({ clocks: { api: 2 }, tasks: { api: Array.from({ length: 200 }, (_, n) => task(`i_${n}`, `Task ${n} `.repeat(40), 1)) } }));
    const sync = open(dir);
    const s = inside(sync);
    s.tasks.api!.i_7 = task('i_7', 'Changed', 3);
    s.clocks.api = 3;
    delete s.tasks.api!.i_9;
    s.tasks.web = {};
    s.save();
    await wait(1100);
    const journal = readFileSync(path.join(dir, 'team-board.log'), 'utf8');
    expect(journal.trim().split('\n')).toHaveLength(3);
    expect(journal.length).toBeLessThan(2000);

    const crashed = inside(open(dir));
    expect(crashed.tasks).toEqual(s.tasks);
    expect(crashed.clocks).toEqual({ api: 3 });

    sync.stop();
    expect(readdirSync(dir).filter((f) => f.startsWith('team-board'))).toEqual(['team-board.json']);
    const back = inside(open(dir));
    expect(back.tasks).toEqual(s.tasks);
    expect(back.clocks).toEqual({ api: 3 });
    expect(back.tasks.web).toEqual({});
  });
});
