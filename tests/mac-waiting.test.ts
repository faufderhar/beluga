import { describe, expect, it } from 'vitest';
import type { Action, AppState } from '../src/core/store.js';
import type { Notice } from '../src/core/work-store.js';
import { type ScreenAction, initialAppState, reduceApp } from '../src/client/screen.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { bellCount, isCovered, noticeNeedView, sameWaiting, splitActions, waitingList } from '../packages/mac/src/layout/waiting-model.js';
import type { TaskView as GwTask } from '../src/core/gateway/model.js';

/** The bell's "Waiting for you" (packages/mac/src/layout/waiting-model.ts, BLG-255). */

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w', projectRoot: '/p', name: 'w', path: '/wt/w', kind: 'worktree', branch: 'klaud/w', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over,
});
const api: Project = { id: 'p1', name: 'beluga', root: '/p', base: 'origin/main', workspaces: [ws({ id: 'main', name: 'main', kind: 'main' }), ws({ id: 'auth', name: 'add-auth' })] };

const apply = (s: AppState, ...actions: Array<Action | ScreenAction>): AppState => actions.reduce<AppState>((st, a) => reduceApp(st, a), s);
const base = (): AppState => apply(initialAppState('room'), { type: 'welcome', self: { peerId: 'me', name: 'kay', agent: true, shares: [] } }, { type: 'projects', projects: [api] });
const question = (qid: string, channel: string): Action => ({
  type: 'question_add',
  question: { qid, requestId: 'r1', owner: 'me', channel, picked: {}, question: { kind: 'question', questions: [{ question: 'Which one?', header: '', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }] } },
});
const teamUp = (s: AppState): AppState => ({ ...s, team: { ...s.team, offers: [{ peerId: 'mia', name: 'mia', projectId: 'p1', repo: 'acme/beluga', state: 'invited', at: 100 }] } });
const notice = (over: Partial<Notice>): Notice => ({ id: 1, kind: 'needsYou', title: 't', body: '', ts: 1, read: false, ...over });

describe('the bell’s Waiting for you', () => {
  it('lists a team-up with where it is, opens Tasks for that repo, and answers it on the row', () => {
    const [w] = waitingList(teamUp(base()));
    expect(w!.item.id).toBe('team:mia:p1');
    expect(w!.view).toEqual({ kind: 'tasks', projectId: 'p1' });
    expect(w!.place).toBe('Tasks · beluga');
    expect(w!.surface.map((a) => [a.label, a.method, a.args])).toEqual([
      ['Team Up', 'team.answer', ['mia', 'p1', true]],
      ['Not Now', 'team.answer', ['mia', 'p1', false]],
    ]);
  });

  it('a question shows its few choices on the row, Skip on right-click, and opens its conversation', () => {
    const [w] = waitingList(apply(base(), question('q1', 'ws:auth')));
    expect(w!.surface.map((a) => a.label)).toEqual(['A', 'B']);
    expect(w!.more.map((a) => a.label)).toEqual(['Skip']);
    expect(w!.view).toMatchObject({ kind: 'workspace', id: 'auth' });
    expect(w!.place).toBe('beluga · add-auth');
  });

  it('a friend request says it’s answered in Friends (no page of its own)', () => {
    const s = base();
    const [w] = waitingList({ ...s, network: { ...s.network, offers: [{ peerId: 'rae', name: 'rae', dir: 'in', at: 5, expiresAt: 10 }] } });
    expect(w!.view).toBeUndefined();
    expect(w!.place).toBe('Friends');
  });

  it('keeps Approve and Decline on the row, Always behind them', () => {
    const { surface, more } = splitActions([
      { label: 'Approve', tone: 'main', method: 'host.answerApproval', args: ['yes', 'a'] },
      { label: 'Decline', tone: 'danger', method: 'host.answerApproval', args: ['no', 'a'] },
      { label: 'Always', tone: 'plain', method: 'host.answerApproval', args: ['always', 'a'] },
    ]);
    expect(surface.map((a) => a.label)).toEqual(['Approve', 'Decline']);
    expect(more.map((a) => a.label)).toEqual(['Always']);
  });

  it('a notice about a waiting request is left out of the history and never counted twice', () => {
    const s = { ...teamUp(base()), inbox: [notice({ id: 2, need: 'team:mia:p1' }), notice({ id: 1, kind: 'done', tag: undefined })] } as AppState;
    const waiting = waitingList(s);
    expect(isCovered(s.inbox[0]!, waiting)).toBe(true);
    expect(isCovered(s.inbox[1]!, waiting)).toBe(false);
    expect(bellCount(s, waiting)).toBe(2);
  });

  it('a question’s notice matches it by its ref', () => {
    const s = apply(base(), question('q1', 'ws:auth'));
    expect(isCovered(notice({ tag: 'question', ref: 'q1' }), waitingList(s))).toBe(true);
  });

  it('a past notice about a request opens where it’s answered, even once it’s gone', () => {
    const s = base();
    expect(noticeNeedView(s, notice({ need: 'team:mia:p1' }))).toEqual({ kind: 'tasks', projectId: 'p1' });
    expect(noticeNeedView(s, notice({ need: 'gwq:t1' }))).toEqual({ kind: 'requests' });
    expect(noticeNeedView(s, notice({ kind: 'done' }))).toBeUndefined();
  });
});

/**
 * BLG-905: opening the bell froze the window grey. An answer's args (a friend's agent asking to do
 * something, one of Claude's questions, a plan to approve) sat deeper than the list's compare
 * could see, so an unchanged list never read the same and the window redrew for good.
 */
describe('an unchanged waiting list reads the same, however deep its answers go', () => {
  const plan: Action = { type: 'question_add', question: { qid: 'q2', requestId: 'r2', owner: 'me', channel: 'ws:auth', picked: {}, question: { kind: 'plan', plan: 'Do it' } } } as Action;
  const friendAsks = (s: AppState): AppState => {
    const task = { id: 't_request00001', direction: 'received', peerId: 'bob', peerName: 'bob', kind: 'run', ask: 'Run the e2e suite', summary: 'run the e2e suite', needs: ['shell'], by: 'person', state: 'awaiting_approval', steps: [], createdAt: 5, updatedAt: 5 } as unknown as GwTask;
    return { ...s, gateway: { ...s.gateway, tasks: [task] } };
  };
  const cases: Array<[string, () => AppState]> = [
    ['one of Claude’s questions with choices', () => apply(base(), question('q1', 'ws:auth'))],
    ['a plan to approve', () => apply(base(), plan)],
    ['a friend’s agent asking to do something', () => friendAsks(base())],
  ];
  for (const [what, state] of cases) {
    it(what, () => {
      const s = state();
      const a = waitingList(s);
      expect(a.length).toBeGreaterThan(0);
      expect(sameWaiting(a, waitingList(s))).toBe(true);
    });
  }

  it('still sees a real change', () => {
    const s = apply(base(), question('q1', 'ws:auth'));
    expect(sameWaiting(waitingList(s), waitingList(teamUp(s)))).toBe(false);
  });
});

