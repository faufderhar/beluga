import { chatLinkOf, formatChatRef } from './chat-ref.js';
import { editDiff } from './line-diff.js';
import { underPart } from './path-inside.js';

/**
 * A step in words people use, never a tool's name or an id: "Read src/auth.ts", "Ran npm test",
 * "Asked bob's Claude: run the tests", "Edited src/auth.ts (+12 −3)". `done` is how it reads once
 * it's finished, `doing` while it's the step Claude is on. Steps that involve someone say who
 * (`person`, for their avatar) and, for Beluga's tasks between Claudes, which task (`task`).
 * Browser-safe: the core names steps with it, and the Mac app names the one-line steps it
 * gets from someone else's Claude.
 */

export interface HumanStep {
  readonly done: string;
  readonly doing: string;
  /** Someone else involved (their name): their avatar shows. */
  readonly person?: string;
  /** A task between Claudes (Beluga's gateway): its live state can be shown. */
  readonly task?: string;
  /** Claude waits on someone (the waiting row). */
  readonly wait?: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max = 72): string => {
  const t = oneLine(s);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const firstLine = (s: string, max = 72): string => clip(s.split('\n').find((l) => l.trim()) ?? '', max);
const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const rel = (p: string, cwd?: string): string => (cwd ? underPart(cwd, p) : undefined) ?? p;
const both = (done: string, doing: string, extra: Omit<HumanStep, 'done' | 'doing'> = {}): HumanStep => ({ done, doing, ...extra });
const same = (text: string, extra: Omit<HumanStep, 'done' | 'doing'> = {}): HumanStep => both(text, text, extra);
const possessive = (name: string): string => `${name}’s`;

/** "+12 −3" for an edit (from the text it replaced), or "" when it can't tell. */
function editCounts(tool: string, input: Readonly<Record<string, unknown>>): string {
  const lines = (s: string): number => (s ? s.replace(/\n$/, '').split('\n').length : 0);
  if (tool === 'Write') return input.content !== undefined ? `+${lines(str(input.content))}` : '';
  const edits = tool === 'MultiEdit' && Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [input];
  let add = 0;
  let del = 0;
  for (const e of edits) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return '';
    for (const l of editDiff(e.old_string, e.new_string)) {
      if (l.kind === 'add') add++;
      if (l.kind === 'del') del++;
    }
  }
  return add || del ? `+${add} −${del}` : '';
}

/** A short, readable command: its first line, else what Claude said it does. */
function commandOf(input: Readonly<Record<string, unknown>>): string {
  const cmd = str(input.command);
  const desc = str(input.description);
  if (!cmd) return desc;
  const line = cmd.split('\n')[0]!.trim();
  return line.length > 72 && desc ? desc : clip(line);
}

/** The words for an MCP tool's name: "query_docs" → "query docs". */
const spaced = (name: string): string => name.replace(/[_-]+/g, ' ').trim();

/** Beluga's own tools (the room, and asking other people's Claudes). */
function belugaTool(name: string, input: Readonly<Record<string, unknown>>): HumanStep | undefined {
  const person = str(input.person) || str(input.peer);
  const who = person || 'someone';
  switch (name) {
    case 'who_can':
      return both('Looked for who can help', 'Looking for who can help');
    case 'ask_person':
    case 'ask_agent': {
      const ask = firstLine(str(input.ask) || str(input.prompt), 64);
      return both(`Asked ${possessive(who)} agent${ask ? `: ${ask}` : ''}`, `Asking ${possessive(who)} agent${ask ? `: ${ask}` : ''}`, person ? { person } : {});
    }
    case 'wait_for':
      return both('Heard back', 'Waiting for an answer', { wait: true, ...(str(input.task) ? { task: str(input.task) } : {}) });
    case 'check':
      return same('Checked how the task is going', str(input.task) ? { task: str(input.task) } : {});
    case 'cancel':
      return same('Cancelled the task', str(input.task) ? { task: str(input.task) } : {});
    case 'answer_question':
      return both(input.skip === true ? 'Let them decide' : 'Answered their agent’s question', 'Answering their agent’s question', str(input.task) ? { task: str(input.task) } : {});
    case 'run_on':
    case 'run_on_peer': {
      const cmd = clip(str(input.command), 56);
      return both(`Ran on ${possessive(who)} Mac${cmd ? `: ${cmd}` : ''}`, `Running on ${possessive(who)} Mac${cmd ? `: ${cmd}` : ''}`, person ? { person } : {});
    }
    case 'get_file':
    case 'get_peer_file': {
      const file = base(str(input.path)) || 'a file';
      return both(`Got ${file} from ${possessive(who)} Mac`, `Getting ${file} from ${possessive(who)} Mac`, person ? { person } : {});
    }
    case 'send_file':
      return both(`Sent ${base(str(input.path)) || 'a file'} to ${who}`, `Sending ${base(str(input.path)) || 'a file'} to ${who}`, person ? { person } : {});
    case 'list_peers':
      return both('Looked at who’s here', 'Looking at who’s here');
    case 'list_peer_files':
      return both(`Looked at ${possessive(who)} files`, `Looking at ${possessive(who)} files`, person ? { person } : {});
    case 'read_peer_file':
      return both(`Read ${base(str(input.path))} on ${possessive(who)} Mac`, `Reading ${base(str(input.path))} on ${possessive(who)} Mac`, person ? { person } : {});
    case 'send_chat':
      return same(`Posted in the chat${str(input.text) ? `: ${firstLine(str(input.text), 60)}` : ''}`);
    case 'write_report':
      return both(`Wrote the report${str(input.title) ? ` “${clip(str(input.title), 60)}”` : ''}`, 'Writing a report');
    case 'continue_in_worktree':
      return both('Moved this to a new worktree', 'Moving this to a new worktree');
    case 'screenshot':
      return both(str(input.app) ? `Looked at ${str(input.app)}` : 'Took a screenshot', 'Taking a screenshot');
    case 'device_info':
      return both('Looked at this Mac’s details', 'Looking at this Mac’s details');
    case 'list_chats':
      return both('Looked through your chats', 'Looking through your chats');
    case 'read_chat':
      return both('Read another chat', 'Reading another chat');
    case 'send_to_chat':
      return str(input.ref) ? both(`Sent a message to chat:${refWord(str(input.ref))}`, `Sending a message to chat:${refWord(str(input.ref))}`) : both('Sent a message to another chat', 'Sending a message to another chat');
    case 'wait_for_chat':
      return both('Waited for another chat', 'Waiting for another chat');
    default:
      return undefined;
  }
}

/** A tool call in words, from its name and input. Paths read relative to `cwd`. */
/** A chat ref as the tool got it (a link, or `chat:` in front), as one word for the step's chip. */
function refWord(text: string): string {
  const link = chatLinkOf(text.trim());
  return (link && formatChatRef(link)) ?? text.trim().replace(/^chat:/, '');
}

export function humanizeTool(tool: string, input: Readonly<Record<string, unknown>> = {}, cwd?: string): HumanStep {
  const file = rel(str(input.file_path) || str(input.notebook_path) || str(input.path), cwd);
  switch (tool) {
    case 'Read':
      return both(`Read ${file || 'a file'}`, `Reading ${file || 'a file'}`);
    case 'Write': {
      const n = editCounts(tool, input);
      return both(`Wrote ${file || 'a file'}${n ? ` (${n})` : ''}`, `Writing ${file || 'a file'}`);
    }
    case 'Edit':
    case 'MultiEdit': {
      const n = editCounts(tool, input);
      return both(`Edited ${file || 'a file'}${n ? ` (${n})` : ''}`, `Editing ${file || 'a file'}`);
    }
    case 'NotebookEdit':
      return both(`Edited ${file || 'a notebook'}`, `Editing ${file || 'a notebook'}`);
    case 'Bash': {
      const cmd = commandOf(input);
      return both(cmd ? `Ran ${cmd}` : 'Ran a command', cmd ? `Running ${cmd}` : 'Running a command');
    }
    case 'BashOutput':
      return both('Checked a background command', 'Checking a background command');
    case 'KillShell':
    case 'KillBash':
      return same('Stopped a background command');
    case 'Grep': {
      const pattern = clip(str(input.pattern), 48);
      const where = file ? ` in ${file}` : '';
      return both(`Searched for ‘${pattern}’${where}`, `Searching for ‘${pattern}’${where}`);
    }
    case 'Glob':
      return both(`Found files matching ${clip(str(input.pattern), 48)}`, `Finding files matching ${clip(str(input.pattern), 48)}`);
    case 'LS':
      return both(`Listed ${file || 'a folder'}`, `Listing ${file || 'a folder'}`);
    case 'WebFetch': {
      const url = str(input.url).replace(/^https?:\/\//, '').replace(/\/$/, '');
      return both(`Read ${clip(url, 60) || 'a web page'}`, `Reading ${clip(url, 60) || 'a web page'}`);
    }
    case 'WebSearch':
      return both(`Searched the web for ‘${clip(str(input.query), 56)}’`, `Searching the web for ‘${clip(str(input.query), 56)}’`);
    case 'Task':
    case 'Agent': {
      const what = clip(str(input.description) || str(input.subagent_type) || 'a task', 60);
      return both(`Started a sub-agent: ${what}`, `Starting a sub-agent: ${what}`);
    }
    case 'SendMessage': {
      const to = str(input.to) || str(input.recipient) || 'an agent';
      const about = firstLine(str(input.summary) || str(input.message), 56);
      return both(`Messaged ${to}${about ? `: ${about}` : ''}`, `Messaging ${to}${about ? `: ${about}` : ''}`);
    }
    case 'TodoWrite':
      return both('Updated the plan', 'Updating the plan');
    case 'ToolSearch':
      return both('Looked up its tools', 'Looking up its tools');
    case 'Skill':
      return both(`Used the ${str(input.skill) || 'a'} skill`, `Using the ${str(input.skill) || 'a'} skill`);
    case 'AskUserQuestion':
      return both('Asked you a question', 'Asking you a question');
    case 'ExitPlanMode':
      return both('Proposed a plan', 'Proposing a plan');
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      if (mcp) {
        // Steps kept from before the rename name the servers klaud, klaud_task, klaud_board…
        const server = mcp[1]!.replace(/^klaud(?=_|$)/, 'beluga');
        const own = belugaTool(mcp[2]!, input);
        if (own && (server === 'beluga' || server === 'beluga_task' || server === 'beluga_chats')) return own;
        return both(`Used ${spaced(mcp[2]!)} from ${spaced(server)}`, `Using ${spaced(mcp[2]!)} from ${spaced(server)}`);
      }
      return belugaTool(tool, input) ?? both(`Used ${spaced(tool)}`, `Using ${spaced(tool)}`);
    }
  }
}

/** Which input a one-line step's words stand for (summarizeTool's "Bash npm test", "Read src/a.ts"). */
const LINE_ARG: Readonly<Record<string, string>> = {
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern',
  Glob: 'pattern',
  LS: 'path',
  WebFetch: 'url',
  WebSearch: 'query',
  ask_person: 'person',
  ask_agent: 'peer',
  run_on: 'command',
  run_on_peer: 'command',
  get_file: 'path',
  get_peer_file: 'path',
  read_peer_file: 'path',
  send_file: 'path',
  wait_for: 'task',
  check: 'task',
  cancel: 'task',
  write_report: 'title',
};

/** Tools a one-line step may start with (anything else is said as it was: "24 passed"). */
const KNOWN = new Set([
  ...Object.keys(LINE_ARG),
  'BashOutput', 'KillShell', 'KillBash', 'Task', 'Agent', 'SendMessage', 'TodoWrite', 'ToolSearch', 'Skill', 'AskUserQuestion', 'ExitPlanMode',
  'who_can', 'answer_question', 'list_peers', 'list_peer_files', 'send_chat', 'continue_in_worktree', 'screenshot', 'device_info',
]);

/** A one-line step ("Bash npm test", "ask_person bob", "wait_for t_123") in words. */
export function humanizeLine(line: string): HumanStep {
  const m = /^((?:mcp__)?[A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(line.trim());
  const name = m?.[1] ?? '';
  if (!m || (!KNOWN.has(name) && !name.startsWith('mcp__'))) return same(line);
  const rest = (m[2] ?? '').trim().replace(/^"(.*)"$/, '$1');
  const key = LINE_ARG[name];
  // Grep's line is the pattern (quoted) and then where.
  const value = name === 'Grep' ? (/^"([^"]*)"/.exec(m[2] ?? '')?.[1] ?? rest.split(' ')[0] ?? '') : rest;
  return humanizeTool(name, key && value ? { [key]: value } : {});
}
