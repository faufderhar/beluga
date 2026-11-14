import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { Store, initialState } from '../src/core/store.js';
import { externalRequester } from '../src/core/trust.js';
import { waitFor } from './helpers.js';

/** Your own agent's runs get the MCP sign-in tools (beluga_mcp); a friend's request never does. */

const ME = 'me';

function setup(opened: string[]) {
  const store = new Store(initialState('room', 'auto'));
  const runs: AgentRunInput[] = [];
  const agent: AgentBackend = {
    async run(input: AgentRunInput) {
      runs.push(input);
      return 'ok';
    },
    mcpServers: async () => [{ name: 'figma', label: 'figma', from: 'user', status: 'needs-auth', canSignIn: true }],
    mcpSignIn: async () => ({ url: 'https://auth.example/authorize' }),
    mcpSignedIn: async () => true,
  };
  const host = new AgentHost({
    store,
    selfId: () => ME,
    send: () => true,
    agent: () => agent,
    openPage: async (url: string) => void opened.push(url),
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: { trustOf: () => 'full', isFriend: () => true } as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
  } as never);
  return { host, runs };
}

describe('MCP sign-in tools in a run', () => {
  it('your own run can sign in: the page opens on your screen', async () => {
    const opened: string[] = [];
    const { host, runs } = setup(opened);
    await host.onAgentRequest(ME, { kind: 'agent_request', requestId: 'r1', prompt: 'hi', viaAgent: false, channel: 'room', urgent: false, plan: false });
    await waitFor(() => runs.length > 0);
    expect(await runs[0]!.mcpTools?.servers()).toContain('figma: needs sign-in');
    expect((await runs[0]!.mcpTools!.signIn('figma')).text).toContain('Signed in to figma');
    expect(opened).toEqual(['https://auth.example/authorize']);
  });

  it('an external agent’s run never gets them (the page would open on your screen for it)', async () => {
    const { host, runs } = setup([]);
    host.setExternalAgents((requester) => (requester === externalRequester('ext1') ? { name: 'Cursor', level: 'full' } : undefined));
    await host.onAgentRequest(ME, { kind: 'agent_request', requestId: 'r3', prompt: 'hi', viaAgent: false, channel: 'room', urgent: false, plan: false, via: { id: 'ext1', name: 'Cursor', creationSource: 'mcp' } } as never);
    await waitFor(() => runs.length > 0);
    expect(runs[0]!.mcpTools).toBeUndefined();
  });

  it('a friend’s request never gets them (your servers and your browser are yours)', async () => {
    const { host, runs } = setup([]);
    await host.onAgentRequest('friend', { kind: 'agent_request', requestId: 'r2', prompt: 'hi', viaAgent: false, channel: 'room', urgent: false, plan: false });
    await waitFor(() => runs.length > 0);
    expect(runs[0]!.mcpTools).toBeUndefined();
  });
});
