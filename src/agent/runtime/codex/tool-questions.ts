import { toolName } from '../../tool-kit.js';

/**
 * Codex asks before it calls an MCP tool that does not say it only reads, with
 * `mcpServer/elicitation/request`. These shapes are from a real codex-cli 0.163 and its
 * generate-json-schema. An elicitation that does not match them exactly is a server's own question
 * to the user, and Beluga does not answer it. Only your own Codex MCP servers are asked about:
 * Codex approves calls to Beluga's own (runner.ts mcpConfig), whose tool server gates each one.
 */
export const ELICITATION = 'mcpServer/elicitation/request';

const MCP_TOOL_CALL = 'mcp_tool_call';
const ASKS_TOOL = /^Allow the (.+) MCP server to run tool "([^"]+)"\?$/;

export interface McpToolCall {
  /** The tool as Beluga's gate names it: `mcp__<server>__<tool>`. */
  readonly name: string;
  readonly server: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** The tool call that this elicitation asks about. Undefined: it is something else. */
export function mcpToolCallOf(params: Record<string, unknown>): McpToolCall | undefined {
  const meta = isRecord(params._meta) ? params._meta : undefined;
  if (params.mode !== 'form' || meta?.codex_approval_kind !== MCP_TOOL_CALL || !isRecord(meta.tool_params)) return undefined;
  // A form with fields asks the user for data. A question about a tool call has none.
  const schema = params.requestedSchema;
  if (!isRecord(schema) || !isRecord(schema.properties) || Object.keys(schema.properties).length) return undefined;
  const asked = typeof params.message === 'string' ? ASKS_TOOL.exec(params.message) : undefined;
  if (!asked || asked[1] !== params.serverName) return undefined;
  return { name: toolName(asked[1]!, asked[2]!), server: asked[1]!, tool: asked[2]!, args: meta.tool_params };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
