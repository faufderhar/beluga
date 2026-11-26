import { commandFacts } from './command.js';
import type { AttrValue } from './otlp.js';
import type { TurnTool } from './turn.js';

/**
 * What a tool span says about its call, beyond its name: a Bash call's command ("Bash:git", its
 * subcommand, every command, the exit code), an MCP call's server and own name, a Skill call's
 * skill, a file change's kind of file and line counts, and, on your own runs at On, what went in and what came back (masked before this runs:
 * src/telemetry/service.ts). Names follow the GenAI conventions where one exists, ratel.* elsewhere.
 */

/** Arguments and results longer than this are cut (a marker says how much is left out). */
export const RESULT_MAX = 4_000;

export interface ToolDetail {
  /** The tool as the span names it: "Bash:git" for a command, else the agent's own name for it. */
  readonly name: string;
  readonly attributes: Readonly<Record<string, AttrValue>>;
}

/** `content`: this run's arguments and results may go (level On, your own run). */
export function toolDetail(t: TurnTool, content: boolean): ToolDetail {
  const kind = bashDetail(t) ?? mcpDetail(t) ?? skillDetail(t) ?? fileDetail(t) ?? { name: t.name, attributes: { 'gen_ai.tool.type': 'function' } };
  return {
    name: kind.name,
    attributes: {
      ...kind.attributes,
      'ratel.tool.native_name': t.native,
      ...(content
        ? {
            'gen_ai.tool.call.arguments': t.input ? cut(JSON.stringify(t.input)) : undefined,
            'gen_ai.tool.call.result': t.output ? cut(t.output) : undefined,
          }
        : {}),
    },
  };
}

/** The sub-agent an Agent call starts, by its type ("Explore"); "general-purpose" when it names none. */
export function agentTypeOf(t: TurnTool): string {
  const type = t.input?.subagent_type;
  return typeof type === 'string' && /^[\w.:@ -]{1,64}$/.test(type) ? type : 'general-purpose';
}

const EXIT = /^Exit(?:ed with)? code (-?\d{1,5})\b/;

function bashDetail(t: TurnTool): ToolDetail | undefined {
  if (t.name !== 'Bash') return undefined;
  const command = typeof t.input?.command === 'string' ? commandFacts(t.input.command) : undefined;
  return {
    name: command ? `Bash:${command.command}` : 'Bash',
    attributes: {
      'gen_ai.tool.type': 'function',
      'ratel.tool.base_name': 'Bash',
      'ratel.tool.command': command?.command,
      'ratel.tool.subcommand': command?.subcommand,
      'ratel.tool.commands': command?.commands,
      'ratel.tool.command_count': command?.segments,
      'ratel.tool.exit_code': exitCodeOf(t),
      'ratel.tool.effects': command?.effects,
    },
  };
}

/** A command's exit code: the runtime's own, else 0 when it worked, else what its result starts with ("Exit code 2"). */
function exitCodeOf(t: TurnTool): number | undefined {
  if (t.exitCode !== undefined) return t.exitCode;
  if (t.ok) return 0;
  const said = EXIT.exec((t.output ?? '').trimStart())?.[1];
  return said !== undefined ? Number(said) : undefined;
}

/** `mcp__<server>__<tool>`: the server is up to the first `__` after the prefix (a tool's own name may hold one). */
function mcpDetail(t: TurnTool): ToolDetail | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(t.name);
  if (!m) return undefined;
  return { name: t.name, attributes: { 'gen_ai.tool.type': 'extension', 'mcp.server.name': m[1], 'ratel.tool.base_name': m[2] } };
}

function skillDetail(t: TurnTool): ToolDetail | undefined {
  const skill = t.input?.skill;
  if (t.name !== 'Skill' || typeof skill !== 'string' || !skill) return undefined;
  const name = skill.slice(0, 120);
  return {
    name: t.name,
    attributes: {
      'gen_ai.tool.type': 'function',
      'ratel.skill.name': name,
      // Claude Code's own word for where it lives, else what the name shows ("plugin:skill").
      'ratel.skill.source': t.skillSource ?? (name.includes(':') ? 'plugin' : undefined),
      'ratel.skill.trigger': 'model',
    },
  };
}

/** The tools that change a file, as Claude Code names them. */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Above this many line pairs, an edit's lines are compared only at their ends. */
const DIFF_MAX = 250_000;

/** A file change: the kind of file (its extension, never its path) and how many lines went in and out. */
function fileDetail(t: TurnTool): ToolDetail | undefined {
  if (!FILE_TOOLS.has(t.name) || !t.input) return undefined;
  const file = t.input.file_path ?? t.input.notebook_path;
  const ext = typeof file === 'string' ? /\.([A-Za-z0-9]{1,12})$/.exec(file.split(/[\\/]/).at(-1) ?? '')?.[1]?.toLowerCase() : undefined;
  const lines = changedLines(t.input);
  return { name: t.name, attributes: { 'gen_ai.tool.type': 'function', 'ratel.tool.file_ext': ext, 'ratel.tool.lines_added': lines?.added, 'ratel.tool.lines_removed': lines?.removed } };
}

/** Lines an input adds and removes: an edit's old and new text compared, a write's content counted (what it replaced isn't known). */
function changedLines(input: Readonly<Record<string, unknown>>): { added: number; removed?: number } | undefined {
  const pair = (v: unknown): { added: number; removed: number } | undefined => {
    const e = (v ?? {}) as { old_string?: unknown; new_string?: unknown; new_source?: unknown };
    const to = e.new_string ?? e.new_source;
    if (typeof to !== 'string' || (e.old_string !== undefined && typeof e.old_string !== 'string')) return undefined;
    return lineDiff(linesOf((e.old_string as string | undefined) ?? ''), linesOf(to));
  };
  if (Array.isArray(input.edits)) {
    const each = input.edits.map(pair).filter((d): d is { added: number; removed: number } => d !== undefined);
    return each.length ? { added: each.reduce((n, d) => n + d.added, 0), removed: each.reduce((n, d) => n + d.removed, 0) } : undefined;
  }
  if (typeof input.content === 'string') return { added: linesOf(input.content).length };
  return pair(input);
}

const linesOf = (text: string): string[] => (text ? text.replace(/\n$/, '').split('\n') : []);

/** How many lines differ between two texts: all but their longest common subsequence (their ends only, when they're long). */
function lineDiff(from: readonly string[], to: readonly string[]): { added: number; removed: number } {
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head++;
  let tail = 0;
  while (tail < from.length - head && tail < to.length - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++;
  const a = from.slice(head, from.length - tail);
  const b = to.slice(head, to.length - tail);
  let common = 0;
  if (a.length && b.length && a.length * b.length <= DIFF_MAX) {
    let row = new Array<number>(b.length + 1).fill(0);
    for (const x of a) {
      const next = [0];
      for (let j = 0; j < b.length; j++) next.push(x === b[j] ? row[j]! + 1 : Math.max(row[j + 1]!, next[j]!));
      row = next;
    }
    common = row[b.length]!;
  }
  return { added: b.length - common, removed: a.length - common };
}

const cut = (text: string): string => (text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}… [cut: ${text.length - RESULT_MAX} more characters]` : text);
