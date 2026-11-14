import { describe, expect, it } from 'vitest';
import { type ControlChannel, sdkMcpCall } from '../src/mcp-apps/adapters/sdk-mcp-call.js';

/** A fake of the Claude Code control channel: records each request, answers what it was given. */
function channel(answer: unknown | Error) {
  const sent: Record<string, unknown>[] = [];
  const ch: ControlChannel = {
    request: async (req) => {
      sent.push(req);
      if (answer instanceof Error) throw answer;
      return { response: answer };
    },
  };
  return { ch, sent };
}

describe('sdkMcpCall (the mcp_call control request)', () => {
  it('sends mcp_call with the tool’s full name, its arguments and result_not_for_model', async () => {
    const { ch, sent } = channel({ content: [{ type: 'text', text: 'ok' }] });
    await sdkMcpCall(ch, 'my server', 'now', { zone: 'UTC' });
    expect(sent).toEqual([{ subtype: 'mcp_call', tool: 'mcp__my_server__now', arguments: { zone: 'UTC' }, result_not_for_model: true }]);
  });

  it('hands back the server’s content blocks, structuredContent and isError', async () => {
    const { ch } = channel({ content: [{ type: 'text', text: 'late' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }], structuredContent: { t: 1 }, isError: true, extra: 'dropped' });
    expect(await sdkMcpCall(ch, 'clock', 'now', {})).toEqual({
      content: [{ type: 'text', text: 'late' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }],
      structuredContent: { t: 1 },
      isError: true,
    });
  });

  it('turns a legacy toolResult string into one text block', async () => {
    const { ch } = channel({ toolResult: 'plain' });
    expect(await sdkMcpCall(ch, 'clock', 'now', {})).toEqual({ content: [{ type: 'text', text: 'plain' }] });
  });

  it('drops content items that aren’t objects with a type', async () => {
    const { ch } = channel({ content: ['x', null, { text: 'no type' }, { type: 'text', text: 'ok' }] });
    expect(await sdkMcpCall(ch, 'clock', 'now', {})).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('rejects with Claude Code’s error when the call could not run', async () => {
    const { ch } = channel(new Error('MCP server not connected'));
    await expect(sdkMcpCall(ch, 'clock', 'now', {})).rejects.toThrow('MCP server not connected');
  });

  it('rejects an answer with no result in it', async () => {
    const { ch } = channel(undefined);
    await expect(sdkMcpCall(ch, 'clock', 'now', {})).rejects.toThrow(/no result/i);
  });
});
