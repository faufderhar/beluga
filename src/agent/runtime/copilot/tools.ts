import path from 'node:path';
import type { AcpDialect } from '../opencode/events.js';
import type { ToolCall } from '../opencode/acp.js';
import { type BelugaCall, patchFiles } from '../opencode/tools.js';

/**
 * Copilot's tools as the tools Beluga already draws and judges (BLG-873), in Claude Code's names
 * and fields. Copilot's titles are words for people ("Viewing src/app.ts", "List workspace
 * contents"), so a call is known by its ACP `kind`: read → Read, execute → Bash, edit → Edit or
 * Write (one per file a patch touches), search → Grep or Glob, fetch → WebFetch. An MCP tool is
 * `<server>-<tool>` (`beluga_board-task_get` → mcp__beluga_board__task_get).
 */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const abs = (cwd: string, p: string | undefined): string | undefined => (p ? path.resolve(cwd, p) : undefined);

/** Beluga's MCP tool name for a Copilot one (`<server>-<tool>`), or undefined: not one of Beluga's. */
export function belugaToolOf(title: string, suites: readonly string[]): string | undefined {
  const suite = [...suites].sort((a, b) => b.length - a.length).find((s) => title.startsWith(`${s}-`));
  return suite ? `mcp__${suite}__${title.slice(suite.length + 1)}` : undefined;
}

/** An MCP tool's title, `<server>-<tool>` (one word, a hyphen): Copilot's own tools have titles in words. */
const MCP_TITLE = /^[\w.]+-[\w.-]+$/;

/**
 * A call's tool: an MCP tool by its title, whatever its kind (a read-only one, Beluga's list_peers,
 * comes as `read`); else its kind; else (`other`) its title.
 */
export function copilotTool(call: Pick<ToolCall, 'kind' | 'title'>): string {
  if (call.title && MCP_TITLE.test(call.title)) return call.title;
  return call.kind && call.kind !== 'other' ? call.kind : (call.title ?? 'tool');
}

/** A call's input as fields: an apply_patch body comes as a bare string; where it is, from its locations when the input doesn't say. */
export function copilotInput(call: Pick<ToolCall, 'rawInput' | 'locations'>): Record<string, unknown> {
  const raw: unknown = call.rawInput;
  const fields = typeof raw === 'string' ? { patch: raw } : raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const at = call.locations?.[0]?.path;
  return at && !str(fields.path) && !str(fields.fileName) ? { ...fields, path: at } : fields;
}

/** Whether an edit makes a new file (its diff from /dev/null, or a create's whole text). */
const creates = (raw: Record<string, unknown>): boolean => /^--- a?\/dev\/null$/m.test(str(raw.diff) ?? '') || typeof raw.file_text === 'string';

/** One Copilot call as Beluga's: several for a patch (one Edit or Write per file). */
export function copilotCalls(tool: string, raw: Record<string, unknown>, cwd: string, suites: readonly string[] = []): BelugaCall[] {
  const file = abs(cwd, str(raw.path) ?? str(raw.fileName) ?? str(raw.file_path));
  switch (tool) {
    case 'read':
      return [{ name: 'Read', input: { file_path: file ?? '' } }];
    case 'edit':
    case 'delete':
    case 'move': {
      const patch = str(raw.patch);
      const files = patch ? patchFiles(patch, cwd) : [];
      if (files.length) return files.map((f) => ({ name: f.kind === 'add' ? 'Write' : 'Edit', input: { file_path: f.file } }));
      return [{ name: creates(raw) ? 'Write' : 'Edit', input: { file_path: file ?? '', ...(typeof raw.old_str === 'string' ? { old_string: raw.old_str } : {}), ...(typeof raw.new_str === 'string' ? { new_string: raw.new_str } : {}) } }];
    }
    case 'execute':
      return [{ name: 'Bash', input: { command: str(raw.command) ?? '', ...(str(raw.description) ? { description: raw.description } : {}) } }];
    case 'search':
      return raw.glob !== undefined || (!raw.path && str(raw.pattern)?.includes('*'))
        ? [{ name: 'Glob', input: { pattern: str(raw.pattern) ?? str(raw.glob) ?? '*', path: file ?? cwd } }]
        : [{ name: 'Grep', input: { pattern: str(raw.pattern) ?? '', path: file ?? cwd } }];
    case 'fetch':
      return str(raw.url) ? [{ name: 'WebFetch', input: { url: raw.url } }] : [{ name: 'WebSearch', input: { query: str(raw.query) ?? '' } }];
    default: {
      const mcp = belugaToolOf(tool, suites);
      return [{ name: mcp ?? `mcp__copilot__${tool.replace(/\W+/g, '_')}`, input: raw }];
    }
  }
}

/** Copilot's ACP dialect: every call's input comes with its `tool_call`, so nothing waits for it. */
export const COPILOT_DIALECT: AcpDialect = {
  toolOf: copilotTool,
  inputOf: copilotInput,
  callsOf: copilotCalls,
  needsInput: new Set(),
  inputKeys: new Set(['path', 'fileName', 'command', 'pattern', 'patch', 'url']),
  writes: new Set(['edit', 'delete', 'move']),
};
