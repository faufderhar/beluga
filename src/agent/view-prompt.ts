import { CHART_KINDS, COLUMN_TYPES, VIEW_FENCE } from '../shared/view-spec.js';
import { TASKS_FENCE } from '../shared/task-refs.js';
import { CODE_FENCE } from '../shared/code-ref.js';
import { PR_COMMENTS_FENCE } from '../shared/pr-comments-ref.js';
import { type ChatRef, formatChatRef } from '../shared/chat-ref.js';

/**
 * Teaching Claude what it can show (src/shared/view-spec.ts, docs/views.md): what's there, and
 * above all when it's worth it. Most answers are words; a plain Markdown table already shows as a
 * sortable table. The `show` tool is for when the user will want to look around in the data.
 */
export function buildViewAppend(terminal = false): string {
  // In the agent's own terminal (BLG-555) Beluga's fenced blocks print as raw text: each goes
  // through show_block there, and a view never as a fence.
  const via = terminal ? ' passed to mcp__beluga_view__show_block (write the token it returns)' : '';
  return [
    '',
    'Showing data (the Beluga app draws it). Answer in words first; use a view, unasked, whenever the shape',
    'of what you are saying is one: rows (a table), a trend (a chart), work over time (a gantt), a grid of',
    'counts (a heatmap), activity by day (a calendar). A plain Markdown table already shows as a sortable,',
    'searchable table that can turn into a chart. Never add a view just to decorate, never more than one or',
    'two per answer unless asked, and not for a handful of values a sentence can say.',
    'Drawn for you, so write them as usual: a file tree (├── └──) in a code block shows as a tree that folds,',
    'a ```json block as a colored tree, a shell session or command output in a ```console block as a terminal',
    '(prompts, colors, errors), $…$ and $$…$$ as typeset math (a price like $5 stays words), and a ```mermaid',
    'block as one of these graphs (flowchart, sequence, state, ER, class) or a chart (pie) or gantt.',
    'A picture on this computer (a screenshot you took, a GIF you made, a rendered page) shows in your answer',
    'as a Markdown image with its absolute path: ![Login page](/Users/…/.beluga/scratch/01-login.png), in <…>',
    'if the path has spaces. A GIF plays; png, jpg, gif, webp or svg, up to 10 MB. Your owner sees it, others in',
    'the room see its name (send_file gives them the file). It is not a view: no token, no show.',
    'Code in this repository: show lines only when the code itself is what the person needs to see: they asked',
    'to see it, you are reviewing it, or where a bug is (what a reviewer meant) is the answer. Telling what you',
    'did or changed is words: never add code to a summary of finished work. When you do show lines, use a',
    `\`\`\`${CODE_FENCE} block${via} instead of pasting them: its first line is the path from the`,
    'project root and the lines ("src/auth.ts:40-62"), then optionally "highlight: 44-46, 51" and "note: one line".',
    'Take the line numbers from the file as it is now (read it first), never from memory or a guess.',
    'The app reads those lines from the worktree, marks the highlighted ones, and goes to that file at a click.',
    `A pull request's comments: when asked what reviewers said on this worktree's PR, show them with a`,
    `\`\`\`${PR_COMMENTS_FENCE} block${via} ("show: open", or "show: all" for resolved threads too; optionally`,
    '"path: src/payments" for one part) instead of retyping them; the app draws each comment with its code.',
    'Then say in words what they ask for. Replying and resolving happen on the PR page, not in chat.',
    '',
    'mcp__beluga_view__show takes one JSON element and returns its token: put that exact token on its own line',
    'in your answer where the element goes. Write only tokens the tool returned, never one by hand (a token',
    'with no view is dropped). Types: table, chart, stats, code, colors, gantt, heatmap, calendar (and graph, with',
    'beluga-graph fields). Give rows',
    'in "data" (all of them: big data is kept for the view, and the user explores it without you), or a',
    '"source" the app fetches from on this computer when the user pages, sorts or filters: {"kind": "file",',
    '"path"}, {"kind": "folder", "path", "glob"}, {"kind": "sqlite", "path", "query"}, {"kind": "postgres",',
    '"query"}, {"kind": "http", "url", "rows": "data.items"}, {"kind": "command", "command", "format"}, or',
    '{"kind": "script", "language": "python"|"node"|"sh"|"bash"|"ruby"|"perl", "code", "args", "format"}: a',
    'script you write for the view that prints rows (JSON, CSV…); Beluga keeps it, so prefer it to a script file',
    'in the project when no ready source fits (an API to page through, files to parse, numbers to work out).',
    'Rows fetched are kept: opening the view again shows them without running it, until the user refreshes.',
    'Databases sort, search and page themselves; "refresh": seconds keeps it live. Postgres finds the',
    "project's own database by itself (DATABASE_URL and the like, or a Supabase project's variables, in",
    'Settings or its .env); "env": "NAME" picks another variable. Never ask for or handle the password: if',
    'it says what is missing, tell the user that.',
    'Controls let the user change what they see without asking you again; add them when you can tell what',
    'they will want next ("top 5", "only failed", "this week"), and skip them otherwise:',
    '{"type": "table", "title": "Customers by revenue", "data": [...], "initial": {"sort": "-revenue"},',
    ' "controls": [{"id": "rank", "type": "buttons", "options": [{"label": "Top 5", "sort": "-revenue", "top": 5},',
    '   {"label": "Bottom 5", "sort": "revenue", "top": 5}, {"label": "All"}]},',
    '  {"id": "region", "type": "select", "column": "region"}, {"id": "min", "type": "number", "label": "Min $", "column": "revenue", "op": "gte"},',
    '  {"id": "late", "type": "toggle", "label": "Overdue only", "where": [{"key": "status", "value": "overdue"}]}, {"id": "q", "type": "search"}]}',
    'An option or toggle can set "sort", "top", "where" ([{key, op: eq|ne|gt|gte|lt|lte|contains|in, value}]),',
    '"search", "params" or another "source". A control\'s value also fills {{id}} in a source\'s command, URL',
    'or query (quoted safely), so one script can serve every choice: "command": "./report.sh --region {{region}}".',
    `Charts: ${CHART_KINDS.join(', ')}; "x", "y" (a key or keys), "group" (one series per value, for long rows),`,
    '"curve": smooth|linear|step, "stacked", "colors" (your own palette). One measure per chart, never two y-scales.',
    `Columns are inferred; "columns": [{"key", "label", "type"}] to choose (${COLUMN_TYPES.join(', ')}).`,
    '{"type": "stats", "items": [{"label": "p95", "value": 182, "unit": "ms", "delta": -12, "invert": true, "trend": [210, 182]}]}',
    'Only data, the app draws them: {"type": "gantt", "data": [{"task": "Design", "start": "2026-11-02", "end":',
    '"2026-11-06", "group": "Web", "progress": 0.6, "status": "active"}]} (end is the last day; "milestone": true',
    'for a point); {"type": "heatmap", "x": "hour", "y": "day", "value": "errors", "data": [{"hour": "09", "day":',
    '"Mon", "errors": 4}]} (or wide rows, one per y); {"type": "calendar", "data": [{"date": "2026-10-01",',
    '"value": 3}]} (one row per event without "value"). "colors": [low, high] picks the scale.',
    ...(terminal ? [] : [`The same JSON in a fenced ${VIEW_FENCE} block works without the tool (absolute paths there).`]),
    'Inline, inside a sentence: a color written as inline code (`#3987e5`) shows its swatch; also `badge:failed`,',
    '`kbd:cmd+k`, `progress:3/8`, `delta:+12%` (`delta:-40ms good`), `spark:3,5,4,8` and `time:2026-10-23T14:00:00Z`.',
    'Use them where they say more than the text would, sparingly.',
    `A board task: \`task:BLG-12\` is a chip with its live status that opens it; a fenced ${TASKS_FENCE} block${via} (one key`,
    'per line) is a list of task cards. Use them for tasks you opened, changed or mean, not for every key you say.',
  ].join('\n');
}

/** Chat chips (core/agent-host.ts): this chat's own ref, as the token. Nothing for a chat with no address. */
export function buildChatLinkAppend(here: ChatRef): string {
  const ref = formatChatRef(here);
  if (!ref) return '';
  return [
    '',
    'A chat: `chat:<owner>/<channel>` is a chip that shows the current title of that chat and opens it.',
    `This chat is \`chat:${ref}\`. Write a chip only for a chat whose ref you were given. Do not write its title next to the chip.`,
  ].join('\n');
}
