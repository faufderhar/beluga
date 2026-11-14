/**
 * Where a run learns which MCP tools have an app: the servers it's connected to, each with its
 * tools and their `_meta` (Claude Code: `mcpServerStatus()`, whose rows fit this shape).
 */

export interface CatalogTool {
  readonly name: string;
  /** Claude Code says `readOnly`; MCP itself says `readOnlyHint`. A hint from the server, never proof. */
  readonly annotations?: { readonly readOnly?: boolean; readonly readOnlyHint?: boolean };
  readonly _meta?: Record<string, unknown>;
}

export interface CatalogServer {
  readonly name: string;
  readonly tools?: readonly CatalogTool[];
}

export interface McpToolCatalog {
  servers(): Promise<readonly CatalogServer[]>;
}
