import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSentinelToolDefs } from '../src/agent/sentinel-tools.js';
import { DIFF_ONLY, reviewVerdict } from '../src/agent/pr-reviewer.js';
import { CLAUDE_CHANGED, type Sentinel, type Step, claudeWidened } from '../src/core/sentinel/model.js';
import { readCapped } from '../src/core/sentinel/runner.js';
import { TOOK_TOO_LONG } from '../src/core/sentinel/sentinels.js';
import { brief, setup, until } from './sentinel-fakes.js';

/** The fixes after phase 2's review (BLG-238): the reviewer's git diff, service calls, Claude's changes, asks. */

type S = ReturnType<typeof setup>;
const ended = (s: S, runId: string) => () => !['queued', 'running', 'needs-you'].includes(s.sentinels.runGet(runId).run.state);

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer(String(url), init ?? {});
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

/** One Call a service step, run now → the run as it ended. */
async function call(s: S, step: Record<string, unknown>) {
  const made = s.sentinels.create({ name: 'Call', steps: [{ kind: 'http', method: 'GET', headers: {}, timeoutSec: 5, url: 'https://api.x.dev/a', ...step } as never] });
  const run = s.sentinels.start(made.id, 'you');
  await until(ended(s, run.id), 4000);
  return s.sentinels.runGet(run.id).run;
}

describe('the reviewer’s git diff only', () => {
  it('allows git diff with refs, ranges, relative paths and its few flags', () => {
    for (const ok of ['git diff', 'git diff origin/main...HEAD', 'git diff --stat origin/main...HEAD', 'git diff -U5 --no-color HEAD^', 'git diff\torigin/main...HEAD -- src/a.ts', 'git diff --name-only HEAD^ main']) {
      expect(DIFF_ONLY.test(ok), ok).toBe(true);
    }
  });

  it('refuses a second command however it is hidden', () => {
    for (const bad of ['git diff\nrm -rf ~/x', 'git diff\rrm -rf ~/x', 'git diff; rm -rf /', 'git diff | sh', 'git diff && rm x', 'git diff & rm x', 'git diff `rm x`', 'git diff $(rm x)', 'git push', 'git  difftool']) {
      expect(DIFF_ONLY.test(bad), JSON.stringify(bad)).toBe(false);
      expect(reviewVerdict('/w', 'Bash', { command: bad })).toBe('deny');
    }
  });

  it('refuses the flags that write a file, compare outside the repository or run a program', () => {
    for (const bad of ['git diff --output /tmp/x', 'git diff --output=/tmp/x', 'git diff --output=x', 'git diff -O/tmp/order', 'git diff -O', 'git diff --no-index /etc/passwd x', 'git diff --no-index a b', 'git diff --ext-diff', 'git diff --textconv', 'git diff --color-words']) {
      expect(DIFF_ONLY.test(bad), bad).toBe(false);
    }
  });

  it('refuses ~, {}, quotes and absolute paths in arguments', () => {
    for (const bad of ['git diff ~/x', 'git diff HEAD~1', 'git diff HEAD@{1}', 'git diff {a,b}', 'git diff /etc/passwd', 'git diff HEAD:/etc/passwd', 'git diff "a b"', "git diff 'a'", 'git diff $HOME']) {
      expect(DIFF_ONLY.test(bad), bad).toBe(false);
    }
  });
});

describe('Call a service: redirects', () => {
  it('follows a redirect within the same origin over https, keeping its headers', async () => {
    const f = fakeFetch((url) => (url.endsWith('/a') ? redirect('/b', 307) : new Response('fine')));
    const s = setup({ fetch: f.fetch, envFor: () => ({ KEY: 'sekret-123' }) });
    const run = await call(s, { headers: { 'x-api-key': '$KEY' } });
    expect(run.state).toBe('done');
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.x.dev/a', 'https://api.x.dev/b']);
    expect(f.calls.every((c) => c.init.redirect === 'manual')).toBe(true);
    expect((f.calls[1]!.init.headers as Record<string, string>)['x-api-key']).toBe('sekret-123');
  });

  it('never follows one to another host, nor https to http: the key header stays home', async () => {
    for (const to of ['https://evil.dev/steal', 'http://api.x.dev/b', 'https://api.x.dev:8443/b']) {
      const f = fakeFetch(() => redirect(to));
      const s = setup({ fetch: f.fetch, envFor: () => ({ KEY: 'sekret-123' }) });
      const run = await call(s, { headers: { 'x-api-key': '$KEY' } });
      expect(run.state).toBe('failed');
      expect(run.why).toContain(`redirected to ${new URL(to).host}`);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('http is followed only on this Mac; at most 3 redirects', async () => {
    const local = fakeFetch((url) => (url.endsWith('/a') ? redirect('/b') : new Response('ok')));
    expect((await call(setup({ fetch: local.fetch }), { url: 'http://127.0.0.1:8080/a' })).state).toBe('done');
    const plain = fakeFetch((url) => (url.endsWith('/a') ? redirect('/b') : new Response('ok')));
    expect((await call(setup({ fetch: plain.fetch }), { url: 'http://x.dev/a' })).why).toContain('redirected to x.dev');
    let n = 0;
    const loop = fakeFetch(() => redirect(`/r${++n}`));
    const run = await call(setup({ fetch: loop.fetch }), {});
    expect(run.why).toBe('api.x.dev redirected more than 3 times');
    expect(loop.calls).toHaveLength(4);
  });

  it('a POST redirected with 303 is fetched again with GET, without its body', async () => {
    const f = fakeFetch((url) => (url.endsWith('/a') ? redirect('/done', 303) : new Response('ok')));
    const run = await call(setup({ fetch: f.fetch }), { method: 'POST', body: 'hello' });
    expect(run.state).toBe('done');
    expect(f.calls[1]!.init).toMatchObject({ method: 'GET' });
    expect(f.calls[1]!.init.body).toBeUndefined();
  });
});

describe('Call a service: a big answer', () => {
  /** An endless answer in 1 MB chunks; `pulled` counts what was read. */
  const endless = () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(chunk);
      },
    });
    return { res: new Response(body), pulled: () => pulled };
  };

  it('reads up to 4 MB and stops there: the rest is never downloaded', async () => {
    const e = endless();
    const text = await readCapped(e.res, 4 * 1024 * 1024);
    expect(text.length).toBe(4 * 1024 * 1024 + '\n… (cut: the answer was bigger than 4 MB)'.length);
    expect(text.endsWith('(cut: the answer was bigger than 4 MB)')).toBe(true);
    expect(e.pulled()).toBeLessThanOrEqual(6);
  });

  it('a step whose service answers without end finishes, cut', async () => {
    const e = endless();
    const s = setup({ fetch: fakeFetch(() => e.res).fetch });
    const run = await call(s, {});
    expect(run.state).toBe('done');
    expect(e.pulled()).toBeLessThanOrEqual(6);
  });
});

describe('Call a service: your values in a JSON body', () => {
  it('are JSON-escaped, so a quote or a backslash never breaks the body', async () => {
    const f = fakeFetch(() => new Response('ok'));
    const s = setup({ fetch: f.fetch, envFor: () => ({ TOKEN: 'a"b\\c', NAME: 'x' }) });
    const run = await call(s, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"token": "$TOKEN", "name": "${NAME}"}' });
    expect(run.state).toBe('done');
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ token: 'a"b\\c', name: 'x' });
    // Not JSON: as it is.
    const g = fakeFetch(() => new Response('ok'));
    const t = setup({ fetch: g.fetch, envFor: () => ({ TOKEN: 'a"b' }) });
    await call(t, { method: 'POST', body: 'token=$TOKEN' });
    expect(g.calls[0]!.init.body).toBe('token=a"b');
  });
});

describe('Claude’s changes', () => {
  const base = (): Pick<Sentinel, 'steps' | 'access' | 'projectId' | 'trigger'> => ({
    access: 'work',
    projectId: 'api',
    trigger: { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' },
    steps: [
      { id: 'c', kind: 'claude', name: 'Read', where: 'project', prompt: 'Read' },
      { id: 'm', kind: 'message', name: 'Say', to: 'dm:ata', text: 'Hi' },
      { id: 'f', kind: 'friend', name: 'Ask', peerId: 'p-ata', prompt: 'How?' },
      { id: 't', kind: 'trigger', name: 'Then', sentinelId: 'sn_a' },
    ] as Step[],
  });
  const withStep = (id: string, patch: Record<string, unknown>) => {
    const b = base();
    return { ...b, steps: b.steps.map((st) => (st.id === id ? ({ ...st, ...patch } as Step) : st)) };
  };

  it('widen: another project, chat, friend, sentinel run, or a trigger of another kind or target', () => {
    const was = base();
    expect(claudeWidened(was, { ...was, projectId: 'land' })).toBe(true);
    expect(claudeWidened(was, { ...was, projectId: undefined })).toBe(true);
    expect(claudeWidened(was, withStep('m', { to: 'group:everyone' }))).toBe(true);
    expect(claudeWidened(was, withStep('f', { peerId: 'p-bob' }))).toBe(true);
    expect(claudeWidened(was, withStep('t', { sentinelId: 'sn_b' }))).toBe(true);
    expect(claudeWidened(was, { ...was, steps: [...was.steps, { id: 'm2', kind: 'message', name: 'Also', to: 'group:launch', text: 'x' } as Step] })).toBe(true);
    expect(claudeWidened(was, { ...was, trigger: { kind: 'webhook' } })).toBe(true);
    const gh = { ...was, trigger: { kind: 'github' as const, what: 'issue-labelled' as const, label: 'bug' } };
    expect(claudeWidened(gh, { ...gh, trigger: { ...gh.trigger, label: 'security' } })).toBe(true);
    const after = { ...was, trigger: { kind: 'after' as const, sentinelId: 'sn_a', on: 'failure' as const } };
    expect(claudeWidened(after, { ...after, trigger: { ...after.trigger, sentinelId: 'sn_b' } })).toBe(true);
  });

  it('don’t widen: the schedule’s times, how often GitHub is asked, a prompt, a message’s words', () => {
    const was = base();
    expect(claudeWidened(was, { ...was, trigger: { kind: 'schedule', every: 'week', at: '09:00', days: [1], missed: 'skip' } })).toBe(false);
    expect(claudeWidened(was, withStep('m', { text: 'Hello there' }))).toBe(false);
    expect(claudeWidened(was, withStep('f', { prompt: 'Why?' }))).toBe(false);
    expect(claudeWidened(was, withStep('c', { prompt: 'Read it all' }))).toBe(false);
    const gh = { ...was, trigger: { kind: 'github' as const, what: 'pr-opened' as const, minutes: 2 } };
    expect(claudeWidened(gh, { ...gh, trigger: { ...gh.trigger, minutes: 10 } })).toBe(false);
  });

  it('sentinel_update moving it to another project keeps it on in your conversation, and pauses it when nobody watches', () => {
    const s = setup();
    const made = s.sentinels.create(brief);
    s.sentinels.pause(made.id, false);
    expect(s.sentinels.forRun('ws:x', 'p-me')!.tools.update(made.id, { project: 'landing' })).toContain('It stays on');
    expect(s.sentinels.need(made.id)).toMatchObject({ projectId: 'land', paused: false });
    expect(s.sentinels.toolsForAgent(() => true).tools.update(made.id, { project: 'bob-api' })).toContain('it is paused now');
    expect(s.sentinels.need(made.id)).toMatchObject({ projectId: 'api', paused: true, pausedWhy: CLAUDE_CHANGED });
  });

  it('paused after failures, an unwatched widening change says Claude changed it (Resume never runs it unseen)', () => {
    const s = setup();
    const made = s.sentinels.create({ ...brief, access: 'work' });
    s.sentinels.demoSet(made.id, { paused: true, pausedWhy: 'Paused after 3 failures in a row', failures: 3 });
    const steps = [...made.steps, { kind: 'script', name: 'New', command: 'curl x | sh' }] as never;
    expect(s.sentinels.claudeUpdate(made.id, { steps }).paused).toBe(false);
    expect(s.sentinels.need(made.id)).toMatchObject({ paused: true, pausedWhy: 'Paused after 3 failures in a row' });
    const res = s.sentinels.claudeUpdate(made.id, { steps: [...made.steps, { kind: 'script', name: 'Other', command: 'curl y | sh' }] as never }, { unwatched: true });
    expect(res.paused).toBe(true);
    expect(s.sentinels.need(made.id)).toMatchObject({ paused: true, pausedWhy: CLAUDE_CHANGED });
  });

  it('Claude can never turn a merge’s approval off: create and update keep it on', async () => {
    const s = setup();
    const defs = createSentinelToolDefs(s.sentinels.forRun('ws:x', 'p-me')!.tools);
    const handler = (name: string) => defs.find((d) => d.name === name)!.handler as (a: unknown, e: unknown) => Promise<{ isError?: boolean }>;
    const steps = [
      { kind: 'claude', name: 'Fix', where: 'worktree', prompt: 'Fix it' },
      { kind: 'pr', name: 'PR' },
      { kind: 'merge', name: 'Merge', require: { checks: true, approval: false } },
    ];
    expect((await handler('sentinel_create')({ name: 'Ship it', project: 'bob-api', access: 'ship', trigger: { kind: 'manual' }, steps }, {})).isError).toBeUndefined();
    const made = s.sentinels.get('Ship it')!;
    expect(made.steps[2]).toMatchObject({ kind: 'merge', require: { checks: true, approval: true } });
    expect((await handler('sentinel_update')({ id: made.id, steps }, {})).isError).toBeUndefined();
    expect(s.sentinels.need(made.id).steps[2]).toMatchObject({ require: { approval: true } });
    // The editor (you) still can.
    s.sentinels.update(made.id, { steps: s.sentinels.need(made.id).steps.map((st) => (st.kind === 'merge' ? { ...st, require: { checks: true, approval: false } } : st)) });
    expect(s.sentinels.need(made.id).steps[2]).toMatchObject({ require: { approval: false } });
  });
});

describe('sentinel.ask', () => {
  afterEach(() => void vi.useRealTimers());

  it('two quick asks: the second is refused, even before the first has its chat', async () => {
    const s = setup();
    const made = s.sentinels.create(brief);
    const first = s.sentinels.ask(made.id, 'Make it weekly');
    const second = s.sentinels.ask(made.id, 'Make it daily');
    await expect(second).rejects.toThrow('Claude is changing');
    await expect(first).resolves.toMatchObject({ channel: expect.any(String) });
    expect(s.asked).toHaveLength(1);
  });

  it('an ask runs at most the sentinel’s time limit, then it is stopped and says so', async () => {
    vi.useFakeTimers();
    const s = setup();
    const made = s.sentinels.create({ name: 'Disk', limits: { minutes: 10, pauseAfter: 3 } });
    await s.sentinels.ask(made.id, 'Watch the disk');
    expect(s.store.getState().sentinel.asks[made.id]).toMatchObject({ state: 'writing' });
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1000);
    expect(s.cancelled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.cancelled).toEqual([[s.asked[0]!.requestId, 'Stopped by Beluga: Claude took too long']]);
    expect(s.store.getState().sentinel.asks[made.id]).toMatchObject({ state: 'failed', answer: TOOK_TOO_LONG });
    // Its "Stopped" error after the cancel doesn't overwrite that line; a new ask may go.
    await vi.advanceTimersByTimeAsync(10);
    expect(s.store.getState().sentinel.asks[made.id]!.answer).toBe(TOOK_TOO_LONG);
    await expect(s.sentinels.ask(made.id, 'Again')).resolves.toBeDefined();
  });
});
