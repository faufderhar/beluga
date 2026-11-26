import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { Store, initialState } from '../src/core/store.js';
import { ASK_ROUND, LATER_MERGES, LATER_MS, type TelemetryRecord, answerAsk, askAnswer, askDue, chooseLevel, levelOnLeave, resetInstallId, effectiveLevel, excludeProject, projectOfFolder, telemetryView } from '../src/core/telemetry-store.js';
import { ClaudeOtel } from '../src/telemetry/claude-otel.js';
import { releaseConfig } from '../src/telemetry/config.js';
import { deviceFacts } from '../src/telemetry/device.js';
import { Exporter } from '../src/telemetry/exporter.js';
import { featureCounter } from '../src/telemetry/features.js';
import { Masker, REDACTED, secretWorthy } from '../src/telemetry/mask.js';
import { observedBackend } from '../src/telemetry/observe.js';
import { event, logsRequest, pseudonym, tracesRequest } from '../src/telemetry/otlp.js';
import { loadTelemetryRecord, saveTelemetryRecord } from '../src/telemetry/record.js';
import { TelemetryService } from '../src/telemetry/service.js';
import { ModelIds, type TurnFacts, belugaToolSpans, isBelugaTool, turnSpans } from '../src/telemetry/turn.js';
import { toolErrorType } from '../src/telemetry/tool-error.js';
import { StepRecorder } from '../src/agent/step-recorder.js';
import type { StepRecord } from '../src/shared/steps.js';
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

  it('an update from a version without usage statistics asks; Later (or closing it) is kept across restarts and asks again', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'tel-')), 'telemetry.json');
    let now = 1_000_000;
    const config = { url: 'https://ratel.example', key: 'rtl_pub_xxxxxxxx' };
    const start = () => {
      const s = new Store(initialState('test', 'ask'));
      return { s, service: new TelemetryService({ store: s, version: '1', file, secrets: () => [], config, now: () => now, fetch: (async () => new Response('', { status: 202 })) as unknown as typeof fetch }) };
    };
    // No telemetry.json: the version before had none.
    const first = start();
    expect(first.s.getState().telemetry).toMatchObject({ available: true, due: true });
    first.service.answer('later', 'limited');
    expect(first.s.getState().telemetry.due).toBe(false);
    await first.service.stop();
    // The next start remembers Later, and asks again once it's due.
    now += 60_000;
    const second = start();
    expect(second.s.getState().telemetry.due).toBe(false);
    await second.service.stop();
    now += LATER_MS;
    const third = start();
    expect(third.s.getState().telemetry.due).toBe(true);
    await third.service.stop();
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

  it('the onboarding picks nothing for you: leaving it with no level picked is Off', () => {
    const view = (record: TelemetryRecord, available = true) => telemetryView(record, ctx({ available }));
    expect(levelOnLeave(view(fresh))).toBe('off');
    expect(levelOnLeave(view(chooseLevel(fresh, 'limited', 'onboarding', 1)))).toBeUndefined();
    expect(levelOnLeave(view(chooseLevel(fresh, 'on', 'onboarding', 1)))).toBeUndefined();
    // A build that can't send has nothing to choose.
    expect(levelOnLeave(view(fresh, false))).toBeUndefined();
    // Picked in this onboarding, before the daemon's copy came back: the pick stands, no Off after it.
    expect(levelOnLeave(view(fresh), true)).toBeUndefined();
    // Off, kept from the onboarding, is a choice: the ask never comes after it.
    expect(askDue(chooseLevel(fresh, levelOnLeave(view(fresh))!, 'onboarding', 1), ctx())).toBe(false);
  });

  it('the ask picks nothing for you: only a level you pick shares, Off is No thanks', () => {
    expect(askAnswer(undefined)).toBeUndefined();
    expect(askAnswer('off')).toEqual({ answer: 'never', level: 'off' });
    expect(askAnswer('limited')).toEqual({ answer: 'share', level: 'limited' });
    expect(askAnswer('on')).toEqual({ answer: 'share', level: 'on' });
  });

  it('a reset install id is a new random one; the rest of the record stays', () => {
    const chosen = chooseLevel(fresh, 'on', 'settings', 1);
    const reset = resetInstallId(chosen, '0f1e2d3c-4b5a-4968-8776-655443322110');
    expect(reset).toEqual({ ...chosen, installId: '0f1e2d3c-4b5a-4968-8776-655443322110' });
  });

  it('shows the install id once a level is chosen, Off too (for a request after withdrawal); Reset ID keeps a new one in telemetry.json', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'tel-id-')), 'telemetry.json');
    const s = new Store(initialState('test', 'ask'));
    const service = new TelemetryService({ store: s, version: '1', file, secrets: () => [], config: { url: 'https://ratel.example', key: 'rtl_pub_xxxxxxxx' }, fetch: (async () => new Response('', { status: 202 })) as unknown as typeof fetch });
    // Never chosen: the id isn't kept anywhere yet, and nothing was sent under it.
    expect(service.installId()).toBeUndefined();
    service.choose('limited', 'settings');
    const before = service.installId();
    expect(before).toBe(loadTelemetryRecord(file).record.installId);
    // Withdrawn: the id stays, for an access or erasure request.
    service.choose('off', 'settings');
    expect(service.installId()).toBe(before);
    // Reset at Off is allowed (nothing is sent anyway), and kept.
    const after = service.resetId();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f-]{36}$/);
    expect(service.installId()).toBe(after);
    expect(loadTelemetryRecord(file).record).toMatchObject({ installId: after, level: 'off' });
    await service.stop();
  });

  it('Reset ID drops the feature counts made before it, so none go under the new id', async () => {
    const s = new Store(initialState('test', 'ask'));
    const service = new TelemetryService({ store: s, version: '1', file: null, secrets: () => [], config: { url: 'https://ratel.example', key: 'rtl_pub_xxxxxxxx' }, fetch: (async () => new Response('', { status: 202 })) as unknown as typeof fetch });
    service.choose('limited', 'settings');
    featureCounter.drain();
    featureCounter.call('session.submit', 5, true);
    service.resetId();
    expect(featureCounter.drain().counts).toEqual([]);
    await service.stop();
  });

  it('only screens choose: the API checks the levels and the places', () => {
    expect(() => parseArgs('telemetry.choose', ['loud', 'settings'])).toThrow();
    expect(() => parseArgs('telemetry.choose', ['on', 'ask'])).toThrow();
    expect(() => parseArgs('telemetry.mark', ['anything', undefined])).toThrow();
    expect(() => parseArgs('telemetry.mark', ['preview_opened', undefined])).toThrow();
    expect(parseArgs('telemetry.answer', ['later', 'limited'])).toEqual(['later', 'limited']);
  });
});

describe('no address leaves this computer', () => {
  it('neither the device facts nor the resource carry an IP address or a host name', () => {
    const facts = deviceFacts({ app_version: '1' });
    const sender = { installId: ID, version: '1' };
    const sent = JSON.stringify([facts, tracesRequest(sender, []), logsRequest(sender, [])]);
    expect(sent).not.toMatch(/host\.(name|ip)|client\.address|hostname|"ip"/i);
    expect(sent).not.toContain(os.hostname());
    for (const nets of Object.values(os.networkInterfaces())) for (const n of nets ?? []) if (!n.internal) expect(sent).not.toContain(n.address);
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

  it('can carry a second key for Beluga\'s own project (the same key twice is one project)', () => {
    const base = { TELEMETRY_URL: 'https://ratel.example', TELEMETRY_KEY: 'rtl_pub_agents_123456' };
    expect(releaseConfig(env({ ...base, TELEMETRY_PRODUCT_KEY: 'rtl_pub_beluga_123456' }))).toEqual({ url: 'https://ratel.example', key: 'rtl_pub_agents_123456', productKey: 'rtl_pub_beluga_123456' });
    expect(releaseConfig(env({ ...base, TELEMETRY_PRODUCT_KEY: 'rtl_pub_agents_123456' }))).toEqual({ url: 'https://ratel.example', key: 'rtl_pub_agents_123456' });
    expect(releaseConfig(env({ TELEMETRY_URL: 'https://ratel.example', TELEMETRY_PRODUCT_KEY: 'rtl_pub_beluga_123456' }))).toBeUndefined();
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

describe('a turn as spans: what Ratel Cloud keeps', () => {
  const op = (s: Parameters<typeof attr>[0]) => attr(s, 'gen_ai.operation.name')?.stringValue;
  const call = (model: string, at: number, output = 2, source = 'sdk') => ({ model, source, at, durationMs: 300, usage: { input: 1, output, cacheRead: 3, cacheWrite: 4, cost: 0.01 } });

  it('the model is the id that answered, not the name picked; the name picked is kept beside it', () => {
    const spans = turnSpans(turn({ model: 'opus', resolvedModel: 'claude-opus-5-5[1m]' }), ID);
    const [root, chat] = spans;
    expect(attr(root!, 'gen_ai.request.model')).toEqual({ stringValue: 'claude-opus-5-5' });
    expect(attr(root!, 'ratel.model.alias')).toEqual({ stringValue: 'opus' });
    expect(attr(chat!, 'gen_ai.request.model')).toEqual({ stringValue: 'claude-opus-5-5' });
    expect(attr(chat!, 'gen_ai.response.model')).toEqual({ stringValue: 'claude-opus-5-5' });
    expect(chat!.name).toBe('chat claude-opus-5-5');
    // Picked by its id already: nothing to add.
    expect(attr(turnSpans(turn(), ID)[0]!, 'ratel.model.alias')).toBeUndefined();
  });

  it('without the id from the run, the requests say which model the name picked was', () => {
    const calls = [call('claude-haiku-5-5', 1_500, 900, 'generate_session_title'), call('claude-opus-5-5', 1_900), call('claude-opus-5-5', 2_900)];
    const root = turnSpans(turn({ model: 'opus', calls }), ID)[0]!;
    expect(attr(root, 'gen_ai.request.model')).toEqual({ stringValue: 'claude-opus-5-5' });
    // No model picked (the default): the one that wrote the most.
    const { model: _m, ...rest } = turn({ calls });
    expect(attr(turnSpans(rest, ID)[0]!, 'gen_ai.request.model')).toEqual({ stringValue: 'claude-haiku-5-5' });
    // Nothing to go by: no model rather than the name (it would split the model's statistics, BLG-1029); the name goes apart.
    const unsaid = turnSpans(turn({ model: 'opus' }), ID)[0]!;
    expect(attr(unsaid, 'gen_ai.request.model')).toBeUndefined();
    expect(attr(unsaid, 'ratel.model.alias')).toEqual({ stringValue: 'opus' });
  });

  it('a later turn that only had the name goes out with the id an earlier turn said it stood for', () => {
    const ids = new ModelIds();
    // Nothing said yet: nothing to fill in.
    expect(ids.settle(turn({ model: 'opus' })).resolvedModel).toBeUndefined();
    ids.settle(turn({ model: 'opus', resolvedModel: 'claude-opus-5-5' }));
    const later = turnSpans(ids.settle(turn({ model: 'opus' })), ID)[0]!;
    expect(attr(later, 'gen_ai.request.model')).toEqual({ stringValue: 'claude-opus-5-5' });
    expect(attr(later, 'ratel.model.alias')).toEqual({ stringValue: 'opus' });
    // An id picked is sent as it is; another runtime's names are its own.
    expect(attr(turnSpans(ids.settle(turn({ model: 'claude-sonnet-5-5' })), ID)[0]!, 'gen_ai.request.model')).toEqual({ stringValue: 'claude-sonnet-5-5' });
    expect(ids.settle(turn({ runtime: 'local', model: 'opus' })).resolvedModel).toBeUndefined();
  });

  it('each request is a chat span with its own tokens, cost and what asked for it', () => {
    const spans = turnSpans(turn({ model: 'opus', calls: [call('claude-haiku-5-5', 1_500, 7, 'generate_session_title'), call('claude-opus-5-5', 1_900, 20)] }), ID);
    const chats = spans.filter((s) => op(s) === 'chat');
    expect(chats.map((c) => attr(c, 'gen_ai.request.model')?.stringValue)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
    expect(chats.map((c) => attr(c, 'gen_ai.usage.output_tokens')?.intValue)).toEqual(['7', '20']);
    expect(chats.map((c) => attr(c, 'ratel.request.source')?.stringValue)).toEqual(['generate_session_title', 'sdk']);
    expect(attr(chats[1]!, 'ratel.usage.cost_usd')).toEqual({ doubleValue: 0.01 });
  });

  it('no beluga.* attribute is left (Ratel Cloud drops them): ratel.* names instead', () => {
    const facts = turn({ effort: 'high', compactions: 2, subagents: 1, tools: [{ id: 't1', name: 'Read', startedAt: 2_000, endedAt: 2_500, ok: true, parent: 'toolu_agent' }, { id: 't2', name: 'mcp__beluga__send_chat', startedAt: 3_000, ok: true }] });
    for (const spans of [turnSpans(facts, ID), belugaToolSpans(facts, ID)]) {
      expect(spans.flatMap((s) => s.attributes.map((a) => a.key)).filter((k) => !/^(gen_ai|ratel|mcp)\.|^error\.type$/.test(k))).toEqual([]);
    }
    const [root, chat, tool] = turnSpans(facts, ID);
    const got = Object.fromEntries(root!.attributes.filter((a) => a.key.startsWith('ratel.')).map((a) => [a.key, Object.values(a.value)[0]]));
    expect(got).toEqual({
      'ratel.harness.name': 'claude',
      'ratel.harness.effort': 'high',
      'ratel.run.place': 'worktree',
      'ratel.run.own': true,
      'ratel.run.outcome': 'ok',
      'ratel.run.tool_calls': '2',
      'ratel.run.tool_errors': '0',
      'ratel.run.subagents': '1',
      'ratel.run.compactions': '2',
      'ratel.run.prompt_chars': '20',
      'ratel.run.answer_chars': '30',
      'ratel.run.cost_usd': 0.12,
    });
    expect(attr(chat!, 'ratel.usage.cost_usd')).toEqual({ doubleValue: 0.12 });
    expect(attr(tool!, 'ratel.agent.parent_call_id')).toEqual({ stringValue: 'toolu_agent' });
    const own = belugaToolSpans(facts, ID);
    expect(own[0]!.attributes.filter((a) => a.key.startsWith('ratel.')).map((a) => a.key)).toEqual(['ratel.harness.name', 'ratel.run.place', 'ratel.run.own', 'ratel.run.outcome', 'ratel.run.tool_calls', 'ratel.run.tool_errors']);
  });

  it('every span says which conversation and which agent (a batch that splits still resolves its session)', () => {
    const facts = turn({ tools: [{ id: 't1', name: 'mcp__beluga__send_chat', startedAt: 2_000, ok: true }] });
    for (const spans of [turnSpans(facts, ID), belugaToolSpans(facts, ID)]) {
      expect(spans.length).toBeGreaterThan(1);
      for (const s of spans) {
        expect(attr(s, 'gen_ai.conversation.id'), s.name).toEqual({ stringValue: pseudonym(ID, 'sess-1') });
        expect(attr(s, 'gen_ai.agent.name'), s.name).toEqual({ stringValue: 'claude' });
      }
    }
  });
});

describe('why a tool call failed (its class, never its words)', () => {
  const failed = (tool: string, output: string): StepRecord => ({ id: 'x', kind: 'tool', tool, title: tool, status: 'error', startedAt: 1, endedAt: 2, isError: true, output });

  it('tells a timeout, a refusal, a stop, a failed command and a rejected input from any other failure', () => {
    const cases: Array<[string, string, string]> = [
      ['Bash', 'Command timed out after 2m 0s', 'timeout'],
      ['mcp__github__search', 'MCP error -32001: Request timed out', 'timeout'],
      ['Bash', "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).", 'denied'],
      ['Write', "Claude requested permissions to write to /tmp/x, but you haven't granted it yet.", 'denied'],
      ['Bash', 'Permission to use Bash has been denied.', 'denied'],
      ['AskUserQuestion', 'The user skipped this question. Continue with your best judgment and say what you assumed.', 'denied'],
      ['Bash', 'Declined.', 'denied'],
      ['Bash', '[Request interrupted by user for tool use]', 'aborted'],
      ['Bash', 'Exit code 1\nnpm ERR! missing script: tset', 'nonzero_exit'],
      ['Bash', 'Exited with code 127', 'nonzero_exit'],
      ['Read', '<tool_use_error>InputValidationError: Read failed due to the following issue:\nThe required parameter `file_path` is missing</tool_use_error>', 'validation'],
      ['mcp__beluga_board__task_update', 'MCP error -32602: Invalid arguments for tool task_update: [{"code":"invalid_enum_value"}]', 'validation'],
      ['Read', 'File does not exist.', 'tool_error'],
      // A word about timeouts is not a timeout.
      ['mcp__github__search', 'Unknown option: timeout', 'tool_error'],
      ['WebFetch', 'Request failed: timeout exceeded', 'timeout'],
      // A command that failed for its own reasons, though its output speaks of a timeout or a denial.
      ['Bash', 'Exit code 1\nError: connect ETIMEDOUT: request timed out\npermission denied', 'nonzero_exit'],
      // Only a command has an exit code.
      ['Read', 'Exit code 1', 'tool_error'],
    ];
    for (const [tool, output, type] of cases) expect(toolErrorType(failed(tool, output)), output).toBe(type);
    // What Claude Code said about the call (a refusal) wins over what its words look like.
    expect(toolErrorType(failed('Bash', 'Not allowed here.'), 'denied')).toBe('denied');
    expect(toolErrorType(failed('Bash', 'Exit code 1'), 'aborted')).toBe('aborted');
  });

  it('a step still open when its run stops was aborted', () => {
    const seen: StepRecord[] = [];
    const recorder = new StepRecorder({ emit: (r) => seen.push(r), now: () => 10 });
    recorder.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 99' } }] } });
    recorder.finish(true);
    expect(toolErrorType(seen.at(-1)!)).toBe('aborted');
  });

  it('a turn\'s failed tools carry their class to error.type, in both projects', async () => {
    const facts: TurnFacts[] = [];
    const run = { run: async (i: AgentRunInput) => {
      i.onEvent('usage', JSON.stringify({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, session: 's1' }));
      i.onStep?.(failed('Bash', 'Exit code 2\nboom'));
      i.onStep?.({ ...failed('mcp__beluga__send_chat', 'Not now.'), id: 'y' });
      i.onStep?.({ ...failed('Read', 'File does not exist.'), id: 'z' });
      i.onStep?.({ id: 'ok', kind: 'tool', tool: 'Read', title: 'Read', status: 'done', startedAt: 1, endedAt: 2 });
      return 'done';
    } } as unknown as AgentBackend;
    const base = { prompt: 'p', ownWords: 'p', requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', onEvent: () => undefined } as unknown as AgentRunInput;
    const taken: string[] = [];
    await observedBackend(run, 'claude', { level: () => 'limited', turn: (f) => facts.push(f), settleMs: 0, calls: () => [], refused: (s) => (taken.push(s), new Map([['y', 'denied' as const]])) }).run(base);
    await new Promise((r) => setTimeout(r, 5));
    expect(taken).toEqual(['s1']);
    expect(facts[0]!.tools.map((t) => t.error)).toEqual(['nonzero_exit', 'denied', 'tool_error', undefined]);
    expect(JSON.stringify(facts)).not.toContain('boom');
    const types = (spans: ReturnType<typeof turnSpans>) => spans.filter((s) => attr(s, 'gen_ai.operation.name')?.stringValue === 'execute_tool').map((s) => attr(s, 'error.type')?.stringValue);
    expect(types(turnSpans(facts[0]!, ID))).toEqual(['nonzero_exit', 'denied', 'tool_error', undefined]);
    expect(types(belugaToolSpans(facts[0]!, ID))).toEqual(['denied']);
  });
});

describe("a turn as Beluga's own project sees it", () => {
  const withBeluga = () =>
    turn({
      tools: [
        { id: 't1', name: 'Bash', startedAt: 2_000, endedAt: 2_500, ok: true },
        { id: 't2', name: 'mcp__beluga_board__task_update', startedAt: 3_000, endedAt: 3_100, ok: true },
        { id: 't3', name: 'mcp__beluga__send_chat', startedAt: 4_000, endedAt: 4_200, ok: false },
        { id: 't4', name: 'mcp__github__search', startedAt: 5_000, endedAt: 5_100, ok: true },
      ],
      text: { prompt: 'my words', answer: 'its words' },
    });

  it("knows Beluga's tools by their server, and no one else's", () => {
    expect(['mcp__beluga__send_chat', 'mcp__beluga_sentinel__sentinel_create', 'mcp__beluga_view__show'].every(isBelugaTool)).toBe(true);
    expect(['Bash', 'mcp__github__search', 'mcp__belugafan__x', 'beluga__send_chat'].some(isBelugaTool)).toBe(false);
  });

  it("only Beluga's tool calls, under a root with no model, tokens, cost or text", () => {
    const [root, ...tools] = belugaToolSpans(withBeluga(), ID);
    expect(tools.map((t) => attr(t, 'gen_ai.tool.name'))).toEqual([{ stringValue: 'mcp__beluga_board__task_update' }, { stringValue: 'mcp__beluga__send_chat' }]);
    expect(tools.every((t) => t.parentSpanId === root!.spanId)).toBe(true);
    expect(tools[1]!.status).toEqual({ code: 2 });
    expect(attr(root!, 'ratel.run.place')).toEqual({ stringValue: 'worktree' });
    const body = JSON.stringify([root, ...tools]);
    for (const leak of ['claude-opus-5-5', 'gen_ai.usage', 'cost', 'chars', 'my words', 'its words', 'Bash', 'github', 'sess-1']) expect(body).not.toContain(leak);
  });

  it("nothing when the turn used none of Beluga's tools", () => {
    expect(belugaToolSpans(turn(), ID)).toEqual([]);
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

  it('tells the model\'s id as the run reported it, beside the name that was picked', async () => {
    const facts: TurnFacts[] = [];
    const script = (i: AgentRunInput) => {
      i.onEvent('context', JSON.stringify({ used: 10, window: 200_000, model: 'claude-opus-5-5' }));
      i.onEvent('context', JSON.stringify({ compacting: false, window: 200_000 }));
    };
    await observedBackend(backend('ok', script), 'claude', { level: () => 'limited', turn: (f) => facts.push(f) }).run(input({ model: 'opus' }));
    expect(facts[0]).toMatchObject({ model: 'opus', resolvedModel: 'claude-opus-5-5' });
    // Nothing reported (another runtime): only the name picked.
    await observedBackend(backend('ok'), 'codex', { level: () => 'limited', turn: (f) => facts.push(f) }).run(input({ model: 'gpt-5.2-codex' }));
    expect(facts[1]!.resolvedModel).toBeUndefined();
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

  // What Claude Code 2.1 really sends: the bare name in `event.name`, the full name in the body, its own scope.
  const real = (records: Array<Record<string, string | number>>, scope = 'com.anthropic.claude_code.events') => ({
    resourceLogs: [{ scopeLogs: [{ scope: { name: scope }, logRecords: records.map((r) => ({ timeUnixNano: '5000000000', body: { stringValue: `claude_code.${r['event.name']}` }, attributes: kv(r) })) }] }],
  });

  it('reads the names Claude Code really sends: bare in event.name, claude_code.* in the body', () => {
    const emitted: unknown[] = [];
    const otel = new ClaudeOtel({ emit: (r) => emitted.push(r), installId: () => ID, now: () => 5_000 });
    otel.logs(
      real([
        { 'event.name': 'api_request', 'session.id': 'S1', model: 'claude-haiku-5-5', query_source: 'generate_session_title', duration_ms: 100, input_tokens: 1, output_tokens: 2 },
        { 'event.name': 'api_request', 'session.id': 'S1', model: 'claude-opus-5-5', query_source: 'sdk', duration_ms: 900, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 40, cost_usd: 1 },
        { 'event.name': 'tool_result', 'session.id': 'S1', tool_name: 'Bash', success: 'true', duration_ms: 12 },
      ]),
    );
    expect(otel.callsFor('S1', 0, 10_000)).toMatchObject([
      { model: 'claude-haiku-5-5', source: 'generate_session_title' },
      { model: 'claude-opus-5-5', source: 'sdk', at: 5_000, durationMs: 900, usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 1 } },
    ]);
    expect(JSON.stringify(emitted)).toContain('ratel.beluga.claude_code.tool_result');
    expect(JSON.stringify(emitted)).not.toContain('claude_code.api_request');
  });

  it('a bare name counts only with Claude Code\'s body or scope (another program that found the port)', () => {
    const emitted: unknown[] = [];
    const otel = new ClaudeOtel({ emit: (r) => emitted.push(r), installId: () => ID, now: () => 5_000 });
    const record = { timeUnixNano: '5000000000', attributes: kv({ 'event.name': 'api_request', 'session.id': 'S1', model: 'm', input_tokens: 1 }) };
    otel.logs({ resourceLogs: [{ scopeLogs: [{ scope: { name: 'some.other.program' }, logRecords: [record, { ...record, body: { stringValue: 'claude_code.tool_result' } }] }] }] });
    expect(otel.callsFor('S1', 0, 10_000)).toEqual([]);
    expect(emitted).toEqual([]);
    // Its scope alone is enough (a version that leaves the body out).
    otel.logs({ resourceLogs: [{ scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: [record] }] }] });
    expect(otel.callsFor('S1', 0, 10_000)).toHaveLength(1);
  });

  it('keeps which tool calls were refused, and how, for the turn (never forwarded by id)', () => {
    const emitted: unknown[] = [];
    const otel = new ClaudeOtel({ emit: (r) => emitted.push(r), installId: () => ID, now: () => 5_000 });
    otel.logs(
      real([
        { 'event.name': 'tool_decision', 'session.id': 'S1', tool_name: 'Bash', tool_use_id: 'toolu_ok', decision: 'accept', source: 'config' },
        { 'event.name': 'tool_decision', 'session.id': 'S1', tool_name: 'Bash', tool_use_id: 'toolu_no', decision: 'reject', source: 'user_reject' },
        { 'event.name': 'tool_decision', 'session.id': 'S1', tool_name: 'Edit', tool_use_id: 'toolu_esc', decision: 'reject', source: 'user_abort' },
      ]),
    );
    expect([...otel.refusedFor('S1')]).toEqual([['toolu_no', 'denied'], ['toolu_esc', 'aborted']]);
    expect(otel.refusedFor('S1').size).toBe(0);
    expect(JSON.stringify(emitted)).not.toContain('toolu_');
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

  describe('two projects', () => {
    const AGENTS = 'rtl_pub_agents_123456';
    const BELUGA = 'rtl_pub_beluga_123456';
    const belugaTurn = () => turn({ tools: [{ id: 'b1', name: 'mcp__beluga_sentinel__sentinel_create', startedAt: 2_000, endedAt: 2_100, ok: true }, { id: 't1', name: 'mcp__github__search', startedAt: 3_000, endedAt: 3_100, ok: true }], text: { prompt: 'my words', answer: 'its words' } });
    const setup = (keys: { key: string; productKey?: string }) => {
      const sent: Array<{ key: string; url: string; body: string }> = [];
      const fetch = vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, key: String((init.headers as Record<string, string>).authorization).replace('Bearer ', ''), body: String(init.body) });
        return new Response('', { status: 202 });
      }) as unknown as typeof globalThis.fetch;
      const service = new TelemetryService({ store: store(), version: '1', file: null, secrets: () => [], config: { url: 'https://ratel.example', ...keys }, fetch });
      return { service, sent, to: (key: string) => sent.filter((x) => x.key === key).map((x) => x.body).join('\n') };
    };

    it("Limited: only Beluga's own data, all to Beluga's project; no sessions, no Claude Code telemetry", async () => {
      const { service, sent, to } = setup({ key: AGENTS, productKey: BELUGA });
      service.choose('limited', 'settings');
      expect(service.observeDeps().env?.('claude')).toBeUndefined();
      service.observeDeps().turn(belugaTurn());
      service.mark('onboarding_done');
      await service.stop();
      expect(sent.length).toBeGreaterThan(0);
      expect(to(AGENTS)).toBe('');
      const beluga = to(BELUGA);
      expect(beluga).toContain('mcp__beluga_sentinel__sentinel_create');
      expect(beluga).toContain('ratel.beluga.onboarding_done');
      expect(beluga).toContain('ratel.beluga.level');
      for (const leak of ['github', 'claude-opus-5-5', 'gen_ai.usage', 'my words']) expect(beluga).not.toContain(leak);
    });

    it("On: the whole turn to the agents project too, and Beluga's own data stays in its project", async () => {
      const { service, to } = setup({ key: AGENTS, productKey: BELUGA });
      service.choose('on', 'settings');
      service.observeDeps().turn(belugaTurn());
      service.mark('onboarding_done');
      await service.stop();
      const agents = to(AGENTS);
      expect(agents).toContain('mcp__github__search');
      expect(agents).toContain('gen_ai.usage.input_tokens');
      expect(agents).toContain('my words');
      expect(agents).not.toContain('ratel.beluga.onboarding_done');
      expect(to(BELUGA)).toContain('mcp__beluga_sentinel__sentinel_create');
      expect(to(BELUGA)).not.toContain('my words');
    });

    it('a turn queued at On never reaches the agents project once the level is Limited', async () => {
      const { service, to } = setup({ key: AGENTS, productKey: BELUGA });
      service.choose('on', 'settings');
      service.observeDeps().turn(belugaTurn());
      service.choose('limited', 'settings');
      await service.stop();
      expect(to(AGENTS)).toBe('');
      expect(to(BELUGA)).toContain('mcp__beluga_sentinel__sentinel_create');
    });

    it("one key: one project, and Beluga's tools are never sent twice", async () => {
      const { service, to } = setup({ key: AGENTS });
      service.choose('on', 'settings');
      service.observeDeps().turn(belugaTurn());
      await service.stop();
      expect(to(AGENTS).split('execute_tool mcp__beluga_sentinel__sentinel_create')).toHaveLength(2);
    });
  });
});
