import { describe, expect, it, vi } from 'vitest';
import { type AppActDeps, AppAlways, callAppTool, readAppResource } from '../src/mcp-apps/call-tool.js';
import type { StepRecord } from '../src/shared/steps.js';

const STEP: StepRecord = {
  id: 't1',
  kind: 'tool',
  tool: 'mcp__clock__now',
  title: 'now',
  status: 'done',
  startedAt: 1,
  app: { server: 'clock', tool: 'now', resourceUri: 'ui://clock/app.html' },
};

const TOOLS = [
  { name: 'now', annotations: { readOnly: true } },
  { name: 'set_alarm', _meta: { ui: { resourceUri: 'ui://clock/app.html', visibility: ['app'] } } },
  { name: 'secret', annotations: { readOnly: true }, _meta: { ui: { resourceUri: 'ui://clock/app.html', visibility: ['model'] } } },
];

const OK = { content: [{ type: 'text', text: '12:00' }], structuredContent: { time: '12:00' } };

function deps(over: Partial<AppActDeps> = {}): AppActDeps & { calls: unknown[][]; asks: unknown[][] } {
  const calls: unknown[][] = [];
  const asks: unknown[][] = [];
  return {
    step: (c, i, s) => (c === 'ws:1' && i === 'i1' && s === 't1' ? STEP : undefined),
    server: {
      tools: async (server) => (server === 'clock' ? TOOLS : []),
      call: async (...args) => {
        calls.push(args);
        return OK;
      },
      read: async (server, uri) => ({ contents: [{ uri, text: `<p>${server}</p>` }] }),
    },
    ask: async (...args) => {
      asks.push(args);
      return 'yes';
    },
    always: new AppAlways(),
    calls,
    asks,
    ...over,
  };
}

const step = { channel: 'ws:1', itemId: 'i1', stepId: 't1' };

describe('callAppTool (apps.call)', () => {
  it('runs a readOnly tool of the app’s own server without asking, and hands back its result', async () => {
    const d = deps();
    expect(await callAppTool(d, step, 'now', { zone: 'UTC' })).toEqual({ ok: true, result: OK });
    expect(d.calls).toEqual([['clock', 'now', { zone: 'UTC' }]]);
    expect(d.asks).toEqual([]);
  });

  it('asks before a tool that is not readOnly, and runs it on yes', async () => {
    const d = deps();
    expect(await callAppTool(d, step, 'set_alarm', {})).toMatchObject({ ok: true });
    expect(d.asks).toHaveLength(1);
    expect(d.asks[0]).toEqual(['clock', 'set_alarm', 'ws:1']);
  });

  it('runs nothing when you decline', async () => {
    const d = deps({ ask: async () => 'no' });
    expect(await callAppTool(d, step, 'set_alarm', {})).toMatchObject({ ok: false, reason: 'declined' });
    expect(d.calls).toEqual([]);
  });

  it('keeps Always per server and tool: the next call of that tool runs without asking', async () => {
    const ask = vi.fn(async () => 'always' as const);
    const d = deps({ ask });
    await callAppTool(d, step, 'set_alarm', {});
    await callAppTool(d, step, 'set_alarm', {});
    expect(ask).toHaveBeenCalledTimes(1);
    expect(d.always.has('clock', 'set_alarm')).toBe(true);
    expect(d.always.has('other', 'set_alarm')).toBe(false);
  });

  it('refuses a tool for the model only, and a tool the server lacks', async () => {
    const d = deps();
    expect(await callAppTool(d, step, 'secret', {})).toMatchObject({ ok: false, reason: 'refused' });
    expect(await callAppTool(d, step, 'nope', {})).toMatchObject({ ok: false, reason: 'refused' });
    expect(d.calls).toEqual([]);
  });

  it('only ever calls the app’s own server: the server comes from its step, never from the app', async () => {
    const tools = vi.fn(async () => TOOLS);
    const d = deps({ server: { ...deps().server, tools } });
    await callAppTool(d, step, 'now', {});
    expect(tools).toHaveBeenCalledWith('clock');
  });


  it('is refused for a step with no app', async () => {
    expect(await callAppTool(deps(), { ...step, stepId: 'zz' }, 'now', {})).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('refuses arguments that are too big', async () => {
    const d = deps();
    expect(await callAppTool(d, step, 'now', { blob: 'x'.repeat(300_000) })).toMatchObject({ ok: false, reason: 'refused' });
    expect(d.calls).toEqual([]);
  });

  it('says why when the call fails', async () => {
    const d = deps({ server: { ...deps().server, call: async () => Promise.reject(new Error('MCP server not connected')) } });
    expect(await callAppTool(d, step, 'now', {})).toEqual({ ok: false, reason: 'failed', message: 'MCP server not connected' });
  });
});

describe('readAppResource (apps.read)', () => {
  it('reads a ui:// resource of the app’s own server', async () => {
    expect(await readAppResource(deps(), step, 'ui://clock/other.html')).toEqual({ ok: true, result: { contents: [{ uri: 'ui://clock/other.html', text: '<p>clock</p>' }] } });
  });

  it('refuses any other scheme', async () => {
    expect(await readAppResource(deps(), step, 'file:///etc/passwd')).toMatchObject({ ok: false, reason: 'refused' });
  });

  it('is refused for a step with no app', async () => {
    expect(await readAppResource(deps(), { ...step, stepId: 'zz' }, 'ui://clock/app.html')).toMatchObject({ ok: false, reason: 'missing' });
  });
});
