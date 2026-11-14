import type { AppToolResult } from '../../shared/mcp-apps.js';
import { normalizeServer } from '../domain/tool-name.js';

/**
 * An app's tools/call through Claude Code: the `mcp_call` control request, with
 * `result_not_for_model` so the server's own content comes back unprocessed (no resizing, no
 * truncation, nothing saved), for the app's frame and never a model. The SDK has no method for it
 * yet, so it goes over the session's control channel (Query's `request`).
 */

/** The part of a Claude Code session that sends a control request and answers its control_response. */
export interface ControlChannel {
  request(req: Record<string, unknown>): Promise<{ readonly response?: unknown } | undefined>;
}

export async function sdkMcpCall(channel: ControlChannel, server: string, tool: string, args: Readonly<Record<string, unknown>>): Promise<AppToolResult> {
  const answer = await channel.request({ subtype: 'mcp_call', tool: `mcp__${normalizeServer(server)}__${tool}`, arguments: args, result_not_for_model: true });
  return toResult(answer?.response);
}

/** The server's CallToolResult, keeping only what MCP defines: content, structuredContent, isError. */
function toResult(response: unknown): AppToolResult {
  if (!response || typeof response !== 'object') throw new Error('Claude Code sent no result for that tool.');
  const r = response as Record<string, unknown>;
  if (typeof r.toolResult === 'string') return { content: [{ type: 'text', text: r.toolResult }] };
  if (!Array.isArray(r.content)) throw new Error('Claude Code sent no result for that tool.');
  const content = r.content.filter((c): c is AppToolResult['content'][number] => Boolean(c) && typeof c === 'object' && typeof (c as { type?: unknown }).type === 'string');
  return {
    content,
    ...(r.structuredContent !== undefined && r.structuredContent !== null ? { structuredContent: r.structuredContent } : {}),
    ...(r.isError === true ? { isError: true } : {}),
  };
}
