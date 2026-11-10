import path from 'node:path';
import type { ToolCall, ToolContent } from '../opencode/acp.js';
import type { BelugaCall } from '../opencode/tools.js';

/**
 * Grok Build's tools as the tools Beluga already draws and judges: Claude Code's names and input
 * fields, so step titles, the policy (agent/policy.ts) and the approval sheet read the same.
 * Shapes recorded from Grok Build 1.0.77. Its tool id is in `_meta["x.ai/tool"].name`, because a
 * call's title changes as it goes ("read_file", then "Read `/a/b`").
 */

/** Grok's tools that only look after its own work: they run without anyone being asked. */
export const GROK_OWN = new Set(['search_tool', 'get_command_or_subagent_output']);
/** Grok's tools that change files. */
export const GROK_WRITES = new Set(['write', 'search_replace']);
/** Its sub-agent tool. */
export const GROK_SUBAGENT = 'spawn_subagent';
/** Its own way of asking for a plan's approval: a request back to the screen that Beluga answers with its own approval card instead. */
export const GROK_EXIT_PLAN = 'exit_plan_mode';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const abs = (cwd: string, p: string | undefined): string | undefined => (p ? path.resolve(cwd, p) : undefined);
const firstPath = (raw: Record<string, unknown>): string | undefined => str(raw.target_file) ?? str(raw.target_directory) ?? str(raw.file_path) ?? str(raw.path);

/** Which of Grok's tools a call is. */
export function grokToolOf(call: Pick<ToolCall, 'title' | 'rawInput' | '_meta'>): string {
  const meta = call._meta?.['x.ai/tool'] as { readonly name?: unknown } | undefined;
  if (typeof meta?.name === 'string' && meta.name) return meta.name;
  // Its web search runs on xAI's side: a call with no tool id, known by its input.
  if (call.rawInput?.variant === 'WebSearch') return 'web_search';
  return call.title ?? '';
}

/** Beluga's name for a tool `use_tool` reaches: Grok says `<server>__<tool>`. */
export function mcpName(toolName: string): string {
  const at = toolName.indexOf('__');
  return at === -1 ? `mcp__grok__${toolName}` : `mcp__${toolName.slice(0, at)}__${toolName.slice(at + 2)}`;
}

/** Whether `name` (Beluga's name for a tool) is one of the tools Beluga mounted for this run. */
export const isBelugaTool = (name: string, suites: readonly string[]): boolean => suites.some((s) => name.startsWith(`mcp__${s}__`));

/** One Grok tool call as Beluga's: its name and its input in Claude Code's fields. */
export function grokCalls(tool: string, raw: Record<string, unknown>, cwd: string): BelugaCall[] {
  const file = abs(cwd, firstPath(raw));
  switch (tool) {
    case 'read_file':
      return [{ name: 'Read', input: { file_path: file ?? '', ...(typeof raw.offset === 'number' ? { offset: raw.offset } : {}), ...(typeof raw.limit === 'number' ? { limit: raw.limit } : {}) } }];
    case 'write':
      return [{ name: 'Write', input: { file_path: file ?? '', ...(typeof raw.content === 'string' ? { content: raw.content } : {}) } }];
    case 'search_replace':
      return [{ name: 'Edit', input: { file_path: file ?? '', ...(typeof raw.old_string === 'string' ? { old_string: raw.old_string } : {}), ...(typeof raw.new_string === 'string' ? { new_string: raw.new_string } : {}) } }];
    case 'run_terminal_command':
      return [{ name: 'Bash', input: { command: str(raw.command) ?? '', ...(str(raw.description) ? { description: raw.description } : {}) } }];
    case 'grep':
      return [{ name: 'Grep', input: { pattern: str(raw.pattern) ?? '', path: abs(cwd, str(raw.path)) ?? cwd, ...(str(raw.glob) ? { glob: raw.glob } : {}) } }];
    case 'list_dir':
      return [{ name: 'LS', input: { path: file ?? cwd } }];
    case 'web_fetch':
      return [{ name: 'WebFetch', input: { url: str(raw.url) ?? '' } }];
    case 'web_search':
      return [{ name: 'WebSearch', input: { query: str(raw.query) ?? '' } }];
    case GROK_SUBAGENT:
      return [{ name: 'Task', input: { description: str(raw.description) ?? '', prompt: str(raw.prompt) ?? '', ...(str(raw.subagent_type) ? { subagent_type: raw.subagent_type } : {}) } }];
    case 'todo_write':
      return [{ name: 'TodoWrite', input: { todos: Array.isArray(raw.todos) ? raw.todos.map((t: { content?: unknown; status?: unknown }) => ({ content: String(t?.content ?? ''), status: String(t?.status ?? 'pending'), activeForm: String(t?.content ?? '') })) : [] } }];
    case 'use_tool': {
      const input = raw.tool_input;
      return [{ name: mcpName(str(raw.tool_name) ?? 'tool'), input: input && typeof input === 'object' ? (input as Record<string, unknown>) : {} }];
    }
    default:
      return [{ name: `mcp__grok__${tool || 'tool'}`, input: raw }];
  }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const plain = (text: string): string => text.replace(ANSI, '');

/** What a finished call gave back: its text, its files' diffs, or (an MCP call, a search) what its raw output holds. */
export function grokResultText(call: Pick<ToolCall, 'content' | 'rawOutput'>): string {
  const parts = (call.content ?? []).flatMap((c: ToolContent) => {
    if (c.type === 'content' && 'content' in c) return c.content.text ? [plain(c.content.text)] : [];
    if (c.type === 'diff' && 'path' in c) return [`${c.path}\n${c.newText}`];
    return [];
  });
  if (parts.length) return parts.join('\n');
  const out = call.rawOutput as { output?: { OkayOutput?: unknown }; text?: unknown } | undefined;
  if (typeof out?.output?.OkayOutput === 'string') return out.output.OkayOutput;
  return typeof out?.text === 'string' ? out.text : '';
}
