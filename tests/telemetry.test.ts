import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { Store, initialState } from '../src/core/store.js';
import { ASK_ROUND, LATER_MERGES, LATER_MS, type TelemetryRecord, answerAsk, askDue, chooseLevel, effectiveLevel, excludeProject, projectOfFolder, telemetryView } from '../src/core/telemetry-store.js';
import { ClaudeOtel } from '../src/telemetry/claude-otel.js';
import { releaseConfig } from '../src/telemetry/config.js';
import { Exporter } from '../src/telemetry/exporter.js';
import { featureCounter } from '../src/telemetry/features.js';
import { Masker, REDACTED, secretWorthy } from '../src/telemetry/mask.js';
import { observedBackend } from '../src/telemetry/observe.js';
import { event, pseudonym } from '../src/telemetry/otlp.js';
import { loadTelemetryRecord, saveTelemetryRecord } from '../src/telemetry/record.js';
import { TelemetryService } from '../src/telemetry/service.js';
import { type TurnFacts, turnSpans } from '../src/telemetry/turn.js';
import { parseArgs } from '../src/ipc/api.js';

/** Usage statistics: the choice and the ask, masking, the spans Ratel reads, sending, and what a run tells it. */

const ID = '7b0c9a52-2d1e-4f5b-9a3c-1e2f3a4b5c6d';
const ctx = (over: Partial<{ available: boolean; merges: number; now: number }> = {}) => ({ available: true, merges: 0, now: 1_000_000, ...over });
const attr = (span: { attributes: Array<{ key: string; value: Record<string, unknown> }> }, key: string) => span.attributes.find((a) => a.key === key)?.value;

describe('the choice and the ask', () => {
  const fresh: TelemetryRecord = { installId: ID };

  it('nothing is sent before a choice, nor from a build that cannot send', () => {
    expect(effectiveLevel(telemetryView(fresh, ctx()))).toBe('off');
    expect(effectiveLevel(telemetryView(chooseLevel(fresh, 'on', 'settings', 1), ctx({ available: false })))).toBe('off');
    expect(effectiveLevel(telemetryView(chooseLevel(fresh, 'limited', 'onboarding', 1), ctx()))).toBe('limited');
  });

  it('asks an install that updated, never one that chose in the onboarding or in Settings', () => {
    expect(askDue(fresh, ctx())).toBe(true);
    expect(askDue(chooseLevel(fresh, 'limited', 'onboarding', 1), ctx())).toBe(false);
    expect(askDue(chooseLevel(fresh, 'off', 'settings', 1), ctx())).toBe(false);
    expect(askDue(fresh, ctx({ available: false }))).toBe(false);
  });

  it('Share keeps the level chosen, No thanks turns it off and never asks again', () => {
    const shared = answerAsk(fresh, 'share', 'on', { merges: 2, now: 5 });
    expect(shared.level).toBe('on');
    expect(askDue(shared, ctx({ now: 10 ** 12, merges: 99 }))).toBe(false);
    const no = answerAsk(fresh, 'never', 'limited', { merges: 2, now: 5 });
    expect(no.level).toBe('off');
    expect(askDue(no, ctx({ now: 10 ** 12, merges: 99 }))).toBe(false);
  });

  it('Later asks again after a few days or a few merges, whichever comes first', () => {
    const later = answerAsk(fresh, 'later', 'limited', { merges: 3, now: 1_000 });
    expect(later.level).toBeUndefined();
    expect(askDue(later, ctx({ now: 1_000 + LATER_MS - 1, merges: 3 + LATER_MERGES - 1 }))).toBe(false);
    expect(askDue(later, ctx({ now: 1_000 + LATER_MS, merges: 3 }))).toBe(true);
    expect(askDue(later, ctx({ now: 1_001, merges: 3 + LATER_MERGES }))).toBe(true);
    expect(later.ask?.times).toBe(1);
    expect(answerAsk(later, 'later', 'limited', { merges: 3, now: 2 }).ask?.times).toBe(2);
  });

  it('a level chosen in Settings after Later settles the ask (Off as No thanks)', () => {
    const later = answerAsk(fresh, 'later', 'limited', { merges: 0, now: 0 });
    for (const level of ['off', 'on'] as const) {
      const chosen = chooseLevel(later, level, 'settings', 1);
      expect(askDue(chosen, ctx({ now: 10 ** 12, merges: 99 }))).toBe(false);
    }
    expect(chooseLevel(later, 'off', 'settings', 1).ask?.answer).toBe('never');
  });

  it('a new round asks Later and never-answered again, not No thanks', () => {
    const old = (answer: 'later' | 'never'): TelemetryRecord => ({ installId: ID, ...(answer === 'never' ? { level: 'off' as const } : {}), ask: { round: ASK_ROUND - 1, answer, at: 999_999, merges: 0, times: 1 } });
    expect(askDue(old('later'), ctx())).toBe(true);
    expect(askDue(old('never'), ctx())).toBe(false);
  });

  it('keeps the record in telemetry.json, and makes a fresh id when there is none', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'telemetry-'));
    const file = path.join(dir, 'telemetry.json');
    const first = loadTelemetryRecord(file);
    expect(first.fresh).toBe(true);
    saveTelemetryRecord(chooseLevel(first.record, 'on', 'settings', 7), file);
    const again = loadTelemetryRecord(file);
    expect(again.fresh).toBe(false);
    expect(again.record).toMatchObject({ installId: first.record.installId, level: 'on', via: 'settings' });
    expect(JSON.parse(readFileSync(file, 'utf8')).installId).toBe(first.record.installId);
  });

  it('only screens choose: the API checks the levels and the places', () => {
    expect(() => parseArgs('telemetry.choose', ['loud', 'settings'])).toThrow();
    expect(() => parseArgs('telemetry.choose', ['on', 'ask'])).toThrow();
    expect(() => parseArgs('telemetry.mark', ['anything', undefined])).toThrow();
    expect(() => parseArgs('telemetry.mark', ['preview_opened', undefined])).toThrow();
    expect(parseArgs('telemetry.answer', ['later', 'limited'])).toEqual(['later', 'limited']);
  });
});

describe('leaving a project out', () => {
  const projects = [
    { root: '/code/app', workspaces: [{ path: '/Users/k/.beluga/workspaces/app-1/fix-login' }] },
    { root: '/code/app-admin', workspaces: [] },
  ];

  it('finds a folder\'s project: its main folder, a worktree, a folder inside; never a neighbour with the same start', () => {
    expect(projectOfFolder(projects, '/code/app')).toBe('/code/app');
    expect(projectOfFolder(projects, '/code/app/src')).toBe('/code/app');
    expect(projectOfFolder(projects, '/Users/k/.beluga/workspaces/app-1/fix-login')).toBe('/code/app');
    expect(projectOfFolder(projects, '/code/app-admin')).toBe('/code/app-admin');
    expect(projectOfFolder(projects, '/elsewhere')).toBeUndefined();
  });

  it('keeps the list as you change it, and keeps it when the level changes', () => {
    const fresh: TelemetryRecord = { installId: ID };
    const out = excludeProject(excludeProject(fresh, '/code/app', true), '/code/b', true);
    expect(out.excluded).toEqual(['/code/app', '/code/b']);
    expect(excludeProject(out, '/code/app', false).excluded).toEqual(['/code/b']);
    expect(excludeProject(excludeProject(out, '/code/app', false), '/code/b', false).excluded).toBeUndefined();
    expect(chooseLevel(out, 'on', 'settings', 1).excluded).toEqual(['/code/app', '/code/b']);
    expect(telemetryView(out, ctx()).excluded).toEqual(['/code/app', '/code/b']);
  });

  it('a run in a project left out sends nothing and gets no telemetry settings; others still do', async () => {
    const s = new Store(initialState('test', 'ask'));
    s.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'app', root: '/code/app', base: 'origin/main', workspaces: [] }, { id: 'p2', name: 'b', root: '/code/b', base: 'origin/main', workspaces: [] }] as never });
    const service = new TelemetryService({ store: s, version: '1', file: null, secrets: () => [], config: { url: 'https://ratel.example', key: 'rtl_pub_xxxxxxxx' }, fetch: (async () => new Response('', { status: 202 })) as unknown as typeof fetch });
    service.choose('limited', 'settings');
    service.exclude('/code/app', true);
    expect(s.getState().telemetry.excluded).toEqual(['/code/app']);
    const facts: TurnFacts[] = [];
    const deps = { ...service.observeDeps(), turn: (f: TurnFacts) => facts.push(f), env: () => ({ CLAUDE_CODE_ENABLE_TELEMETRY: '1' }) };
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const inner = { run: async (i: AgentRunInput) => (seen.push(i.env), 'ok') } as unknown as AgentBackend;
    const place = (cwd: string) => ({ cwd, additionalDirectories: [], autoEdit: true, onSession: () => undefined }) as unknown as AgentRunInput['place'];
    const run = (cwd: string) => observedBackend(inner, 'claude', deps).run({ prompt: 'x', requesterName: 'k', viaAgent: false, context: [], scope: 'folder', onEvent: () => undefined, onFileTouched: () => undefined, place: place(cwd) } as unknown as AgentRunInput);
    await run('/code/app/src');
    await run('/code/b');
    expect(facts).toHaveLength(1);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toEqual({ CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
    service.exclude('/code/app', false);
    await run('/code/app');
    expect(facts).toHaveLength(2);
    await service.stop();
  });

  it('only screens leave a project out (the API checks it)', () => {
    expect(parseArgs('telemetry.exclude', ['/code/app', true])).toEqual(['/code/app', true]);
    expect(() => parseArgs('telemetry.exclude', ['', true])).toThrow();
  });
});

describe('the release config', () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];

  it('comes from the release (or the environment), https only', () => {
    expect(releaseConfig(env({}))).toBeUndefined();
    expect(releaseConfig(env({ TELEMETRY_URL: 'https://ratel.example/', TELEMETRY_KEY: 'rtl_pub_abcdef123456' }))).toEqual({ url: 'https://ratel.example', key: 'rtl_pub_abcdef123456' });
    expect(releaseConfig(env({ TELEMETRY_URL: 'http://ratel.example', TELEMETRY_KEY: 'rtl_pub_abcdef123456' }))).toBeUndefined();
    expect(releaseConfig(env({ TELEMETRY_URL: 'http://127.0.0.1:4318', TELEMETRY_KEY: 'rtl_pub_abcdef123456' }))?.url).toBe('http://127.0.0.1:4318');
  });

  it('BELUGA_TELEMETRY=0 turns it off whatever else says', () => {
    expect(releaseConfig(env({ TELEMETRY: '0', TELEMETRY_URL: 'https://ratel.example', TELEMETRY_KEY: 'rtl_pub_abcdef123456' }))).toBeUndefined();
  });
});

describe('masking', () => {
  const home = '/Users/someone';
  const masker = new Masker(home);
  masker.setSecrets(['s3cr3t-db-pass-91', 'production', 'true', '3000', 'postgres://admin:hunter2pass@db.internal:5432/app']);

  it('takes out every kind of secret a conversation carries (the canary)', () => {
    const text = [
      'my db is postgres://admin:hunter2pass@db.internal:5432/app and the pass is s3cr3t-db-pass-91',
      'ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'openai sk-proj-1234567890abcdefghijABCDEFGHIJ and github ghp_1234567890abcdefghijABCDEFGHIJklmn',
      'stripe sk_live_1234567890abcdefABCDEF, aws AKIAIOSFODNN7EXAMPLE, ratel rtl_exampleexampleexample1',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      '"password": "correct horse battery", token: abcdefgh12345678',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      'mail me at jane.doe@example.co.uk, files in /Users/someone/code/app',
    ].join('\n');
    const out = masker.mask(text);
    for (const leak of ['hunter2pass', 's3cr3t-db-pass-91', 'sk-ant-api03', 'sk-proj-123', 'ghp_123', 'sk_live_', 'AKIAIOSFODNN7EXAMPLE', 'rtl_exampleexample', 'eyJhbGci', 'correct horse', 'abcdefgh12345678', 'abcdefghijklmnopqrstuvwxyz012345', 'MIIEowIBAAKCAQEA', 'jane.doe', '/Users/someone']) {
      expect(out, leak).not.toContain(leak);
    }
    expect(out).toContain(REDACTED);
    expect(out).toContain('~/code/app');
    expect(out).toContain('[email]');
    expect(out).toContain('"password": ');
  });

  it('short passwords and anyone\'s home folder too', () => {
    const out = masker.mask('password=hunter2 and PASS: abcd, see /Users/bob/notes and C:\\Users\\alice\\x and /home/carol/y');
    for (const leak of ['hunter2', 'abcd', 'bob', 'alice', 'carol']) expect(out, leak).not.toContain(leak);
  });

  it('leaves ordinary words alone (only worthy values are matched exactly)', () => {
    expect(secretWorthy('production')).toBe(false);
    expect(secretWorthy('true')).toBe(false);
    expect(secretWorthy('3000')).toBe(false);
    expect(secretWorthy('s3cr3t-db-pass-91')).toBe(true);
    expect(masker.mask('ship it to production on port 3000, true story')).toBe('ship it to production on port 3000, true story');
  });

  it('is quick on long text and cuts it first', () => {
    const many = new Masker(home);
    many.setSecrets(Array.from({ length: 2_000 }, (_, i) => `secret-value-${i}-xyzzy`));
    const text = 'lorem ipsum dolor sit amet '.repeat(5_000);
    const t0 = performance.now();
    const out = many.mask(text);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(out.length).toBeLessThan(33_000);
    expect(out.endsWith('[cut]')).toBe(true);
  });
});

const turn = (over: Partial<TurnFacts> = {}): TurnFacts => ({
  runtime: 'claude',
  model: 'claude-opus-5-5',
  session: 'sess-1',
  startedAt: 1_000,
  endedAt: 9_000,
  outcome: 'ok',
  usage: { input: 100, output: 50, cacheRead: 1_000, cacheWrite: 200, cost: 0.12 },
  tools: [
    { id: 't1', name: 'Bash', startedAt: 2_000, endedAt: 2_500, ok: true },
    { id: 't2', name: 'mcp__github__search', startedAt: 3_000, endedAt: 3_100, ok: false },
  ],
  own: true,
  place: 'worktree',
  subagents: 0,
  compactions: 0,
  promptChars: 20,
  answerChars: 30,
  ...over,
});

describe('a turn as spans (the shape Ratel reads)', () => {
  it('an invoke_agent root without usage, a chat span with the tokens, tools under it', () => {
    const spans = turnSpans(turn(), ID);
    const [root, chat, ...tools] = spans;
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
    expect(attr(root!, 'gen_ai.operation.name')).toEqual({ stringValue: 'invoke_agent' });
    expect(root!.attributes.some((a) => a.key.startsWith('gen_ai.usage.'))).toBe(false);
    expect(attr(chat!, 'gen_ai.operation.name')).toEqual({ stringValue: 'chat' });
    // The semconv's input includes the cache.
    expect(attr(chat!, 'gen_ai.usage.input_tokens')).toEqual({ intValue: '1300' });
    expect(attr(chat!, 'gen_ai.usage.cache_read.input_tokens')).toEqual({ intValue: '1000' });
    expect(attr(chat!, 'gen_ai.provider.name')).toEqual({ stringValue: 'anthropic' });
    expect(attr(chat!, 'gen_ai.conversation.id')).toEqual({ stringValue: pseudonym(ID, 'sess-1') });
    expect(tools.map((t) => attr(t, 'gen_ai.tool.name'))).toEqual([{ stringValue: 'Bash' }, { stringValue: 'mcp__github__search' }]);
    expect(tools.every((t) => t.parentSpanId === chat!.spanId)).toBe(true);
    expect(tools[1]!.status).toEqual({ code: 2 });
    expect(JSON.stringify(spans)).not.toContain('sess-1');
  });

  it('no text at limited; at on, the prompt on the first chat and the answer in the last one\'s details', () => {
    expect(JSON.stringify(turnSpans(turn(), ID))).not.toContain('gen_ai.input.messages');
    const spans = turnSpans(turn({ text: { prompt: 'fix the login', answer: 'fixed it' } }), ID);
    const chat = spans[1]!;
    expect(String(attr(chat, 'gen_ai.input.messages')?.stringValue)).toContain('fix the login');
    expect(JSON.stringify(chat.events)).toContain('fixed it');
  });

  it('one chat span per request when Claude Code reported them, each tool under the request before it', () => {
    const spans = turnSpans(
      turn({
        calls: [
          { model: 'claude-opus-5-5', at: 1_900, durationMs: 800, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.01 } },
          { model: 'claude-haiku-5-5', at: 2_900, durationMs: 300, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.01 } },
        ],
      }),
      ID,
    );
    const chats = spans.filter((s) => attr(s, 'gen_ai.operation.name')?.stringValue === 'chat');
    expect(chats).toHaveLength(2);
    const tools = spans.filter((s) => attr(s, 'gen_ai.operation.name')?.stringValue === 'execute_tool');
    expect(tools[0]!.parentSpanId).toBe(chats[0]!.spanId);
    expect(tools[1]!.parentSpanId).toBe(chats[1]!.spanId);
    expect(attr(chats[0]!, 'gen_ai.response.finish_reasons')).toEqual({ arrayValue: { values: [{ stringValue: 'tool_call' }] } });
  });
});

describe('sending', () => {
  const config = { url: 'https://ratel.example', key: 'rtl_pub_test_key_1234' };
  const sender = () => ({ installId: ID, version: '9.9.9' });

  it('posts traces and logs with the key, and masks text at the last moment', async () => {
    const calls: Array<{ url: string; body: string; auth: string }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), auth: String((init.headers as Record<string, string>).authorization) });
      return new Response('{}', { status: 202 });
    }) as unknown as typeof globalThis.fetch;
    const exporter = new Exporter({ config, sender, prepare: (t) => (t.text ? { ...t, text: { prompt: 'MASKED', answer: 'MASKED' } } : t), fetch });
    exporter.turn(turn({ text: { prompt: 'secret words', answer: 'more secret words' } }));
    exporter.log(event('feature', 1, { method: 'session.submit', calls: 3 }));
    await exporter.flush();
    expect(calls.map((c) => c.url)).toEqual(['https://ratel.example/v1/traces', 'https://ratel.example/v1/logs']);
    expect(calls[0]!.auth).toBe('Bearer rtl_pub_test_key_1234');
    expect(calls[0]!.body).not.toContain('secret words');
    expect(calls[0]!.body).toContain('MASKED');
    expect(calls[1]!.body).toContain('ratel.beluga.feature');
  });

  it('a revoked key stops everything until Beluga starts again', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof globalThis.fetch;
    const exporter = new Exporter({ config, sender, prepare: (t) => t, fetch });
    exporter.turn(turn());
    await exporter.flush();
    expect(exporter.stopped).toBe(true);
    exporter.turn(turn());
    await exporter.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a failed send keeps what didn\'t go and waits; traces that went are never sent twice', async () => {
    let now = 0;
    const statuses = [202, 503, 202];
    const bodies: string[] = [];
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response('', { status: statuses.shift() ?? 202 });
    }) as unknown as typeof globalThis.fetch;
    const exporter = new Exporter({ config, sender, prepare: (t) => t, fetch, flushMs: 1_000, now: () => now });
    exporter.turn(turn());
    exporter.log(event('feature', 1, { method: 'a' }));
    await exporter.flush();
    // Traces went (202), logs failed (503): only the logs wait.
    now = 500;
    await exporter.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    now = 10_000;
    await exporter.flush();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(bodies[2]).toContain('ratel.beluga.feature');
    expect(bodies.filter((b) => b.includes('resourceSpans'))).toHaveLength(1);
  });
});

describe('a run, observed', () => {
  // Your own run: Beluga's expanded prompt, and the words you typed (ownWords).
  const input = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({ prompt: 'fix it\n\n(worktree wt-1 is at /Users/kay/.beluga/wt-1; carried: bob said hi)', ownWords: 'fix it', requesterName: 'kay', viaAgent: false, context: ['bob said: my password is tulip'], scope: 'folder', onEvent: () => undefined, onFileTouched: () => undefined, ...over }) as AgentRunInput;
  const friends = (): AgentRunInput => {
    const { ownWords: _w, ...rest } = input({ requesterName: 'bob' });
    return rest as AgentRunInput;
  };
  const backend = (answer: string, script?: (i: AgentRunInput) => void): AgentBackend =>
    ({
      run: async (i: AgentRunInput) => {
        script?.(i);
        return answer;
      },
    }) as AgentBackend;

  it('off: the backend itself runs, with the same input', async () => {
    const run = vi.fn(async () => 'ok');
    const inner = { run } as unknown as AgentBackend;
    const facts: TurnFacts[] = [];
    const given = input();
    await observedBackend(inner, 'claude', { level: () => 'off', turn: (f) => facts.push(f) }).run(given);
    expect(run).toHaveBeenCalledWith(given);
    expect(facts).toHaveLength(0);
  });

  it('tells what a turn did: usage, tools, sub-agents; text only at on, only your own typed words, never the context or what Beluga added', async () => {
    const facts: TurnFacts[] = [];
    const script = (i: AgentRunInput) => {
      i.onEvent('usage', JSON.stringify({ input: 10, output: 5, cacheRead: 100, cacheWrite: 0, cost: 0.01, session: 's9' }));
      i.onEvent('sub', JSON.stringify({ id: 'a1', phase: 'start', kind: 'agent' }));
      i.onStep?.({ id: 'x', kind: 'tool', tool: 'Read', title: 'Read a', status: 'done', startedAt: 1, endedAt: 2 });
    };
    const deps = (level: 'limited' | 'on') => ({ level: () => level, turn: (f: TurnFacts) => facts.push(f) });
    await observedBackend(backend('done!', script), 'claude', deps('limited')).run(input());
    await observedBackend(backend('done!', script), 'claude', deps('on')).run(friends());
    await observedBackend(backend('done!', script), 'claude', deps('on')).run(input());
    expect(facts[0]).toMatchObject({ runtime: 'claude', session: 's9', usage: { input: 10, cacheRead: 100 }, subagents: 1, tools: [{ name: 'Read', ok: true }], own: true, answerChars: 5 });
    expect(facts[0]!.text).toBeUndefined();
    expect(facts[1]!.text).toBeUndefined();
    expect(facts[1]!.own).toBe(false);
    expect(facts[2]!.text).toEqual({ prompt: 'fix it', answer: 'done!' });
    for (const leak of ['tulip', 'carried', '.beluga/wt-1']) expect(JSON.stringify(facts), leak).not.toContain(leak);
  });

  it('a failing run still fails the same way, and says only the kind of error', async () => {
    const facts: TurnFacts[] = [];
    const failing = { run: async () => Promise.reject(new TypeError('bad /Users/someone/secret path')) } as unknown as AgentBackend;
    await expect(observedBackend(failing, 'codex', { level: () => 'limited', turn: (f) => facts.push(f) }).run(input())).rejects.toThrow('bad /Users');
    expect(facts[0]).toMatchObject({ outcome: 'error', errorKind: 'TypeError' });
    expect(JSON.stringify(facts)).not.toContain('secret path');
  });

  it('gives Claude its telemetry settings, unless your own variables set them', async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const inner = backend('ok', (i) => seen.push(i.env));
    const deps = { level: () => 'limited' as const, turn: () => undefined, env: () => ({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' }) };
    await observedBackend(inner, 'claude', deps).run(input({ env: { FOO: 'bar' } }));
    await observedBackend(inner, 'claude', deps).run(input({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://mine' } }));
    expect(seen[0]).toEqual({ FOO: 'bar', CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' });
    expect(seen[1]).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://mine' });
  });
});

describe("Claude Code's own telemetry", () => {
  const kv = (o: Record<string, string | number>) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } }));
  const logs = (records: Array<Record<string, string | number>>) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records.map((r) => ({ timeUnixNano: '5000000000', attributes: kv(r) })) }] }] });

  it('keeps each request for the turn, forwards other events with only the listed fields, and drops who you are', () => {
    const emitted: unknown[] = [];
    const otel = new ClaudeOtel({ emit: (r) => emitted.push(r), installId: () => ID, now: () => 5_000 });
    otel.logs(
      logs([
        { 'event.name': 'claude_code.api_request', 'session.id': 'S1', model: 'claude-opus-5-5', duration_ms: 900, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 40, cost_usd: 1, 'user.email': 'kay@example.com', 'organization.id': 'org-1' },
        { 'event.name': 'claude_code.tool_result', 'session.id': 'S1', tool_name: 'Bash', success: 'true', duration_ms: 12, tool_parameters: '{"command":"rm -rf /secret"}', 'user.email': 'kay@example.com', 'user.account_uuid': 'acc', 'user.id': 'uid' },
        { 'event.name': 'claude_code.user_prompt', 'session.id': 'S1', prompt: 'my private words', prompt_length: 16 },
      ]),
    );
    expect(otel.callsFor('S1', 0, 10_000)).toMatchObject([{ model: 'claude-opus-5-5', at: 5_000, durationMs: 900, usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 1 } }]);
    expect(otel.callsFor('S1', 0, 10_000)).toEqual([]);
    const sent = JSON.stringify(emitted);
    expect(sent).toContain('ratel.beluga.claude_code.tool_result');
    expect(sent).toContain('Bash');
    for (const leak of ['kay@example.com', 'org-1', 'acc', '"uid"', 'rm -rf', 'my private words', '"S1"']) expect(sent, leak).not.toContain(leak);
    expect(sent).not.toContain('claude_code.user_prompt');
  });

  it('drops anything not named claude_code.* (another program that found the port)', () => {
    const emitted: unknown[] = [];
    const otel = new ClaudeOtel({ emit: (r) => emitted.push(r), installId: () => ID, now: () => 5_000 });
    otel.logs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: 'GET /api/users?email=jane@example.com 200' } }, { attributes: kv({ 'event.name': 'http.request', 'url.full': 'https://x/secret' }) }] }] }] });
    otel.metrics({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'http.server.duration', sum: { dataPoints: [{ asInt: '3' }] } }] }] }] });
    expect(emitted).toEqual([]);
  });

  it('leaves alone someone who set it up in Claude Code\'s own settings', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-settings-'));
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://their-collector' } }));
    const otel = new ClaudeOtel({ emit: () => undefined, installId: () => ID, env: { CLAUDE_CONFIG_DIR: dir } });
    await otel.start();
    expect(otel.env()).toBeUndefined();
    otel.stop();
  });

  it('leaves alone someone who sends Claude Code\'s telemetry elsewhere', async () => {
    const theirs = new ClaudeOtel({ emit: () => undefined, installId: () => ID, env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://their-collector' } });
    await theirs.start();
    expect(theirs.env()).toBeUndefined();
    theirs.stop();
    const ours = new ClaudeOtel({ emit: () => undefined, installId: () => ID, env: { CLAUDE_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'no-claude-')) } });
    await ours.start();
    expect(ours.env()).toMatchObject({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'false' });
    expect(ours.env()?.OTEL_EXPORTER_OTLP_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(Object.keys(ours.env() ?? {})).not.toContain('OTEL_LOG_USER_PROMPTS');
    ours.stop();
  });

  it('answers only its own token', async () => {
    const otel = new ClaudeOtel({ emit: () => undefined, installId: () => ID, env: { CLAUDE_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'no-claude-')) } });
    await otel.start();
    const env = otel.env()!;
    const res = await fetch(`${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(401);
    const token = env.OTEL_EXPORTER_OTLP_HEADERS!.replace('authorization=', '');
    const ok = await fetch(`${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', authorization: token } });
    expect(ok.status).toBe(200);
    otel.stop();
  });
});

describe('the service', () => {
  const store = () => new Store(initialState('test', 'ask'));

  it('publishes nothing to ask and sends nothing in a build without the release config', () => {
    const s = store();
    const service = new TelemetryService({ store: s, version: '1', file: null, secrets: () => [] });
    expect(s.getState().telemetry).toEqual({ available: false, due: false });
    service.choose('on', 'settings');
    expect(service.level).toBe('off');
  });

  it('a turn queued at On loses its text once the level goes down, and is dropped at Off', async () => {
    const s = store();
    const bodies: string[] = [];
    const fetch = vi.fn(async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), new Response('', { status: 202 }))) as unknown as typeof globalThis.fetch;
    const service = new TelemetryService({ store: s, version: '1', file: null, secrets: () => [], config: { url: 'https://ratel.example', key: 'rtl_pub_xxxxxxxx' }, fetch });
    service.choose('on', 'settings');
    service.observeDeps().turn(turn({ text: { prompt: 'my words', answer: 'its words' } }));
    service.choose('limited', 'settings');
    service.observeDeps().turn(turn({ text: { prompt: 'late words', answer: 'x' } }));
    service.choose('off', 'settings');
    service.observeDeps().turn(turn());
    await service.stop();
    expect(bodies.join('')).not.toContain('my words');
    expect(bodies.join('')).not.toContain('late words');
    expect(bodies.filter((b) => b.includes('resourceSpans'))).toHaveLength(0);
  });

  it('counts features only while a level sends', async () => {
    const s = store();
    const fetch = vi.fn(async () => new Response('', { status: 202 })) as unknown as typeof globalThis.fetch;
    const service = new TelemetryService({ store: s, version: '1', file: null, secrets: () => [], config: { url: 'https://ratel.example', key: 'rtl_pub_xxxxxxxx' }, fetch });
    service.start();
    expect(s.getState().telemetry).toMatchObject({ available: true, due: true });
    featureCounter.call('session.submit', 3, true);
    expect(featureCounter.drain().counts).toEqual([]);
    service.choose('limited', 'onboarding');
    expect(s.getState().telemetry).toMatchObject({ level: 'limited', due: false });
    featureCounter.call('session.submit', 3, true);
    featureCounter.call('session.submit', 5, false);
    expect(featureCounter.drain().counts).toEqual([{ method: 'session.submit', calls: 2, errors: 1, totalMs: 8, maxMs: 5 }]);
    service.choose('off', 'settings');
    featureCounter.call('session.submit', 3, true);
    expect(featureCounter.drain().counts).toEqual([]);
    await service.stop();
  });
});
