import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SENTINEL_TOOL_NAMES, createSentinelToolDefs } from '../src/agent/sentinel-tools.js';
import { decideTool } from '../src/agent/policy.js';
import { attachSentinel } from '../src/core/sentinel/registry.js';
import { RECIPES } from '../src/core/sentinel/recipes.js';
import { accessAllows, scheduleSentence } from '../src/core/sentinel/model.js';
import { SentinelDraftSchema } from '../src/core/sentinel/schema.js';
import type { Session } from '../src/core/session.js';
import { API, parseArgs } from '../src/ipc/api.js';
import { SENTINEL_HANDLERS } from '../src/ipc/sentinel-handlers.js';
import { PHONE } from '../src/companion/coverage.js';
import { brief, setup, until } from './sentinel-fakes.js';

/** Claude's beluga_sentinel tools, the API's sentinel.* methods, and the recipes. */

type Handler = (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const call = (defs: ReturnType<typeof createSentinelToolDefs>, name: string, args: unknown) => (defs.find((d) => d.name === name)!.handler as Handler)(args, {});

describe('beluga_sentinel', () => {
  it('your own runs get the tools, never asking; sentinel_stop only inside a run', async () => {
    const s = setup();
    const outside = createSentinelToolDefs(s.sentinels.forRun('ws:else', 'p-me')!.tools);
    expect(outside.map((d) => `mcp__beluga_sentinel__${d.name}`)).toEqual(SENTINEL_TOOL_NAMES.slice(1));
    // Deleting one, or its runs (BLG-577), asks you (the approval gate); everything else never asks.
    for (const name of SENTINEL_TOOL_NAMES) expect(decideTool(name, {}, { cwd: '/tmp', roots: [], autoEdit: false })).toBe(name.endsWith('sentinel_remove') || name.endsWith('sentinel_delete_runs') ? 'ask' : 'allow');
    // A friend's runs get nothing.
    expect(s.sentinels.forRun('ws:else', 'p-friend')).toBeUndefined();

    const run = s.sentinels.start(s.sentinels.create(brief).id, 'you');
    await until(() => s.asked.length === 1);
    const inside = createSentinelToolDefs(s.sentinels.forRun(s.asked[0]!.channel, 'p-me')!.tools);
    expect(inside.map((d) => `mcp__beluga_sentinel__${d.name}`)).toEqual(SENTINEL_TOOL_NAMES);
    expect((await call(inside, 'sentinel_stop', { reason: 'nothing new' })).content[0]!.text).toMatch(/^Noted/);
    s.asked[0]!.answer('Nothing new.');
    await until(() => s.sentinels.runGet(run.id).run.state === 'skipped');
  });

  it('sentinel_create sets one up, paused, its project by name, and links it', async () => {
    const s = setup();
    const defs = createSentinelToolDefs(s.sentinels.forRun('ws:else', 'p-me')!.tools);
    const res = await call(defs, 'sentinel_create', {
      name: 'Issues to tasks',
      project: 'bob-api',
      trigger: { kind: 'schedule', every: 'week', at: '08:00', days: [1, 2, 3, 4, 5], missed: 'catch-up' },
      steps: [{ kind: 'claude', name: 'Triage', where: 'project', prompt: 'Read new issues and make tasks' }, { kind: 'notify', name: 'Tell me' }],
    });
    const made = s.sentinels.list()[0]!;
    expect(res.content[0]!.text).toBe(`Made “Issues to tasks” (Every weekday at 8:00), paused: \`sentinel:${made.id}\`. Its steps: Triage (step ${made.steps[0]!.id}), Tell me (step ${made.steps[1]!.id}). It runs once the user turns it on from its page (you can’t).`);
    expect(made).toMatchObject({ projectId: 'api', paused: true, access: 'look', steps: [{ kind: 'claude', name: 'Triage' }, { kind: 'notify', phone: false }] });
    const bad = await call(defs, 'sentinel_create', { name: 'X', project: 'nope', trigger: { kind: 'manual' }, steps: [{ kind: 'notify', name: 'n' }] });
    expect(bad).toMatchObject({ isError: true, content: [{ text: "There's no project nope" }] });
  });

  it('sentinel_create and sentinel_update take every few minutes; a frequent agent step comes with a word about the plan', async () => {
    const s = setup();
    const defs = createSentinelToolDefs(s.sentinels.forRun('ws:else', 'p-me')!.tools);
    const every = (minutes: number) => ({ kind: 'schedule', every: 'minutes', minutes, at: '00:00', missed: 'skip' });
    const stars = await call(defs, 'sentinel_create', { name: 'Stars', trigger: every(30), steps: [{ kind: 'notify', name: 'Tell me' }] });
    expect(stars.content[0]!.text).toMatch(/^Made “Stars” \(Every 30 minutes\), paused/);
    expect(stars.content[0]!.text).not.toMatch(/Tell the user/);
    expect(s.sentinels.list()[0]!.trigger).toEqual(every(30));
    const triage = await call(defs, 'sentinel_create', { name: 'Triage', trigger: every(15), steps: [{ kind: 'claude', name: 'Look', where: 'project', prompt: 'Look' }] });
    expect(triage.content[0]!.text).toMatch(/Tell the user: Its agent step runs up to 96 times a day/);
    const changed = await call(defs, 'sentinel_update', { id: 'Triage', limits: { perDay: 6 } });
    expect(changed.content[0]!.text).not.toMatch(/Tell the user/);
    // Only 5, 10, 15 or 30: the tool's schema says no to anything else.
    const shape = z.object(defs.find((d) => d.name === 'sentinel_create')!.inputSchema);
    const draft = (minutes: number) => ({ name: 'Odd', trigger: every(minutes), steps: [{ kind: 'notify', name: 'n' }] });
    for (const ok of [1, 5, 10, 15, 30]) expect(shape.safeParse(draft(ok)).success).toBe(true);
    for (const no of [0, 2, 7, 60]) expect(shape.safeParse(draft(no)).success).toBe(false);
    expect(SentinelDraftSchema.safeParse({ name: 'Odd', trigger: every(7) }).success).toBe(false);
    expect(SentinelDraftSchema.safeParse({ name: 'Ok', trigger: every(10) }).success).toBe(true);
  });

  it('sentinel_list, sentinel_pause and sentinel_run', async () => {
    const s = setup({ reply: () => 'Done it' });
    const made = s.sentinels.create(brief);
    const defs = createSentinelToolDefs(s.sentinels.forRun('ws:else', 'p-me')!.tools);
    expect((await call(defs, 'sentinel_list', {})).content[0]!.text).toBe(`Morning brief · Every day at 7:00 · paused · Look · \`sentinel:${made.id}\``);
    // Claude can't run a paused one, nor turn it on: sentinel_pause is pause-only (paused: false does nothing).
    expect(await call(defs, 'sentinel_run', { id: 'Morning brief' })).toMatchObject({ isError: true });
    expect((await call(defs, 'sentinel_pause', { id: made.id, paused: false })).content[0]!.text).toBe('“Morning brief” is paused already; only the user can turn it on, from its page');
    expect(s.sentinels.need(made.id).paused).toBe(true);
    // The user turns it on; then Claude may run it, and pause it.
    s.sentinels.pause(made.id, false);
    expect((await call(defs, 'sentinel_run', { id: 'morning brief' })).content[0]!.text).toBe(`Started “Morning brief” (\`sentinel:${made.id}\`)`);
    await until(() => s.sentinels.runsOf(made.id)[0]?.state === 'done');
    expect(s.sentinels.runsOf(made.id)[0]).toMatchObject({ by: 'claude', trigger: { summary: 'Your Claude ran it' } });
    expect((await call(defs, 'sentinel_list', {})).content[0]!.text).toContain('last run done: Done it');
    expect((await call(defs, 'sentinel_pause', { id: made.id })).content[0]!.text).toBe('“Morning brief” is paused; the user can turn it back on from its page');
    expect(s.sentinels.need(made.id).paused).toBe(true);
  });

  it('sentinel_pause takes only the sentinel; sentinel_create says it’s made paused', () => {
    const s = setup();
    const defs = createSentinelToolDefs(s.sentinels.forRun('ws:else', 'p-me')!.tools);
    const pause = defs.find((d) => d.name === 'sentinel_pause')!;
    expect(Object.keys(pause.inputSchema)).toEqual(['id']);
    expect(pause.description).toMatch(/never turn one on/);
    expect(defs.find((d) => d.name === 'sentinel_create')!.description).toMatch(/always made paused/);
  });

  it('tasks the run’s Claude makes with its label go on the run', async () => {
    const s = setup();
    s.store.dispatch({ type: 'board_init', state: { enabled: true, issues: [], projects: {}, autoTasks: false } });
    const run = s.sentinels.start(s.sentinels.create(brief).id, 'you');
    await until(() => s.asked.length === 1);
    const issue = { id: 'i1', key: 'BOB-7', number: 7, projectId: 'api', title: 'Fix it', status: 'todo', priority: 'none', labels: ['sentinel:morning-brief'], blockedBy: [], related: [], rank: 0, brief: {}, revisions: [], worktrees: [], proof: [], activity: [], createdAt: Date.now() + 1, updatedAt: Date.now() + 1, origin: 'claude' };
    s.store.dispatch({ type: 'board_issue', issue: issue as never });
    await until(() => s.sentinels.runGet(run.id).run.tasks.length === 1);
    expect(s.sentinels.runGet(run.id).run.tasks).toEqual(['BOB-7']);
    s.asked[0]!.answer('1 task made');
  });
});

describe('the sentinel.* API', () => {
  it('works through the session; phase 3’s webhooks say so in words', async () => {
    const s = setup({ reply: () => 'ok' });
    const session = {} as Session;
    attachSentinel(session, s.sentinels);
    const made = SENTINEL_HANDLERS['sentinel.create'](session, ...parseArgs('sentinel.create', [{ name: 'From the API', projectId: 'api', steps: [{ kind: 'script', command: 'npm test' }] }]));
    expect(made).toMatchObject({ paused: true, steps: [{ kind: 'script', cwd: 'project', timeoutSec: 120, name: 'Run a script' }] });
    const updated = SENTINEL_HANDLERS['sentinel.update'](session, made.id, { name: 'Renamed', projectId: null });
    expect(updated.name).toBe('Renamed');
    expect(updated.projectId).toBeUndefined();
    const copy = SENTINEL_HANDLERS['sentinel.duplicate'](session, made.id);
    expect(copy).toMatchObject({ name: 'Renamed copy', paused: true });
    expect(SENTINEL_HANDLERS['sentinel.recipes'](session).map((r) => r.id)).toEqual(['morning-brief', 'fix-what-broke', 'fix-and-ship', 'nightly-tests', 'dependency-updates', 'release-notes', 'issues-to-tasks', 'uptime-guard', 'failed-payments', 'watch-the-web', 'fetch-analyse-send', 'review-new-prs', 'customers-this-week', 'youtube-subscribers', 'stripe-revenue', 'last-job-run', 'site-speed', 'open-issues-prs']);
    expect(SENTINEL_HANDLERS['sentinel.setRunAtOnce'](session, 3)).toBe(3);
    expect(() => (SENTINEL_HANDLERS['sentinel.rotateSecret'] as (s: Session, ...a: unknown[]) => unknown)(session, made.id)).toThrow('doesn’t start from a webhook');
    expect(() => (SENTINEL_HANDLERS['sentinel.webhookUrl'] as (s: Session, ...a: unknown[]) => unknown)(session, made.id)).toThrow('doesn’t start from a webhook');
    const run = SENTINEL_HANDLERS['sentinel.run'](session, made.id);
    expect(run.by).toBe('you');
    await until(() => SENTINEL_HANDLERS['sentinel.runGet'](session, run.id).run.state !== 'running');
    expect(SENTINEL_HANDLERS['sentinel.runs'](session, made.id)).toHaveLength(1);
    await expect(SENTINEL_HANDLERS['sentinel.decide'](session, run.id, 'merge')).rejects.toThrow('isn’t waiting for you');
    SENTINEL_HANDLERS['sentinel.remove'](session, made.id);
    expect(s.store.getState().sentinel.items.map((i) => i.id)).toEqual([copy.id]);
  });

  it('the phone may run, pause, read runs, list a chat’s schedules and decide; the rest is the Mac’s', () => {
    const methods = Object.keys(API).filter((m) => m.startsWith('sentinel.'));
    expect(methods.filter((m) => PHONE[m as keyof typeof PHONE] === 'phone').sort()).toEqual(['sentinel.dataList', 'sentinel.decide', 'sentinel.document', 'sentinel.documentOpen', 'sentinel.forChat', 'sentinel.metricRead', 'sentinel.pause', 'sentinel.run', 'sentinel.runFileOpen', 'sentinel.runGet', 'sentinel.runRow', 'sentinel.runs', 'sentinel.signStorage', 'sentinel.storageOpen']);
  });
});

describe('recipes', () => {
  it('each is a sentinel the API takes, with a real prompt', () => {
    for (const r of RECIPES) {
      expect(SentinelDraftSchema.safeParse(r.sentinel).success).toBe(true);
      for (const st of r.sentinel.steps ?? []) if (st.kind === 'claude') expect(st.prompt.length).toBeGreaterThan(120);
    }
    const s = setup();
    for (const r of RECIPES) expect(s.sentinels.create({ ...r.sentinel, projectId: 'api' })).toMatchObject({ recipe: r.id, paused: true });
  });

  it('are the design’s twelve and six for numbers, each with what its steps need, and the second sentinel runs after the first', () => {
    expect(RECIPES).toHaveLength(18);
    expect(RECIPES.filter((r) => r.group === 'numbers').map((r) => r.id)).toEqual(['customers-this-week', 'youtube-subscribers', 'stripe-revenue', 'last-job-run', 'site-speed', 'open-issues-prs']);
    for (const r of RECIPES) {
      const steps = r.sentinel.steps ?? [];
      // Every recipe ends by telling you (one for numbers, by keeping them), and what it does fits the access it asks for.
      expect(steps.at(-1)?.kind).toBe(r.group === 'numbers' ? 'measure' : 'notify');
      for (const st of steps) expect(accessAllows(r.sentinel.access ?? 'look', st.kind, st.kind === 'claude' ? st.where : undefined)).toBe(true);
      // A pull request needs the worktree a Claude step before it made.
      const pr = steps.findIndex((st) => st.kind === 'pr');
      if (pr >= 0) expect(steps.slice(0, pr).some((st) => st.kind === 'claude' && st.where === 'worktree')).toBe(true);
      // Material from outside is never instructions.
      for (const st of steps) if (st.kind === 'claude' && /\{\{(trigger\.json|previous)\}\}/.test(st.prompt)) expect(st.prompt).toMatch(/material/);
    }
    expect(RECIPES.find((r) => r.id === 'fix-and-ship')?.sentinel.steps?.find((st) => st.kind === 'merge')).toMatchObject({ require: { checks: true, approval: true } });
    // Groqbot's address stays a placeholder until its API is settled.
    expect(RECIPES.find((r) => r.id === 'watch-the-web')?.sentinel.steps?.[0]).toMatchObject({ kind: 'http', preset: 'groqbot', url: '' });
    const nightly = RECIPES.find((r) => r.id === 'nightly-tests')!;
    expect(nightly.then?.on).toBe('failure');
    const s = setup();
    const first = s.sentinels.create({ ...nightly.sentinel, projectId: 'api' });
    const fixer = s.sentinels.create({ ...nightly.then!.sentinel, projectId: 'api', trigger: { kind: 'after', sentinelId: first.id, on: 'failure' } });
    expect(scheduleSentence(fixer.trigger, (id) => s.sentinels.get(id)?.name)).toBe('After “Nightly tests” fails');
  });
});

describe('the demo', () => {
  it('seeds eleven sentinels with their history, five of them keeping numbers on three dashboards (Overview with every kind of tile), and the Sentinel chat', async () => {
    const { demoGitHub, seedDemoSentinel } = await import('../src/core/sentinel/demo.js');
    const s = setup({ github: demoGitHub() });
    let back = 0;
    seedDemoSentinel(s.store, s.sentinels, (ms) => (back = ms))();
    expect(back).toBe(0);
    const st = s.store.getState().sentinel;
    expect(st.items.map((i) => [i.name, i.paused])).toEqual([
      ['Morning brief', false],
      ['Fix what broke', false],
      ['Nightly tests', true],
      ['Watch the web', false],
      ['Uptime guard', false],
      ['GitHub pushes', false],
      ['Stripe revenue', false],
      ['YouTube subscribers', false],
      ['Site speed', false],
      ['Last job run', true],
      ['Signups by day', false],
    ]);
    // A week of numbers, and the dashboards made by hand (none made for you).
    const revenue = st.metrics![st.items[6]!.id]!.revenue!;
    expect(revenue.points.map((p) => p.value)).toEqual([2810, 3020, 2950, 3240, 3105, 3390, 3180, 3412]);
    expect(revenue.points.at(-1)!.runId).toBe(st.runs.filter((r) => r.sentinelId === st.items[6]!.id).at(-1)!.id);
    expect(st.metrics![st.items[8]!.id]!.home!.points).toHaveLength(57);
    expect(st.metrics![st.items[9]!.id]!['last-jobs']!.rows).toHaveLength(6);
    expect(st.dashboards!.map((d) => [d.name, d.tiles.length])).toEqual([
      ['Overview', 14],
      ['Revenue', 11],
      ['Ops', 4],
    ]);
    // Overview shows every kind of tile; its outputs are the Morning brief's Claude step (Markdown) and YouTube's answer (JSON).
    const overview = st.dashboards![0]!;
    expect([...new Set(overview.tiles.map((t) => t.kind))].sort()).toEqual(['divider', 'number', 'output', 'series', 'table', 'text']);
    const outputs = overview.tiles.filter((t) => t.kind === 'output').map((t) => st.outputs?.[t.step!.sentinelId]?.[t.step!.stepId]);
    expect(outputs.map((o) => o?.format)).toEqual(['markdown', 'json']);
    expect(outputs[1]!.text).toContain('"subscriberCount": "12304"');
    const signups = st.metrics![st.items[10]!.id]!['signups-by-day']!;
    expect(signups).toMatchObject({ kind: 'series', label: 'Signups by day' });
    expect(signups.series).toHaveLength(14);
    // The Sentinel chat starts with a short exchange.
    const chat = s.store.getState().log.filter((l) => l.channel === 'sentinel-chat:main');
    expect(chat.map((l) => l.type)).toEqual(['chat', 'agent']);
    // Uptime guard went down and came back: a pair of runs, by the event, in that order.
    const guard = st.items[4]!;
    expect(st.runs.filter((r) => r.sentinelId === guard.id).map((r) => [r.by, r.trigger.summary])).toEqual([
      ['event', 'landing.example.com stopped answering (503)'],
      ['event', 'landing.example.com is back (200, 284 ms)'],
    ]);
    expect(st.items[2]!.pausedWhy).toBe('Paused after 3 failures in a row');
    const brief = st.items[0]!;
    expect(st.runs.filter((r) => r.sentinelId === brief.id)).toHaveLength(7);
    const waiting = st.runs.find((r) => r.state === 'needs-you')!;
    expect(waiting).toMatchObject({ headline: 'Merge the fix for #48?', pr: { number: 53 } });
    expect(Object.values(st.live).map((l) => l.state).sort()).toEqual(['needs-you', 'running']);
    expect(s.sentinels.runGet(st.runs.find((r) => r.sentinelId === brief.id && r.state === 'done')!.id).report).toMatch(/\n\n- /);
    // Merge on the demo's waiting run goes through the real decide path (the demo's GitHub merges it).
    await expect(s.sentinels.decide(waiting.id, 'merge')).resolves.toMatchObject({ state: 'done', headline: 'Merged #53' });
    expect(s.store.getState().sentinel.runs.find((r) => r.id === waiting.id)!.steps.map((st) => st.state)).toEqual(['done', 'done', 'done', 'skipped']);
    await expect(s.sentinels.decide(waiting.id, 'merge')).rejects.toThrow('isn’t waiting for you');
  });
});
