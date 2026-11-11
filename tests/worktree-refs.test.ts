import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { Store, initialState } from '../src/core/store.js';
import type { Project } from '../src/workspaces/types.js';
import { waitFor } from './helpers.js';
import { readInline } from '../src/shared/render/inline-model.js';
import { codeWorktreeRefs, explainWorktreeRefs, splitWorktreeRefs, worktreeRef, type WorktreeFacts } from '../src/shared/worktree-refs.js';

const ID = 'wt-1a2b3c4d5e6f';
const has = (id: string): boolean => id === ID;
const facts: Record<string, WorktreeFacts> = {
  [ID]: { name: 'Fix the login', project: 'Beluga', branch: 'beluga/fix-login', path: '/Users/me/.beluga/workspaces/beluga/fix-login' },
};
const find = (id: string): WorktreeFacts | undefined => facts[id];

describe('worktree refs (BLG-878)', () => {
  it('Copy Link copies a ref the chip reads', () => {
    expect(worktreeRef(ID)).toBe(`worktree:${ID}`);
    expect(readInline(worktreeRef(ID))).toEqual({ kind: 'worktree', id: ID });
  });

  it('a bare ref you have is put in ticks, so it draws as the chip', () => {
    expect(codeWorktreeRefs(`look at worktree:${ID} please`, has)).toBe(`look at \`worktree:${ID}\` please`);
    expect(codeWorktreeRefs(`worktree:${ID}.`, has)).toBe(`\`worktree:${ID}\`.`);
    expect(codeWorktreeRefs(`(worktree:${ID})`, has)).toBe(`(\`worktree:${ID}\`)`);
  });

  it('leaves code, links, URLs, unknown ids and refs inside words alone', () => {
    for (const text of [
      `\`worktree:${ID}\``,
      '```\nworktree:' + ID + '\n```',
      `[it](https://x.dev/worktree:${ID})`,
      `https://x.dev/worktree:${ID}`,
      'worktree:wt-000000000000',
      `myworktree:${ID}`,
      `a/worktree:${ID}`,
    ])
      expect(codeWorktreeRefs(text, has)).toBe(text);
  });

  it('cuts the words in the box around the refs it knows, for their chips', () => {
    expect(splitWorktreeRefs(`compare with worktree:${ID}, and\nworktree:${ID}`, has)).toEqual([{ text: 'compare with ' }, { raw: `worktree:${ID}`, id: ID }, { text: ', and\n' }, { raw: `worktree:${ID}`, id: ID }]);
    expect(splitWorktreeRefs('worktree:wt-000000000000 here', has)).toEqual([{ text: 'worktree:wt-000000000000 here' }]);
    expect(splitWorktreeRefs('', has)).toEqual([]);
  });

  it('tells Claude which worktree a ref is', () => {
    expect(explainWorktreeRefs(`compare with worktree:${ID}`, find)).toBe(`compare with worktree:${ID} (worktree “Fix the login” in Beluga, branch beluga/fix-login, folder /Users/me/.beluga/workspaces/beluga/fix-login)`);
    expect(explainWorktreeRefs(`see \`worktree:${ID}\`.`, find)).toBe(`see \`worktree:${ID}\` (worktree “Fix the login” in Beluga, branch beluga/fix-login, folder /Users/me/.beluga/workspaces/beluga/fix-login).`);
  });

  it('leaves unknown ids, code and what is already explained alone', () => {
    const once = explainWorktreeRefs(`worktree:${ID}`, find);
    expect(explainWorktreeRefs(once, find)).toBe(once);
    expect(explainWorktreeRefs('worktree:wt-000000000000', find)).toBe('worktree:wt-000000000000');
    expect(explainWorktreeRefs('```\nworktree:' + ID + '\n```', find)).toBe('```\nworktree:' + ID + '\n```');
  });
});

describe('your Claude, sent a worktree link', () => {
  it('reads which worktree it is, while the chat keeps what you pasted', async () => {
    const store = new Store(initialState('room', 'auto'));
    const project = { id: 'p', name: 'Beluga', root: '/r', base: 'main', workspaces: [{ id: ID, projectId: 'p', projectRoot: '/r', name: 'Fix the login', path: '/r/fix-login', kind: 'worktree', branch: 'beluga/fix-login', createdAt: 0 }] } as unknown as Project;
    store.dispatch({ type: 'projects', projects: [project] });
    const runs: AgentRunInput[] = [];
    const agent: AgentBackend = { run: async (input: AgentRunInput) => (runs.push(input), 'ok') };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-worktree-ref-'));
    const host = new AgentHost({
      store,
      selfId: () => 'me',
      send: () => true,
      agent: () => agent,
      shares: {} as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
      people: {} as never,
      questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
      toast: () => undefined,
      system: () => undefined,
      approvalTimeoutMs: () => 60_000,
      refreshUsage: async () => undefined,
      workspaces: { place: () => ({ cwd: dir, additionalDirectories: [], autoEdit: true, onSession: () => undefined }), refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
    });
    await host.onAgentRequest('me', { kind: 'agent_request', requestId: 'r1', prompt: `review worktree:${ID} please`, viaAgent: false, channel: 'ws:w2', urgent: false, plan: false });
    await waitFor(() => runs.length === 1);
    expect(runs[0]!.prompt).toBe(`review worktree:${ID} (worktree “Fix the login” in Beluga, branch beluga/fix-login, folder /r/fix-login) please`);
  });
});
