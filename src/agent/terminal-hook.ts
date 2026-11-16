import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { belugaHome } from '../core/home.js';
import { GRAPH_FENCE } from '../shared/graph-spec.js';
import { VIEW_FENCE } from '../shared/view-spec.js';
import { type PolicyContext, confineSearch, decideTool, denyReason } from './policy.js';
import type { AgentRunInput } from './types.js';

/**
 * Beluga's rules for Claude Code in its own terminal (BLG-534). A run in the chat checks every
 * tool call in a PreToolUse hook in-process (claude/runner.ts); the terminal's Claude Code is its
 * own program, so the same hook is a command in its `--settings` that asks the daemon (over the
 * tool host, with the terminal's token) and prints the answer. Its own permission prompts still
 * ask you in the terminal.
 */

/** The variables the hook reads: where to ask, and the terminal's token. */
export const GATE_URL_ENV = 'BELUGA_GATE_URL';
export const GATE_TOKEN_ENV = 'BELUGA_GATE_TOKEN';

/**
 * The hook itself: plain Node, no Beluga code, so it starts in a moment for every tool call. It
 * sends Claude Code's JSON to the daemon and prints what comes back. When the daemon can't be
 * asked, the call is refused: Beluga's rules never silently stop applying.
 */
export const GATE_HOOK_SCRIPT = `// Beluga: asks the Beluga daemon about each tool call of Claude Code in Beluga's terminal view.
const proc = process;
const url = process.env.${GATE_URL_ENV};
const token = process.env.${GATE_TOKEN_ENV};
let body = '';
// Only a tool call is refused when Beluga can't be asked; the end of a turn (Stop) just goes on.
const refuse = (why) => {
  let event;
  try {
    event = JSON.parse(body).hook_event_name;
  } catch {}
  if (event === undefined || event === 'PreToolUse') proc.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }));
  process.exit(0);
};
proc.stdin.setEncoding('utf8');
proc.stdin.on('data', (chunk) => (body += chunk));
proc.stdin.on('end', async () => {
  if (!url || !token) return refuse('Beluga could not check this action (its terminal lost its settings). Open the terminal again from Beluga.');
  try {
    const res = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok) return refuse('Beluga could not check this action (' + res.status + '). Open the terminal again from Beluga.');
    proc.stdout.write(await res.text());
    process.exit(0);
  } catch {
    refuse('Beluga could not check this action: is Beluga still running?');
  }
});
`;

/** The hook's file, written (again when it changed) under Beluga's home. */
export function gateHookFile(home = belugaHome()): string {
  const file = path.join(home, 'terminal', 'gate-hook.mjs');
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== GATE_HOOK_SCRIPT) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, GATE_HOOK_SCRIPT, { mode: 0o600 });
  }
  return file;
}

/** A word for a shell, quoted (the hook's command is run by one). */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The settings that add the hook (merged by Claude Code with yours; your own hooks run too). */
export function gateHookSettings(node: string, file: string): Record<string, unknown> {
  const command = `${shellQuote(node)} ${shellQuote(file)}`;
  // Stop: an answer that wrote a graph or a view as a fence goes back once to show it (BLG-555).
  return { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 600 }] }], Stop: [{ hooks: [{ type: 'command', command, timeout: 30 }] }] } };
}

/** A graph or a view written as a fence: in a terminal it prints as raw JSON. */
const RAW_VISUAL = new RegExp(`^[ \t]*\`\`\`(${GRAPH_FENCE}|${VIEW_FENCE})\\b`, 'm');

/** Whether an answer has a graph or a view written as a fence. */
export const hasRawVisual = (text: string): boolean => RAW_VISUAL.test(text);

/** How much of the transcript's end is read for the last answer. */
const TAIL_BYTES = 512 * 1024;

const texts = (content: unknown): string[] =>
  typeof content === 'string' ? [content] : Array.isArray(content) ? content.flatMap((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? [(b as { text: string }).text] : [])) : [];

/**
 * The text Claude wrote since your last message, from its transcript's lines (JSON each): its
 * answers between tool calls too, as the terminal shows them all.
 */
export function lastAnswer(jsonl: string): string {
  const out: string[] = [];
  for (const raw of jsonl.split('\n').reverse()) {
    let entry: { type?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(raw) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type === 'user' && texts(entry.message?.content).length) break;
    if (entry.type === 'assistant') out.unshift(...texts(entry.message?.content));
  }
  return out.join('\n\n');
}

/** The end of a transcript Claude Code named (only its own .jsonl files). */
function transcriptTail(file: unknown): string {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.jsonl')) return '';
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const STOP_REASON =
  'Your answer has a ```' + GRAPH_FENCE + ' or ```' + VIEW_FENCE + ' block, which this terminal prints as raw JSON. Show it with mcp__beluga_view__show ' +
  '(a graph: {"type": "graph", …its fields}) and write the token it returns on a line of its own. Say nothing else: the rest of your answer is already on screen.';

/** Beluga's answer when Claude ends a turn in the terminal: once, back to show a raw graph or view through the tool (BLG-555). */
function stopAnswer(hook: Record<string, unknown>): Record<string, unknown> {
  if (hook.stop_hook_active === true) return {};
  const text = [typeof hook.last_assistant_message === 'string' ? hook.last_assistant_message : '', lastAnswer(transcriptTail(hook.transcript_path))].join('\n\n');
  return hasRawVisual(text) ? { decision: 'block', reason: STOP_REASON } : {};
}

const verdict = (permissionDecision: 'deny' | 'ask', permissionDecisionReason: string): Record<string, unknown> => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } });

/**
 * Beluga's answer to one tool call in the terminal, as the chat's hook decides it: a friend's
 * limits (vetTool) and Beluga's policy deny what they deny (the main folder, outside the
 * worktree, credential files); a .env file always asks you, in the terminal; the rest is up to
 * Claude Code's own rules and prompts. Beluga's own tools are checked by the tool host (gateTool).
 */
export function terminalHookAnswer(hook: Record<string, unknown>, input: Pick<AgentRunInput, 'vetTool'>, policy: PolicyContext): Record<string, unknown> {
  if (hook.hook_event_name === 'Stop') return stopAnswer(hook);
  if (hook.hook_event_name !== 'PreToolUse') return {};
  const tool = typeof hook.tool_name === 'string' ? hook.tool_name : '';
  if (!tool || /^mcp__beluga(_\w+)?__/.test(tool)) return {};
  const toolInput = hook.tool_input && typeof hook.tool_input === 'object' && !Array.isArray(hook.tool_input) ? (hook.tool_input as Record<string, unknown>) : {};
  const veto = input.vetTool?.(tool, toolInput);
  if (veto) return verdict('deny', veto);
  const confined = confineSearch(tool, toolInput, policy);
  const judged = confined ?? toolInput;
  const decision = decideTool(tool, judged, policy);
  if (decision === 'deny') return verdict('deny', denyReason(tool, judged, policy));
  if (decision === 'secret') return verdict('ask', 'Beluga: this touches a secrets file (.env). Allow it only if you mean to.');
  if (confined && decision === 'allow') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Allowed by Beluga.', updatedInput: confined } };
  return {};
}
