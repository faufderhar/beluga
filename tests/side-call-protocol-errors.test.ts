import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { codexComplete } from '../src/agent/runtime/codex/complete.js';
import { copilotComplete } from '../src/agent/runtime/copilot/complete.js';
import type { Turn, TurnStatus } from '../src/agent/runtime/codex/protocol.js';
import { CodexRpc } from '../src/agent/runtime/codex/rpc.js';
import type { PromptResponse, SessionUpdate, StopReason } from '../src/agent/runtime/opencode/acp.js';
import { openCodeComplete } from '../src/agent/runtime/opencode/complete.js';
import type { OpenCodeConnection } from '../src/agent/runtime/opencode/connection.js';
import type { Complete, CompletionRequest } from '../src/agent/runtime/types.js';
import { sideCalls } from '../src/agent/side-calls.js';

type Runtime = 'codex' | 'opencode' | 'copilot';
const completeWith = { codex: codexComplete, opencode: openCodeComplete, copilot: copilotComplete };
const request: CompletionRequest = { cwd: process.cwd(), system: 'Name it.', prompt: 'Fix login redirect.', model: 'gpt-test' };
const providerError = 'Failed to authenticate. OAuth session expired.';

/** Real line-delimited RPC, with no subprocess, SDK query, or session deletion. */
function wire(runtime: Runtime, onPrompt: (id: number, peer: Peer) => void) {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const rpc = new CodexRpc(incoming, outgoing, { name: runtime, jsonrpc: runtime !== 'codex' });
  const requests: string[] = [];
  let alive = true;
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => (exit = resolve));
  const kill = vi.fn(async () => {
    if (!alive) return;
    alive = false;
    incoming.end();
    outgoing.end();
    exit();
  });
  const send = (message: object): void => {
    incoming.write(`${JSON.stringify({ ...(runtime !== 'codex' ? { jsonrpc: '2.0' } : {}), ...message })}\n`);
  };
  const peer = {
    result: (id: number, result: unknown): void => send({ id, result }),
    error: (id: number): void => send({ id, error: { code: -32603, message: providerError } }),
    close: (): void => { incoming.end(); },
    text: (text: string): void => {
      if (runtime === 'codex') {
        send({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', id: 'message', text, phase: null } } });
      } else {
        const update: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
        send({ method: 'session/update', params: { sessionId: 'session', update } });
      }
    },
    turn: (status: TurnStatus): void => {
      const turn: Turn & { items: [] } = { id: 'turn', status, items: [], error: status === 'failed' ? { message: providerError, codexErrorInfo: 'unauthorized', additionalDetails: null } : null };
      send({ method: 'turn/completed', params: { threadId: 'thread', turn } });
    },
    started: (id: number): void => send({ id, result: { turn: { id: 'turn', status: 'inProgress', error: null, items: [] } } }),
    stopped: (id: number, stopReason: StopReason): void => {
      const result: PromptResponse = { stopReason };
      send({ id, result });
    },
  };
  readline.createInterface({ input: outgoing }).on('line', (line: string) => {
    const { id, method } = JSON.parse(line) as { id: number; method: string };
    requests.push(method);
    switch (method) {
      case 'model/list': return peer.result(id, { data: [] });
      case 'config/read': return peer.result(id, { config: {} });
      case 'thread/start': return peer.result(id, { thread: { id: 'thread' }, model: 'gpt-test' });
      case 'session/new': return peer.result(id, { sessionId: 'session' });
      case 'turn/start':
      case 'session/prompt': return onPrompt(id, peer);
      default: throw new Error(`Unexpected request: ${method}`);
    }
  });
  const conn: OpenCodeConnection = { rpc, proc: { pid: 1, alive: () => alive, exited, kill }, stderr: () => [], init: { protocolVersion: 1 } };
  const drop = vi.fn(async () => true);
  const connect = vi.fn(async () => conn);
  const complete: Complete = (req) => completeWith[runtime](req, { connect, drop });
  return { conn, connect, complete, drop, kill, requests };
}

type Peer = {
  result: (id: number, result: unknown) => void;
  error: (id: number) => void;
  close: () => void;
  text: (text: string) => void;
  turn: (status: TurnStatus) => void;
  started: (id: number) => void;
  stopped: (id: number, stopReason: StopReason) => void;
};

function finish(runtime: Runtime, id: number, peer: Peer, failed = false): void {
  if (runtime === 'codex') {
    peer.started(id);
    peer.turn(failed ? 'failed' : 'completed');
  } else peer.stopped(id, failed ? 'refusal' : 'end_turn');
}

for (const runtime of ['codex', 'opencode', 'copilot'] as const) {
  describe(`${runtime} side-call protocol outcomes`, () => {
    it('accepts a successful answer about authentication errors', async () => {
      const fake = wire(runtime, (id, peer) => {
        peer.text('fix-oauth-session-expired');
        finish(runtime, id, peer);
      });
      await expect(fake.complete(request)).resolves.toBe('fix-oauth-session-expired');
      expect(fake.kill).toHaveBeenCalled();
      if (runtime !== 'codex') expect(fake.drop).toHaveBeenCalledWith('session');
    });

    it('rejects answer text followed by terminal failure and preserves naming fallbacks', async () => {
      const complete: Complete = (req) => wire(runtime, (id, peer) => {
        peer.text(providerError);
        finish(runtime, id, peer, true);
      }).complete(req);
      await expect(complete(request)).rejects.toMatchObject({ kind: 'failed' });
      const calls = sideCalls(complete, request.cwd);
      expect(await calls.nameTask('please fix the login redirect')).toBe('fix-login-redirect');
      expect(await calls.titlePlan('take card payments')).toBeUndefined();
      expect(await calls.titleChat('take card payments')).toBeUndefined();
    });

    it.each(['', ' \n '])('rejects successful completion without an answer (%j)', async (text) => {
      const fake = wire(runtime, (id, peer) => {
        if (text) peer.text(text);
        finish(runtime, id, peer);
      });
      await expect(fake.complete(request)).rejects.toMatchObject({ kind: 'no_answer' });
    });

    it('rejects an RPC error response even after answer text', async () => {
      const fake = wire(runtime, (id, peer) => {
        peer.text('A plausible title');
        peer.error(id);
      });
      await expect(fake.complete(request)).rejects.toMatchObject({ kind: 'failed' });
      expect(fake.kill).toHaveBeenCalled();
    });

    it('rejects transport closure before terminal completion', async () => {
      const fake = wire(runtime, (id, peer) => {
        peer.text('A plausible title');
        if (runtime === 'codex') peer.started(id);
        peer.close();
      });
      await expect(fake.complete(request)).rejects.toMatchObject({ kind: 'failed' });
    });

    it('cancels a pending prompt when its caller aborts or times out', async () => {
      const fake = wire(runtime, (id, peer) => {
        peer.text('Partial answer');
        if (runtime === 'codex') peer.started(id);
      });
      const controller = new AbortController();
      const pending = fake.complete({ ...request, signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow('aborted');
      try {
        await vi.waitFor(() => expect(fake.requests).toContain(runtime === 'codex' ? 'turn/start' : 'session/prompt'));
        controller.abort();
        await rejected;
        expect(fake.kill).toHaveBeenCalled();
      } finally {
        controller.abort();
        await fake.kill();
      }
    });

    it('honors cancellation during startup before sending any requests', async () => {
      const fake = wire(runtime, (id, peer) => {
        if (runtime === 'codex') peer.started(id);
      });
      let connected!: (conn: OpenCodeConnection) => void;
      const connect = vi.fn(() => new Promise<OpenCodeConnection>((resolve) => (connected = resolve)));
      const controller = new AbortController();
      const req = { ...request, signal: controller.signal };
      const pending = completeWith[runtime](req, { connect, drop: fake.drop }).catch((err: unknown) => err);
      try {
        expect(connect).toHaveBeenCalledOnce();
        controller.abort();
        connected(fake.conn);
        await vi.waitFor(() => expect(fake.kill).toHaveBeenCalled());
        expect(fake.requests).toEqual([]);
        expect(await pending).toMatchObject({ message: 'aborted' });
        expect(fake.drop).not.toHaveBeenCalled();
      } finally {
        await fake.kill();
        await pending;
      }
    });
  });
}

describe('runtime-specific terminal outcomes', () => {
  it('rejects a failed Codex turn arriving before the turn/start response', async () => {
    const fake = wire('codex', (id, peer) => {
      peer.text('A plausible title');
      peer.turn('failed');
      peer.started(id);
    });
    await expect(fake.complete(request)).rejects.toMatchObject({ kind: 'failed' });
  });

  it('rejects an interrupted Codex turn despite earlier answer text', async () => {
    const fake = wire('codex', (id, peer) => {
      peer.started(id);
      peer.text('Partial answer');
      peer.turn('interrupted');
    });
    await expect(fake.complete(request)).rejects.toMatchObject({ kind: 'failed' });
  });

  for (const runtime of ['opencode', 'copilot'] as const) {
    it.each([
      ['cancelled', 'failed'],
      ['max_turn_requests', 'max_turns'],
    ] as const)(`rejects ${runtime} %s despite earlier answer text`, async (stopReason, kind) => {
      const fake = wire(runtime, (id, peer) => {
        peer.text('Partial answer');
        peer.stopped(id, stopReason);
      });
      await expect(fake.complete(request)).rejects.toMatchObject({ kind });
    });

    it(`preserves accepted ${runtime} max_tokens output`, async () => {
      const fake = wire(runtime, (id, peer) => {
        peer.text('A short answer');
        peer.stopped(id, 'max_tokens');
      });
      await expect(fake.complete(request)).resolves.toBe('A short answer');
    });
  }
});
