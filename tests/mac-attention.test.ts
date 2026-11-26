import { describe, expect, it } from 'vitest';
import type { Action, AppState } from '../src/core/store.js';
import type { CcSession } from '../src/core/claude-code/model.js';
import type { Notice } from '../src/core/work-store.js';
import type { ChatTriage } from '../src/core/triage/model.js';
import { type ScreenAction, initialAppState, reduceApp } from '../src/client/screen.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { CATEGORY_TITLES, SETTLED_PAGE, categoriesOf, conversationEntries, dockCount, foldsForCategories, groupTally, nextActive, settledWords, wakeWords, groupWorking, needOf, projectTally, projectWorking, signalOf, statusWords, tally, tallyTip, unreadEntries, visibleRows, workspaceSignal } from '../packages/mac/src/layout/attention-model.js';

/** The sidebar's unread and needs-you marks (packages/mac/src/layout/attention-model.ts), and the core's unread counts behind them. */

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w', projectRoot: '/p', name: 'w', path: '/wt/w', kind: 'worktree', branch: 'klaud/w', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over,
});
const api: Project = {
  id: 'p1', name: 'api', root: '/p', base: 'origin/main',
  workspaces: [ws({ id: 'main', name: 'main', kind: 'main' }), ws({ id: 'auth', name: 'add-auth' }), ws({ id: 'hooks', name: 'webhooks' }), ws({ id: 'old', name: 'old', archived: true })],
};
const site: Project = { id: 'p2', name: 'site', root: '/s', base: 'origin/main', workspaces: [ws({ id: 'hero', name: 'new-hero', projectId: 'p2' })] };
const chats: Project = { id: 'chats', name: 'Chats', root: '', base: '', workspaces: [ws({ id: 'q', name: 'How do deploys work?', kind: 'chat', projectId: 'chats' })] };

const apply = (s: AppState, ...actions: Array<Action | ScreenAction>): AppState => actions.reduce<AppState>((st, a) => reduceApp(st, a), s);
const base = (): AppState =>
  apply(initialAppState('room'), { type: 'welcome', self: { peerId: 'me', name: 'kay', agent: true, shares: [] } }, { type: 'projects', projects: [chats, api, site] });
const run = (event: 'queued' | 'started' | 'done' | 'error' | 'awaiting_approval', channel = 'ws:auth', requestId = 'r1'): Action => ({ type: 'agent_event', owner: 'me', requestId, requester: 'me', event, text: event === 'done' ? 'All set.' : '', ts: 5, channel });
const view = (id: string): ScreenAction => ({ type: 'view', view: { kind: 'workspace', id, tab: 'chat' } });
const overview: ScreenAction = { type: 'view', view: { kind: 'overview' } };
const question = (qid: string, channel: string, kind: 'plan' | 'question' = 'question'): Action => ({
  type: 'question_add',
  question: { qid, requestId: 'r1', owner: 'me', channel, picked: {}, question: kind === 'plan' ? { kind: 'plan', plan: 'Do it' } : { kind: 'question', questions: [{ question: 'Which?', header: '', options: [], multiSelect: false }] } },
});
const session = (over: Partial<CcSession>): CcSession => ({ id: 's1', title: 'fix', cwd: '/wt/hooks', projectId: 'p1', workspaceId: 'hooks', status: 'working', lastAt: 1, steps: 0, agents: [], ...over });

describe('the core counts what you missed', () => {
  it("counts Claude's answer when a run finishes in a workspace you aren't looking at", () => {
    let s = apply(base(), view('auth'), run('started'));
    expect(s.unread['ws:auth']).toBeUndefined();
    s = apply(s, overview, run('done'));
    expect(s.unread['ws:auth']).toBe(1);
    // Opening it reads it.
    expect(apply(s, view('auth')).unread['ws:auth']).toBeUndefined();
  });

  it('never counts a run that finishes while you look at it, nor counts one finish twice', () => {
    let s = apply(base(), view('auth'), run('started'), run('done'));
    expect(s.unread['ws:auth']).toBeUndefined();
    s = apply(base(), view('auth'), run('started'), overview, run('done'), run('done'));
    expect(s.unread['ws:auth']).toBe(1);
  });

  it("doesn't count your own first message, nor the run it starts, in a new worktree you left", () => {
    let s = apply(base(), overview, { type: 'chat', id: 'c1', from: 'me', text: 'Add auth', ts: 1, byAgent: false, channel: 'ws:auth' }, run('queued'), run('started'));
    expect(s.unread['ws:auth']).toBeUndefined();
    // Its answer is news.
    s = apply(s, run('done'));
    expect(s.unread['ws:auth']).toBe(1);
    // A friend's message, or your agent posting, still counts.
    s = apply(base(), overview, { type: 'chat', id: 'c2', from: 'bob', text: 'hi', ts: 2, byAgent: false, channel: 'ws:auth' }, { type: 'chat', id: 'c3', from: 'me', text: 'on it', ts: 3, byAgent: true, channel: 'ws:auth' });
    expect(s.unread['ws:auth']).toBe(2);
  });

  it('counts a Claude Code session in one of your worktrees ending its turn', () => {
    let s = apply(base(), overview, { type: 'claude_code', sessions: [session({})] });
    expect(s.unread['ws:hooks']).toBeUndefined();
    s = apply(s, { type: 'claude_code', sessions: [session({ status: 'waiting' })] });
    expect(s.unread['ws:hooks']).toBe(1);
    // Shown: not news.
    s = apply(base(), view('hooks'), { type: 'claude_code', sessions: [session({})] }, { type: 'claude_code', sessions: [session({ status: 'waiting' })] });
    expect(s.unread['ws:hooks']).toBeUndefined();
  });
});

describe('a conversation’s signal: needs you > unread > working > idle', () => {
  it('is idle with nothing going on, and working while Claude runs', () => {
    const s = base();
    expect(workspaceSignal(s, api.workspaces[1]!)).toMatchObject({ level: 'idle', unread: 0, tip: '' });
    const busy = apply(s, view('auth'), run('started'));
    expect(signalOf(busy, 'ws:auth', 'auth')).toMatchObject({ level: 'working', working: true, tip: 'Your agent is working' });
    const cc = apply(s, { type: 'claude_code', sessions: [session({})] });
    expect(signalOf(cc, 'ws:hooks', 'hooks').level).toBe('working');
  });

  it('is working while a thread under it works, and idle once its threads are done', () => {
    const child = ws({ id: 'kid', name: 'kid', kind: 'chat', projectId: 'chats', thread: { parent: 'ws:q', parentTitle: 'How do deploys work?', root: 'ws:q', depth: 1, task: 't', startedAt: 1, owed: [] } });
    const s = apply(base(), { type: 'projects', projects: [{ ...chats, workspaces: [...chats.workspaces, child] }, api, site] }, overview);
    const busy = apply(s, run('started', 'ws:kid'));
    expect(signalOf(busy, 'ws:q')).toMatchObject({ level: 'working', working: true });
    expect(signalOf(apply(busy, run('done', 'ws:kid')), 'ws:q').working).toBe(false);
  });

  it('is unread once Claude finished elsewhere, and says so', () => {
    const s = apply(base(), view('auth'), run('started'), overview, run('done'));
    expect(signalOf(s, 'ws:auth', 'auth')).toMatchObject({ level: 'unread', unread: 1, tip: 'Your agent finished · 1 new message' });
    const stopped = apply(base(), view('auth'), run('started'), overview, run('error'));
    expect(signalOf(stopped, 'ws:auth', 'auth').tip).toBe('Your agent stopped · 1 new message');
    const chat = apply(base(), overview, { type: 'chat', id: 'c1', from: 'bob', text: 'hi', ts: 3, byAgent: false, channel: 'ws:hooks' }, { type: 'chat', id: 'c2', from: 'bob', text: 'there?', ts: 4, byAgent: false, channel: 'ws:hooks' });
    expect(signalOf(chat, 'ws:hooks', 'hooks')).toMatchObject({ level: 'unread', unread: 2, tip: '2 new messages' });
  });

  it('needs you for an approval, a question, a plan, a conflict or failed checks, until it is resolved', () => {
    const s = base();
    expect(needOf(apply(s, run('awaiting_approval')), 'ws:auth', 'auth')).toBe('approval');
    expect(needOf(apply(s, { type: 'approval_add', approval: { id: 'a1', kind: 'tool', title: 'Bash', detail: '', channel: 'ws:auth' } }), 'ws:auth', 'auth')).toBe('approval');
    expect(needOf(apply(s, question('q1', 'ws:auth')), 'ws:auth', 'auth')).toBe('question');
    expect(needOf(apply(s, question('q1', 'ws:auth', 'plan')), 'ws:auth', 'auth')).toBe('plan');
    expect(needOf(apply(s, { type: 'conflicts', id: 'auth', files: ['a.ts'] }), 'ws:auth', 'auth')).toBe('conflict');
    const pr = { number: 1, url: 'u', state: 'OPEN' as const, title: 't', draft: false, checks: 'failing' as const };
    expect(needOf(apply(s, { type: 'pr', id: 'auth', pr }), 'ws:auth', 'auth')).toBe('checks');
    expect(needOf(apply(s, { type: 'pr', id: 'auth', pr: { ...pr, state: 'MERGED' } }), 'ws:auth', 'auth')).toBeUndefined();
    // Someone else's question is theirs.
    expect(needOf(apply(s, question('q1', 'ws:hooks')), 'ws:auth', 'auth')).toBeUndefined();
    // Answered: it no longer needs you.
    expect(needOf(apply(s, question('q1', 'ws:auth'), { type: 'question_remove', qid: 'q1' }), 'ws:auth', 'auth')).toBeUndefined();
  });

  it('keeps needing you after you open it, while the unread part clears', () => {
    let s = apply(base(), view('auth'), run('started'), overview, question('q1', 'ws:auth'), { type: 'chat', id: 'c1', from: 'me', text: 'hm', ts: 6, byAgent: true, channel: 'ws:auth' });
    expect(signalOf(s, 'ws:auth', 'auth')).toMatchObject({ level: 'needs', need: 'question', unread: 1, tip: 'Your agent asks a question · 1 new message' });
    s = apply(s, view('auth'));
    expect(signalOf(s, 'ws:auth', 'auth')).toMatchObject({ level: 'needs', unread: 0, tip: 'Your agent asks a question' });
  });

  it('archived conversations stay quiet', () => {
    const s = apply(base(), overview, { type: 'chat', id: 'c1', from: 'bob', text: 'hi', ts: 3, byAgent: false, channel: 'ws:old' });
    expect(workspaceSignal(s, api.workspaces[3]!).level).toBe('idle');
  });
});

describe('projects and groups add up', () => {
  it('counts conversations with news, and how many need you', () => {
    const s = apply(
      base(),
      overview,
      { type: 'chat', id: 'c1', from: 'bob', text: 'a', ts: 3, byAgent: false, channel: 'ws:auth' },
      { type: 'chat', id: 'c2', from: 'bob', text: 'b', ts: 4, byAgent: false, channel: 'ws:auth' },
      { type: 'chat', id: 'c3', from: 'bob', text: 'c', ts: 5, byAgent: false, channel: 'ws:hero' },
      question('q1', 'ws:hooks'),
      // The main folder and archived ones aren't listed, so they don't count.
      { type: 'chat', id: 'c4', from: 'bob', text: 'd', ts: 6, byAgent: false, channel: 'ws:main' },
    );
    expect(projectTally(s, api)).toEqual({ unread: 1, needs: 1, working: false });
    expect(projectTally(s, site)).toEqual({ unread: 1, needs: 0, working: false });
    expect(groupTally(s, [api, site])).toEqual({ unread: 2, needs: 1, working: false });
    expect(tallyTip(groupTally(s, [api, site]))).toBe('1 needs you · 2 unread');
    expect(tallyTip(tally([]))).toBe('');
  });
});

describe('the Unread section and the Dock', () => {
  const busy = (): AppState =>
    apply(
      base(),
      view('hooks'),
      run('started', 'ws:hooks', 'r2'),
      overview,
      run('done', 'ws:hooks', 'r2'),
      { type: 'chat', id: 'c1', from: 'bob', text: 'a', ts: 9, byAgent: false, channel: 'ws:q' },
      question('q1', 'ws:hero'),
    );

  it('lists what needs you first, then the latest; empty when nothing waits', () => {
    expect(unreadEntries(base())).toEqual([]);
    const list = unreadEntries(busy());
    expect(list.map((e) => [e.name, e.signal.level])).toEqual([
      ['new-hero', 'needs'],
      ['How do deploys work?', 'unread'],
      ['webhooks', 'unread'],
    ]);
    // Chats have no project; worktrees carry theirs (for its icon).
    expect(list.map((e) => (e.kind === 'workspace' ? e.project?.name : undefined))).toEqual(['site', undefined, 'api']);
  });

  it('includes friends and groups with unread messages on the klaud network', () => {
    const s = busy();
    const net = { ...s, network: { ...s.network, enabled: true, friends: [{ peerId: 'b'.repeat(32), name: 'bob', online: true, presence: { state: 'online' as const }, addedAt: 0, unread: 2, last: { id: 'm', from: 'b', name: 'bob', text: 'yo', ts: 99, mine: false } }], groups: [] } } as unknown as AppState;
    expect(unreadEntries(net).map((e) => e.channel)).toContain(`dm:${'b'.repeat(32)}`);
  });

  it('counts one per conversation on the Dock, with other notices and waiting things once each', () => {
    let s = busy();
    expect(dockCount(s)).toBe(3);
    const notice = (id: number, over: Partial<Notice>): Action => ({ type: 'notice_add', notice: { kind: 'done', title: 't', body: '', ...over } as Notice, ts: id }) as Action;
    // A notice about a listed conversation (its run, its question) doesn't add another.
    s = apply(s, notice(1, { channel: 'ws:hooks' }), notice(2, { kind: 'needsYou', tag: 'question', ref: 'q1', channel: 'ws:hero' }));
    expect(dockCount(s)).toBe(3);
    // One elsewhere (the room) does, and so does an approval that holds up nothing listed.
    s = apply(s, notice(3, { channel: 'room' }), { type: 'approval_add', approval: { id: 'a1', kind: 'request', title: 'bob wants…', detail: '' } });
    expect(dockCount(s)).toBe(5);
    // An approval in a listed conversation (and its notice) is that conversation.
    s = apply(s, { type: 'approval_add', approval: { id: 'a2', kind: 'tool', title: 'Bash', detail: '', channel: 'ws:hooks' } }, notice(4, { kind: 'needsYou', tag: 'approval', ref: 'a2' }));
    expect(dockCount(s)).toBe(5);
  });
});

describe('a folded project or group says Claude is working inside it', () => {
  it('for klaud’s own runs, Claude Code sessions in any worktree (also ones made outside klaud) and the main folder', () => {
    expect(projectWorking(base(), api)).toBe(false);
    expect(projectWorking(apply(base(), run('started')), api)).toBe(true);
    // Claude Code running in a worktree, even while another conversation there has news.
    const cc = apply(base(), view('auth'), run('started'), overview, run('done'), { type: 'claude_code', sessions: [session({})] });
    expect(projectTally(cc, api).unread).toBe(1);
    expect(projectWorking(cc, api)).toBe(true);
    expect(projectWorking(apply(base(), { type: 'claude_code', sessions: [session({ workspaceId: 'main' })] }), api)).toBe(true);
    // Not an archived one.
    expect(projectWorking(apply(base(), { type: 'claude_code', sessions: [session({ workspaceId: 'old' })] }), api)).toBe(false);
    expect(groupWorking(cc, [site, api])).toBe(true);
    expect(groupWorking(cc, [site])).toBe(false);
  });
});

describe('the sidebar categories', () => {
  const triage = (channel: string, record: ChatTriage): Action => ({ type: 'triage_set', channel, record });
  const names = (list: readonly { readonly name: string }[]): string[] => list.map((e) => e.name);
  const on = (): AppState => apply(base(), { type: 'prefs', prefs: { chatCategories: true } });

  it("calls the Active category Inbox and leaves a project's main folder and archived chats out", () => {
    expect(CATEGORY_TITLES.active).toBe('Inbox');
    expect(names(categoriesOf(on()).active).sort()).toEqual(['How do deploys work?', 'add-auth', 'new-hero', 'webhooks']);
  });

  it('leaves out a quiet worktree nobody talked in, and shows one with news, with no actions', () => {
    const outside = ws({ id: 'agent-a3f9', name: 'agent-a3f9', external: true, createdAt: 0, path: '/repo/.claude/worktrees/agent-a3f9' });
    const withIt = (state: AppState): AppState => ({ ...state, projects: state.projects.map((p, i) => (i === 0 ? { ...p, workspaces: [...p.workspaces, outside] } : p)) });
    const all = (state: AppState) => Object.values(categoriesOf(state)).flat();
    expect(names(all(withIt(on())))).not.toContain('agent-a3f9');
    const news = all({ ...withIt(on()), unread: { 'ws:agent-a3f9': 2 } }).find((e) => e.name === 'agent-a3f9');
    expect(news?.category).toBe('active');
    expect(news?.key).toBeUndefined();
  });

  it('calls the list of chats put off with Remind Me Later Later, and a new question brings one back to the Inbox', () => {
    expect(CATEGORY_TITLES.snoozed).toBe('Later');
    const later = apply(on(), triage('ws:auth', { snoozed: { at: 1, until: Date.now() + 3_600_000, seen: [] } }));
    expect(names(categoriesOf(later).snoozed)).toEqual(['add-auth']);
    expect(names(categoriesOf(later).active)).not.toContain('add-auth');
    expect(names(categoriesOf(apply(later, question('q1', 'ws:auth'))).active)[0]).toBe('add-auth');
  });

  it('moves a running chat to Working and back to Active when its turn ends', () => {
    let s = apply(on(), overview, run('started'));
    expect(names(categoriesOf(s).working)).toEqual(['add-auth']);
    expect(categoriesOf(s).working[0]!.status).toEqual({ kind: 'working', since: 5 });
    s = apply(s, run('done'));
    expect(names(categoriesOf(s).working)).toEqual([]);
    expect(names(categoriesOf(s).active)).toContain('add-auth');
  });

  it("says Waiting for a queued run and Stopped for a failed one", () => {
    expect(categoriesOf(apply(on(), run('queued'))).working[0]!.status).toEqual({ kind: 'waiting' });
    const stopped = categoriesOf(apply(on(), run('started'), run('error'))).active.find((e) => e.name === 'add-auth')!;
    expect(stopped.status).toEqual({ kind: 'stopped' });
  });

  it("a question brings a chat to Active with 'Input', from Working and from Snoozed, first in the list", () => {
    const from = [apply(on(), run('started')), apply(on(), triage('ws:auth', { snoozed: { at: 1, until: 9_999, seen: [] } }))];
    for (const s of from) {
      const asked = categoriesOf(apply(s, question('q1', 'ws:auth')));
      expect(asked.active[0]!.name).toBe('add-auth');
      expect(statusWords(asked.active[0]!.status, 10)).toBe('Input');
    }
  });

  it('a snoozed question stays quiet on its row, and a new one wakes it', () => {
    let s = apply(on(), question('q1', 'ws:auth'), triage('ws:auth', { snoozed: { at: 1, until: 3_600_001, seen: ['q1'] } }));
    const row = categoriesOf(s).snoozed[0]!;
    expect(row.signal.level).toBe('idle');
    expect(statusWords(row.status, 1)).toBe('1h left');
    s = apply(s, question('q2', 'ws:auth'));
    expect(names(categoriesOf(s).active)[0]).toBe('add-auth');
  });

  it('DMs and groups with news are in Active, with no key to settle or snooze them by', () => {
    const friend = { peerId: 'b'.repeat(32), name: 'bob', online: true, presence: { state: 'online' as const }, addedAt: 0, unread: 2, last: { id: 'm', from: 'b', name: 'bob', text: 'yo', ts: 99, mine: false } };
    const group = { id: 'g1', name: 'crew', active: true, unread: 1, last: { ts: 50 } };
    const s = { ...on(), network: { ...on().network, enabled: true, friends: [friend], groups: [group] } } as unknown as AppState;
    const news = categoriesOf(s).active.filter((e) => e.kind === 'dm' || e.kind === 'group');
    expect(names(news)).toEqual(['bob', 'crew']);
    expect(news.map((e) => e.key)).toEqual([undefined, undefined]);
  });

  it('sorts Snoozed by soonest wake and Settled by newest', () => {
    const s = apply(
      on(),
      triage('ws:auth', { snoozed: { at: 1, until: 500, seen: [] } }),
      triage('ws:hero', { snoozed: { at: 1, until: 200, seen: [] } }),
      triage('ws:hooks', { settled: { at: 10, why: 'you' } }),
      triage('ws:q', { settled: { at: 20, why: 'idle' } }),
    );
    expect(names(categoriesOf(s).snoozed)).toEqual(['new-hero', 'add-auth']);
    expect(names(categoriesOf(s).settled)).toEqual(['How do deploys work?', 'webhooks']);
    expect(statusWords(categoriesOf(s).settled[0]!.status, 20 + 49 * 60_000)).toBe('49m');
  });

  it('shows Back in bold until you open the chat', () => {
    let s = apply(on(), overview, triage('ws:auth', { backAt: 7 }));
    const back = categoriesOf(s).active[0]!;
    expect([back.name, back.status.kind, back.bold]).toEqual(['add-auth', 'back', true]);
    s = apply(s, view('auth'));
    expect(categoriesOf(s).active.find((e) => e.name === 'add-auth')!.bold).toBe(false);
  });

  it('a Working chat sorts by the last message you sent', () => {
    const said = (id: string, channel: string, ts: number): Action => ({ type: 'chat', id, from: 'me', text: 'go', ts, byAgent: false, channel });
    const s = apply(on(), { type: 'identity', selfId: 'me', isHost: true }, said('a', 'ws:auth', 10), said('b', 'ws:hooks', 20), run('started'), run('started', 'ws:hooks', 'r2'));
    expect(names(categoriesOf(s).working)).toEqual(['webhooks', 'add-auth']);
  });

  it('shows the first page of a long list, and the one you are in', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ channel: `ws:${i}` }));
    expect(visibleRows(rows, SETTLED_PAGE, undefined)).toHaveLength(SETTLED_PAGE);
    expect(visibleRows(rows, SETTLED_PAGE, 'ws:999').at(-1)).toEqual({ channel: 'ws:999' });
    expect(visibleRows(rows.slice(0, 3), SETTLED_PAGE, 'ws:1')).toHaveLength(3);
  });

  it('folds Projects and the quiet categories when turned on, and gives your folds back when turned off', () => {
    const turned = foldsForCategories(true, { folded: ['chats'], foldedBeforeCategories: [] });
    expect(turned.folded).toEqual(['chats', 'projects', 'working', 'snoozed', 'settled']);
    expect(foldsForCategories(false, { folded: [...turned.folded, 'friends'], foldedBeforeCategories: turned.foldedBeforeCategories })).toEqual({ folded: ['chats'], foldedBeforeCategories: [] });
  });

  it('lists every conversation, not only those with news', () => {
    expect(names(conversationEntries(base()))).toEqual(['How do deploys work?', 'add-auth', 'webhooks', 'new-hero']);
    expect(unreadEntries(base())).toEqual([]);
  });

  it('goes to the next Active row after this one, and to none when it was the last', () => {
    const s = apply(on(), overview);
    const order = names(categoriesOf(s).active);
    expect(nextActive(s, `ws:auth`)?.name).toBe(order[order.indexOf('add-auth') + 1] ?? order[order.indexOf('add-auth') - 1]);
    const last = apply(s, triage('ws:q', { settled: { at: 1, why: 'you' } }), triage('ws:hooks', { settled: { at: 1, why: 'you' } }), triage('ws:hero', { settled: { at: 1, why: 'you' } }));
    expect(nextActive(last, 'ws:auth')).toBeUndefined();
  });

  it('says why a chat is Settled, and names the merged PR', () => {
    const at = 1_000;
    const now = at + 49 * 60_000;
    expect(settledWords({ at, why: 'pr_merged', pr: 12 }, 3, now)).toBe('Settled 49m ago: PR #12 merged');
    expect(settledWords({ at, why: 'you' }, 3, now)).toBe('Settled by you');
    expect(settledWords({ at, why: 'idle' }, 3, now)).toBe('Settled: idle for 3 days');
    expect(settledWords({ at, why: 'merged_here' }, 3, now)).toBe('Settled 49m ago: merged into main here');
  });

  it('says when a snooze ends in local time, with its day when it is not today', () => {
    const now = new Date(2026, 10, 7, 14, 0).getTime();
    expect(wakeWords(new Date(2026, 10, 7, 15, 30).getTime(), now)).toBe('15:30');
    expect(wakeWords(new Date(2026, 10, 9, 9, 0).getTime(), now)).toBe('Mon 09:00');
  });

  describe('the Dock and the tallies', () => {
    const snoozedNews = (s: AppState): AppState => apply(s, overview, run('done'), triage('ws:auth', { snoozed: { at: 1, until: 9_999, seen: [] } }));

    it('a snoozed chat with unread messages adds nothing while the setting is on', () => {
      const s = snoozedNews(on());
      expect(s.unread['ws:auth']).toBe(1);
      expect(dockCount(s)).toBe(0);
      expect(projectTally(s, api).unread).toBe(0);
    });

    it('adds nothing with the setting off either (Remind Me Later), until its time', () => {
      const later = (s: AppState, until: number): AppState => apply(s, overview, run('done'), triage('ws:auth', { snoozed: { at: 1, until, seen: [] } }));
      const s = later(base(), Date.now() + 3_600_000);
      expect(s.unread['ws:auth']).toBe(1);
      expect(dockCount(s)).toBe(0);
      expect(projectTally(s, api).unread).toBe(0);
      expect(workspaceSignal(s, s.projects.flatMap((p) => p.workspaces).find((w) => w.id === 'auth')!)).toMatchObject({ level: 'idle', unread: 0 });
      // Its time passed (the daemon wakes it within moments): its row shows the news again.
      expect(dockCount(later(base(), Date.now() - 1))).toBe(1);
    });

    it('a chat that is Back counts once, with or without news', () => {
      expect(dockCount(apply(on(), overview, triage('ws:auth', { backAt: 7 })))).toBe(1);
      expect(dockCount(apply(on(), overview, run('done'), triage('ws:auth', { backAt: 7 })))).toBe(1);
    });

    it('a new question on a snoozed chat counts', () => {
      expect(dockCount(apply(snoozedNews(on()), question('q9', 'ws:auth')))).toBe(1);
    });
  });
});
