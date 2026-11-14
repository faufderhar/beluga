import { isGraphFence } from '../shared/graph-spec.js';
import { TASKS_FENCE } from '../shared/task-refs.js';
import { PREVIEW_FENCE, STILL_SCHEME, parsePreviewRef, previewTitle, stillName } from '../shared/preview/ref.js';
import { isViewFence } from '../shared/view-spec.js';
import { tableSpec } from '../shared/render/md-table.js';
import { findTextTables, looksLikeTable, readTextTable } from '../shared/render/text-table.js';
import { displayMathAt, normalizeMathDelimiters } from '../shared/render/math.js';
import { richFence } from '../shared/render/rich-fence.js';
import type { ProseView, ToolKind } from './protocol.js';

/**
 * What of Claude's words go to the phone: everything but code. Fenced blocks (``` or ~~~, any
 * length, closed or not) become a `[[code:n]]` marker on a line of its own and one entry in `code`
 * (its language and how many lines it had), which the phone draws as a "code · 24 lines" chip.
 * Inline `code` stays: it's a word in a sentence, not a listing. Steps go in words too
 * ("Edited store.ts", not the edit). Pure and runtime-free, like protocol.ts.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/;
const MAX_CODE = 200;
/** A drawn block's JSON, at most (a view with 500 rows of its own fits). */
export const MAX_BLOCK = 200_000;

/** The fences the screens draw (src/shared: view-spec, graph-spec, task-refs), by what they are. */
export function blockKind(lang: string): 'view' | 'graph' | 'tasks' | undefined {
  if (isViewFence(lang)) return 'view';
  if (isGraphFence(lang)) return 'graph';
  if (lang === TASKS_FENCE) return 'tasks';
  return undefined;
}
/**
 * A picture linked in a chat message ("[📎 image 1 (png, 6K)](klaud-attachment:<owner>/<file>)",
 * src/core/attachment-share.ts ATTACHMENT_SCHEME): the phone can't open that link, so only its
 * words stay ("📎 image 1 (png, 6K)"). Kept here, not imported, so this file stays runtime-free.
 */
const ATTACHMENT_LINK = /\[([^\]\n]*)\]\((?:klaud|beluga)-attachment:[^)\s]*\)/g;

/** Fences whose body may be a table Claude wrote as text (not a language: plain text, a table, Markdown). */
const TEXT_FENCE = /^(|text|txt|plain|plaintext|table|md|markdown|console|output)$/;

/**
 * A table written as text (BLG-71, src/shared/render/text-table.ts): read, it goes as a view block
 * (a table, drawn with the same table as Markdown tables and views, on any phone since 1.3); only
 * looking like one, as a `text` block the phone shows monospaced, never wrapped (1.5).
 */
function tableBlock(body: string, n: number): ProseView['code'][number] | undefined {
  const table = readTextTable(body);
  if (table) {
    const spec = JSON.stringify(tableSpec(table));
    if (spec.length <= MAX_BLOCK) return { lang: 'table', lines: n, block: { kind: 'view', text: spec } };
  }
  if (looksLikeTable(body) && body.length <= MAX_BLOCK) return { lang: 'table', lines: n, block: { kind: 'text', text: body.replace(/\s+$/, '') } };
  return undefined;
}

/**
 * What else a block may be drawn as (BLG-87, src/shared/render/rich-fence.ts): a file tree, JSON
 * or a terminal goes as it was written, display math as its TeX, a mermaid diagram as the graph or
 * view it reads as. A phone before 1.9 shows a chip for the new kinds (a mermaid one draws).
 */
function richBlock(lang: string, body: string, n: number, rich = richFence(lang, body)): ProseView['code'][number] | undefined {
  if (!rich || body.length > MAX_BLOCK) return undefined;
  if (rich.kind === 'mermaid') return { lang: rich.block.kind === 'graph' ? 'beluga-graph' : 'beluga-view', lines: n, block: { kind: rich.block.kind, text: rich.block.text } };
  if (rich.kind === 'math') return { lang: 'math', lines: n, block: { kind: 'math', text: rich.tex } };
  return { ...(lang ? { lang } : {}), lines: n, block: { kind: rich.kind, text: body.replace(/\s+$/, '') } };
}

/** Claude's markdown with its code blocks taken out (and its tables written as text read as tables). */
export function stripCode(markdown: string): ProseView {
  const lines = normalizeMathDelimiters(markdown).split('\n');
  const out: string[] = [];
  const code: ProseView['code'][number][] = [];
  // Prose waits here until a code block or the end, so a table written in it is found whole.
  let prose: string[] = [];
  const flush = (): void => {
    const tables = prose.length >= 3 ? findTextTables(prose) : [];
    let at = 0;
    for (const t of tables) {
      out.push(...prose.slice(at, t.start));
      const body = prose.slice(t.start, t.end + 1).join('\n');
      const entry = code.length < MAX_CODE ? tableBlock(body, t.end - t.start + 1) : undefined;
      if (entry) {
        out.push(`[[code:${code.length}]]`);
        code.push(entry);
      } else out.push(...prose.slice(t.start, t.end + 1));
      at = t.end + 1;
    }
    out.push(...prose.slice(at));
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    // Display math ($$ … $$ on lines of their own) is drawn, as on the Mac.
    const math = lines[i]!.trimStart().startsWith('$$') && code.length < MAX_CODE ? displayMathAt(lines, i) : undefined;
    if (math && math.tex.length <= 4000) {
      flush();
      out.push(`[[code:${code.length}]]`);
      code.push({ lang: 'math', lines: math.end - i + 1, block: { kind: 'math', text: math.tex } });
      i = math.end;
      continue;
    }
    const open = FENCE.exec(lines[i]!);
    if (!open) {
      prose.push(lines[i]!.replace(ATTACHMENT_LINK, '$1'));
      continue;
    }
    flush();
    const fence = open[1]!;
    const lang = (open[2] ?? '').toLowerCase().slice(0, 40);
    let n = 0;
    let j = i + 1;
    // The block ends at a fence of the same character, at least as long (CommonMark), or at the end.
    for (; j < lines.length; j++) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]!);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) break;
      n++;
    }
    // A live preview (Settings › Experimental) runs only on the Mac: the phone says what it is, in words.
    if (lang === PREVIEW_FENCE) {
      const ref = parsePreviewRef(lines.slice(i + 1, i + 1 + n).join('\n'));
      // Its newest picture where the Mac drew one (views.ts withPictures), else these words.
      out.push(ref ? `![A live preview of ${previewTitle(ref)}, on your Mac](${STILL_SCHEME}${stillName(ref.target)})` : '_A live preview, on your Mac._');
      i = j;
      continue;
    }
    if (code.length < MAX_CODE) {
      out.push(`[[code:${code.length}]]`);
      // What Claude drew for the screen (a view, a graph, tasks) goes along to be drawn there too
      // (BLG-68); a phone before 1.3 still shows a chip. A block that's only a table is a table
      // (BLG-71). Any other code stays a chip.
      const kind = blockKind(lang);
      const body = lines.slice(i + 1, i + 1 + n).join('\n');
      // A file tree before a table (its rails can read as columns), a table before a terminal.
      const rich = kind ? undefined : richFence(lang, body);
      const tree = rich?.kind === 'tree' ? richBlock(lang, body, n, rich) : undefined;
      const table = !kind && !tree && TEXT_FENCE.test(lang) ? tableBlock(body, n) : undefined;
      const other = !kind && !tree && !table && rich ? richBlock(lang, body, n, rich) : undefined;
      code.push(tree ?? table ?? other ?? { ...(lang ? { lang } : {}), lines: n, ...(kind && body.length <= MAX_BLOCK ? { block: { kind, text: body } } : {}) });
    } else out.push('[[code]]');
    i = j;
  }
  flush();
  return { text: out.join('\n').slice(0, 64_000), code };
}

/** Just the words, one line (a conversation's last line, a notification): markers say "(code)". */
export function plainLine(markdown: string, max = 300): string {
  const { text } = stripCode(markdown);
  const line = text
    .replace(/\[\[code(?::\d+)?\]\]/g, '(code)')
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/[*_#>`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? p;
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A step's words in both tenses: what it did ("Edited store.ts") and what it's doing ("Editing store.ts"), and its tool's kind. */
export interface StepWords {
  readonly did: string;
  readonly doing: string;
  readonly tool: ToolKind;
}
const w = (did: string, doing: string, tool: ToolKind): StepWords => ({ did, doing, tool });

/** Programs whose first word alone says little ("npm run", "cargo check"): their second word goes along. */
const TWO_WORDS = /^(npm|npx|pnpm|yarn|bun|git|cargo|go|make|python3?|node|deno|uv|poetry|bundle|rake|mix|dotnet|swift|xcodebuild|gradle|\.\/gradlew)$/;
const TESTS = /(^|[\s/:-])(test|tests|vitest|jest|pytest|playwright|mocha|ava|rspec|phpunit|ctest|test:\w+|e2e)($|[\s:])/;

/** A command in words: the tests, the types, a build, an install, else its program (and first word), never the whole line. */
function command(a: string): StepWords {
  const words = a.trim().split(/\s+/).filter((x) => x && !/^[A-Z_][A-Z0-9_]*=/.test(x));
  const line = words.join(' ');
  if (TESTS.test(line)) return w('Ran the tests', 'Running the tests', 'test');
  if (/(^|\s)(tsc|typecheck|mypy|pyright)(\s|$)/.test(line)) return w('Checked the types', 'Checking the types', 'test');
  if (/(^|\s)(eslint|lint|biome|ruff|clippy)(\s|$)/.test(line)) return w('Ran the linter', 'Running the linter', 'test');
  if (/^(npm|pnpm|yarn|bun) (i|install|ci|add)\b|^pip3? install\b|^brew install\b/.test(line)) return w('Installed packages', 'Installing packages', 'run');
  if (words[0] && TWO_WORDS.test(words[0]) && /(^|\s)(build|bundle|compile)(\s|$)/.test(line)) return w('Built it', 'Building it', 'run');
  const what = words.slice(0, words[0] && TWO_WORDS.test(words[0]) ? 2 : 1).join(' ');
  return what ? w(`Ran ${clip(what, 40)}`, `Running ${clip(what, 40)}`, 'run') : w('Ran a command', 'Running a command', 'run');
}

const file =
  (did: string, doing: string, tool: ToolKind, none: string, noneDoing: string) =>
  (a: string): StepWords =>
    a ? w(`${did} ${base(a)}`, `${doing} ${base(a)}`, tool) : w(none, noneDoing, tool);
const unquote = (a: string): string => clip(a.replace(/^"|"$/g, ''), 40);

/** How a tool's step reads on the phone: a verb and a file name, never its code or diff. */
const VERBS: Readonly<Record<string, (arg: string) => StepWords>> = {
  Read: file('Read', 'Reading', 'read', 'Read a file', 'Reading a file'),
  Edit: file('Edited', 'Editing', 'edit', 'Edited a file', 'Editing a file'),
  MultiEdit: file('Edited', 'Editing', 'edit', 'Edited a file', 'Editing a file'),
  Write: file('Wrote', 'Writing', 'write', 'Wrote a file', 'Writing a file'),
  NotebookEdit: file('Edited', 'Editing', 'edit', 'Edited a notebook', 'Editing a notebook'),
  Grep: (a) => (a ? w(`Searched for ${unquote(a)}`, `Searching for ${unquote(a)}`, 'search') : w('Searched the code', 'Searching the code', 'search')),
  Glob: () => w('Looked for files', 'Looking for files', 'search'),
  LS: () => w('Looked through a folder', 'Looking through a folder', 'search'),
  WebFetch: (a) => {
    const host = /^https?:\/\/([^/\s]+)/.exec(a)?.[1];
    return host ? w(`Read a page on ${host}`, `Reading a page on ${host}`, 'web') : w('Read a web page', 'Reading a web page', 'web');
  },
  WebSearch: (a) => (a ? w(`Searched the web for ${clip(a, 40)}`, `Searching the web for ${clip(a, 40)}`, 'web') : w('Searched the web', 'Searching the web', 'web')),
  Task: (a) => (a ? w(`Started a sub-agent: ${clip(a, 60)}`, `Starting a sub-agent: ${clip(a, 60)}`, 'agent') : w('Started a sub-agent', 'Starting a sub-agent', 'agent')),
  Agent: (a) => (a ? w(`Started a sub-agent: ${clip(a, 60)}`, `Starting a sub-agent: ${clip(a, 60)}`, 'agent') : w('Started a sub-agent', 'Starting a sub-agent', 'agent')),
  TodoWrite: () => w('Updated its to-do list', 'Updating its to-do list', 'plan'),
  // A command: what it is ("Ran the tests"), or its program and first word ("Ran npm run"), never the whole line.
  Bash: (a) => command(a),
};

/** Steps the Mac's chat doesn't show either (src/ui/format.ts HIDDEN_STEPS): looking up tools, the to-do list. */
export const HIDDEN_STEP = /^(ToolSearch|TodoWrite)\b/;

/** A step of Claude's ("Edit src/store.ts", "Bash npm test", "mcp__beluga__show") in words, both tenses, with its tool. */
export function stepWords(step: string): StepWords {
  const s = step.trim();
  const at = s.indexOf(' ');
  const tool = at < 0 ? s : s.slice(0, at);
  const arg = at < 0 ? '' : s.slice(at + 1).trim();
  const verb = VERBS[tool];
  if (verb) {
    const v = verb(arg);
    return w(clip(v.did, 300), clip(v.doing, 300), v.tool);
  }
  // MCP tools and Beluga's own: their name in words ("task define" → "Used task define").
  const name = tool.replace(/^mcp__.+?__/, '').replace(/[_-]+/g, ' ').trim();
  if (/^[a-z][\w ]*$/i.test(name) && name.length <= 40 && (tool.startsWith('mcp__') || /_/.test(tool))) return w(clip(`Used ${name}`, 300), clip(`Using ${name}`, 300), 'tool');
  // Anything else (a sub-agent's own words, a count): as it is, without code fences.
  const words = clip(plainLine(s, 300) || 'Working', 300);
  return w(words, words, 'tool');
}

/**
 * A step as the phone says it, from its record's summary: a step whose tool has an MCP App
 * (Settings › Experimental › MCP Apps) is drawn on the Mac only, so the phone says where
 * ("Get time app, on your Mac"); any other step reads as stepWords says.
 */
export function summaryWords(step: { readonly title: string; readonly hasApp?: boolean }): StepWords {
  if (!step.hasApp) return stepWords(step.title);
  const tool = step.title.trim().split(' ')[0] ?? '';
  const name = tool.replace(/^mcp__.+?__/, '').replace(/[_-]+/g, ' ').trim() || 'MCP';
  const words = clip(`${name.charAt(0).toUpperCase()}${name.slice(1)} app, on your Mac`, 300);
  return w(words, words, 'tool');
}

/** A step of Claude's in words, as it did it ("Edited store.ts"). */
export const humanizeStep = (step: string): string => stepWords(step).did;

/**
 * What Claude Code says an agent is doing (src/core/claude-code/transcript.ts describeTool:
 * "Reading src/core/store.ts", "Running npm test -- --run", "Searching for retry in src") in the
 * phone's words: file names without their folders, commands by what they are, no page paths.
 */
export function humanizeDoing(words: string): { text: string; tool: ToolKind } {
  const s = plainLine(words, 400);
  const m = /^(Reading|Editing|Writing|Listing) (.+)$/.exec(s);
  if (m) return { text: clip(`${m[1]} ${base(m[2]!.replace(/^…/, ''))}`, 300), tool: m[1] === 'Reading' ? 'read' : m[1] === 'Listing' ? 'search' : m[1] === 'Writing' ? 'write' : 'edit' };
  const run = /^Running (.+)$/.exec(s);
  if (run) {
    const c = command(run[1]!);
    return { text: c.doing, tool: c.tool };
  }
  const find = /^(Searching for|Finding) (.+?)(?: in .+)?$/.exec(s);
  if (find) return { text: clip(`${find[1]} ${clip(find[2]!, 40)}`, 300), tool: 'search' };
  const page = /^Fetching https?:\/\/([^/\s]+)/.exec(s);
  if (page) return { text: `Reading a page on ${page[1]}`, tool: 'web' };
  if (/^Searching the web/.test(s)) return { text: clip(s, 100), tool: 'web' };
  const agent = /^Agent: (.+)$/.exec(s);
  if (agent) return { text: clip(`Starting a sub-agent: ${agent[1]}`, 300), tool: 'agent' };
  if (s === 'Updating the plan') return { text: 'Updating its to-do list', tool: 'plan' };
  // A command's own description ("Run the unit tests"), or another tool's name: words, kept short.
  return { text: clip(s || 'Working', 120), tool: TESTS.test(s.toLowerCase()) ? 'test' : 'tool' };
}
