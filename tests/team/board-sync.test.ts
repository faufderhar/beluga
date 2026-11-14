import { afterEach, describe, expect, it } from 'vitest';
import { BRAKE_HOLD_MS, TeamBoardSync } from '../../src/core/team/board-sync.js';
import type { Issue } from '../../src/core/board/model.js';
import { LOCAL_ACTS, canon, merge, newer } from '../../src/core/team/crdt.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type PartsFor, type TeamMac, personOf, teamMac } from './helpers.js';

/** BLG-222: a team's board stays in step on every Mac: tasks, briefs, status, comments. */

let net: Crowd | undefined;
const macs: TeamMac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

/** Worktrees that count as live on a Mac (the rest are gone). */
const liveWs = new Set<string>();
const runWs = new Set<string>();
/** Tasks the brake held (BLG-942): only ever a loop, so none in any of these. */
const braked: string[] = [];
const withSync: PartsFor = ({ team, board, dir }) => [new TeamBoardSync(team, { board, live: (id) => liveWs.has(id), running: (id) => runWs.has(id), dir, onBrake: (id) => braked.push(id) })];

async function teamUp(a: TeamMac, pa: string, b: TeamMac, pb: string): Promise<void> {
  await settle(() => a.store.getState().team.offers.find((o) => o.peerId === b.id && o.projectId === pa) && b.store.getState().team.offers.find((o) => o.peerId === a.id && o.projectId === pb));
  a.team.answer(b.id, pa, true);
  await settle(() => b.store.getState().team.offers.find((o) => o.peerId === a.id && o.state === 'invited'));
  b.team.answer(a.id, pb, true);
  await settle(() => a.store.getState().team.teams[pa]?.mates.some((m) => m.peerId === b.id) && b.store.getState().team.teams[pb]?.mates.some((m) => m.peerId === a.id));
}

const issue = (m: TeamMac, id: string) => m.board.get(id);

describe('the CRDT', () => {
  it('settles conflicts the same whatever order they arrive in', () => {
    const x = { v: 'from ata', l: 5, a: 'a'.repeat(32) };
    const y = { v: 'from kay', l: 5, a: 'k'.repeat(32) };
    const z = { v: 'later', l: 6, a: 'a'.repeat(32) };
    expect(newer(y, x)).toBe(true);
    expect(newer(z, y)).toBe(true);
    const one = merge(merge(merge(undefined, { id: 't', fields: { title: x }, acts: [] }).task, { id: 't', fields: { title: y }, acts: [] }).task, { id: 't', fields: { title: z }, acts: [] }).task;
    const two = merge(merge(merge(undefined, { id: 't', fields: { title: z }, acts: [] }).task, { id: 't', fields: { title: x }, acts: [] }).task, { id: 't', fields: { title: y }, acts: [] }).task;
    expect(one.fields.title).toEqual(z);
    expect(two.fields.title).toEqual(z);
  });

  it('a line its author took back stays gone, whichever teammate passes it on again later', () => {
    const line = { id: 'a_x', at: 1, by: { kind: 'beluga' as const }, kind: 'status' as const, text: 'moved this to In Progress' };
    const had = merge(undefined, { id: 't', fields: {}, acts: [line] }).task;
    const taken = merge(had, { id: 't', fields: {}, acts: [], drop: ['a_x'] });
    expect(taken.dropped).toEqual(['a_x']);
    // The add still on its way through another Mac arrives after the drop: not new here.
    const late = merge(taken.task, { id: 't', fields: {}, acts: [line] });
    expect(late.added).toEqual([]);
    expect(late.task.acts).toEqual([]);
    // The drop again (another Mac passing it on): nothing to take back, so nothing to pass on.
    expect(merge(late.task, { id: 't', fields: {}, acts: [], drop: ['a_x'] }).dropped).toEqual([]);
    // A drop that came before the line: it never shows.
    const early = merge(merge(undefined, { id: 't', fields: {}, acts: [], drop: ['a_x'] }).task, { id: 't', fields: {}, acts: [line] });
    expect(early.added).toEqual([]);
  });
});

describe('a team board over the network', () => {
  it('shares what each had, then every kind of change both ways, with keys of their own and nothing local', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'acme-api', repo: 'acme/api' }], withSync);
    macs.push(ata, kay);
    const a1 = ata.board.create({ projectId: 'pa', title: 'Rate limits', brief: { goal: 'Stop abuse' } }, personOf(ata));
    const a2 = ata.board.create({ projectId: 'pa', title: 'Docs' }, personOf(ata));
    const k1 = kay.board.create({ projectId: 'pk', title: 'Login bug', priority: 'urgent' }, personOf(kay));
    await befriend(ata.person, kay.person);
    await teamUp(ata, 'pa', kay, 'pk');

    // Everything either had is on both boards: same ids, each Mac's own keys.
    await settle(() => issue(kay, a1.id) && issue(kay, a2.id) && issue(ata, k1.id));
    expect(issue(kay, a1.id)).toMatchObject({ title: 'Rate limits', projectId: 'pk', brief: { goal: 'Stop abuse' } });
    expect(issue(ata, k1.id)).toMatchObject({ title: 'Login bug', priority: 'urgent', projectId: 'pa' });
    const keys = (m: TeamMac) => m.board.list().map((i) => i.key);
    expect(new Set(keys(ata)).size).toBe(3);
    expect(new Set(keys(kay)).size).toBe(3);
    expect(issue(kay, a1.id)!.key.startsWith('ACM')).toBe(true);

    // Kay's edits reach ata, ata's reach kay.
    kay.board.update(a1.id, { title: 'Rate limits per key', status: 'in_progress', priority: 'high', labels: ['api'] }, personOf(kay));
    kay.board.editBrief(a1.id, 'acceptance', '- [ ] 429 after 100 calls', personOf(kay));
    kay.board.comment(a1.id, 'I can take this', personOf(kay));
    ata.board.update(k1.id, { status: 'in_review', estimate: 3, due: '2026-11-03' }, personOf(ata));
    const kid = ata.board.create({ projectId: 'pa', title: 'Sub-task', parent: k1.id }, personOf(ata));
    await settle(() => issue(ata, a1.id)?.activity.some((a) => a.body === 'I can take this') && issue(kay, kid.id));
    expect(issue(ata, a1.id)).toMatchObject({ title: 'Rate limits per key', status: 'in_progress', priority: 'high', labels: ['api'], brief: { goal: 'Stop abuse', acceptance: '- [ ] 429 after 100 calls' } });
    // The brief came with its history (Restore This works on it).
    expect(issue(ata, a1.id)!.revisions.at(-1)).toMatchObject({ section: 'acceptance', by: { kind: 'person', id: kay.id } });
    expect(issue(ata, a1.id)!.activity.find((a) => a.body === 'I can take this')?.by).toEqual(personOf(kay));
    await settle(() => issue(kay, k1.id)?.status === 'in_review');
    expect(issue(kay, k1.id)).toMatchObject({ estimate: 3, due: '2026-11-03' });
    expect(issue(kay, kid.id)?.parent).toBe(k1.id);

    // Worktrees stay local: ata starting one shows kay only "ata is working on this".
    liveWs.add('ws-ata-1');
    ata.board.linkWorktree(a2.id, 'ws-ata-1', { name: 'docs-pass', branch: 'beluga/docs' }, personOf(ata));
    await settle(() => kay.store.getState().team.working[a2.id]?.some((w) => w.peerId === ata.id));
    expect(issue(kay, a2.id)!.worktrees).toEqual([]);
    expect(issue(kay, a2.id)!.branch).toBeUndefined();
    expect(issue(kay, a2.id)!.activity.some((a) => a.kind === 'worktree' || a.text.includes('docs-pass'))).toBe(false);

    // Ata's Claude at work there: kay's card shows it moving, and still when it stops (BLG-278).
    const event = (e: 'started' | 'done') => ata.store.dispatch({ type: 'agent_event', owner: ata.id, requestId: 'r1', requester: ata.id, event: e, text: '', ts: 1, channel: 'ws:ws-ata-1' });
    runWs.add('ws-ata-1');
    event('started');
    await settle(() => kay.store.getState().team.working[a2.id]?.some((w) => w.peerId === ata.id && w.running));
    runWs.delete('ws-ata-1');
    event('done');
    await settle(() => kay.store.getState().team.working[a2.id]?.some((w) => w.peerId === ata.id && !w.running));

    // Deleting goes for everyone.
    ata.board.remove(a2.id);
    await settle(() => !issue(kay, a2.id));
  }, 90_000);

  it('changes made offline arrive when back, and a conflict settles the same on both Macs', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], withSync);
    macs.push(ata, kay);
    const t = ata.board.create({ projectId: 'pa', title: 'Shared' }, personOf(ata));
    await befriend(ata.person, kay.person);
    await teamUp(ata, 'pa', kay, 'pk');
    await settle(() => issue(kay, t.id));

    // Kay's network is off: both change the same field, and different ones.
    await kay.stop();
    await settle(() => ata.person.friend(kay.id)?.online === false);
    ata.board.update(t.id, { title: 'Title from ata', priority: 'high' }, personOf(ata));
    ata.board.comment(t.id, 'ata offline note', personOf(ata));
    kay.board.update(t.id, { title: 'Title from kay', labels: ['web'] }, personOf(kay));
    kay.board.comment(t.id, 'kay offline note', personOf(kay));
    const made = kay.board.create({ projectId: 'pk', title: 'Made offline' }, personOf(kay));
    await kay.start();

    await settle(() => issue(ata, made.id) && issue(ata, t.id)?.labels.includes('web') && issue(kay, t.id)?.priority === 'high');
    await settle(() => issue(ata, t.id)?.title === issue(kay, t.id)?.title);
    expect(['Title from ata', 'Title from kay']).toContain(issue(ata, t.id)!.title);
    for (const m of [ata, kay]) {
      const bodies = issue(m, t.id)!.activity.map((a) => a.body).filter(Boolean);
      expect(bodies).toEqual(expect.arrayContaining(['ata offline note', 'kay offline note']));
    }
  }, 90_000);

  it('private tasks stay home, sharing sends them, and making one private again takes it back (BLG-501)', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], withSync);
    macs.push(ata, kay);
    const shared = ata.board.create({ projectId: 'pa', title: 'Shared' }, personOf(ata));
    const mine = ata.board.create({ projectId: 'pa', title: 'X launch thread', private: true }, personOf(ata));
    const kid = ata.board.create({ projectId: 'pa', title: 'Draft the hook', parent: mine.id }, personOf(ata));
    expect(kid.private).toBe(true);
    await befriend(ata.person, kay.person);
    await teamUp(ata, 'pa', kay, 'pk');
    await settle(() => issue(kay, shared.id));

    // Made after teaming up, changed: still never sent.
    const later = ata.board.create({ projectId: 'pa', title: 'Bio rewrite', private: true }, personOf(ata));
    ata.board.update(mine.id, { status: 'in_progress' }, personOf(ata));
    ata.board.comment(shared.id, 'marker', personOf(ata));
    await settle(() => issue(kay, shared.id)?.activity.some((a) => a.body === 'marker'));
    for (const t of [mine, kid, later]) expect(issue(kay, t.id)).toBeUndefined();

    // Share with Team: the task and its sub-tasks arrive as they are now.
    ata.board.setPrivate(mine.id, false, personOf(ata));
    await settle(() => issue(kay, mine.id) && issue(kay, kid.id));
    expect(issue(kay, mine.id)).toMatchObject({ title: 'X launch thread', status: 'in_progress' });
    expect(issue(kay, kid.id)?.parent).toBe(mine.id);
    expect(issue(kay, mine.id)!.private).toBeUndefined();

    // Kay edits it; then ata takes it back: gone from kay's board, ata's copy untouched by kay's later word.
    kay.board.update(mine.id, { priority: 'high' }, personOf(kay));
    await settle(() => issue(ata, mine.id)?.priority === 'high');
    ata.board.setPrivate(mine.id, true, personOf(ata));
    await settle(() => !issue(kay, mine.id) && !issue(kay, kid.id));
    expect(issue(ata, mine.id)).toMatchObject({ private: true, title: 'X launch thread', priority: 'high' });
    expect(issue(ata, kid.id)?.private).toBe(true);

    // Shared again: back on kay's board with what it had, and the newest of ata's changes.
    ata.board.update(mine.id, { title: 'X launch thread v2' }, personOf(ata));
    ata.board.setPrivate(mine.id, false, personOf(ata));
    await settle(() => issue(kay, mine.id)?.title === 'X launch thread v2' && issue(kay, kid.id));
    expect(issue(kay, mine.id)?.priority).toBe('high');
  }, 90_000);

  it('a teammate on an older Beluga sending one line’s add and drop over and over: the board here changes once, then stays still (BLG-951)', async () => {
    net = await crowd();
    const syncs = new Map<string, TeamBoardSync>();
    const keepSync: PartsFor = (m) => {
      const parts = withSync(m);
      syncs.set(m.name, parts[0] as TeamBoardSync);
      return parts;
    };
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], keepSync);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], keepSync);
    macs.push(ata, kay);
    const t = ata.board.create({ projectId: 'pa', title: 'Confirm the old table is deleted' }, personOf(ata));
    await befriend(ata.person, kay.person);
    await teamUp(ata, 'pa', kay, 'pk');
    ata.board.comment(t.id, 'moved it back to Ready', personOf(ata));
    await settle(() => issue(kay, t.id)?.activity.some((a) => a.body === 'moved it back to Ready'));
    const line = issue(kay, t.id)!.activity.find((a) => a.body === 'moved it back to Ready')!;
    const link = kay.team.linksOf('pk').find((l) => l.peerId === ata.id)!;
    const sync = syncs.get('kay')!;

    // What 3.3.0 Macs passed round a team of four, about 17 times a second, all afternoon.
    const seen: string[] = [];
    const off = kay.store.onAction((a) => {
      if ((a.type === 'board_issue' && a.issue.id === t.id) || a.type === 'team_state') seen.push(a.type);
    });
    type Ops = Parameters<TeamBoardSync['receive']>[1];
    const add = { k: 'ops', link: link.id, tasks: [{ id: t.id, fields: {}, acts: [line] }] } as Ops;
    const drop = { k: 'ops', link: link.id, tasks: [{ id: t.id, fields: {}, acts: [], drop: [line.id] }] } as Ops;
    sync.receive(ata.id, drop);
    for (let n = 0; n < 200; n++) sync.receive(ata.id, n % 2 ? drop : add);
    off();

    // Taken off the board once; every later add and drop is already known here, and changes nothing.
    expect(issue(kay, t.id)!.activity.some((a) => a.id === line.id)).toBe(false);
    expect(seen.filter((s) => s === 'board_issue').length).toBeLessThanOrEqual(1);
    expect(seen.filter((s) => s === 'team_state').length).toBeLessThanOrEqual(1);
  }, 90_000);

  it('three teammates agree even where two of them aren’t friends', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], withSync);
    const mia = await teamMac(net, 'mia', [{ id: 'pm', name: 'api', repo: 'acme/api' }], withSync);
    macs.push(ata, kay, mia);
    await befriend(ata.person, kay.person);
    await befriend(kay.person, mia.person);
    await teamUp(ata, 'pa', kay, 'pk');
    await teamUp(kay, 'pk', mia, 'pm');
    const t = ata.board.create({ projectId: 'pa', title: 'From ata' }, personOf(ata));
    await settle(() => issue(mia, t.id));
    mia.board.update(t.id, { status: 'done' }, personOf(mia));
    await settle(() => issue(ata, t.id)?.status === 'done');
  }, 90_000);

  it('three teammates all linked: a status line folded into the next settles, and nothing keeps going round', async () => {
    const [ata, kay, mia] = await linkedTrio();
    const t = ata.board.create({ projectId: 'pa', title: 'Shared' }, personOf(ata));
    await settle(() => issue(kay, t.id) && issue(mia, t.id));

    // Two quick moves by ata: the first line is taken back and folded into the second.
    ata.board.update(t.id, { status: 'in_progress' }, personOf(ata));
    ata.board.update(t.id, { status: 'in_review' }, personOf(ata));
    const lines = (m: TeamMac) => issue(m, t.id)!.activity.filter((a) => a.kind === 'status').map((a) => a.id);
    await settle(() => [kay, mia].every((m) => issue(m, t.id)?.status === 'in_review' && lines(m).join() === lines(ata).join()));

    expect(await sendsWhileQuiet([ata, kay, mia])).toBe(0);
    for (const m of [ata, kay, mia]) expect(lines(m)).toEqual(lines(ata));
    expect(lines(ata)).toHaveLength(1);
  }, 90_000);

  it('three teammates all linked, many edits from everyone at once: every board agrees, then nothing is sent (BLG-942)', async () => {
    const trio = await linkedTrio();
    const home: Record<string, string> = { ata: 'pa', kay: 'pk', mia: 'pm' };
    const ids: string[] = [];
    const rand = seeded(942);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const statuses = ['todo', 'in_progress', 'in_review', 'done', 'backlog'] as const;
    for (let n = 0; n < 4; n++) ids.push(trio[n % 3]!.board.create({ projectId: home[trio[n % 3]!.name]!, title: `Task ${n}` }, personOf(trio[n % 3]!)).id);
    await settle(() => trio.every((m) => ids.every((id) => issue(m, id))));

    for (let n = 0; n < 60; n++) {
      const m = pick(trio);
      const id = pick(ids);
      if (!issue(m, id)) continue;
      const by = personOf(m);
      const op = pick(['status', 'twice', 'twice', 'title', 'priority', 'comment', 'brief', 'child', 'parent'] as const);
      try {
        if (op === 'status') m.board.update(id, { status: pick(statuses) }, by);
        // Moved twice in a moment: the first line is taken back and folded into the second.
        else if (op === 'twice') {
          m.board.update(id, { status: pick(statuses) }, by);
          m.board.update(id, { status: pick(statuses) }, by);
        }
        else if (op === 'title') m.board.update(id, { title: `Title ${n} by ${m.name}` }, by);
        else if (op === 'priority') m.board.update(id, { priority: pick(['high', 'low', 'urgent', 'none'] as const) }, by);
        else if (op === 'comment') m.board.comment(id, `note ${n}`, by);
        else if (op === 'brief') m.board.editBrief(id, pick(['goal', 'context', 'acceptance'] as const), `brief ${n}`, by);
        else if (op === 'child') ids.push(m.board.create({ projectId: home[m.name]!, title: `Sub ${n}`, parent: id }, by).id);
        else m.board.update(id, { parent: pick(ids.filter((x) => x !== id && issue(m, x))) ?? null }, by);
      } catch {
        // A move the board refuses (a sub-task of its own sub-task): a person would be told no too.
      }
      if (n % 5 === 4) await new Promise((r) => setTimeout(r, 15));
    }

    await settle(() => trio.every((m) => ids.every((id) => same(issue(m, id), issue(trio[0]!, id)))));
    expect(await sendsWhileQuiet(trio)).toBe(0);
  }, 120_000);
});

/** Ata, kay and mia, all friends, on one team, each linked straight to the other two. */
async function linkedTrio(): Promise<[TeamMac, TeamMac, TeamMac]> {
  braked.length = 0;
  net = await crowd();
  const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync);
  const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], withSync);
  const mia = await teamMac(net, 'mia', [{ id: 'pm', name: 'api', repo: 'acme/api' }], withSync);
  macs.push(ata, kay, mia);
  await befriend(ata.person, kay.person);
  await befriend(kay.person, mia.person);
  await befriend(ata.person, mia.person);
  await teamUp(ata, 'pa', kay, 'pk');
  await teamUp(kay, 'pk', mia, 'pm');
  // Ata and mia are friends on the same team: they link up by themselves, so every Mac passes changes on to two.
  const direct = (m: TeamMac, p: string, other: TeamMac) => m.store.getState().team.teams[p]?.mates.some((x) => x.peerId === other.id && !x.indirect);
  await settle(() => direct(ata, 'pa', mia) && direct(mia, 'pm', ata));
  return [ata, kay, mia];
}

/** How many team frames the Macs send in a quiet moment after they agree (a loop never stops sending). */
async function sendsWhileQuiet(all: readonly TeamMac[]): Promise<number> {
  let sent = 0;
  for (const m of all) {
    const send = m.team.send.bind(m.team);
    m.team.send = (...args: Parameters<typeof send>) => {
      sent += 1;
      return send(...args);
    };
  }
  // Longer than the brake holds a task, so a loop it slows down still shows.
  await new Promise((r) => setTimeout(r, BRAKE_HOLD_MS + 1000));
  // Nothing went round at any point (the brake settles a loop, but only a loop ever needs it).
  expect(braked).toEqual([]);
  return sent;
}

/** Two Macs' copies of a task agree on what the team shares (keys and local lines are each Mac's own). */
function same(x: Issue | undefined, y: Issue | undefined): boolean {
  if (!x || !y) return false;
  const shared = (i: Issue) => ({ title: i.title, status: i.status, priority: i.priority, parent: i.parent ?? null, brief: i.brief, lines: i.activity.filter((a) => !LOCAL_ACTS.has(a.kind)).map((a) => a.id).sort() });
  return canon(shared(x)) === canon(shared(y));
}

/** The same "random" edits on every run. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}
