import path from 'node:path';
import type { AcpDialect } from '../opencode/events.js';
import type { ToolCall } from '../opencode/acp.js';
import type { BelugaCall } from '../opencode/tools.js';

/**
 * Antigravity's tools as the tools Beluga already draws and judges, in Claude Code's names and
 * fields. Its ACP calls carry the tool's own `name` (`run_command`, `read_file`, `write_file`,
 * `edit_file`…) with its input in PascalCase (`CommandLine`, `Path`, `Target`, `Replacement`), as
 * agy 1.5.8 sends them (recorded from a real one); a tool it names that Beluga doesn't know is read
 * by its ACP `kind`. An MCP tool is `mcp_<server>_<tool>` (`mcp_beluga_board_task_get` →
 * mcp__beluga_board__task_get), and its arguments aren't sent: Beluga's own are judged where they run.
 */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const abs = (cwd: string, p: string | undefined): string | undefined => (p ? path.resolve(cwd, p) : undefined);

/** The first of `keys` the input has (any case: `Path`, `path`). */
function field(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  const lower = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    const v = str(lower.get(key.toLowerCase()));
    if (v) return v;
  }
  return undefined;
}

/**
 * Beluga's MCP tool name for an Antigravity one (`mcp_<server>_<tool>`), or undefined: not one of
 * Beluga's. With `known` (the tools mounted for the run, by their Beluga names) it must be one of
 * them: a server of your own whose name only starts like a suite (`beluga_helper`) is not Beluga's.
 */
export function belugaToolOf(name: string, suites: readonly string[], known?: ReadonlySet<string>): string | undefined {
  const named = [...suites].sort((a, b) => b.length - a.length).filter((s) => name.startsWith(`mcp_${s}_`)).map((s) => `mcp__${s}__${name.slice(s.length + 5)}`);
  return known ? named.find((n) => known.has(n)) : named[0];
}

/** A call's tool: its own name, else its kind, else its title. */
export function agyTool(call: Pick<ToolCall, 'name' | 'kind' | 'title'>): string {
  return call.name ?? (call.kind && call.kind !== 'other' ? call.kind : (call.title ?? 'tool'));
}

/**
 * A call's input as fields, without its words for people (`toolSummary`); where it is, from its
 * locations (ACP's own list of the files a call touches) when the input doesn't say. Every one of
 * them is kept too (`Locations`), so a step on several files is judged on each.
 */
export function agyInput(call: Pick<ToolCall, 'rawInput' | 'locations'>): Record<string, unknown> {
  const raw: unknown = call.rawInput;
  const { toolSummary: _summary, ...fields } = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const paths = (call.locations ?? []).map((l) => l.path).filter(Boolean);
  const at = paths[0];
  return { ...fields, ...(at && !field(fields, 'Path', 'AbsolutePath', 'TargetFile', 'FilePath') ? { Path: at } : {}), ...(paths.length > 1 ? { Locations: paths } : {}) };
}

/** The other files a call says it touches (its locations past the first), as full paths. */
const otherLocations = (raw: Record<string, unknown>, cwd: string, file: string | undefined): string[] =>
  (Array.isArray(raw.Locations) ? raw.Locations : []).filter((p): p is string => typeof p === 'string' && Boolean(p)).map((p) => path.resolve(cwd, p)).filter((p) => p !== file);

const READS = new Set(['read_file', 'view_file', 'view_file_outline', 'view_code_item', 'read']);
const WRITES_NEW = new Set(['write_file', 'write_to_file', 'create_file']);
const EDITS = new Set(['edit_file', 'replace_file_content', 'multi_replace_file_content', 'delete_file', 'edit', 'delete']);
/** A file that goes somewhere else: where it lands is written too. */
const MOVES = new Set(['move', 'move_file', 'rename_file']);
const COMMANDS = new Set(['run_command', 'send_command_input', 'execute']);
const LISTS = new Set(['list_dir', 'list_directory', 'find_by_name', 'glob']);
const GREPS = new Set(['grep_search', 'grep', 'codebase_search', 'search']);
const SEARCHES = new Set(['search_web', 'web_search']);
const FETCHES = new Set(['read_url_content', 'fetch']);

/** One Antigravity call as Beluga's. */
export function agyCalls(tool: string, raw: Record<string, unknown>, cwd: string, suites: readonly string[] = [], known?: ReadonlySet<string>): BelugaCall[] {
  const file = abs(cwd, field(raw, 'Path', 'AbsolutePath', 'TargetFile', 'FilePath', 'File'));
  if (READS.has(tool)) return [{ name: 'Read', input: { file_path: file ?? '' } }];
  if (WRITES_NEW.has(tool)) return [{ name: 'Write', input: { file_path: file ?? '' } }];
  if (EDITS.has(tool)) {
    const target = field(raw, 'Target', 'TargetContent');
    const replacement = typeof raw.Replacement === 'string' ? raw.Replacement : typeof raw.ReplacementContent === 'string' ? raw.ReplacementContent : undefined;
    return [{ name: 'Edit', input: { file_path: file ?? '', ...(target ? { old_string: target } : {}), ...(replacement !== undefined ? { new_string: replacement } : {}) } }];
  }
  // A move changes two files: the one it takes, and where it lands (its other location, as ACP says it). One that doesn't say where is judged on no file (and turned down).
  if (MOVES.has(tool)) {
    const lands = otherLocations(raw, cwd, file);
    return [{ name: 'Edit', input: { file_path: file ?? '' } }, ...(lands.length ? lands : ['']).map((to) => ({ name: 'Write', input: { file_path: to } }))];
  }
  if (COMMANDS.has(tool)) return [{ name: 'Bash', input: { command: field(raw, 'CommandLine', 'Command', 'Input') ?? '' } }];
  if (LISTS.has(tool)) return [{ name: 'Glob', input: { pattern: field(raw, 'Pattern', 'Glob') ?? '*', path: abs(cwd, field(raw, 'DirectoryPath', 'SearchDirectory', 'SearchPath', 'Path')) ?? cwd } }];
  if (GREPS.has(tool)) return [{ name: 'Grep', input: { pattern: field(raw, 'Query', 'Pattern') ?? '', path: abs(cwd, field(raw, 'SearchPath', 'SearchDirectory', 'DirectoryPath', 'Path')) ?? cwd } }];
  if (SEARCHES.has(tool)) return [{ name: 'WebSearch', input: { query: field(raw, 'Query') ?? '' } }];
  if (FETCHES.has(tool)) return [{ name: 'WebFetch', input: { url: field(raw, 'Url', 'URL') ?? '' } }];
  const mcp = belugaToolOf(tool, suites, known);
  return [{ name: mcp ?? `mcp__antigravity__${tool.replace(/\W+/g, '_')}`, input: raw }];
}

/** Antigravity's ACP dialect: every call's input comes with its `tool_call`, so nothing waits for it. */
export const AGY_DIALECT: AcpDialect = {
  toolOf: agyTool,
  inputOf: agyInput,
  callsOf: agyCalls,
  needsInput: new Set(),
  inputKeys: new Set(['Path', 'CommandLine', 'Query', 'Url', 'DirectoryPath']),
  writes: new Set([...WRITES_NEW, ...EDITS, ...MOVES]),
};

/** The dialect for one run: Beluga's tools are only the ones mounted for it (their Beluga names). */
export const agyDialect = (known: ReadonlySet<string>): AcpDialect => ({ ...AGY_DIALECT, callsOf: (tool, raw, cwd, suites) => agyCalls(tool, raw, cwd, suites, known) });
