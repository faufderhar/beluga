/**
 * Claude Code names an MCP tool `mcp__<server>__<tool>`, with the server's name normalized
 * (anything but [a-zA-Z0-9_-] becomes `_`). Pure.
 */

/** The server (its real name, from `servers`) and tool a Claude Code tool name is for. */
export function splitMcpToolName(name: string, servers: readonly string[]): { readonly server: string; readonly tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  // The longest prefix wins: a server named `a__b` beside one named `a`.
  const match = [...servers]
    .sort((a, b) => normalizeServer(b).length - normalizeServer(a).length)
    .find((s) => name.startsWith(`mcp__${normalizeServer(s)}__`) && name.length > `mcp__${normalizeServer(s)}__`.length);
  return match ? { server: match, tool: name.slice(`mcp__${normalizeServer(match)}__`.length) } : undefined;
}

export function normalizeServer(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
