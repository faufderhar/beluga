import type { AppReadResult, AppToolResult } from '../../shared/mcp-apps.js';
import type { CatalogTool } from './tool-catalog.js';

/**
 * The MCP server an app acts on, through Claude Code (the one MCP client: same connection
 * settings and sign-ins as your runs). Results are the server's own, untrusted data.
 */
export interface McpAppServer {
  /** The tools the server lists now, with their annotations and `_meta`. */
  tools(server: string): Promise<readonly CatalogTool[]>;
  /** tools/call, its result for the app (never the model). Rejects when it could not run. */
  call(server: string, tool: string, args: Readonly<Record<string, unknown>>): Promise<AppToolResult>;
  /** resources/read of a `ui://` resource. */
  read(server: string, uri: string): Promise<AppReadResult>;
}
