/**
 * Whether a Claude Code can host MCP Apps, from the `capabilities` of its `system/init`: it must
 * give each tool's `_meta.ui` (mcp_tool_ui_meta_v1) and read `ui://` resources
 * (mcp_read_resource_v1). Older ones say neither, so Beluga records no app and the chat looks as
 * it did before. Pure.
 */

export const APP_CAPABILITIES = ['mcp_tool_ui_meta_v1', 'mcp_read_resource_v1'] as const;

export function appsSupported(capabilities: unknown): boolean {
  return Array.isArray(capabilities) && APP_CAPABILITIES.every((c) => capabilities.includes(c));
}
