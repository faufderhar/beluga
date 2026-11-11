import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditFile } from '../src/external/adapters/audit-file.js';
import { callTool, type ExternalToolDef } from '../src/external/adapters/mcp-tools.js';
import { fileTools } from '../src/external/adapters/tools/files.js';
import { methodTools, ALL_METHOD_ROWS } from '../src/external/adapters/tools/method-rows.js';
import { peopleTools } from '../src/external/adapters/tools/people.js';
import { EXTERNAL_ACCESS } from '../src/external/coverage.js';
import type { Grant } from '../src/external/domain/grant.js';
import { CHAT_TOOLS, DISCOVERY_TOOLS, EXTERNAL_TOOLS, PEER_TOOLS, STATE_TOOLS, WORKSPACE_TOOLS } from '../src/external/domain/tools.js';
import type { Method } from '../src/ipc/api.js';
import type { ChatRead, ChatRef } from '../src/external/ports/chat-read.js';
import type { FilesPort } from '../src/external/ports/files.js';
import type { MethodCalls } from '../src/external/ports/methods.js';

/** Each mark is in one credential that a method makes: no tool result may hold one. */
const JOIN = 'JOINSECRETmark';
const BEARER = 'BEARERTOKENmark';
const PAIRING = 'PAIRINGCODEmark';
/** A browser's session cookie: only redeeming a join link makes one, so it is the join link that must not leave. */
const MARKS = [JOIN, BEARER, PAIRING, '/join#'] as const;

/** What the methods that make a credential answer, in the shape their handlers give it. */
const MINTS: Partial<Record<Method, unknown>> = {
  'web.link': { url: `http://127.0.0.1:7777/join#${JOIN}`, expiresAt: 1 },
  'web.public': { url: 'https://x.trycloudflare.com', link: { url: `https://x.trycloudflare.com/join#${JOIN}`, expiresAt: 1 } },
  'web.tailscale': { url: 'https://mac.tail.ts.net', link: { url: `https://mac.tail.ts.net/join#${JOIN}`, expiresAt: 1 } },
  'external.pairingCode': { code: PAIRING, expiresAt: 1 },
  'external.localToken': { token: BEARER },
  'companion.pair.start': { code: PAIRING, qr: `beluga://pair/${PAIRING}` },
  'sentinel.rotateSecret': { secret: BEARER },
  'sentinel.webhookUrl': { url: `https://hooks.example/${BEARER}` },
  'invites.copyLink': `beluga://join/${JOIN}`,
  'session.copyInvite': `beluga://join/${JOIN}`,
};

const chat: ChatRef = { id: 'c1', kind: 'project', title: 'c1', projectId: 'p1', projectName: 'api', status: 'idle', createdBy: 'you', creationSource: 'beluga' };
const reads = { projects: () => [{ id: 'p1', name: 'api' }], chats: () => [chat, { ...chat, id: 'dm:bob', kind: 'dm', projectId: undefined }, { ...chat, id: 'group:g1', kind: 'group', projectId: undefined }] } as unknown as ChatRead;
const ARGS: Record<string, unknown> = { task: 'BLG-1', plan: 'pl1', sentinel: 's1', dashboard: 'd1', board: 'b1', conversation: 'dm:bob', chat: 'c1', channel: 'ws:c1', project: 'p1', where: 'p1', request: 'r1', dialogue: { channel: 'ws:c1' }, file: 'a.ts', peer: 'bob', dm: 'dm:bob', group: 'g1', text: 'hi', on: true };
const grant: Grant = { id: 'g', name: 'GrokBot', clientId: 'c', redirectHost: 'h', route: 'local', level: 'full', projects: ['p1'], chats: { dms: true, groups: true }, createdAt: 0, expiresAt: Date.now() + 60_000, lastSeen: 0 };
/** Tools that reach no API method: their own tests read what they answer. */
const NO_METHOD: ReadonlySet<string> = new Set([...CHAT_TOOLS, ...STATE_TOOLS, ...PEER_TOOLS, ...WORKSPACE_TOOLS, ...DISCOVERY_TOOLS]);

describe('a credential a method makes', () => {
  let dir: string;
  let audit: AuditFile;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-credentials-'));
    audit = new AuditFile({ file: path.join(dir, 'a.jsonl') });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const tools = (): readonly ExternalToolDef[] => {
    const calls: MethodCalls = { call: vi.fn((m: Method) => MINTS[m] ?? { ok: true }), channelOfRequest: () => 'ws:c1', projectsOf: () => ['p1'], dashboardExists: () => true, changedPlan: () => false, postAs: vi.fn(() => ({ id: 'm1' })), personName: (id: string) => id };
    return [...methodTools(ALL_METHOD_ROWS, reads, calls, () => 'g'), ...fileTools(reads, {} as FilesPort, calls), ...peopleTools(calls)];
  };

  it('walks each tool that reaches a method', () => {
    const walked = new Set(tools().map((t) => t.name));
    expect(EXTERNAL_TOOLS.filter((t) => !walked.has(t) && !NO_METHOD.has(t))).toEqual([]);
  });

  it('is in no tool result at full, after a yes', async () => {
    const deps = { audit, ask: async () => 'yes' as const, now: Date.now, always: new Set<string>(), live: () => true, cards: new Map() };
    const leaks: string[] = [];
    for (const def of tools()) {
      const out = await callTool(def, ARGS, grant, deps).catch((err: unknown) => ({ content: [{ text: String(err) }] }));
      const text = (out.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
      for (const mark of MARKS) if (text.includes(mark)) leaks.push(`${def.name}: ${mark}`);
    }
    expect(leaks).toEqual([]);
  });

  it('comes from a method that no tool reaches', () => {
    for (const m of Object.keys(MINTS) as Method[]) expect(['ui_only', 'refused'], m).toContain(typeof EXTERNAL_ACCESS[m] === 'object' ? 'refused' : EXTERNAL_ACCESS[m]);
  });
});
