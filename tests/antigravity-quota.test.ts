import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgyConnection } from '../src/agent/runtime/antigravity/connection.js';
import { type AgyQuotaSummary, type AgyUserStatus, fromQuotaSummary, fromUserStatus, portFromLog, readAgyQuota } from '../src/agent/runtime/antigravity/quota.js';
import { createAgyBackend } from '../src/agent/runtime/antigravity/runner.js';
import { dropAgyLog } from '../src/agent/runtime/antigravity/connection.js';
import { AGY_LOG_DAYS, tidyAgyData } from '../src/agent/runtime/antigravity/sessions.js';
import type { RoomBridge } from '../src/agent/types.js';
import { room } from './runtime-conformance.js';

const RESET = '2026-11-19T22:26:56Z';
const LATER = '2026-11-19T22:44:42Z';

/** The shapes GetUserStatus answered with (Antigravity 2.33, CLI 1.5.12), trimmed. */
const status: AgyUserStatus = {
  userTier: { name: 'Google AI Ultra' },
  planStatus: { planInfo: { planName: 'Pro' } },
  cascadeModelConfigData: {
    clientModelConfigs: [
      { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', quotaInfo: { remainingFraction: 0.9786179, resetTime: RESET } },
      { label: 'Orchestrator (Carbon)', modelId: 'gemini-pro-orchestrator', quotaInfo: { remainingFraction: 0.9786179, resetTime: RESET } },
      { label: 'Gemini 3.8 Flash (Low)', modelId: 'gemini-3.8-flash-low', quotaInfo: { remainingFraction: 0.5, resetTime: RESET } },
      { label: 'Claude Opus 5.5 (High)', modelId: 'claude-opus-5-5-high', quotaInfo: { remainingFraction: 1, resetTime: LATER } },
      // Used up: protobuf's JSON leaves a 0 out.
      { label: 'GPT-OSS 120B (Medium)', modelId: 'gpt-oss-120b-medium', quotaInfo: { resetTime: LATER } },
      { label: 'Some Model', modelId: 'other-thing' },
    ],
  },
};

const WEEK = '2026-11-26T17:26:56Z';

/** What RetrieveUserQuotaSummary answered (Antigravity CLI 1.5.12), trimmed: each group of models with its 5-hour and weekly limits. */
const summary: AgyQuotaSummary = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.92214495, resetTime: WEEK },
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.73432255, resetTime: RESET },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      // Used up this week: protobuf's JSON leaves the 0 out.
      buckets: [
        { bucketId: '3p-weekly', window: 'weekly', resetTime: WEEK },
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: LATER },
      ],
    },
  ],
};

describe('Antigravity quota', () => {
  it('reads each group’s 5-hour and weekly limits, as its own quota panel shows them', () => {
    expect(fromQuotaSummary(summary, status)).toEqual({
      plan: 'AI Ultra',
      windows: [
        { group: 'Gemini Models', label: '5-hour', pct: 27, resetsAt: Date.parse(RESET) },
        { group: 'Gemini Models', label: 'Weekly', pct: 8, resetsAt: Date.parse(WEEK) },
        { group: 'Claude and GPT models', label: '5-hour', pct: 0, resetsAt: Date.parse(LATER) },
        { group: 'Claude and GPT models', label: 'Weekly', pct: 100, resetsAt: Date.parse(WEEK) },
      ],
    });
    // Nothing it names: an older CLI, read per model family instead.
    expect(fromQuotaSummary({ groups: [] }, status)).toBeUndefined();
    expect(fromQuotaSummary(undefined)).toBeUndefined();
  });

  it('asks for the summary, and falls back to one window per family when the CLI has none', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-log-'));
    try {
      const pid = 4343;
      writeFileSync(path.join(dir, `acp-server-20261120_004854-${pid}.log`), 'Language server listening on random port at 52378 for HTTP\n');
      const conn = () => ({ rpc: { request: async () => ({ sessionId: 'abc' }) }, proc: { pid, alive: () => true, kill: async () => undefined, exited: Promise.resolve() } }) as unknown as AgyConnection;
      const answer = (withSummary: boolean) => async (url: string) =>
        url.endsWith('/RetrieveUserQuotaSummary') ? (withSummary ? new Response(JSON.stringify({ response: summary })) : new Response('{}', { status: 404 })) : new Response(JSON.stringify({ userStatus: status }));
      const both = await readAgyQuota({ connect: async () => conn(), logDir: dir, fetch: answer(true) as unknown as typeof globalThis.fetch, drop: async () => true });
      expect(both?.windows?.map((w) => `${w.group} ${w.label}`)).toEqual(['Gemini Models 5-hour', 'Gemini Models Weekly', 'Claude and GPT models 5-hour', 'Claude and GPT models Weekly']);
      expect(both?.plan).toBe('AI Ultra');
      const older = await readAgyQuota({ connect: async () => conn(), logDir: dir, fetch: answer(false) as unknown as typeof globalThis.fetch, drop: async () => true });
      expect(older?.windows?.map((w) => w.label)).toEqual(['Gemini', 'Claude', 'GPT-OSS']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('one window per model family, its tightest model’s, and the tier as the plan', () => {
    expect(fromUserStatus(status)).toEqual({
      plan: 'AI Ultra',
      windows: [
        { label: 'Gemini', pct: 50, resetsAt: Date.parse(RESET) },
        { label: 'Claude', pct: 0, resetsAt: Date.parse(LATER) },
        { label: 'GPT-OSS', pct: 100, resetsAt: Date.parse(LATER) },
      ],
    });
  });

  it('says nothing without a model that has a quota', () => {
    expect(fromUserStatus(undefined)).toBeUndefined();
    expect(fromUserStatus({ cascadeModelConfigData: { clientModelConfigs: [{ label: 'X', modelId: 'x' }] } })).toBeUndefined();
  });

  it('keeps at most six families', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `Fam${i} (Low)`, modelId: `fam${i}-low`, quotaInfo: { remainingFraction: 1 } }));
    expect(fromUserStatus({ cascadeModelConfigData: { clientModelConfigs: many } })?.windows).toHaveLength(6);
  });

  it('reads the HTTP port from its log, never the HTTPS one', () => {
    const log = ['I1120 server.go:1274] Language server listening on random port at 50007 for HTTPS (gRPC)', 'I1120 server.go:1282] Language server listening on random port at 50008 for HTTP', ''].join('\n');
    expect(portFromLog(log)).toBe(50008);
    expect(portFromLog('Language server listening on random port at 50007 for HTTPS (gRPC)\n')).toBeUndefined();
  });

  it('opens a conversation, asks its language server, then stops it and drops the conversation', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-log-'));
    try {
      const pid = 4242;
      writeFileSync(path.join(dir, `acp-server-20261120_004854-${pid}.log`), 'Language server listening on random port at 52377 for HTTP\n');
      const kill = vi.fn(async () => undefined);
      const conn = { rpc: { request: async () => ({ sessionId: 'abc' }) }, proc: { pid, alive: () => true, kill, exited: Promise.resolve() } } as unknown as AgyConnection;
      const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ userStatus: status })));
      const drop = vi.fn(async () => true);
      const update = await readAgyQuota({ connect: async () => conn, logDir: dir, fetch: fetch as unknown as typeof globalThis.fetch, drop });
      expect(update?.windows?.map((w) => w.label)).toEqual(['Gemini', 'Claude', 'GPT-OSS']);
      expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:52377/exa.language_server_pb.LanguageServerService/GetUserStatus');
      expect(kill).toHaveBeenCalled();
      expect(drop).toHaveBeenCalledWith('abc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a refresh files it under Antigravity, never Claude', async () => {
    const reportUsage = vi.fn();
    const bridge = Object.assign(Object.create(room) as RoomBridge, { reportUsage });
    const backend = createAgyBackend({ cwd: os.tmpdir(), autoEdit: false, additionalDirectories: [], bridge, readQuota: async () => fromUserStatus(status) });
    expect(await backend.refreshUsage?.()).toBeUndefined();
    expect(reportUsage).toHaveBeenCalledWith(expect.objectContaining({ plan: 'AI Ultra', signedIn: true }), { runtime: 'antigravity', label: 'Antigravity' });
  });

  it('removes a look’s own log once it has stopped, and only that one', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-log-'));
    try {
      for (const n of ['acp-server-20261120_004854-4242.log', 'acp-server-20261120_004855-14242.log', 'cli-20261120_004854-4242.log']) writeFileSync(path.join(dir, n), 'x');
      expect(await dropAgyLog(4242, dir)).toBe(1);
      expect(existsSync(path.join(dir, 'acp-server-20261120_004854-4242.log'))).toBe(false);
      expect(existsSync(path.join(dir, 'acp-server-20261120_004855-14242.log'))).toBe(true);
      expect(existsSync(path.join(dir, 'cli-20261120_004854-4242.log'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tidies what earlier looks left: journals of gone conversations, and old acp logs', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-data-'));
    try {
      const now = Date.parse('2026-11-20T00:00:00Z');
      const conv = path.join(dir, 'conversations');
      const logs = path.join(dir, 'log');
      mkdirSync(conv);
      mkdirSync(logs);
      const gone = '6e15d96b-cb2c-48c8-adb0-e718b9ab1dde';
      const kept = '7f26ea7c-dc3d-49d9-bec1-f829cabc2eef';
      for (const n of [`${gone}.db-wal`, `${gone}.db-shm`, `${kept}.db`, `${kept}.db-wal`, 'notes.db-wal']) writeFileSync(path.join(conv, n), 'x');
      const old = (AGY_LOG_DAYS + 1) * 24 * 60 * 60_000;
      for (const [n, age] of [['acp-server-a-1.log', old], ['acp-server-b-2.log', 60_000], ['cli-c-3.log', old]] as const) {
        writeFileSync(path.join(logs, n), 'x');
        utimesSync(path.join(logs, n), (now - age) / 1000, (now - age) / 1000);
      }
      expect(await tidyAgyData(dir, now)).toEqual({ journals: 2, logs: 1 });
      expect(existsSync(path.join(conv, `${gone}.db-wal`))).toBe(false);
      // A conversation that's still there keeps its journal; a file not named for a conversation is left.
      expect(existsSync(path.join(conv, `${kept}.db-wal`))).toBe(true);
      expect(existsSync(path.join(conv, 'notes.db-wal'))).toBe(true);
      expect(existsSync(path.join(logs, 'acp-server-a-1.log'))).toBe(false);
      expect(existsSync(path.join(logs, 'acp-server-b-2.log'))).toBe(true);
      // Its own CLI's logs are Antigravity's, never Beluga's to tidy.
      expect(existsSync(path.join(logs, 'cli-c-3.log'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
