import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { EnvVars } from '../src/core/env-vars.js';
import { Store, initialState } from '../src/core/store.js';
import { parseArgs } from '../src/ipc/api.js';
import { type DestinationStore, TraceDestinations, withoutText } from '../src/telemetry/destinations.js';
import { observedBackend } from '../src/telemetry/observe.js';
import { tracesProto } from '../src/telemetry/otlp-proto.js';
import { tracesRequest } from '../src/telemetry/otlp.js';
import { TelemetryService } from '../src/telemetry/service.js';
import { type TurnFacts, turnSpans } from '../src/telemetry/turn.js';
import { TRACE_PROVIDERS, TRACE_PROVIDER_IDS, parseHeaders, sentryTarget, traceTarget } from '../src/shared/trace-destinations.js';

/** Your own traces (BLG-1014): each tool's address and headers, the keys kept, protobuf, and how it sits beside usage statistics. */

const turn = (over: Partial<TurnFacts> = {}): TurnFacts => ({
  runtime: 'codex',
  model: 'gpt-5.5',
  session: 'sess-1',
  startedAt: 1_000,
  endedAt: 9_000,
  outcome: 'ok',
  usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 },
  tools: [{ id: 't1', name: 'Bash', startedAt: 2_000, endedAt: 3_000, ok: true, input: { command: 'deploy --token sk-ant-api03-secretsecretsecret' }, output: 'done' }],
  own: true,
  content: true,
  place: 'worktree',
  subagents: 0,
  compactions: 0,
  promptChars: 10,
  answerChars: 10,
  text: { prompt: 'ship it with hunter2-secret', answer: 'shipped' },
  ...over,
});

/** A tiny protobuf reader: each field's number and its value (bytes as nested reads where asked). */
function fields(buf: Uint8Array): Array<{ n: number; wire: number; value: bigint | Uint8Array }> {
  const out: Array<{ n: number; wire: number; value: bigint | Uint8Array }> = [];
  let i = 0;
  const varint = (): bigint => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      const b = buf[i++]!;
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(varint());
    const n = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) out.push({ n, wire, value: varint() });
    else if (wire === 1) {
      out.push({ n, wire, value: buf.slice(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      out.push({ n, wire, value: buf.slice(i, i + len) });
      i += len;
    } else throw new Error(`wire ${wire}`);
  }
  return out;
}
const sub = (buf: Uint8Array, ...path: number[]): Uint8Array[] => {
  let level = [buf];
  for (const n of path) level = level.flatMap((b) => fields(b).filter((f) => f.n === n).map((f) => f.value as Uint8Array));
  return level;
};
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('the tools and what they need', () => {
  it('lists Ratel first and every tool once, each with somewhere to find its key', () => {
    expect(TRACE_PROVIDERS[0]!.id).toBe('ratel');
    expect(TRACE_PROVIDERS.map((p) => p.id)).toEqual([...TRACE_PROVIDER_IDS]);
    for (const p of TRACE_PROVIDERS) {
      expect(p.where.length).toBeGreaterThan(5);
      expect(p.docs).toMatch(/^https:\/\//);
      // Any endpoint of your own is nobody's product.
      if (p.id === 'otlp') expect(p.site).toBeUndefined();
      else expect(p.site).toMatch(/^https:\/\//);
      expect(p.fields.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['ratel', { key: 'rtl_abc' }, 'https://cloud.ratel.sh/v1/traces', { authorization: 'Bearer rtl_abc' }],
    ['braintrust', { key: 'sk-1', project: 'Agents', region: 'eu' }, 'https://api-eu.braintrust.dev/otel/v1/traces', { authorization: 'Bearer sk-1', 'x-bt-parent': 'project_name:Agents' }],
    ['posthog', { key: 'phc_1', region: 'eu' }, 'https://eu.i.posthog.com/i/v0/ai/otel', { authorization: 'Bearer phc_1' }],
    ['langsmith', { key: 'lsv2_1', project: 'beluga' }, 'https://api.smith.langchain.com/otel/v1/traces', { 'x-api-key': 'lsv2_1', 'langsmith-project': 'beluga' }],
    ['langsmith', { key: 'lsv2_1', region: 'apac' }, 'https://apac.api.smith.langchain.com/otel/v1/traces', { 'x-api-key': 'lsv2_1' }],
    ['logfire', { key: 'pylf_1', region: 'eu' }, 'https://logfire-eu.pydantic.dev/v1/traces', { authorization: 'pylf_1' }],
    ['newrelic', { key: 'nr1', region: 'eu' }, 'https://otlp.eu01.nr-data.net/v1/traces', { 'api-key': 'nr1' }],
    ['datadog', { key: 'dd1', region: 'datadoghq.eu' }, 'https://otlp.datadoghq.eu/v1/traces', { 'dd-api-key': 'dd1', 'dd-otlp-source': 'llmobs', 'dd-llmobs-enabled': 'true', 'dd-ml-app': 'beluga' }],
    ['langfuse', { publicKey: 'pk-lf-1', key: 'sk-lf-2' }, 'https://cloud.langfuse.com/api/public/otel/v1/traces', { authorization: `Basic ${Buffer.from('pk-lf-1:sk-lf-2').toString('base64')}`, 'x-langfuse-ingestion-version': '4' }],
    ['langfuse', { publicKey: 'p', key: 's', region: 'self', url: 'https://lf.example.com/' }, 'https://lf.example.com/api/public/otel/v1/traces', undefined],
    ['databricks', { host: 'dbc-1.cloud.databricks.com/some/page', key: 'dapi1', table: 'main.obs.beluga_otel_spans' }, 'https://dbc-1.cloud.databricks.com/api/2.0/otel/v1/traces', { authorization: 'Bearer dapi1', 'x-databricks-uc-table-name': 'main.obs.beluga_otel_spans' }],
    ['otlp', { url: 'http://localhost:4318', headers: 'x-team=a\nauthorization: Bearer t' }, 'http://localhost:4318/v1/traces', { 'x-team': 'a', authorization: 'Bearer t' }],
  ] as const)('%s: %j → its address and headers', (id, f, url, headers) => {
    const t = traceTarget(id, f);
    expect('error' in t ? t.error : t.traces).toBe(url);
    if (headers && !('error' in t)) expect(t.headers).toEqual(headers);
  });

  it('Arize AX takes its space and key, and its project as the resource; Phoenix takes an address', () => {
    const ax = traceTarget('arize', { key: 'ak', space: 'sp', project: 'mine' });
    expect(ax).toMatchObject({ traces: 'https://otlp.arize.com/v1/traces', headers: { 'arize-api-key': 'ak', 'arize-space-id': 'sp', 'x-project-name': 'mine' }, resource: { 'openinference.project.name': 'mine' } });
    expect(traceTarget('arize', { region: 'phoenix', url: 'http://localhost:6006' })).toMatchObject({ traces: 'http://localhost:6006/v1/traces', headers: { 'x-project-name': 'beluga' } });
  });

  it('a Sentry DSN becomes its project’s OTLP endpoint, keeping its region', () => {
    expect(sentryTarget('https://abc123@o42.ingest.us.sentry.io/7')).toEqual({ traces: 'https://o42.ingest.us.sentry.io/api/7/integration/otlp/v1/traces', headers: { 'x-sentry-auth': 'sentry sentry_key=abc123' } });
    expect(sentryTarget('not a dsn')).toHaveProperty('error');
    expect(sentryTarget('https://o42.ingest.sentry.io/7')).toHaveProperty('error');
  });

  it('says what is missing, and never sends a key over plain http to another computer', () => {
    expect(traceTarget('ratel', {})).toHaveProperty('error');
    expect(traceTarget('braintrust', { key: 'k' })).toHaveProperty('error');
    expect(traceTarget('otlp', { url: 'http://collector.example.com' })).toHaveProperty('error');
    expect(traceTarget('nope', { key: 'k' })).toHaveProperty('error');
    expect(parseHeaders('just words')).toHaveProperty('error');
    // A bad header line is never repeated back: it may hold a key.
    expect(JSON.stringify(parseHeaders('authorization Bearer sk-live-abcdef'))).not.toContain('sk-live');
    // Odd input never throws into a run: it's just not ready.
    expect(traceTarget('sentry', { dsn: 'https://%zz@o1.ingest.sentry.io/2' })).toHaveProperty('traces');
    expect(traceTarget('langfuse', { publicKey: 'pk-ünïcode', key: 'sk-✓' })).toHaveProperty('traces');
    expect(parseHeaders('a=1, b=2')).toEqual({ a: '1', b: '2' });
  });

  it('the API takes only known tools and field names', () => {
    expect(() => parseArgs('traces.save', [{ id: 'ratel', fields: { key: 'x' } }])).not.toThrow();
    expect(() => parseArgs('traces.save', [{ id: 'evil', fields: {} }])).toThrow();
    expect(() => parseArgs('traces.save', [{ id: 'ratel', fields: { 'bad key': 'x' } }])).toThrow();
  });
});

describe('traces as protobuf', () => {
  it('encodes the same spans as the JSON, ids as bytes', () => {
    const spans = turnSpans(turn(), 'install');
    const bytes = tracesProto(tracesRequest({ installId: 'i', version: '3.8.0' }, spans, { 'openinference.project.name': 'p' }));
    const encoded = sub(bytes, 1, 2, 2);
    expect(encoded).toHaveLength(spans.length);
    const first = encoded[0]!;
    expect(Buffer.from(sub(first, 1)[0]!).toString('hex')).toBe(spans[0]!.traceId);
    expect(text(sub(first, 5)[0]!)).toBe(spans[0]!.name);
    const resourceKeys = sub(bytes, 1, 1, 1, 1).map(text);
    expect(resourceKeys).toContain('service.name');
    expect(resourceKeys).toContain('openinference.project.name');
    const keys = encoded.flatMap((s) => sub(s, 9, 1).map(text));
    expect(keys).toContain('gen_ai.operation.name');
  });
});

describe('the keys, kept with your other secrets', () => {
  it('saves a tool, keeps a saved key when it is left empty, masks it, and forgets it on remove', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'traces-')), 'env.json');
    const env = new EnvVars({ store: new Store(initialState('test', 'ask')), file });
    env.saveTraceDestination({ id: 'braintrust', fields: { key: 'sk-braintrust-123456', project: 'Agents' } });
    env.saveTraceDestination({ id: 'braintrust', fields: { key: '', project: 'Renamed' }, text: false });
    expect(env.traceDestinations()).toEqual([{ id: 'braintrust', on: true, text: false, fields: { key: 'sk-braintrust-123456', project: 'Renamed', region: 'us' } }]);
    expect(env.secretValues()).toContain('sk-braintrust-123456');
    expect(env.secretValues()).not.toContain('Renamed');
    const id = env.tracesId();
    expect(JSON.parse(readFileSync(file, 'utf8')).tracesId).toBe(id);
    expect(new EnvVars({ store: new Store(initialState('test', 'ask')), file }).traceDestinations()).toHaveLength(1);
    // A key never follows a changed address unasked: it has to be typed again.
    env.saveTraceDestination({ id: 'otlp', fields: { url: 'https://collector.mine.example', headers: 'authorization=Bearer mine-123456' } });
    env.saveTraceDestination({ id: 'otlp', fields: { url: 'https://elsewhere.example', headers: '' } });
    expect(env.traceDestinations().find((d) => d.id === 'otlp')?.fields).toEqual({ url: 'https://elsewhere.example' });
    env.removeTraceDestination('otlp');
    env.removeTraceDestination('braintrust');
    expect(env.traceDestinations()).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toContain('sk-braintrust-123456');
  });
});

/** An in-memory env.json for the destinations. */
function memoryStore(): DestinationStore & { list: () => readonly unknown[] } {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'traces-')), 'env.json');
  const env = new EnvVars({ store: new Store(initialState('test', 'ask')), file });
  return Object.assign(env, { list: () => env.traceDestinations() });
}

const recorder = (status = 200) => {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Uint8Array }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array });
    return new Response('', { status });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch, all: () => sent.map((s) => Buffer.from(s.body).toString('latin1')).join('\n') };
};

describe('the destinations', () => {
  const masked = (t: TurnFacts): TurnFacts => ({ ...t, ...(t.text ? { text: { prompt: t.text.prompt.replace('hunter2-secret', '[secret]'), answer: t.text.answer } } : {}) });

  it('Settings sees only which keys are saved, never them', () => {
    const store = memoryStore();
    const d = new TraceDestinations({ store, version: '1', mask: (t) => t });
    const views = d.save({ id: 'langfuse', fields: { publicKey: 'pk-lf-1', key: 'sk-lf-secret' } });
    expect(views).toEqual([{ id: 'langfuse', on: true, text: true, fields: { publicKey: 'pk-lf-1', region: 'eu' }, saved: ['key'], state: 'waiting' }]);
    expect(JSON.stringify(views)).not.toContain('sk-lf-secret');
  });

  it('sends each turn as protobuf, with its headers, masked; text off leaves your words out', async () => {
    const store = memoryStore();
    const { sent, fetch, all } = recorder();
    const d = new TraceDestinations({ store, version: '1', mask: masked, fetch });
    d.save({ id: 'ratel', fields: { key: 'rtl_mine_1234567890' } });
    d.save({ id: 'newrelic', fields: { key: 'nr-license' }, text: false });
    expect(d.active).toBe(true);
    d.turn(turn());
    await d.stop();
    const ratel = sent.find((s) => s.url.includes('ratel'))!;
    expect(ratel.headers).toMatchObject({ 'content-type': 'application/x-protobuf', authorization: 'Bearer rtl_mine_1234567890' });
    const ratelBody = Buffer.from(ratel.body).toString('latin1');
    expect(ratelBody).toContain('[secret]');
    expect(ratelBody).not.toContain('hunter2-secret');
    const nr = Buffer.from(sent.find((s) => s.url.includes('nr-data'))!.body).toString('latin1');
    expect(nr).toContain('gen_ai');
    expect(nr).not.toContain('ship it');
    expect(nr).not.toContain('deploy --token');
    expect(all()).toContain('gpt-5.5');
  });

  it('a key a tool refuses stops it and says so, until it is saved again', async () => {
    const store = memoryStore();
    const { sent, fetch } = recorder(401);
    const d = new TraceDestinations({ store, version: '1', mask: (t) => t, fetch });
    d.save({ id: 'ratel', fields: { key: 'rtl_revoked_1234567' } });
    d.turn(turn());
    await d.stop();
    expect(d.views()[0]).toMatchObject({ state: 'refused' });
    // Refused: runs aren't watched for it any more.
    expect(d.active).toBe(false);
    d.turn(turn());
    await d.stop();
    expect(sent).toHaveLength(1);
    expect(d.save({ id: 'ratel', fields: { key: 'rtl_fresh_12345678' } })[0]).toMatchObject({ state: 'waiting' });
  });

  it('a tool switched off, or missing a field, sends nothing and runs are not watched for it', () => {
    const store = memoryStore();
    const d = new TraceDestinations({ store, version: '1', mask: (t) => t });
    d.save({ id: 'ratel', fields: { key: 'rtl_x_1234567890123' }, on: false });
    d.save({ id: 'braintrust', fields: { key: 'sk-1' } });
    expect(d.active).toBe(false);
    expect(d.views().map((v) => v.state)).toEqual(['off', 'invalid']);
  });

  it('Send Test posts one trace with what is typed, falling back to the saved key, and says how it went', async () => {
    const store = memoryStore();
    const { sent, fetch } = recorder(200);
    const d = new TraceDestinations({ store, version: '1', mask: (t) => t, fetch });
    d.save({ id: 'langsmith', fields: { key: 'lsv2_saved' } });
    const result = await d.test('langsmith', { key: '', project: 'Typed' });
    expect(result.ok).toBe(true);
    expect(sent[0]).toMatchObject({ url: 'https://api.smith.langchain.com/otel/v1/traces', headers: { 'x-api-key': 'lsv2_saved', 'langsmith-project': 'Typed' } });
    expect(Buffer.from(sent[0]!.body).toString('latin1')).toContain('Beluga test');
    expect(store.list()).toEqual([expect.objectContaining({ fields: { key: 'lsv2_saved', region: 'us' } })]);
    expect((await d.test('ratel', {})).ok).toBe(false);
    // PostHog takes any trace and checks the key later: the test says so instead of promising.
    expect((await d.test('posthog', { key: 'phc_maybe' })).words).toMatch(/checks the key only later/);
    // Nor in a test: a typed address with the key left empty sends no saved key there.
    d.save({ id: 'otlp', fields: { url: 'https://collector.mine.example', headers: 'x-key=saved-secret-1' } });
    await d.test('otlp', { url: 'https://other.example', headers: '' });
    expect(sent.at(-1)).toMatchObject({ url: 'https://other.example/v1/traces' });
    expect(JSON.stringify(sent.at(-1)!.headers)).not.toContain('saved-secret-1');
  });

  it('withoutText drops the prompt, the answer, questions and tools’ input and output', () => {
    const t = withoutText(turn({ waits: [{ kind: 'question', tool: 'AskUserQuestion', startedAt: 1, endedAt: 2, outcome: 'answered', question: 'which db?' }] }));
    expect(JSON.stringify(t)).not.toMatch(/ship it|deploy|done|which db/);
    expect(t.content).toBe(false);
  });
});

describe('beside usage statistics', () => {
  const backend: AgentBackend = {
    run: async (input: AgentRunInput) => {
      input.onEvent('usage', JSON.stringify({ input: 5, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0.01 }));
      return 'all done';
    },
  } as unknown as AgentBackend;
  const run = (deps: ReturnType<TelemetryService['observeDeps']>, over: Partial<AgentRunInput> = {}) =>
    observedBackend(backend, 'codex', { ...deps, settleMs: 0 }).run({ prompt: 'p', ownWords: 'my own words', requesterName: 'k', viaAgent: false, context: [], scope: 'folder', onEvent: () => undefined, onFileTouched: () => undefined, ...over } as unknown as AgentRunInput);

  const setup = () => {
    const { sent, fetch } = recorder(202);
    const store = new Store(initialState('test', 'ask'));
    const destinations = memoryStore();
    const service = new TelemetryService({ store, version: '1', file: null, secrets: () => [], fetch, destinations, config: { url: 'https://ratel.example', key: 'rtl_pub_beluga_12345' } });
    return { service, sent, store, to: (host: string) => sent.filter((s) => s.url.includes(host)) };
  };

  it('with usage statistics off, a destination still gets every turn, and Beluga gets nothing', async () => {
    const { service, to } = setup();
    service.choose('off', 'settings');
    expect(service.capture).toBe('off');
    service.traces!.save({ id: 'datadog', fields: { key: 'dd-key-123456' } });
    expect(service.capture).toBe('on');
    await run(service.observeDeps());
    await service.stop();
    expect(to('otlp.datadoghq.com')).toHaveLength(1);
    expect(Buffer.from(to('otlp.datadoghq.com')[0]!.body).toString('latin1')).toContain('my own words');
    expect(to('ratel.example')).toHaveLength(0);
  });

  it('a project left out of usage statistics still reaches your own tools, and never Beluga’s', async () => {
    const { service, store, to } = setup();
    service.choose('on', 'settings');
    store.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'app', root: '/code/app', base: 'origin/main', workspaces: [] }] as never });
    service.exclude('/code/app', true);
    const place = { cwd: '/code/app/src', additionalDirectories: [], autoEdit: true, onSession: () => undefined } as unknown as AgentRunInput['place'];
    service.traces!.save({ id: 'ratel', fields: { key: 'rtl_mine_1234567890' } });
    await run(service.observeDeps(), { place });
    await service.stop();
    expect(to('cloud.ratel.sh')).toHaveLength(1);
    expect(to('ratel.example').map((s) => String(s.body)).join('')).not.toContain('invoke_agent');
  });

  it('without a destination, usage statistics are just as before', () => {
    const { service } = setup();
    service.choose('limited', 'settings');
    expect(service.capture).toBe('limited');
    expect(service.observeDeps().env?.('claude')).toBeUndefined();
  });
});
