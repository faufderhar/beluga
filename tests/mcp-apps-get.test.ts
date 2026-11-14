import { describe, expect, it, vi } from 'vitest';
import { McpAppFrames } from '../src/mcp-apps/frames.js';
import { StepRecorder } from '../src/agent/step-recorder.js';
import { type GetAppDeps, getApp } from '../src/mcp-apps/get-app.js';
import { McpAppTracker } from '../src/mcp-apps/tracker.js';
import type { StepRecord } from '../src/shared/steps.js';

const STEP: StepRecord = {
  id: 't1',
  kind: 'tool',
  tool: 'mcp__basic__get-time',
  title: 'get-time',
  status: 'done',
  startedAt: 1,
  input: { zone: 'UTC' },
  output: '{"time":"now"}',
  app: { server: 'basic', tool: 'get-time', resourceUri: 'ui://get-time/app.html', structuredContent: { time: 'now' } },
};

const deps = (over: Partial<GetAppDeps> = {}): GetAppDeps => ({
  step: (channel, itemId, stepId) => (channel === 'ws:1' && itemId === 'i1' && stepId === 't1' ? STEP : undefined),
  frame: async () => ({ url: 'http://127.0.0.1:47792/a/x/' }),
  ...over,
});

describe('getApp (apps.get)', () => {
  it('returns the frame, input and result of a UI tool call', async () => {
    expect(await getApp(deps(), 'ws:1', 'i1', 't1')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:47792/a/x/',
      server: 'basic',
      tool: 'get-time',
      resourceUri: 'ui://get-time/app.html',
      input: { zone: 'UTC' },
      result: { text: '{"time":"now"}', structuredContent: { time: 'now' } },
    });
  });

  it('gives no app on a Claude Code without the MCP Apps capabilities, and reads nothing', async () => {
    // The run as the runner wires it: this CLI's system/init lacks mcp_read_resource_v1.
    let kept: StepRecord | undefined;
    const servers = vi.fn(async () => [{ name: 'basic', tools: [{ name: 'get-time', _meta: { ui: { resourceUri: 'ui://get-time/app.html' } } }] }]);
    const tracker = new McpAppTracker({ servers }, (r) => (kept = r));
    const recorder = new StepRecorder({ emit: (r) => (kept = tracker.decorate(r)) });
    for (const msg of [
      { type: 'system', subtype: 'init', capabilities: ['mcp_tool_ui_meta_v1'] },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__basic__get-time', input: {} }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'now' }] }, tool_use_result: { content: 'now', structuredContent: { time: 'now' } } },
    ]) {
      tracker.observe(msg as never);
      recorder.observe(msg as never);
    }
    await new Promise((r) => setTimeout(r, 0));
    const frame = vi.fn();
    expect(kept?.app).toBeUndefined();
    expect(await getApp(deps({ step: () => kept, frame }), 'ws:1', 'i1', 't1')).toMatchObject({ ok: false, reason: 'missing' });
    expect(frame).not.toHaveBeenCalled();
    expect(servers).not.toHaveBeenCalled();
  });

  it('says missing for a step without an app', async () => {
    expect(await getApp(deps(), 'ws:1', 'i1', 'nope')).toMatchObject({ ok: false, reason: 'missing' });
    expect(await getApp(deps({ step: () => ({ ...STEP, app: undefined }) }), 'ws:1', 'i1', 't1')).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('has no result while the tool runs', async () => {
    const view = await getApp(deps({ step: () => ({ ...STEP, status: 'running', output: undefined, app: { ...STEP.app!, structuredContent: undefined } }) }), 'ws:1', 'i1', 't1');
    expect(view.ok && view.result).toBeUndefined();
  });

  it('says unavailable when the page cannot be read', async () => {
    const view = await getApp(deps({ frame: () => Promise.reject(new Error('server down')) }), 'ws:1', 'i1', 't1');
    expect(view).toEqual({ ok: false, reason: 'unavailable', message: 'server down' });
  });
});

describe('McpAppFrames', () => {
  it('serves the page with its CSP once per resource, and reads again after a failure', async () => {
    const add = vi.fn(async (_html: string, _csp: string) => 'http://127.0.0.1:1/a/y/');
    const frames = new McpAppFrames({ add }, 'tauri://localhost');
    const read = vi.fn<(server: string, uri: string) => Promise<{ html: string; meta?: Record<string, unknown> }>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ html: '<p>app</p>', meta: { ui: { csp: { connectDomains: ['https://api.example.com'] }, prefersBorder: false } } });
    await expect(frames.frame('basic', 'ui://a', read)).rejects.toThrow('down');
    expect(await frames.frame('basic', 'ui://a', read)).toEqual({ url: 'http://127.0.0.1:1/a/y/', prefersBorder: false });
    expect(await frames.frame('basic', 'ui://a', read)).toEqual({ url: 'http://127.0.0.1:1/a/y/', prefersBorder: false });
    expect(read).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toBe('<p>app</p>');
    expect(add.mock.calls[0]![1]).toContain('connect-src https://api.example.com');
    expect(add.mock.calls[0]![1]).toContain('frame-ancestors tauri://localhost');
  });
});

describe('getApp: a server that needs a sign-in', () => {
  it('shows unavailable, with the reason, so the chat says why there is no app', async () => {
    const view = await getApp(deps({ frame: () => Promise.reject(new Error('basic needs you to sign in. Sign in to it, then open this chat again.')) }), 'ws:1', 'i1', 't1');
    expect(view).toEqual({ ok: false, reason: 'unavailable', message: 'basic needs you to sign in. Sign in to it, then open this chat again.' });
  });
});
