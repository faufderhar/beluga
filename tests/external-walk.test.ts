import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditFile } from '../src/external/adapters/audit-file.js';
import { callTool, type ExternalToolDef } from '../src/external/adapters/mcp-tools.js';
import { fileTools } from '../src/external/adapters/tools/files.js';
import { ALL_METHOD_ROWS } from '../src/external/adapters/tools/method-rows.js';
import { peopleTools } from '../src/external/adapters/tools/people.js';
import { workspaceTools } from '../src/external/adapters/tools/workspace.js';
import { decide, type Level } from '../src/external/domain/decide.js';
import type { Grant } from '../src/external/domain/grant.js';
import { CHAT_TOOLS, DISCOVERY_TOOLS, EXTERNAL_TOOLS, PEER_TOOLS, STATE_TOOLS, TOOL_ACCESS, WORKSPACE_TOOLS } from '../src/external/domain/tools.js';
import type { ChatControl } from '../src/external/ports/chat-control.js';
import type { ChatRead } from '../src/external/ports/chat-read.js';
import type { FilesPort } from '../src/external/ports/files.js';
import type { MethodCalls } from '../src/external/ports/methods.js';
import type { WorkspacePort } from '../src/external/ports/workspace.js';

const LEVELS: readonly Level[] = ['blocked', 'ask', 'trusted', 'full'];
const PHONE_ACTS = ['phone_tap', 'phone_swipe', 'phone_type', 'phone_key', 'phone_scroll', 'phone_open', 'phone_install', 'phone_setup_link', 'phone_shell', 'phone_logcat', 'phone_push', 'phone_pull', 'phone_macro_save', 'phone_macro_list', 'phone_macro_run', 'phone_macro_delete'] as const;
const PEOPLE_WRITES = ['dm_send', 'group_send', 'conversation_post'] as const;
/** Arguments that any of these tools can read: a stub is what they reach. */
const ARGS = { peer: 'a'.repeat(32), group: 'b'.repeat(32), conversation: `dm:${'a'.repeat(32)}`, text: 'hello', x: 1, y: 2, key: 'home', dir: 'down', path: '/tmp/ok.apk', command: 'ls', name: 'flow', steps: [{ tap: { x: 1, y: 2 } }], package: 'com.example' };
const grant = (level: Level): Grant => ({ id: 'g', name: 'GrokBot', clientId: 'c', redirectHost: 'h', route: 'local', level, projects: ['p1'], chats: { dms: true, groups: true }, createdAt: 0, expiresAt: Date.now() + 60_000, lastSeen: 0 });

const reads = { projects: () => [], chats: () => [], runtimes: async () => [] } as unknown as ChatRead;
const noCalls: MethodCalls = { call: () => undefined, postAs: () => undefined, personName: (id) => id, channelOfRequest: () => undefined, projectsOf: () => undefined, dashboardExists: () => false, changedPlan: () => false };

/** Names in a walk, and those the milestone did not add: their tests are from when each came. */
const WALKED: ReadonlySet<string> = new Set([
  ...ALL_METHOD_ROWS.map((r) => r.name), // tests/external-methods.test.ts
  ...fileTools(reads, {} as FilesPort, noCalls).map((t) => t.name), // tests/external-files.test.ts
  ...PHONE_ACTS,
  ...PEOPLE_WRITES,
]);
// beluga_find and beluga_call: tests/external-discover.test.ts.
const OLDER: ReadonlySet<string> = new Set([...DISCOVERY_TOOLS, ...CHAT_TOOLS, ...STATE_TOOLS, ...PEER_TOOLS, ...WORKSPACE_TOOLS.filter((t) => !(PHONE_ACTS as readonly string[]).includes(t))]);
const notWalked = (names: readonly string[]): string[] => names.filter((n) => !WALKED.has(n) && !OLDER.has(n));

describe('the last tools at each level', () => {
  let dir: string;
  let audit: AuditFile;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-walk-'));
    audit = new AuditFile({ file: path.join(dir, 'a.jsonl') });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const setup = (answer: 'yes' | 'no') => {
    const phoneCall = vi.fn(async () => 'done');
    // Each method of the phone is the same recorded stub.
    const phone = new Proxy({}, { get: () => phoneCall });
    const port = { phone: () => phone, phoneOff: () => false, phoneUse: () => 'use', mac: () => ({}) } as unknown as WorkspacePort;
    const posted = vi.fn(() => ({ id: 'm1' }));
    const tools: readonly ExternalToolDef[] = [...workspaceTools(reads, port, {} as ChatControl), ...peopleTools({ ...noCalls, postAs: posted })];
    const cards: boolean[] = [];
    const deps = { audit, ask: async (_t: string, _d: string, once: boolean) => { cards.push(once); return answer; }, now: Date.now, always: new Set<string>(), live: () => true, cards: new Map() };
    const use = async (name: string, level: Level) => JSON.parse(((await callTool(tools.find((t) => t.name === name)!, ARGS, grant(level), deps)).content[0] as { text: string }).text) as { error?: string };
    return { use, cards, ran: () => phoneCall.mock.calls.length + posted.mock.calls.length };
  };

  describe.each(LEVELS)('at level %s', (level) => {
    it.each([...PHONE_ACTS, ...PEOPLE_WRITES])('%s follows the decision table', async (name) => {
      const rule = decide({ operation: TOOL_ACCESS[name], level, inScope: true });
      const refused = setup('no');
      const out = await refused.use(name, level);
      if (rule.outcome === 'deny') expect(out.error).toBe(rule.denial);
      if (rule.outcome === 'ask' || rule.outcome === 'ask-once') {
        expect(out.error).toBe('declined');
        expect(refused.cards).toEqual([rule.outcome === 'ask-once']);
      }
      if (rule.outcome === 'allow') {
        expect(refused.cards).toEqual([]);
        expect(refused.ran()).toBeGreaterThan(0);
        return;
      }
      // No handler runs on a refusal or a no.
      expect(refused.ran()).toBe(0);
      if (rule.outcome === 'deny') return;
      const allowed = setup('yes');
      await allowed.use(name, level);
      expect(allowed.ran()).toBeGreaterThan(0);
    });
  });

  it('leaves no tool out: each name is in a walk, or came before this milestone', () => {
    expect(notWalked(EXTERNAL_TOOLS)).toEqual([]);
    expect(PHONE_ACTS.length + PEOPLE_WRITES.length).toBe(19);
  });

  it('fails on a planted name that is in no walk', () => {
    expect(notWalked([...EXTERNAL_TOOLS, 'planted_tool'])).toEqual(['planted_tool']);
  });
});
