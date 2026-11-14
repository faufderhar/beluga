import { describe, expect, it, vi } from 'vitest';
import { StepRecorder } from '../src/agent/step-recorder.js';
import type { CatalogServer } from '../src/mcp-apps/ports/tool-catalog.js';
import { McpAppTracker } from '../src/mcp-apps/tracker.js';
import type { StepRecord } from '../src/shared/steps.js';

const SERVERS: CatalogServer[] = [
  { name: 'basic', tools: [{ name: 'get-time', _meta: { ui: { resourceUri: 'ui://get-time/app.html' } } }, { name: 'plain' }] },
];

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, text: string, toolUseResult?: unknown) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, ...(toolUseResult !== undefined ? { tool_use_result: toolUseResult } : {}) });

const init = (capabilities?: string[]) => ({ type: 'system', subtype: 'init', ...(capabilities ? { capabilities } : {}) });
const CAPS = ['interrupt_receipt_v1', 'mcp_tool_ui_meta_v1', 'mcp_read_resource_v1'];

/** A recorder and a tracker wired as the runner wires them; `records`: the last record per step. `caps`: what the turn's system/init says (undefined: no init). */
function rig(servers: () => Promise<readonly CatalogServer[]>, caps: string[] | null = CAPS) {
  const records = new Map<string, StepRecord>();
  const put = (r: StepRecord) => records.set(r.id, r);
  const tracker = new McpAppTracker({ servers }, put);
  const recorder = new StepRecorder({ emit: (r) => put(tracker.decorate(r)) });
  const observe = (msg: Record<string, unknown>) => {
    tracker.observe(msg as never);
    recorder.observe(msg as never);
  };
  if (caps) observe(init(caps));
  return { records, observe };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('McpAppTracker on a Claude Code without MCP Apps', () => {
  for (const [name, caps] of [
    ['no system/init yet', null],
    ['an init with no capabilities', []],
    ['no mcp_read_resource_v1', ['mcp_tool_ui_meta_v1']],
    ['no mcp_tool_ui_meta_v1', ['mcp_read_resource_v1']],
  ] as const) {
    it(`records no app, and never asks for the tool list: ${name}`, async () => {
      const servers = vi.fn(async () => SERVERS);
      const { records, observe } = rig(servers, caps === null ? null : [...caps]);
      observe(toolUse('t1', 'mcp__basic__get-time'));
      observe(toolResult('t1', 'now', { content: 'now', structuredContent: { time: 'now' } }));
      await flush();
      expect(records.get('t1')).toMatchObject({ status: 'done', output: 'now' });
      expect(records.get('t1')?.app).toBeUndefined();
      expect(servers).not.toHaveBeenCalled();
    });
  }

  it('follows each turn’s init: a later init without them stops recording', async () => {
    const { records, observe } = rig(async () => SERVERS);
    observe(init(['mcp_tool_ui_meta_v1']));
    observe(toolUse('t2', 'mcp__basic__get-time'));
    await flush();
    expect(records.get('t2')?.app).toBeUndefined();
  });
});

describe('McpAppTracker', () => {
  it('puts the app and its structured content on a UI tool step', async () => {
    const { records, observe } = rig(async () => SERVERS);
    observe(toolUse('t1', 'mcp__basic__get-time', { zone: 'UTC' }));
    await flush();
    expect(records.get('t1')?.app).toEqual({ server: 'basic', tool: 'get-time', resourceUri: 'ui://get-time/app.html' });
    observe(toolResult('t1', '{"time":"now"}', { content: '{"time":"now"}', structuredContent: { time: 'now' } }));
    expect(records.get('t1')).toMatchObject({ status: 'done', output: '{"time":"now"}', app: { server: 'basic', tool: 'get-time', resourceUri: 'ui://get-time/app.html', structuredContent: { time: 'now' } } });
  });

  it('adds the app to a step that ended before the lookup came back', async () => {
    let answer!: (s: readonly CatalogServer[]) => void;
    const { records, observe } = rig(() => new Promise((r) => (answer = r)));
    observe(toolUse('t1', 'mcp__basic__get-time'));
    observe(toolResult('t1', 'now', { content: 'now', structuredContent: { time: 'now' } }));
    expect(records.get('t1')?.app).toBeUndefined();
    answer(SERVERS);
    await flush();
    expect(records.get('t1')).toMatchObject({ status: 'done', app: { resourceUri: 'ui://get-time/app.html', structuredContent: { time: 'now' } } });
  });

  it('leaves other tools as they are', async () => {
    const servers = vi.fn(async () => SERVERS);
    const { records, observe } = rig(servers);
    observe(toolUse('b1', 'Bash', { command: 'ls' }));
    observe(toolUse('p1', 'mcp__basic__plain'));
    await flush();
    observe(toolResult('p1', 'ok', { content: 'ok', structuredContent: { x: 1 } }));
    expect(records.get('b1')?.app).toBeUndefined();
    expect(records.get('p1')?.app).toBeUndefined();
  });

  it('asks again once for a tool its first list did not have', async () => {
    const servers = vi.fn<() => Promise<readonly CatalogServer[]>>().mockResolvedValueOnce([]).mockResolvedValue(SERVERS);
    const { records, observe } = rig(servers);
    observe(toolUse('t1', 'mcp__basic__get-time'));
    await flush();
    await flush();
    expect(records.get('t1')?.app?.resourceUri).toBe('ui://get-time/app.html');
    expect(servers).toHaveBeenCalledTimes(2);
  });

  it('has no app when the list fails', async () => {
    const { records, observe } = rig(async () => {
      throw new Error('closed');
    });
    observe(toolUse('t1', 'mcp__basic__get-time'));
    await flush();
    expect(records.get('t1')?.app).toBeUndefined();
  });

  it('keeps the list for the run: a listed tool without an app never lists the servers again', async () => {
    const servers = vi.fn(async () => SERVERS);
    const { records, observe } = rig(servers);
    observe(toolUse('t1', 'mcp__basic__plain'));
    await flush();
    observe(toolUse('t2', 'mcp__basic__plain'));
    observe(toolUse('t3', 'mcp__basic__get-time'));
    await flush();
    expect(records.get('t1')?.app).toBeUndefined();
    expect(records.get('t3')?.app?.resourceUri).toBe('ui://get-time/app.html');
    expect(servers).toHaveBeenCalledTimes(1);
  });

  it('lists again after a failed list: one failure doesn’t stop the run’s later apps', async () => {
    const servers = vi.fn<() => Promise<readonly CatalogServer[]>>().mockRejectedValueOnce(new Error('closed')).mockResolvedValue(SERVERS);
    const { records, observe } = rig(servers);
    observe(toolUse('t1', 'mcp__basic__get-time'));
    await flush();
    await flush();
    observe(toolUse('t2', 'mcp__basic__get-time'));
    await flush();
    await flush();
    expect(records.get('t2')?.app?.resourceUri).toBe('ui://get-time/app.html');
  });
});
