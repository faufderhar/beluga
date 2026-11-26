import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PRESETS,
  LATER,
  MAC_SCOPE,
  byWords,
  chatPlaceOf,
  countsOf,
  dotStrip,
  duplicateStep,
  durationText,
  filterSentinels,
  footLine,
  groupSentinels,
  iconOf,
  moveStep,
  nextText,
  rowOf,
  runLine,
  runsFolderOf,
  sharedModel,
  sidebarLine,
  stepChoices,
  toggleDay,
  triggerChoices,
  triggerOfKind,
  whenText,
  withEvery,
  everySegment,
  intervalOf,
  withInterval,
  INTERVAL_CHOICES,
  withModel,
  anyRunning,
  accessSentence,
  askLine,
  chatChoices,
  describedName,
  headerRows,
  mergeWords,
  newStep,
  otherSentinels,
  rowsToHeaders,
  eventCards,
  eventSentence,
  looksLikeUrl,
  troubleOf,
} from '../packages/mac/src/sentinel/sentinel-model.js';
import { panelFits } from '../packages/mac/src/lib/panel-model.js';
import { dockCount, isSentinelOwned, projectTally, unreadEntries } from '../packages/mac/src/layout/attention-model.js';
import { initialAppState, reduceApp } from '../src/client/screen.js';
import type { Action, AppState } from '../src/core/store.js';
import type { Notice } from '../src/core/work-store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { BELUGA_EVENTS, CLAUDE_CHANGED, GITHUB_EVENTS, NO_SENTINEL, type RunSummary, SENTRY_EVENTS, STRIPE_EVENTS, type Sentinel, type SentinelState, type Step, type Trigger, presetFields, stepSentence, triggerSentence } from '../src/core/sentinel/model.js';
import { TriggerSchema } from '../src/core/sentinel/schema.js';
import { StepInputSchema } from '../src/core/sentinel/schema.js';

/** Sentinel on the Mac, its plain parts: rows, groups, the sidebar's line, times, the schedule's controls, step edits. */

const at = (y: number, m: number, d: number, hh: number, mm = 0): number => new Date(y, m - 1, d, hh, mm).getTime();
const NOW = at(2026, 10, 23, 9, 30); // a Friday

const sentinel = (over: Partial<Sentinel> & Pick<Sentinel, 'id' | 'name'>): Sentinel => ({
  icon: 'calendar',
  trigger: { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' },
  steps: [],
  access: 'look',
  limits: { minutes: 30, pauseAfter: 3 },
  notify: 'mac',
  paused: false,
  failures: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const run = (over: Partial<RunSummary> & Pick<RunSummary, 'id' | 'sentinelId'>): RunSummary => ({
  by: 'schedule',
  trigger: { kind: 'schedule', summary: 'Every day at 7:00' },
  state: 'done',
  startedAt: at(2026, 10, 23, 7),
  endedAt: at(2026, 10, 23, 7, 2),
  headline: '3 commits landed',
  steps: [],
  tasks: [],
  ...over,
});

const brief = sentinel({ id: 'sn_brief', name: 'Morning brief', projectId: 'api', steps: [{ id: 'a', kind: 'claude', name: 'Read what changed', prompt: 'Brief', where: 'project' }, { id: 'b', kind: 'notify', name: 'Tell me', phone: true }] });
const nightly = sentinel({ id: 'sn_night', name: 'Nightly tests', projectId: 'api', paused: true, pausedWhy: 'Paused after 3 failures in a row', failures: 3 });
const mac = sentinel({ id: 'sn_mac', name: 'Disk check', trigger: { kind: 'manual' } });
const web = sentinel({ id: 'sn_web', name: 'Watch the web', projectId: 'landing' });

const state = (over: Partial<SentinelState> = {}): SentinelState => ({ ...NO_SENTINEL, enabled: true, items: [brief, nightly, mac, web], nextAt: { sn_brief: at(2026, 10, 24, 7), sn_web: at(2026, 10, 24, 6) }, ...over });

describe('Sentinel on the Mac', () => {
  it('counts, filters and scopes the list', () => {
    const items = state().items;
    expect(countsOf(items)).toEqual({ watching: 3, paused: 1, all: 4 });
    expect(filterSentinels(items, { show: 'paused' }).map((s) => s.id)).toEqual(['sn_night']);
    expect(filterSentinels(items, { show: 'watching', scope: 'api' }).map((s) => s.id)).toEqual(['sn_brief']);
    expect(filterSentinels(items, { show: 'all', scope: MAC_SCOPE }).map((s) => s.id)).toEqual(['sn_mac']);
    // The filter reads the name, the sentence and the steps.
    expect(filterSentinels(items, { show: 'all', query: 'tell me' }).map((s) => s.id)).toEqual(['sn_brief']);
    expect(filterSentinels(items, { show: 'all', query: 'press run' }).map((s) => s.id)).toEqual(['sn_mac']);
  });

  it('groups rows by project in the sidebar’s order, Your Mac last, names A to Z', () => {
    const groups = groupSentinels(state().items, [{ id: 'landing', name: 'landing' }, { id: 'api', name: 'bob-api' }]);
    expect(groups.map((g) => [g.name, g.items.map((s) => s.name)])).toEqual([
      ['landing', ['Watch the web']],
      ['bob-api', ['Morning brief', 'Nightly tests']],
      ['Your Mac', ['Disk check']],
    ]);
  });

  it('makes a row: the sentence, the last run, when it runs next', () => {
    const st = state({ runs: [run({ id: 'r1', sentinelId: 'sn_brief', startedAt: NOW - 2 * 3_600_000 })] });
    const row = rowOf(st, brief, NOW);
    expect(row.sentence).toBe('Every day at 7:00');
    expect(row.last).toMatchObject({ state: 'done', label: 'Done', tone: 'ok', headline: '3 commits landed', when: '2 h ago' });
    expect(row.next).toBe('next tomorrow 7:00');
    expect(row.steps.map((s) => s.kind)).toEqual(['claude', 'notify']);
    // Paused: no "next"; never run: no last.
    expect(rowOf(st, nightly, NOW).next).toBeUndefined();
    expect(rowOf(st, mac, NOW).last).toBeUndefined();
    // Running: live, and the headline says so until it has one.
    const going = state({ runs: [run({ id: 'r2', sentinelId: 'sn_web', state: 'running', headline: '', endedAt: undefined })] });
    expect(rowOf(going, web, NOW)).toMatchObject({ live: true, last: { headline: 'Running…', label: 'Running' } });
  });

  it('says the sidebar’s line: watching and the next run, a problem first, or nothing yet', () => {
    expect(sidebarLine(state())).toEqual({ text: 'Paused after 3 failures in a row', problem: true });
    const fine = state({ items: [brief, mac, web] });
    expect(sidebarLine(fine)).toEqual({ text: '3 watching · next at 6:00', problem: false });
    expect(sidebarLine({ ...NO_SENTINEL, enabled: true })).toEqual({ text: 'Nothing watching yet', problem: false });
    expect(sidebarLine({ ...NO_SENTINEL, enabled: true, items: [{ ...mac, paused: true }] }).text).toBe('Nothing watching · 1 paused');
    // Claude's change pausing one isn't a problem.
    expect(sidebarLine({ ...NO_SENTINEL, enabled: true, items: [{ ...mac, paused: true, pausedWhy: CLAUDE_CHANGED }] })).toEqual({ text: 'Nothing watching · 1 paused', problem: false });
    expect(anyRunning(state({ live: { r: { state: 'running' } } }))).toBe(true);
    expect(anyRunning(state({ live: { r: { state: 'needs-you' } } }))).toBe(false);
  });

  it('writes the foot', () => {
    const runs = [run({ id: 'r1', sentinelId: 'sn_brief', startedAt: NOW - 120_000 })];
    expect(footLine(state().items, runs, NOW)).toBe('3 watching · 1 paused · last run 2 min ago');
    expect(footLine([mac], [], NOW)).toBe('1 watching');
  });

  it('says times and durations', () => {
    expect(whenText(at(2026, 10, 23, 7), NOW)).toBe('Today 7:00');
    expect(whenText(at(2026, 10, 22, 2), NOW)).toBe('Yesterday 2:00');
    expect(whenText(at(2026, 10, 20, 2), NOW)).toBe('Tue 2:00');
    expect(whenText(at(2026, 10, 3, 2), NOW)).toBe('Oct 3 2:00');
    expect(nextText(at(2026, 10, 23, 17, 5), NOW)).toBe('17:05');
    expect(nextText(at(2026, 10, 26, 7), NOW)).toBe('Mon 7:00');
    expect(durationText(2_100)).toBe('2.1 s');
    expect(durationText(48_000)).toBe('48 s');
    expect(durationText(252_000)).toBe('4 min 12 s');
    expect(durationText(120_000)).toBe('2 min');
    expect(durationText(3_780_000)).toBe('1 h 3 min');
  });

  it('says who ran a run, and the run page’s line', () => {
    const st = state({ runs: [run({ id: 'r1', sentinelId: 'sn_night' })] });
    expect(byWords({ by: 'schedule', trigger: { kind: 'schedule', summary: '' } }, st)).toBe('schedule');
    expect(byWords({ by: 'phone', trigger: { kind: 'manual', summary: '' } }, st)).toBe('your phone');
    expect(byWords({ by: 'event', trigger: { kind: 'github', summary: 'GitHub #48' } }, st)).toBe('GitHub #48');
    expect(byWords({ by: 'after:r1', trigger: { kind: 'after', summary: '' } }, st)).toBe('after Nightly tests');
    expect(byWords({ by: 'after:gone', trigger: { kind: 'after', summary: '' } }, st)).toBe('after another sentinel');
    const r = run({ id: 'r9', sentinelId: 'sn_night', startedAt: at(2026, 10, 20, 2), endedAt: at(2026, 10, 20, 2) + 252_000 });
    expect(runLine(r, 'Nightly tests', st, NOW)).toBe('Nightly tests · ran by schedule · Tue 2:00 · 4 min 12 s');
  });

  it('draws the dot strip: the last 30, oldest first, in their tones', () => {
    const runs = Array.from({ length: 34 }, (_, i) => run({ id: `r${i}`, sentinelId: 'sn_brief', startedAt: i, state: i === 33 ? 'failed' : i === 32 ? 'skipped' : 'done' }));
    const dots = dotStrip([...runs].reverse());
    expect(dots).toHaveLength(30);
    expect(dots[0]!.id).toBe('r4');
    expect(dots.at(-1)).toMatchObject({ id: 'r33', tone: 'error' });
    expect(dots.at(-2)!.tone).toBe('muted');
  });

  it('finds where a run’s chat is, and the runs folder', () => {
    expect(chatPlaceOf('ws:wt-1')).toEqual({ kind: 'workspace', id: 'wt-1' });
    expect(chatPlaceOf('mac:assistant')).toEqual({ kind: 'assistant' });
    expect(chatPlaceOf('mac:assistant:k2')).toEqual({ kind: 'assistant', chat: 'k2' });
    expect(chatPlaceOf('room')).toBeUndefined();
    expect(runsFolderOf([{ report: '/Users/k/.beluga/sentinel/runs/run_1/report.md' }])).toBe('/Users/k/.beluga/sentinel/runs');
    expect(runsFolderOf([{}])).toBeUndefined();
  });

  it('every few minutes or hours: one "Through the day" segment, one Every menu', () => {
    const hourly = { kind: 'schedule', every: 'hours', hours: 3, at: '00:00', missed: 'catch-up' } as const;
    expect(INTERVAL_CHOICES.map((c) => c.label)).toEqual(['minute', '5 minutes', '10 minutes', '15 minutes', '30 minutes', 'hour', '2 hours', '3 hours', '6 hours', '12 hours']);
    expect(intervalOf(hourly)).toBe('3h');
    const quarter = withInterval(hourly, '15m');
    expect(quarter).toEqual({ kind: 'schedule', every: 'minutes', minutes: 15, at: '00:00', missed: 'catch-up' });
    expect(intervalOf(quarter)).toBe('15m');
    expect(everySegment(quarter)).toBe('hours');
    expect(everySegment(hourly)).toBe('hours');
    expect(everySegment({ ...hourly, every: 'week' })).toBe('week');
    expect(withInterval(quarter, '1h')).toEqual({ kind: 'schedule', every: 'hours', hours: 1, at: '00:00', missed: 'catch-up' });
    // Not one of the menu's: nothing changes.
    expect(withInterval(quarter, '7m')).toBe(quarter);
    expect(withInterval(quarter, 'soon')).toBe(quarter);
  });

  it('changes a schedule: every, the weekday chips', () => {
    const day = { kind: 'schedule', every: 'day', at: '07:00', missed: 'skip' } as const;
    expect(withEvery(day, 'week')).toEqual({ kind: 'schedule', every: 'week', at: '07:00', missed: 'skip', days: [1] });
    expect(withEvery(day, 'month')).toMatchObject({ every: 'month', day: 1 });
    expect(withEvery({ ...day, every: 'week', days: [1, 3] }, 'hours')).toEqual({ kind: 'schedule', every: 'hours', at: '07:00', missed: 'skip', hours: 3 });
    expect(withEvery(day, 'minutes')).toEqual({ kind: 'schedule', every: 'minutes', at: '07:00', missed: 'skip', minutes: 30 });
    expect(toggleDay([1], 3)).toEqual([1, 3]);
    expect(toggleDay([1, 3], 1)).toEqual([3]);
    // One day stays on; Sunday sorts last, as the chips show.
    expect(toggleDay([3], 3)).toEqual([3]);
    expect(toggleDay([1], 0)).toEqual([1, 0]);
  });

  it('offers only what this Beluga runs: the rest is shown for a later update, or refused by the access', () => {
    const triggers = triggerChoices();
    // Every kind runs now (phase 3): nothing is left for a later update.
    expect(triggers.filter((c) => !c.disabled).map((c) => c.value)).toEqual(['schedule', 'once', 'manual', 'after', 'beluga', 'github', 'stripe', 'uptime', 'sentry', 'webhook']);
    expect(triggers.find((c) => c.value === 'once')!.label).toBe('Once');
    // A one-time trigger starts at the next whole hour on the Mac's clock.
    const now = new Date(2026, 10, 12, 14, 30, 15).getTime();
    const once = triggerOfKind('once', { kind: 'manual' }, now);
    expect(once).toMatchObject({ kind: 'once', missed: 'catch-up' });
    expect(new Date((once as { at: string }).at).getTime()).toBe(new Date(2026, 10, 12, 15, 0).getTime());
    expect(triggers.some((c) => c.description === LATER)).toBe(false);
    expect(triggerOfKind('manual', { kind: 'schedule', every: 'day', at: '07:00', missed: 'skip' })).toEqual({ kind: 'manual' });
    expect(triggerOfKind('schedule', { kind: 'manual' })).toMatchObject({ kind: 'schedule', every: 'day' });
    expect(triggerOfKind('after', { kind: 'manual' })).toEqual({ kind: 'after', sentinelId: '', on: 'failure' });
    expect(triggerOfKind('github', { kind: 'manual' })).toEqual({ kind: 'github', what: 'workflow-failed', minutes: 2 });
    // Every kind's starting trigger is one the daemon takes as it is.
    for (const c of triggers) expect(TriggerSchema.safeParse(triggerOfKind(c.value, { kind: 'manual' })).success).toBe(true);
    const steps = stepChoices('look');
    expect(steps).toHaveLength(10);
    expect(steps.filter((c) => !c.disabled).map((c) => c.kind)).toEqual(['claude', 'script', 'notify', 'http', 'message', 'friend', 'trigger', 'measure']);
    expect(steps.find((c) => c.kind === 'pr')!.hint).toBe('Needs Work access');
    expect(steps.find((c) => c.kind === 'merge')!.hint).toBe('Needs Ship access');
    expect(stepChoices('ship').every((c) => !c.disabled)).toBe(true);
    // Every new step is one the daemon takes as it is.
    for (const c of stepChoices('ship')) expect(StepInputSchema.safeParse(newStep(c.kind)).success).toBe(true);
  });

  it('phase 2’s steps in words: services, merges, chats, other sentinels', () => {
    const groq = { id: 'h', kind: 'http', name: 'Search', timeoutSec: 30, ...presetFields('groqbot'), url: 'https://api.groqbot.example/search' } as Step;
    expect(stepSentence(groq)).toBe('Groqbot: POST api.groqbot.example');
    expect(stepSentence({ id: 'h', kind: 'http', name: 'x', method: 'GET', url: '', headers: {}, timeoutSec: 30 })).toBe('GET a URL');
    expect(presetFields('slack')).toMatchObject({ method: 'POST', url: '$SLACK_WEBHOOK_URL', headers: { 'Content-Type': 'application/json' } });
    const merge = { id: 'm', kind: 'merge' as const, name: 'Merge', require: { checks: true as const, approval: true }, method: 'squash' as const };
    expect(mergeWords(merge)).toBe('It merges once the checks pass, the agent’s review says ship, and you tap Merge (here or on your phone).');
    expect(mergeWords({ require: { checks: true, approval: false } })).toMatch(/^It merges by itself/);
    expect(accessSentence('ship', [merge])).toBe('Your agent can change code in a worktree, open pull requests, and merge when the checks pass and you’ve approved');
    expect(accessSentence('ship', [{ ...merge, require: { checks: true, approval: false } }])).toBe('Your agent can change code in a worktree, open pull requests, and merge by itself when the checks pass');
    const network = { friends: [{ peerId: 'p2', name: 'Zoe' }, { peerId: 'p1', name: 'Ata' }], groups: [{ id: 'g1', name: 'Launch crew', active: true }, { id: 'g2', name: 'Old', active: false }] };
    expect(chatChoices(network).map((c) => [c.value, c.label])).toEqual([
      ['dm:p1', 'Ata'],
      ['dm:p2', 'Zoe'],
      ['group:g1', 'Launch crew'],
    ]);
    expect(stepSentence({ id: 'x', kind: 'message', name: 'm', to: 'group:g1', text: '' }, (id) => (id === 'group:g1' ? 'Launch crew' : undefined))).toBe('Messages Launch crew');
    expect(otherSentinels([{ ...mac, id: 'b', name: 'B', paused: true }, { ...mac, id: 'a', name: 'A' }, { ...mac, id: 'me', name: 'Me' }], 'me')).toEqual([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', description: 'Paused: it won’t start until you turn it on' },
    ]);
    expect(headerRows({ Authorization: 'Bearer $K' })).toEqual([{ key: 'Authorization', value: 'Bearer $K' }, { key: '', value: '' }]);
    expect(rowsToHeaders([{ key: ' X-A ', value: '1' }, { key: '', value: 'lost' }, { key: 'X-A', value: '2' }])).toEqual({ 'X-A': '2' });
  });

  it('the page’s box: Claude’s last line while it writes, then its answer', () => {
    const ask = { channel: 'ws:c1', startedAt: NOW, state: 'writing' as const, text: 'make it weekly' };
    expect(askLine(undefined, undefined)).toBeUndefined();
    expect(askLine(ask, { running: true, last: 'mcp__beluga_sentinel__sentinel_update' })).toEqual({ who: 'claude', text: 'Your agent is writing… changing the sentinel' });
    expect(askLine(ask, { running: true, last: 'make it weekly' })).toEqual({ who: 'claude', text: 'Your agent is writing…' });
    expect(askLine({ ...ask, state: 'done', answer: 'Made it weekly' }, undefined)).toEqual({ who: 'done', text: 'Made it weekly' });
    expect(askLine({ ...ask, state: 'failed', answer: 'usage limit' }, undefined)).toEqual({ who: 'failed', text: 'Your agent stopped: usage limit' });
    expect(describedName('Every weekday morning, read yesterday’s commits and open issues, write me a brief')).toBe('Read yesterday’s commits and open');
    expect(describedName('Read the commits and the issues')).toBe('Read the commits');
    expect(describedName('Every weekday at 8, read yesterday’s commits')).toBe('Read yesterday’s commits');
    expect(describedName('   ')).toBe('New sentinel');
  });

  it('edits steps: move, duplicate, one model for every Claude step', () => {
    const steps: Step[] = [
      { id: 'a', kind: 'claude', name: 'Read', prompt: 'x', where: 'project', model: 'opus' },
      { id: 'b', kind: 'script', name: 'Test', command: 'npm test', cwd: 'project', timeoutSec: 120 },
      { id: 'c', kind: 'claude', name: 'Fix', prompt: 'y', where: 'worktree', model: 'opus' },
    ];
    expect(moveStep(steps, 0, 1).map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(moveStep(steps, 0, -1).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    const copy = duplicateStep(steps, 1);
    expect(copy).toHaveLength(4);
    expect(copy[2]).toMatchObject({ kind: 'script', name: 'Test copy' });
    expect('id' in copy[2]!).toBe(false);
    expect(sharedModel(steps)).toBe('opus');
    expect(sharedModel([steps[0]!, { ...(steps[2] as Extract<Step, { kind: 'claude' }>), model: 'haiku' }])).toBeUndefined();
    expect(sharedModel([steps[1]!])).toBe('');
    const plain = withModel(steps, '');
    expect(plain.some((s) => s.kind === 'claude' && 'model' in s)).toBe(false);
    expect(sharedModel(withModel(steps, 'sonnet'))).toBe('sonnet');
  });

  it('has the six Ask Claude presets, each a prompt that says when to stop or what to make', () => {
    expect(CLAUDE_PRESETS.map((p) => p.label)).toEqual(['Write a brief of what changed', 'Turn this into tasks', 'Investigate and fix it', 'Review the changes', 'Update dependencies and run the tests', 'Write release notes']);
    for (const p of CLAUDE_PRESETS) expect(p.prompt.length).toBeGreaterThan(80);
  });

  it('knows its icons, the shield for anything else', () => {
    expect(iconOf('calendar')).toBe('calendar');
    expect(iconOf('rocket')).toBe('sentinel');
    expect(iconOf(undefined)).toBe('sentinel');
  });

  it('takes the whole window: no right panel on the list, a sentinel’s page or a run', () => {
    expect(panelFits({ kind: 'sentinel' })).toBe(false);
    expect(panelFits({ kind: 'sentinel_page', id: 'sn_1' })).toBe(false);
    expect(panelFits({ kind: 'sentinel_run', runId: 'run_1' })).toBe(false);
    expect(panelFits({ kind: 'overview' })).toBe(true);
  });
});

describe('a sentinel run’s conversations in Unread and the Dock', () => {
  const ws = (id: string, kind: Workspace['kind']): Workspace => ({ id, projectRoot: '/p', name: id, path: `/wt/${id}`, kind, branch: `b/${id}`, base: 'origin/main', createdAt: 1, projectId: 'api', external: false, status: { changed: 0, ahead: 0, behind: 0 } });
  const api: Project = { id: 'api', name: 'bob-api', root: '/p', base: 'origin/main', workspaces: [ws('main', 'main'), ws('mine', 'worktree'), ws('brief-chat', 'chat')] };
  const apply = (s: AppState, ...actions: Action[]): AppState => actions.reduce<AppState>((st, a) => reduceApp(st, a), s);
  const done = (channel: string, requestId: string): Action => ({ type: 'agent_event', owner: 'me', requestId, requester: 'me', event: 'done', text: 'Brief written', ts: 5, channel });
  const notice = (ts: number, over: Partial<Notice>): Action => ({ type: 'notice_add', notice: { kind: 'done', title: 't', body: '', ...over } as Notice, ts }) as Action;
  const ask = (qid: string, channel: string): Action => ({
    type: 'question_add',
    question: { qid, requestId: 'r9', owner: 'me', channel, picked: {}, question: { kind: 'question', questions: [{ question: 'Which branch?', header: '', options: [], multiSelect: false }] } },
  });
  const sentinels = state({ runs: [run({ id: 'run_1', sentinelId: 'sn_brief', channel: 'ws:brief-chat', steps: [{ id: 'a', state: 'done', channel: 'ws:brief-chat' }] }), run({ id: 'run_2', sentinelId: 'sn_mac', channel: 'mac:assistant:c7' })] });
  const base = (): AppState =>
    apply(initialAppState('room'), { type: 'welcome', self: { peerId: 'me', name: 'kay', agent: true, shares: [] } }, { type: 'projects', projects: [api] }, { type: 'sentinel_init', state: sentinels }, { type: 'view', view: { kind: 'overview' } } as unknown as Action);

  it('a finished run’s chat is in neither Unread, the project’s tally nor the Dock', () => {
    const s = apply(base(), done('ws:brief-chat', 'r1'), done('ws:mine', 'r2'), done('mac:assistant:c7', 'r3'), notice(1, { channel: 'ws:brief-chat' }), notice(2, { channel: 'mac:assistant:c7', tag: 'sentinel' }));
    expect(s.unread['ws:brief-chat']).toBe(1);
    expect(isSentinelOwned(s, 'ws:brief-chat')).toBe(true);
    expect(isSentinelOwned(s, 'mac:assistant:c7')).toBe(true);
    expect(isSentinelOwned(s, 'ws:mine')).toBe(false);
    expect(unreadEntries(s).map((e) => e.channel)).toEqual(['ws:mine']);
    expect(projectTally(s, api).unread).toBe(1);
    expect(dockCount(s)).toBe(1);
  });

  it('one that needs you shows once, as the sentinel’s, and opens the run’s chat', () => {
    const s = apply(base(), done('ws:brief-chat', 'r1'), ask('q1', 'ws:brief-chat'), notice(1, { kind: 'needsYou', tag: 'question', ref: 'q1', channel: 'ws:brief-chat' }));
    const entries = unreadEntries(s);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e).toMatchObject({ kind: 'sentinel', channel: 'sentinel:sn_brief', name: 'Morning brief', at: 'ws:brief-chat', runId: 'run_1', signal: { level: 'needs', need: 'question', tip: 'Morning brief asks a question' } });
    // The question and its notice are that one entry.
    expect(dockCount(s)).toBe(1);
    // Answered: gone again.
    const answered = apply(s, { type: 'question_remove', qid: 'q1' });
    expect(unreadEntries(answered)).toEqual([]);
  });
});

describe('Sentinel’s events on the Mac', () => {
  it('says when every kind of trigger runs, in the design’s words', () => {
    const cases: Array<[Trigger, string]> = [
      [{ kind: 'beluga', what: 'task-done' }, 'When a task is done'],
      [{ kind: 'beluga', what: 'claude-finished' }, 'When a worktree’s agent finishes'],
      [{ kind: 'github', what: 'workflow-failed' }, 'When a workflow fails on GitHub'],
      [{ kind: 'github', what: 'issue-labelled', label: 'bug' }, 'When an issue gets the label “bug” on GitHub'],
      [{ kind: 'stripe', what: 'payment-failed' }, 'When a payment fails in Stripe'],
      [{ kind: 'uptime', url: 'https://example.com/health', minutes: 5 }, 'When example.com stops answering (checked every 5 minutes), and when it’s back'],
      [{ kind: 'uptime', url: 'https://example.com', minutes: 1 }, 'When example.com stops answering (checked every minute), and when it’s back'],
      [{ kind: 'sentry', org: 'acme', project: 'checkout', what: 'regression' }, 'When Sentry sees a regression in acme/checkout'],
      [{ kind: 'sentry', org: '', project: '', what: 'new-issue' }, 'When Sentry sees a new issue'],
      [{ kind: 'webhook' }, 'When something posts to its URL'],
      [{ kind: 'webhook', signature: 'github' }, 'When GitHub posts to its URL'],
    ];
    for (const [t, words] of cases) expect(triggerSentence(t)).toBe(words);
  });

  it('has a card for every event of each kind, and none for the kinds with fields', () => {
    expect(eventCards('beluga')!.map((c) => c.value)).toEqual([...BELUGA_EVENTS]);
    expect(eventCards('github')!.map((c) => c.value).sort()).toEqual([...GITHUB_EVENTS].sort());
    expect(eventCards('stripe')!.map((c) => c.value)).toEqual([...STRIPE_EVENTS]);
    expect(eventCards('sentry')!.map((c) => c.value)).toEqual([...SENTRY_EVENTS]);
    expect(eventCards('uptime')).toBeUndefined();
    expect(eventCards('webhook')).toBeUndefined();
  });

  it('says in one sentence what will happen', () => {
    expect(eventSentence({ kind: 'github', what: 'workflow-failed', minutes: 2 }, { repo: 'acme/bob-api' })).toMatch(/^Beluga asks GitHub about acme\/bob-api every 2 minutes with gh\. When a workflow run failed/);
    expect(eventSentence({ kind: 'uptime', url: 'https://example.com', minutes: 15, expect: 204 })).toMatch(/^Beluga opens example\.com every 15 minutes and expects 204 within 10 seconds\. Two misses in a row/);
    expect(eventSentence({ kind: 'sentry', org: '', project: '', what: 'spike' })).toMatch(/^Say which Sentry organization and project/);
    expect(eventSentence({ kind: 'webhook', signature: 'github' })).toMatch(/it’s live while this sentinel is on/);
    expect(eventSentence({ kind: 'beluga', what: 'pr-opened' })).toMatch(/never start it again/);
    expect(eventSentence({ kind: 'schedule', every: 'day', at: '07:00', missed: 'skip' })).toBeUndefined();
  });

  it('puts a trigger’s trouble on its row (the alert mark), never on a paused one', () => {
    const gh = sentinel({ id: 'sn_gh', name: 'Fix what broke', projectId: 'api', trigger: { kind: 'github', what: 'workflow-failed' } });
    const hook = sentinel({ id: 'sn_hook', name: 'Pushes', trigger: { kind: 'webhook' } });
    const st = state({ items: [gh, hook], troubles: { sn_gh: 'Sign in to GitHub first: run gh auth login in a terminal' } });
    expect(rowOf(st, gh, NOW).trouble).toBe('Sign in to GitHub first: run gh auth login in a terminal');
    expect(rowOf(st, { ...gh, paused: true }, NOW).trouble).toBeUndefined();
    // The tunnel: opening isn't trouble; one that didn't open is, for the webhooks that are on.
    expect(troubleOf({ webhook: { ready: false } }, hook)).toBeUndefined();
    expect(troubleOf({ webhook: { ready: false, why: 'The tunnel didn’t open' } }, hook)).toBe('The tunnel didn’t open');
    expect(troubleOf({ webhook: { ready: false, why: 'The tunnel didn’t open' } }, gh)).toBeUndefined();
    expect(rowOf(state({ items: [hook] }), hook, NOW).trouble).toBeUndefined();
  });

  it('takes any whole http(s) address to check: localhost and ports too', () => {
    for (const ok of ['http://localhost:3000/health', 'https://example.com', 'https://api.example.com/v1/health?deep=1', 'http://127.0.0.1:8080', 'http://intranet/status']) expect(looksLikeUrl(ok), ok).toBe(true);
    for (const bad of ['', 'example.com', 'ftp://example.com', 'file:///etc/hosts', 'https://', 'http://exa mple.com', 'javascript:alert(1)']) expect(looksLikeUrl(bad), bad).toBe(false);
    expect(iconOf('link')).toBe('link');
  });
});
