import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CAPABILITIES } from '../src/agent/runtime/claude/index.js';
import { CODEX_CAPABILITIES } from '../src/agent/runtime/codex/index.js';
import type { AgentRuntime, RuntimeOptions } from '../src/agent/runtime/types.js';
import type { AgentBackend } from '../src/agent/types.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { PeerClient } from '../src/net/peer-client.js';

/**
 * #442: Settings › Agent › MCP servers checks your servers with the variables you saved in
 * Settings › Environment, as your own runs get them, so a token kept there isn't reported missing.
 */

const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-mcp-env-')));

function runtime(id: string, made: RuntimeOptions[]): AgentRuntime {
  return {
    id,
    label: id,
    capabilities: id === 'codex' ? CODEX_CAPABILITIES : CLAUDE_CAPABILITIES,
    create: (opts) => {
      made.push(opts);
      return { run: async () => `${id} ran` } as AgentBackend;
    },
    complete: async () => 'ok',
  };
}

describe("Settings' MCP check gets your saved variables (#442)", () => {
  it('hands every runtime a way to read them where the check starts, read fresh each time', () => {
    const made: RuntimeOptions[] = [];
    const runtimes = [runtime('claude', made), runtime('codex', made)];
    const root = tmp();
    const s = new Session({
      client: new PeerClient({ url: 'ws://127.0.0.1:1', keys: deriveKeys(generateSecret()), profile: { name: 'kay', shares: [], agent: true } }),
      store: new Store(initialState('room')),
      shares: new ShareService([]),
      agentCwd: root,
      runtime: { runtimes: (id = 'claude') => runtimes.find((r) => r.id === id), options: { cwd: root, autoEdit: false, additionalDirectories: [] } },
    });
    expect(s.backendFor('codex')).toBeDefined();
    expect(made.length).toBeGreaterThanOrEqual(2);
    for (const opts of made) expect(opts.ownEnv).toBeTypeOf('function');

    s.env.set(undefined, [{ key: 'GITHUB_PAT_TOKEN', value: 'saved-token' }]);
    for (const opts of made) expect(opts.ownEnv?.(root)).toMatchObject({ GITHUB_PAT_TOKEN: 'saved-token' });
    // Changed in Settings: the next check sees the new value, no restart.
    s.env.set(undefined, []);
    for (const opts of made) expect(opts.ownEnv?.(root)).not.toHaveProperty('GITHUB_PAT_TOKEN');
  });
});
